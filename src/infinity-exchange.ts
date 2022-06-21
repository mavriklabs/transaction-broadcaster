import { TransactionRequest } from '@ethersproject/abstract-provider';
import {
  ChainId,
  ChainNFTs,
  ChainOBOrder,
  FirestoreOrderMatchErrorCode,
  MakerOrder,
  OrderMatchStateError
} from '@infinityxyz/lib/types/core';
import { getExchangeAddress, getOBOrderPrice, getTxnCurrencyAddress } from '@infinityxyz/lib/utils/orders';
import { BigNumber, BigNumberish, Contract, ethers, providers } from 'ethers';
import { erc20Abi } from './abi/erc20.abi';
import { erc721Abi } from './abi/erc721.abi';
import { infinityExchangeAbi } from './abi/infinity-exchange.abi';
import { MAX_GAS_LIMIT } from './utils/constants';
import {
  BundleCallDataEncoder,
  BundleItem,
  BundleItemsToArgsTransformer,
  BundleItemWithCurrentPrice,
  BundleOrdersEncoder,
  BundleType,
  BundleVerifier,
  MatchOrdersArgs,
  MatchOrdersBundleItem,
  MatchOrdersOneToOneArgs,
  MatchOrdersOneToOneBundleItem
} from './flashbots-broadcaster/bundle.types';
import { getErrorMessage } from './utils/general';
import { formatEther } from 'ethers/lib/utils';

type InvalidBundleItem = {
  bundleItem: BundleItem | MatchOrdersBundleItem;
  orderError: Pick<OrderMatchStateError, 'code' | 'error'>;
};
export class InfinityExchange {
  private contracts: Map<ChainId, Contract>;

  public get exchangeAddresses() {
    return [...this.contracts.values()].map((contract) => contract.address);
  }

  constructor(private providers: Record<ChainId, providers.JsonRpcProvider>) {
    this.contracts = new Map();
    for (const [chainId, provider] of Object.entries(providers) as [ChainId, providers.JsonRpcProvider][]) {
      const contract = new Contract(InfinityExchange.getExchangeAddress(chainId), infinityExchangeAbi, provider);
      this.contracts.set(chainId, contract);
    }
  }

  public getBundleEncoder(bundleType: BundleType, chainId: ChainId, signerAddress: string) {
    switch (bundleType) {
      case BundleType.MatchOrders:
        return this.getEncoder<MatchOrdersBundleItem, MatchOrdersArgs>(
          chainId,
          signerAddress,
          this.matchOrdersItemsToArgsTransformer.bind(this),
          this.matchOrdersCallDataEncoder.bind(this),
          this.matchOrdersVerifier.bind(this)
        );
      case BundleType.MatchOrdersOneToOne:
        return this.getEncoder<MatchOrdersOneToOneBundleItem, MatchOrdersOneToOneArgs>(
          chainId,
          signerAddress,
          this.matchOrdersOneToOneItemsToArgsTransformer.bind(this),
          this.matchOrdersOneToOneCallDataEncoder.bind(this),
          this.matchOrdersOneToOneVerifier.bind(this)
        );
      default:
        throw new Error(`Bundle type ${bundleType} not yet supported`);
    }
  }

