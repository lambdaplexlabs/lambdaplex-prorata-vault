# Lambdaplex Pro-Rata Vault

Solidity smart contracts for the Lambdaplex **oracle-free pro-rata pair vault** system on Hedera EVM.

This vault design is intended for emerging token pairs, such as **PLEX/USDC**, where a reliable on-chain oracle feed may not yet exist.

Unlike the Lambdaplex balanced vault, the pro-rata vault does **not** price BASE in QUOTE terms and does **not** attempt to keep the vault 50/50 by value. Instead, shares represent a proportional claim on the vault’s current inventory of both assets.

Core contracts:
- **`PLEXProRataVault`** — oracle-free two-asset vault with pro-rata deposits, pro-rata withdrawals, deposit lots, lockups, streaming rewards, management fee share-minting, and emergency mode.
- **`AirdropDistributor`** — custody and accounting contract for reward tokens; pays user claims on behalf of vaults.
- **`PLEXVaultHook`** — Hiero Hook installed to the smart contract at deployment time or with the Hedera admin key.
- **Mocks** — `ERC20Mock`, bad reward token mocks, distributor mocks, etc. for local testing.

> ⚠️ This repo is intended for audit and production deployment review. Always run the full test suite and review the security assumptions below before deploying.

---

## High-level architecture

### 1) PLEXProRataVault

A pro-rata vault holds two assets:

- **BASE**: ERC-20 or native HBAR (`address(0)`)
- **QUOTE**: ERC-20 or native HBAR (`address(0)`)

Users receive **shares** representing a pro-rata claim on the vault’s current token inventory.

If the vault holds:

```text
1,000,000 PLEX
50,000 USDC
```

and a user owns 10% of shares, that user owns a claim on approximately:

```text
100,000 PLEX
5,000 USDC
```

No price oracle is used to determine this claim.

---

## Key design difference from the balanced vault

The balanced vault uses an oracle to maintain and enforce value-aware behavior:

```text
50% BASE value / 50% QUOTE value
```

The pro-rata vault does not.

Instead, it enforces:

```text
Deposits follow the current inventory ratio.
Withdrawals return the current inventory ratio.
```

This means the pro-rata vault should be presented as a:

```text
market-making inventory vault
```

or:

```text
oracle-free pro-rata inventory vault
```

not as a value-balanced vault.

---

## Vault lifecycle

### 1) Deployment

The vault is deployed with configuration values such as:

- BASE token
- QUOTE token
- distributor address
- manager address
- initial owner fee bips
- vesting duration
- lockup duration
- fee-change delay

The vault starts uninitialized.

### 2) Initialization

The vault must be initialized once by the vault owner or manager:

```solidity
initialize(
    uint256 baseAmount,
    uint256 quoteAmount,
    uint256 minSharesOut,
    address receiver,
    uint64 deadline
)
```

Initialization creates the first deposit lot and defines the initial BASE/QUOTE inventory ratio.

The first share supply is calculated using a geometric mean:

```text
initialShares = sqrt(normalizedBaseAmount * normalizedQuoteAmount)
```

Both assets are normalized to 18 decimals before this calculation.

### 3) Public deposits

After initialization, users deposit with:

```solidity
depositProRata(
    uint256 baseMax,
    uint256 quoteMax,
    uint256 minSharesOut,
    uint64 deadline
)
```

The user provides maximum amounts for BASE and QUOTE. The vault accepts the largest deposit possible that matches the current vault inventory ratio.

For example, if the vault holds:

```text
2,000 BASE
1,000 QUOTE
```

the current ratio is:

```text
2 BASE : 1 QUOTE
```

If a user provides caps of:

```text
200 BASE
200 QUOTE
```

the vault accepts approximately:

```text
200 BASE
100 QUOTE
```

and leaves the excess QUOTE with the user.

### 4) Withdrawals

Users withdraw from individual deposit lots:

```solidity
withdrawFromDeposit(
    uint256 depositId,
    uint256 sharesToBurn,
    uint256 minBaseOut,
    uint256 minQuoteOut,
    uint64 deadline
)
```

Withdrawals return pro-rata BASE and QUOTE inventory based on the number of shares burned.

---

## Share accounting

The vault tracks:

- `totalShares`
- `userShares[user]`
- `ownerFeeShares`
- individual `Deposit` lots

Each deposit lot stores:

