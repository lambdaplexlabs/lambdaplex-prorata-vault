import { BigNumber, Signer } from "ethers";
import { VIRTUAL_ASSET, VIRTUAL_SHARES } from "./constants";

export function sharesToAsset(
  shares: BigNumber,
  balance: BigNumber,
  supply: BigNumber,
  virtualAsset: BigNumber = VIRTUAL_ASSET
): BigNumber {
  const out = shares
    .mul(balance.add(virtualAsset))
    .div(supply.add(VIRTUAL_SHARES));

  return out.gt(balance) ? balance : out;
}

export function absDiff(a: BigNumber, b: BigNumber): BigNumber {
  return a.gte(b) ? a.sub(b) : b.sub(a);
}

export function sqrtBN(x: BigNumber): BigNumber {
  if (x.isZero()) return BigNumber.from(0);

  let z = x.add(1).div(2);
  let y = x;

  while (z.lt(y)) {
    y = z;
    z = x.div(z).add(z).div(2);
  }

  return y;
}

export function normalizeTo18(amount: BigNumber, decimals: number): BigNumber {
  if (decimals === 18) return amount;

  if (decimals < 18) {
    return amount.mul(BigNumber.from(10).pow(18 - decimals));
  }

  return amount.div(BigNumber.from(10).pow(decimals - 18));
}

export function assetToShares(
  amount: BigNumber,
  balance: BigNumber,
  supply: BigNumber,
  virtualAsset: BigNumber = VIRTUAL_ASSET
): BigNumber {
  return amount
    .mul(supply.add(VIRTUAL_SHARES))
    .div(balance.add(virtualAsset));
}

export function mulDivUp(x: BigNumber, y: BigNumber, denominator: BigNumber): BigNumber {
  if (x.isZero() || y.isZero()) return BigNumber.from(0);

  const product = x.mul(y);
  const z = product.div(denominator);

  return product.mod(denominator).isZero() ? z : z.add(1);
}

export function expectedDepositPreview(
  baseMax: BigNumber,
  quoteMax: BigNumber,
  baseBal: BigNumber,
  quoteBal: BigNumber,
  supply: BigNumber
) {
  const sharesByBase = assetToShares(baseMax, baseBal, supply);
  const sharesByQuote = assetToShares(quoteMax, quoteBal, supply);

  const sharesOut = sharesByBase.lt(sharesByQuote) ? sharesByBase : sharesByQuote;

  if (sharesOut.isZero()) {
    return {
      baseIn: BigNumber.from(0),
      quoteIn: BigNumber.from(0),
      sharesOut,
      sharesByBase,
      sharesByQuote,
    };
  }

  const denom = supply.add(VIRTUAL_SHARES);

  const baseIn = mulDivUp(sharesOut, baseBal.add(VIRTUAL_ASSET), denom);
  const quoteIn = mulDivUp(sharesOut, quoteBal.add(VIRTUAL_ASSET), denom);

  return {
    baseIn,
    quoteIn,
    sharesOut,
    sharesByBase,
    sharesByQuote,
  };
}

export function expectedInitialShares(
  baseAmount: BigNumber,
  quoteAmount: BigNumber,
  baseDecimals = 8,
  quoteDecimals = 8
): BigNumber {
  const baseNorm = normalizeTo18(baseAmount, baseDecimals);
  const quoteNorm = normalizeTo18(quoteAmount, quoteDecimals);
  return sqrtBN(baseNorm.mul(quoteNorm));
}

export function bnAbs(a: BigNumber, b: BigNumber): BigNumber {
  return a.gte(b) ? a.sub(b) : b.sub(a);
}