  private getEncoder<T extends BundleItem, Args extends Array<unknown>>(
    chainId: ChainId,
    signerAddress: string,
    bundleItemsToArgs: BundleItemsToArgsTransformer<T, Args>,
    encodeCallData: BundleCallDataEncoder<Args>,
    verifyBundleItems: BundleVerifier<T>
  ): BundleOrdersEncoder<T> {
    const contract = this.getContract(chainId);
    const provider = this.getProvider(chainId);

    const buildBundles = async (
      bundleItems: T[],
      numBundles: number
    ): Promise<{ txRequests: TransactionRequest[]; invalidBundleItems: T[] }> => {
      const bundleArgs = bundleItemsToArgs(bundleItems, numBundles);
      const transactionRequests: TransactionRequest[] = (
        await Promise.all(
          bundleArgs.map(async (args) => {
            try {
              const data = encodeCallData(args, chainId);
              const estimate = await provider.estimateGas({
                to: contract.address,
                from: signerAddress,
                data
              });
              const gasLimit = Math.floor(estimate.toNumber() * 1.2);
              return {
                to: contract.address,
                gasLimit: gasLimit,
                data,
                chainId: parseInt(chainId),
                type: 2
              };
            } catch (err: any) {
              if ('error' in err && 'error' in err.error) {
                console.log(err.error.error);
              } else {
                console.error(err);
              }
              return undefined;
            }
          })
        )
      ).filter((item) => !!item) as TransactionRequest[];
      const transactionsTooBig = transactionRequests.some(
        (txRequest) => txRequest.gasLimit != null && txRequest.gasLimit > MAX_GAS_LIMIT
      );
      if (transactionsTooBig) {
        const estimatedNumBundles = Math.ceil(transactionRequests.length / MAX_GAS_LIMIT);
        const updatedNumBundles = numBundles >= estimatedNumBundles ? numBundles * 2 : estimatedNumBundles;
        return await buildBundles(bundleItems, updatedNumBundles);
      }
      return { txRequests: transactionRequests, invalidBundleItems: [] };
    };

    const encoder: BundleOrdersEncoder<T> = async (
      bundleItems: T[],
      minBundleSize: number
    ): Promise<{ txRequests: TransactionRequest[]; invalidBundleItems: T[] }> => {
      let validBundleItems: BundleItemWithCurrentPrice[] = [];
      let invalidBundleItems: InvalidBundleItem[] = [];

      console.log(
        `Received: ${bundleItems.length} valid bundle items and ${invalidBundleItems.length} invalid bundle items`
      );

      // TODO it would be more scalable to call an external service to check bundle item validity
      const { validBundleItems: validBundleItemsAfterVerification, invalidBundleItems: invalidBundleItemsFromVerify } =
        await verifyBundleItems(bundleItems, chainId);
      const invalidBundleItemsFromVerifyWithError = invalidBundleItemsFromVerify.map((invalidItem) => {
        return {
          bundleItem: invalidItem,
          orderError: {
            code: FirestoreOrderMatchErrorCode.OrderInvalid,
            error: 'Order match not valid for one or more orders'
          }
        };
      });
      validBundleItems = validBundleItemsAfterVerification;
      invalidBundleItems = [...invalidBundleItems, ...invalidBundleItemsFromVerifyWithError];

      console.log(
        `Have ${validBundleItems.length} valid bundle items and ${invalidBundleItems.length} invalid bundle items after verifying orders`
      );

      const {
        validBundleItems: validBundleItemsAfterNftApproval,
        invalidBundleItems: invalidBundleItemsAfterNftApproval
      } = await this.checkNftSellerApprovalAndBalance(validBundleItems, chainId);
      validBundleItems = validBundleItemsAfterNftApproval;
      invalidBundleItems = [...invalidBundleItems, ...invalidBundleItemsAfterNftApproval];

      console.log(
        `Have ${validBundleItems.length} valid bundle items and ${invalidBundleItems.length} invalid bundle items after checking nft approval and balance`
      );

      const {
        validBundleItems: validBundleItemsAfterCurrencyCheck,
        invalidBundleItems: invalidBundleItemsFromCurrencyCheck
      } = await this.checkNftBuyerApprovalAndBalance(validBundleItems, chainId);
      validBundleItems = validBundleItemsAfterCurrencyCheck as unknown as BundleItemWithCurrentPrice[];
      invalidBundleItems = [...invalidBundleItems, ...invalidBundleItemsFromCurrencyCheck];

      console.log(
        `Have ${validBundleItems.length} valid bundle items and ${invalidBundleItems.length} invalid bundle items after checking currency approval and balance`
      );

      if (validBundleItems.length < minBundleSize) {
        return { txRequests: [] as TransactionRequest[], invalidBundleItems: invalidBundleItemsFromVerify };
      }

      const { txRequests, invalidBundleItems: invalidBundleItemsFromBuild } = await buildBundles(
        validBundleItems as unknown as T[],
        1
      );

      return { txRequests, invalidBundleItems: [...invalidBundleItemsFromVerify, ...invalidBundleItemsFromBuild] };
    };

    return encoder;
  }