```solidity
struct Deposit {
    address user;
    uint96 shares;
    uint64 createdAt;
    uint64 lockupUntil;
    uint8 state;
}
```

Deposit IDs are not reused. When a lot is fully withdrawn, the lot is deleted and removed from the user’s deposit list.

---

## Virtual offset mitigation

The vault uses an ERC-4626-style virtual offset for post-initialization deposit and withdrawal conversions.

Conceptually:

```text
shares = amount * (totalShares + VIRTUAL_SHARES) / (tokenBalance + VIRTUAL_ASSET)

amount = shares * (tokenBalance + VIRTUAL_ASSET) / (totalShares + VIRTUAL_SHARES)
```

This helps mitigate first-depositor / donation-style rounding attacks.

Current constants:

```solidity
VIRTUAL_SHARES = 1e3
VIRTUAL_BASE = 1
VIRTUAL_QUOTE = 1
```

These are virtual values only. They are not real minted shares and do not receive rewards.

---

## Deposit policy

The pro-rata vault does not accept arbitrary token mixes after initialization.

Deposits are based on the current inventory ratio.

The vault computes:

```text
sharesByBase  = baseMax  * (totalShares + VIRTUAL_SHARES) / (baseBalance + VIRTUAL_BASE)
sharesByQuote = quoteMax * (totalShares + VIRTUAL_SHARES) / (quoteBalance + VIRTUAL_QUOTE)

sharesOut = min(sharesByBase, sharesByQuote)
```

Then the required BASE and QUOTE amounts are calculated from `sharesOut`.

This means the limiting side determines the actual deposit.

---

## Withdrawal policy

Normal withdrawals use the same virtual-offset model in reverse:

```text
baseOut  = shares * (baseBalance + VIRTUAL_BASE) / (totalShares + VIRTUAL_SHARES)
quoteOut = shares * (quoteBalance + VIRTUAL_QUOTE) / (totalShares + VIRTUAL_SHARES)
```

Emergency withdrawals use strict raw pro-rata accounting:

```text
baseOut  = baseBalance  * shares / totalShares
quoteOut = quoteBalance * shares / totalShares
```

---

## Management fee

The vault implements a continuous management fee by minting fee shares to `ownerFeeShares`.

Important details:

- Fee rate is capped by `MAX_OWNER_FEE_BIPS`.
- Fee changes must be scheduled and become active only after `feeChangeDelaySecs`.
- Fee shares are included in `totalShares`.
- Fee shares are excluded from airdrop eligibility.
- Management fees do not accrue when there are no depositor shares.

The relevant eligible-share calculation is:

```solidity
eligibleShares = totalShares - ownerFeeShares
```

---

## Streaming rewards / airdrops

The vault supports streaming reward tokens through `AirdropDistributor`.

Reward behavior:

- Rewards are funded through the distributor.
- The distributor calls:

```solidity
onAirdropFunded(address rewardToken, uint256 netAmount)
```

- Rewards stream over `vestingSecs`.
- Reward accounting uses cumulative `perShare`.
- Users can claim one reward token:

```solidity
claimRewards(address rewardToken)
```

- Or claim all reward tokens:

```solidity
claimAllRewards()
```

The vault excludes `ownerFeeShares` from the reward denominator so management fee shares do not earn airdrops.

If `claimAllRewards()` fails for one reward token, the vault emits:

```solidity
RewardClaimFailed(rewardToken, user, amount)
```

and leaves the accrued amount intact for retry.

---

## AirdropDistributor

The distributor:

- holds reward tokens
- tracks `credited[vault][token]`
- tracks `claimed[vault][token]`
- only allows funding with approved reward tokens
- pays claims when called by the vault

Important functions:

```solidity
fund(address vault, address token, uint256 amount)
claimTo(address token, address to, uint256 amount)
remaining(address vault, address token)
modifyAllowed(address token, bool allowed)
```

The vault calls:

```solidity
distributor.claimTo(token, user, amount)
```

The distributor uses `msg.sender` as the vault whose credited balance is being spent.

---

## Emergency mode

Emergency mode is one-way.

It can be enabled by:

- the vault owner, or
- the distributor owner, if the distributor supports `owner()`

Once enabled:

- normal deposits are disabled
- emergency withdrawals become available
- emergency withdrawals ignore deposit lockup
- emergency withdrawals return strict raw pro-rata BASE and QUOTE balances

Emergency withdrawal:

```solidity
emergencyWithdrawFromDeposit(uint256 depositId)
```

