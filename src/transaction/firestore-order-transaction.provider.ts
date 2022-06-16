import { TransactionProvider } from './transaction.provider.abstract';
import { firestoreConstants } from '@infinityxyz/lib/utils/constants';
import {
  ChainId,
  ChainNFTs,
  ChainOBOrder,
  FirestoreOrder,
  FirestoreOrderMatch,
  FirestoreOrderMatchMethod,
  FirestoreOrderMatchOneToOne,
  FirestoreOrderMatchStatus,
  OrderMatchState
} from '@infinityxyz/lib/types/core';
import { TransactionProviderEvent } from './transaction.provider.interface';
import { getExchangeAddress } from '@infinityxyz/lib/utils/orders';
import {
  BundleItem,
  BundleType,
  MatchOrdersBundleItem,
  MatchOrdersOneToOneBundleItem
} from '../flashbots-broadcaster/bundle.types';
import { BigNumber } from 'ethers';
import { orderHash } from '../utils/order-hash';

export class FirestoreOrderTransactionProvider extends TransactionProvider {
  constructor(private db: FirebaseFirestore.Firestore) {
    super();
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false;
      const query = this.db
        .collection(firestoreConstants.ORDER_MATCHES_COLL)
        .where('state.status', '==', FirestoreOrderMatchStatus.Active);
      query.onSnapshot(
        (snapshot) => {
          if (!resolved) {
            resolve();
            resolved = true;
          }
          const changes = snapshot.docChanges();
          for (const change of changes) {
            const ref = change.doc.ref;
            const match = change.doc.data() as FirestoreOrderMatch;
            switch (change.type) {
              case 'added':
              case 'modified':
                this.handleOrderMatchUpdate(ref.id, match).catch(console.error);
                break;
              case 'removed':
                this.handleOrderMatchRemoved(ref.id);
                break;
            }
          }
        },
        (err) => {
          console.error(err);
        }
      );
    });
  }

  async transactionReverted(id: string): Promise<void> {
    try {
      // TODO handle orders that are no longer valid
      await this.deleteOrderMatch(id);
    } catch (err) {
      console.error(err);
    }
  }

  async orderCompleted(id: string, status: FirestoreOrderMatchStatus): Promise<void> {
    const matchRef = this.db.collection(firestoreConstants.ORDER_MATCHES_COLL).doc(id);
    await matchRef.update({ status });
  }

  async updateOrderMatch(id: string, state: Partial<OrderMatchState>) {
    const matchRef = this.db.collection(firestoreConstants.ORDER_MATCHES_COLL).doc(id);
    await matchRef.set({ state }, { merge: true });
  }

  async transactionCompleted(id: string): Promise<void> {
    try {
      await this.deleteOrderMatch(id);
      // TODO should we mark the order as invalid once it has been fulfilled?
      // TODO how do we know that this has been completed and it wasn't just skipped?
    } catch (err) {
      console.error(err);
    }
  }

  private async handleOrderMatchUpdate(id: string, match: FirestoreOrderMatch): Promise<void> {
    try {
      if (match.state.status !== FirestoreOrderMatchStatus.Active) {
        throw new Error('Order match is not active');
      }
      const { listing, offer } = await this.getOrders(match);
      const bundleItem = this.createBundleItem(id, listing, offer, match);

      this.emit(TransactionProviderEvent.Update, { id, item: bundleItem });
    } catch (err) {
      console.error(err);
    }
  }

  private createBundleItem(
    id: string,
    listing: FirestoreOrder,
    offer: FirestoreOrder,
    match: FirestoreOrderMatch | FirestoreOrderMatchOneToOne
  ): BundleItem {
    const chainNfts: ChainNFTs[] = [];
    let numMatches = 0;
    const collections = Object.values(match.matchData.orderItems);
    for (const collection of collections) {
      let collectionNumMatches = 0;
      const tokens = Object.values(collection.tokens);
      const collectionChainNfts: ChainNFTs = {
        collection: collection.collectionAddress,
        tokens: []
      };
      for (const token of tokens) {
        collectionChainNfts.tokens.push({
          tokenId: token.tokenId,
          numTokens: token.numTokens
        });
        collectionNumMatches += 1;
      }
      chainNfts.push(collectionChainNfts);

      if (collectionNumMatches === 0) {
        collectionNumMatches += 1;
      }

      numMatches += collectionNumMatches;
    }

    switch (match.type) {
      case FirestoreOrderMatchMethod.MatchOrders:
        return this.getMatchOrdersBundle(id, listing, offer, numMatches, chainNfts);
      case FirestoreOrderMatchMethod.MatchOneToOneOrders: {
        const bundleItem: MatchOrdersOneToOneBundleItem = {
          id,
          chainId: listing.chainId as ChainId,
          bundleType: BundleType.MatchOrdersOneToOne,
          exchangeAddress: getExchangeAddress(listing.chainId),
          sell: listing.signedOrder,
          buy: offer.signedOrder,
          buyOrderHash: orderHash(offer.signedOrder),
          sellOrderHash: orderHash(listing.signedOrder)
        };
        return bundleItem;
      }
      default:
        throw new Error(`Unknown match type: ${(match as any)?.type}`);
    }
  }

  private getMatchOrdersBundle(
    id: string,
    listing: FirestoreOrder,
    offer: FirestoreOrder,
    numMatches: number,
    chainNfts: ChainNFTs[]
  ) {
    const constructed: ChainOBOrder = {
      /**
       * refunding gas fees is done in WETH and paid by the buyer
       * therefore constructed isSellOrder needs to be the buy order side
       */
      isSellOrder: false,
      signer: listing.signedOrder.signer,
      constraints: [
        numMatches,
        BigNumber.from(offer.signedOrder.constraints[1]).toString(),
        BigNumber.from(offer.signedOrder.constraints[2]).toString(),
        offer.signedOrder.constraints[3],
        offer.signedOrder.constraints[4],
        offer.nonce
      ],
      nfts: chainNfts,
      execParams: [listing.complicationAddress, listing.currencyAddress],
      extraParams: listing.signedOrder.extraParams,
      sig: listing.signedOrder.sig
    };

    listing.signedOrder.constraints = listing.signedOrder.constraints.map((item) => BigNumber.from(item).toString());
    offer.signedOrder.constraints = offer.signedOrder.constraints.map((item) => BigNumber.from(item).toString());
    const bundleItem: MatchOrdersBundleItem = {
      id,
      chainId: listing.chainId as ChainId,
      bundleType: BundleType.MatchOrders,
      exchangeAddress: getExchangeAddress(listing.chainId),
      sell: listing.signedOrder,
      buy: offer.signedOrder,
      buyOrderHash: orderHash(offer.signedOrder),
      sellOrderHash: orderHash(listing.signedOrder),
      constructed
    };

    return bundleItem;
  }

  private handleOrderMatchRemoved(id: string): void {
    this.emit(TransactionProviderEvent.Remove, { id });
  }

  private async getOrders(match: FirestoreOrderMatch): Promise<{ listing: FirestoreOrder; offer: FirestoreOrder }> {
    const ordersCollectionRef = this.db.collection(
      firestoreConstants.ORDERS_COLL
    ) as FirebaseFirestore.CollectionReference<FirestoreOrder>;

    const orderRefs = match.ids.map((id) => ordersCollectionRef.doc(id));
    const orderSnaps = (await this.db.getAll(...orderRefs)) as FirebaseFirestore.DocumentSnapshot<FirestoreOrder>[];

    const orders = orderSnaps.map((item) => item.data() as FirestoreOrder);
    const listings = orders.filter((item) => item?.isSellOrder === true);
    const offers = orders.filter((item) => item?.isSellOrder === false);

    const listing = listings?.[0];
    const offer = offers?.[0];

    if (!listing || !offer) {
      throw new Error('Order not found');
    }
    if (listings.length > 1 || offers.length > 1) {
      throw new Error(`Multiple orders are not yet supported`);
    }

    return { listing, offer };
  }

  private async deleteOrderMatch(id: string) {
    const matchRef = this.db.collection(firestoreConstants.ORDER_MATCHES_COLL).doc(id);
    await matchRef.delete();
  }
}