  private async checkNftBuyerApprovalAndBalance(
    bundleItems: BundleItemWithCurrentPrice[],
    chainId: ChainId
  ): Promise<{ validBundleItems: BundleItemWithCurrentPrice[]; invalidBundleItems: InvalidBundleItem[] }> {
    const provider = this.getProvider(chainId);
    const operator = this.getContract(chainId).address;
    type BundleItemIsValid = { bundleItem: BundleItemWithCurrentPrice; isValid: true };
    type BundleItemIsInvalid = InvalidBundleItem & { isValid: false };

    const results: (BundleItemIsValid | BundleItemIsInvalid)[] = await Promise.all(
      bundleItems.map(async (bundleItem) => {
        try {
          const buyer = bundleItem.buy.signer;
          const currency = bundleItem.buy.execParams[1];
          const weth = getTxnCurrencyAddress(chainId);
          const currencies = [...new Set([currency, weth])];

          for (const currency of currencies) {
            const contract = new ethers.Contract(currency, erc20Abi, provider);
            const allowance: BigNumberish = await contract.allowance(buyer, operator);
            let expectedCost = bundleItem.currentPrice.mul(11).div(10); // 10% buffer
            if (currency === weth) {
              // TODO estimate gas price and add it here
              expectedCost = expectedCost.add(0);
            }

            if (BigNumber.from(allowance).lt(expectedCost)) {
              return {
                bundleItem,
                isValid: false,
                orderError: {
                  code: FirestoreOrderMatchErrorCode.InsufficientCurrencyAllowance,
                  error: `Buyer: ${buyer} has an insufficient currency allowance for currency ${currency}. Allowance: ${allowance.toString()}. Expected: ${expectedCost.toString()}`
                }
              };
            }

            const balance: BigNumberish = await contract.balanceOf(buyer);
            if (BigNumber.from(balance).lt(expectedCost)) {
              return {
                bundleItem,
                isValid: false,
                orderError: {
                  code: FirestoreOrderMatchErrorCode.InsufficientCurrencyBalance,
                  error: `Buyer: ${buyer} has an insufficient currency balance for currency ${currency}. Balance: ${balance.toString()}. Expected: ${expectedCost.toString()}`
                }
              };
            }
          }
          return { bundleItem, isValid: true };
        } catch (err) {
          console.error(err);
          const errorMessage = getErrorMessage(err);
          return {
            bundleItem,
            isValid: false,
            orderError: {
              code: FirestoreOrderMatchErrorCode.UnknownError,
              error: errorMessage
            }
          };
        }
      })
    );

    return results.reduce(
      (acc: { validBundleItems: BundleItemWithCurrentPrice[]; invalidBundleItems: InvalidBundleItem[] }, result) => {
        if (result.isValid) {
          return {
            ...acc,
            validBundleItems: [...acc.validBundleItems, result.bundleItem]
          };
        }
        const invalidBundleItem = {
          bundleItem: result.bundleItem,
          orderError: result.orderError
        };
        return {
          ...acc,
          invalidBundleItems: [...acc.invalidBundleItems, invalidBundleItem]
        };
      },
      { validBundleItems: [], invalidBundleItems: [] }
    );
  }

