import { BigNumber } from 'ethers'

export const MaxUint128 = BigNumber.from(2).pow(128).sub(1)
export const MaxInt64 = BigNumber.from(2).pow(63).sub(1)
export const ONE = BigNumber.from(10).pow(8); // token decimals = 8
export const ONE_18 = BigNumber.from(10).pow(18);
export const VIRTUAL_SHARES = BigNumber.from(1_000);
export const VIRTUAL_ASSET = BigNumber.from(1);