Owner emergency fee redemption:

```solidity
ownerRedeemFeesEmergency(uint256 feeSharesToBurn)
```

---

## Native HBAR support

Either BASE or QUOTE may be native HBAR using:

```solidity
address(0)
```

For HBAR deposits:

- `msg.value` is treated as a maximum funding amount
- the vault uses only the required HBAR
- any excess HBAR is refunded to the caller

For HBAR withdrawals:

- the vault transfers native HBAR directly to the receiver

---

## Important product assumptions

### No oracle

This vault does not use Supra or any other oracle.

It cannot determine whether:

```text
1 PLEX = 0.05 USDC
```

or:

```text
1 PLEX = 0.10 USDC
```

Therefore it cannot maintain a 50/50 value balance.

### Deposits follow inventory ratio

Users must deposit in the current vault inventory ratio.

If the vault has become heavily skewed through market-making activity, new users deposit into that skewed inventory.

### Withdrawals return inventory ratio

Users withdraw their share of whatever the vault currently holds.

They may receive a different token mix than they originally deposited.

### Market-making risk remains

The vault accounting is pro-rata and oracle-free, but the vault’s inventory can still gain or lose value due to:

- market maker performance
- external trading
- token price movement
- inventory skew
- manager-controlled strategy actions

### Vault can become inactive if fully emptied

This vault is intentionally not reinitializable.

If all shares are burned and the vault loses its inventory ratio, public deposits may become permanently unavailable.

The vault owner/operator is responsible for avoiding full depletion if they want the vault to remain active.

---

## Security model & assumptions

This is a non-exhaustive checklist for auditors and reviewers.

### Token behavior

- ERC-20 tokens are expected to behave normally.
- Fee-on-transfer tokens are rejected in deposit paths using balance-delta checks.
- Native HBAR is supported through `address(0)`.

### Reentrancy

The vault uses OpenZeppelin-style `nonReentrant` protection.

Sensitive functions include:

- `initialize`
- `depositProRata`
- `withdrawFromDeposit`
- `emergencyWithdrawFromDeposit`
- `claimRewards`
- `claimAllRewards`
- `ownerRedeemFees`
- `ownerRedeemFeesEmergency`

### Initialization

- Only owner or manager can initialize.
- Initialization can happen only once.
- The initializer defines the starting inventory ratio.
- Pre-initialization direct token transfers are included in the initial basket.

### Rewards

- Rewards accrue only to eligible depositor shares.
- Owner fee shares do not receive rewards.
- Users who join mid-stream are checkpointed so they cannot earn past rewards.
- Users who exit to zero shares and re-enter later are checkpointed to prevent reward stealing.

### Management fees

- Fee changes are delayed.
- Fees accrue only when there are depositor shares.
- Owner fee shares are redeemable for pro-rata inventory.
- If only owner fee shares remain, further fee accrual does not self-compound.

### Emergency mode

- Emergency mode is one-way.
- Emergency withdrawals ignore lockup.
- Emergency withdrawals use strict raw pro-rata accounting.

---

## Testing

Run the full test suite before deployment.

```bash
npx hardhat test
```

Run a specific test file:

```bash
npx hardhat test test/PLEXVaultTest.spec.ts
```

Common test categories:

```text
Initialization
Deposits
Withdrawals
Deposit lot storage
Management fees
Airdrop rewards
Reward anti-steal fuzz tests
Emergency mode
HBAR deposit/withdraw behavior
Virtual offset / donation mitigation
```

---

## Install / Build / Test

### Prerequisites

- Node.js LTS recommended
- Yarn or npm
- Hardhat

### Install dependencies

```bash
yarn install
```

or:

```bash
npm install
```

### Compile

```bash
npx hardhat compile
```

### Test

```bash
npx hardhat test
```

---

## Suggested repository layout

```text
contracts/
  PLEXProRataVault.sol
  AirdropDistributor.sol
  hooks/
    PLEXVaultHook.sol
  mocks/
    ERC20Mock.sol
    BadRewardToken.sol

interfaces/
  IERC20.sol
  IAirdropDistributor.sol

libraries/
  SafeERC20.sol
  PRBMathCommon.sol

test/
  PLEXVaultTest.spec.ts
  AirdropDistributor.spec.ts

typechain-types/
```

---

## Licensing

The primary license for the Lambdaplex pro-rata vault contracts is the MIT License (`MIT`).