  private async checkNftSellerApprovalAndBalance(
    bundleItems: BundleItemWithCurrentPrice[],
    chainId: ChainId
  ): Promise<{ validBundleItems: BundleItemWithCurrentPrice[]; invalidBundleItems: InvalidBundleItem[] }> {
    const provider = this.getProvider(chainId);
    const operator = this.getContract(chainId).address;
    type BundleItemIsValid = { bundleItem: BundleItemWithCurrentPrice; isValid: true };
    type BundleItemIsInvalid = InvalidBundleItem & { isValid: false };
    const results: (BundleItemIsValid | BundleItemIsInvalid)[] = await Promise.all(
      bundleItems.map(async (bundleItem) => {
        try {
          const owner = bundleItem.sell;
          const signerAddress = owner.signer;
          const nfts =
            bundleItem.bundleType === BundleType.MatchOrders ? bundleItem.constructed.nfts : bundleItem.sell.nfts;
          for (const { collection, tokens } of nfts) {
            const erc721Contract = new ethers.Contract(collection, erc721Abi, provider);
            const isApproved = await erc721Contract.isApprovedForAll(signerAddress, operator);
            if (!isApproved) {
              return {
                bundleItem,
                isValid: false,
                orderError: {
                  error: `Operator ${operator} is not approved on contract ${collection}`,
                  code: FirestoreOrderMatchErrorCode.NotApprovedToTransferToken
                }
              };
            }
            for (const { tokenId, numTokens } of tokens) {
              const ownerOfToken = await erc721Contract.ownerOf(tokenId);
              if (signerAddress !== ownerOfToken.toLowerCase()) {
                return {
                  bundleItem,
                  isValid: false,
                  orderError: {
                    error: `Signer ${signerAddress} does not own at least ${numTokens} tokens of token ${tokenId} from collection ${collection}`,
                    code: FirestoreOrderMatchErrorCode.InsufficientTokenBalance
                  }
                };
              }
            }
          }
          return { bundleItem, isValid: true };
        } catch (err) {
          console.error(err);
          const errorMessage = getErrorMessage(err);
          return {
            bundleItem,
            isValid: false,
            orderError: {
              error: errorMessage,
              code: FirestoreOrderMatchErrorCode.UnknownError
            }
          };
        }
      })
    );

    return results.reduce(
      (acc: { validBundleItems: BundleItemWithCurrentPrice[]; invalidBundleItems: InvalidBundleItem[] }, result) => {
        if (result.isValid) {
          return {
            ...acc,
            validBundleItems: [...acc.validBundleItems, result.bundleItem]
          };
        }
        const invalidBundleItem = {
          bundleItem: result.bundleItem,
          orderError: result.orderError
        };
        return {
          ...acc,
          invalidBundleItems: [...acc.invalidBundleItems, invalidBundleItem]
        };
      },
      { validBundleItems: [], invalidBundleItems: [] }
    );
  }

  private matchOrdersOneToOneCallDataEncoder: BundleCallDataEncoder<MatchOrdersOneToOneArgs> = (
    args: MatchOrdersOneToOneArgs,
    chainId: ChainId
  ) => {
    const contract = this.getContract(chainId);
    const fn = contract.interface.getFunction('matchOneToOneOrders');
    const data = contract.interface.encodeFunctionData(fn, args);

    return data;
  };

  private matchOrdersCallDataEncoder: BundleCallDataEncoder<MatchOrdersArgs> = (
    args: MatchOrdersArgs,
    chainId: ChainId
  ) => {
    const contract = this.getContract(chainId);
    const fn = contract.interface.getFunction('matchOrders');
    const data = contract.interface.encodeFunctionData(fn, args);

    return data;
  };

  private matchOrdersOneToOneItemsToArgsTransformer: BundleItemsToArgsTransformer<
    MatchOrdersOneToOneBundleItem,
    MatchOrdersOneToOneArgs
  > = (bundleItems: MatchOrdersOneToOneBundleItem[], numBundles: number) => {
    const bundles = bundleItems.reduce(
      (acc: { sells: MakerOrder[]; buys: MakerOrder[] }[], bundleItem, currentIndex) => {
        const index = currentIndex % numBundles;
        const bundle = acc[index] ?? { sells: [], buys: [], constructed: [] };
        bundle.sells.push(bundleItem.sell);
        bundle.buys.push(bundleItem.buy);
        acc[index] = bundle;
        return acc;
      },
      []
    );
    const bundlesArgs = bundles.map((bundle) => {
      const args: MatchOrdersOneToOneArgs = [bundle.sells, bundle.buys];
      return args;
    });
    return bundlesArgs;
  };

  private matchOrdersItemsToArgsTransformer: BundleItemsToArgsTransformer<MatchOrdersBundleItem, MatchOrdersArgs> = (
    bundleItems: MatchOrdersBundleItem[],
    numBundles: number
  ) => {
    const bundles = bundleItems.reduce(
      (acc: { sells: MakerOrder[]; buys: MakerOrder[]; constructed: ChainNFTs[][] }[], bundleItem, currentIndex) => {
        const index = currentIndex % numBundles;
        const bundle = acc[index] ?? { sells: [], buys: [], constructed: [] };
        bundle.sells.push(bundleItem.sell);
        bundle.buys.push(bundleItem.buy);
        bundle.constructed.push(bundleItem.constructed.nfts);
        acc[index] = bundle;
        return acc;
      },
      []
    );
    const bundlesArgs = bundles.map((bundle) => {
      const args: MatchOrdersArgs = [bundle.sells, bundle.buys, bundle.constructed];
      return args;
    });
    return bundlesArgs;
  };

  private matchOrdersOneToOneVerifier: BundleVerifier<MatchOrdersOneToOneBundleItem> = async (
    bundleItems: MatchOrdersOneToOneBundleItem[],
    chainId: ChainId
  ) => {
    try {
      const result = await new Promise<{
        validBundleItems: BundleItemWithCurrentPrice[];
        invalidBundleItems: MatchOrdersOneToOneBundleItem[];
      }>((res) => {
        const bundleItemsWithCurrentPrice = bundleItems.map((bundleItem) => {
          return {
            ...bundleItem,
            currentPrice: BigNumber.from(bundleItem.sell.constraints[1])
          };
        }); // TODO add validation once new contracts deployed
        res({
          validBundleItems: bundleItemsWithCurrentPrice,
          invalidBundleItems: []
        });
      });
      return result;
    } catch (err) {
      console.log(`failed to verify match orders`);
      console.error(err);
      throw err;
    }
  };

  private matchOrdersVerifier: BundleVerifier<MatchOrdersBundleItem> = async (
    bundleItems: MatchOrdersBundleItem[],
    chainId: ChainId
  ) => {
    try {
      const contract = this.getContract(chainId);
      const results = await Promise.allSettled(
        bundleItems.map(async (item) => {
          return contract.verifyMatchOrders(
            item.sellOrderHash,
            item.buyOrderHash,
            item.sell,
            item.buy
          ) as Promise<boolean>;
        })
      );
      return bundleItems.reduce(
        (
          acc: {
            validBundleItems: BundleItemWithCurrentPrice[];
            invalidBundleItems: MatchOrdersBundleItem[];
          },
          bundleItem,
          index
        ) => {
          const result = results[index];
          const isValid = result.status === 'fulfilled' && result.value;
          const getCurrentPrice = (order: ChainOBOrder) => {
            const startPriceEth = parseFloat(formatEther(order.constraints[1]).toString());
            const endPriceEth = parseFloat(formatEther(order.constraints[2]).toString());
            const startTimeMs = BigNumber.from(order.constraints[3]).toNumber() * 1000;
            const endTimeMs = BigNumber.from(order.constraints[4]).toNumber() * 1000;
            const props = { startPriceEth, startTimeMs, endPriceEth, endTimeMs };
            const currentPrice = getOBOrderPrice(props, Date.now());
            return currentPrice;
          };
          const sellPrice = getCurrentPrice(bundleItem.sell);
          const buyPrice = getCurrentPrice(bundleItem.buy);
          const currentPrice = sellPrice.gte(buyPrice) ? buyPrice : sellPrice;
          const bundleItemWithCurrentPrice: BundleItemWithCurrentPrice = {
            ...bundleItem,
            currentPrice
          };
          return {
            validBundleItems: isValid ? [...acc.validBundleItems, bundleItemWithCurrentPrice] : acc.validBundleItems,
            invalidBundleItems: !isValid ? [...acc.invalidBundleItems, bundleItem] : acc.invalidBundleItems
          };
        },
        { validBundleItems: [], invalidBundleItems: [] }
      );
    } catch (err) {
      console.log(`failed to verify match orders`);
      console.error(err);
      throw err;
    }
  };

  private getProvider(chainId: ChainId) {
    const provider = this.providers[chainId];
    if (!provider) {
      throw new Error(`No provider for chainId: ${chainId}`);
    }
    return provider;
  }

  private getContract(chainId: ChainId) {
    const contract = this.contracts.get(chainId);
    if (!contract) {
      throw new Error(`No exchange contract for chainId: ${chainId}`);
    }
    return contract;
  }

  private static getExchangeAddress(chainId: ChainId): string {
    const exchangeAddress = getExchangeAddress(chainId);
    if (!exchangeAddress) {
      throw new Error(`No exchange address for chainId: ${chainId}`);
    }
    return exchangeAddress;
  }
}
