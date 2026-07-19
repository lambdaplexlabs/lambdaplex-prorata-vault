// test/Vault.test.ts
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { BigNumber, Signer } from "ethers";
import { AirdropDistributor, ERC20Mock, PLEXProRataVault } from "../typechain-types";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { ONE, VIRTUAL_ASSET, VIRTUAL_SHARES } from "./shared/constants";
import { absDiff, assetToShares, bnAbs, expectedDepositPreview, expectedInitialShares, mulDivUp, normalizeTo18, sharesToAsset, sqrtBN } from "./shared/Helpers";

describe("Vault", () => {
  let deployer: Signer;
  let alice: Signer;
  let bob: Signer;

  let token0: ERC20Mock;
  let token1: ERC20Mock;
  let distributor: AirdropDistributor;
  let vault: PLEXProRataVault;

  let initOwnerBips = 0;

  const INITIAL_MINT = 1_000_000_000;
  const WEEK_SECS = 7 * 24 * 60 * 60;
  const DAY_SECS = 24 * 60 * 60;
  const DEC = BigNumber.from(8)

  async function increaseTime(seconds: number) {
    await network.provider.send("evm_increaseTime", [seconds]);
    await network.provider.send("evm_mine");
  }

  async function setNextBlockTimestamp(ts: number) {
    await network.provider.send("evm_setNextBlockTimestamp", [ts]);
    await network.provider.send("evm_mine");
  }

  // for integer rounding for equality checks
  function isWithinOne(a: BigNumber, b: BigNumber): boolean {
    const absDiff =  a.gte(b) ? a.sub(b) : b.sub(a);
    return absDiff <= BigNumber.from(1);
  }

  beforeEach(async () => {
    [deployer, alice, bob] = await ethers.getSigners();
    const deployerAddr = await deployer.getAddress();

    // ---------- Deploy mock underlying tokens ----------
    const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");
    token0 = (await ERC20MockFactory.deploy("Token0", "TK0", 8, INITIAL_MINT)) as ERC20Mock;
    await token0.deployed();

    const ERC20MockFactory2 = await ethers.getContractFactory("ERC20Mock");
    token1 = (await ERC20MockFactory2.deploy("Token1", "TK1", 8, INITIAL_MINT)) as ERC20Mock;
    await token1.deployed();

    // ---------- Deploy distributor ----------
    const Distributor = await ethers.getContractFactory("AirdropDistributor");
    distributor = (await Distributor.deploy()) as AirdropDistributor;
    await distributor.deployed();

    // ---------- Deploy vault ----------
    const Vault = await ethers.getContractFactory("PLEXProRataVault");
    vault = (await Vault.deploy(
      token0.address,
      token1.address,
      distributor.address,
      deployer.getAddress(),
      initOwnerBips,
      WEEK_SECS,
      DAY_SECS,
      WEEK_SECS
    )) as PLEXProRataVault;
    await vault.deployed();

  });

  describe("deployment", () => {
    it("sets token0 correctly", async () => {
      expect(await token0.name()).to.equal("Token0");
      expect(await token0.symbol()).to.equal("TK0");
      expect(await token0.decimals()).to.equal(8);
      expect(await token0.totalSupply()).to.equal(BigNumber.from(10).pow(17));
    });
    it("sets token1 correctly", async () => {
      expect(await token1.name()).to.equal("Token1");
      expect(await token1.symbol()).to.equal("TK1");
      expect(await token1.decimals()).to.equal(8);
      expect(await token1.totalSupply()).to.equal(BigNumber.from(10).pow(17));
    });
    it("sets vault correctly", async () => {
      expect(await vault.BASE()).to.equal(token0.address);
      expect(await vault.QUOTE()).to.equal(token1.address);
      expect(await vault.distributor()).to.equal(distributor.address);
    });

    it("disables ownership renunciation", async () => {
      const ownerBefore = await vault.owner();

      await expect(vault.renounceOwnership()).to.be.revertedWithCustomError(
        vault,
        "OwnershipRenunciationDisabled"
      );

      expect(await vault.owner()).to.equal(ownerBefore);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────
  describe("initialization", () => {

    function expectedInitialShares(
      baseAmount: BigNumber,
      quoteAmount: BigNumber,
      baseDecimals = 8,
      quoteDecimals = 8
    ): BigNumber {
      const baseNorm = normalizeTo18(baseAmount, baseDecimals);
      const quoteNorm = normalizeTo18(quoteAmount, quoteDecimals);

      return sqrtBN(baseNorm.mul(quoteNorm));
    }

    async function futureDeadline(seconds = 3600): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp + seconds;
    }

    async function expiredDeadline(): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp - 1;
    }

    async function deployFreshVault(managerAddr?: string): Promise<PLEXProRataVault> {
      const deployerAddr = await deployer.getAddress();

      const Vault = await ethers.getContractFactory("PLEXProRataVault");
      const freshVault = (await Vault.deploy(
        token0.address,
        token1.address,
        distributor.address,
        managerAddr ?? deployerAddr,
        initOwnerBips,
        WEEK_SECS,
        DAY_SECS,
        WEEK_SECS
      )) as PLEXProRataVault;

      await freshVault.deployed();
      return freshVault;
    }

    async function approveFrom(
      signer: Signer,
      vaultAddr: string,
      baseAmount: BigNumber,
      quoteAmount: BigNumber
    ) {
      await token0.connect(signer).approve(vaultAddr, baseAmount);
      await token1.connect(signer).approve(vaultAddr, quoteAmount);
    }

    it("only manager/owner can initialize", async () => {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      const baseAmount = ethers.utils.parseUnits("1000", 8);
      const quoteAmount = ethers.utils.parseUnits("1000", 8);

      // Vault where Bob is manager, deployer is owner.
      const ownerOrBobVault = await deployFreshVault(bobAddr);

      // Alice is neither owner nor manager.
      await expect(
        ownerOrBobVault.connect(alice).initialize(
          baseAmount,
          quoteAmount,
          0,
          aliceAddr,
          await futureDeadline()
        )
      ).to.be.revertedWith("not manager/owner");

      // Owner can initialize.
      await approveFrom(deployer, ownerOrBobVault.address, baseAmount, quoteAmount);

      await expect(
        ownerOrBobVault.connect(deployer).initialize(
          baseAmount,
          quoteAmount,
          0,
          aliceAddr,
          await futureDeadline()
        )
      ).to.emit(ownerOrBobVault, "VaultInitialized");

      // Separate fresh vault where Alice is manager.
      const managerVault = await deployFreshVault(aliceAddr);

      // Give Alice funds and approvals.
      await token0.transfer(aliceAddr, baseAmount);
      await token1.transfer(aliceAddr, quoteAmount);
      await approveFrom(alice, managerVault.address, baseAmount, quoteAmount);

      // Manager can initialize.
      await expect(
        managerVault.connect(alice).initialize(
          baseAmount,
          quoteAmount,
          0,
          aliceAddr,
          await futureDeadline()
        )
      ).to.emit(managerVault, "VaultInitialized");

      expect(await managerVault.initialized()).to.equal(true);
    });

    it("initialize can only happen once", async () => {
      const aliceAddr = await alice.getAddress();

      const baseAmount = ethers.utils.parseUnits("1000", 8);
      const quoteAmount = ethers.utils.parseUnits("1000", 8);

      const freshVault = await deployFreshVault();

      await approveFrom(deployer, freshVault.address, baseAmount.mul(2), quoteAmount.mul(2));

      await freshVault.connect(deployer).initialize(
        baseAmount,
        quoteAmount,
        0,
        aliceAddr,
        await futureDeadline()
      );

      expect(await freshVault.initialized()).to.equal(true);

      await expect(
        freshVault.connect(deployer).initialize(
          baseAmount,
          quoteAmount,
          0,
          aliceAddr,
          await futureDeadline()
        )
      ).to.be.revertedWith("already initialized");
    });

    it("initializes share supply using geometric mean", async () => {
      const aliceAddr = await alice.getAddress();

      // Unequal amounts make the geometric mean obvious:
      // sqrt(1000 * 250) = 500, after both are normalized to 18 decimals.
      const baseAmount = ethers.utils.parseUnits("1000", 8);
      const quoteAmount = ethers.utils.parseUnits("250", 8);

      const freshVault = await deployFreshVault();

      await approveFrom(deployer, freshVault.address, baseAmount, quoteAmount);

      const expectedShares = expectedInitialShares(baseAmount, quoteAmount, 8, 8);
      expect(expectedShares).to.equal(ethers.utils.parseUnits("500", 18));

      await expect(
        freshVault.connect(deployer).initialize(
          baseAmount,
          quoteAmount,
          expectedShares,
          aliceAddr,
          await futureDeadline()
        )
      )
        .to.emit(freshVault, "VaultInitialized")
        .withArgs(
          await deployer.getAddress(),
          aliceAddr,
          baseAmount,
          quoteAmount,
          baseAmount,
          quoteAmount,
          expectedShares
        );

      expect(await freshVault.totalShares()).to.equal(expectedShares);
      expect(await freshVault.userShares(aliceAddr)).to.equal(expectedShares);
    });

    it("creates first deposit lot", async () => {
      const aliceAddr = await alice.getAddress();

      const baseAmount = ethers.utils.parseUnits("1000", 8);
      const quoteAmount = ethers.utils.parseUnits("1000", 8);

      const freshVault = await deployFreshVault();

      await approveFrom(deployer, freshVault.address, baseAmount, quoteAmount);

      const expectedShares = expectedInitialShares(baseAmount, quoteAmount, 8, 8);

      await expect(
        freshVault.connect(deployer).initialize(
          baseAmount,
          quoteAmount,
          0,
          aliceAddr,
          await futureDeadline()
        )
      )
        .to.emit(freshVault, "DepositedProRata")
        .withArgs(
          aliceAddr,
          BigNumber.from(0),
          baseAmount,
          quoteAmount,
          expectedShares,
          BigNumber.from(0),
          BigNumber.from(0)
        );

      expect(await freshVault.depositsLength()).to.equal(1);

      const deposits = await freshVault.depositsOf(aliceAddr);
      expect(deposits.length).to.equal(1);
      expect(deposits[0]).to.equal(0);

      const dep = await freshVault.deposits(0);
      expect(dep.user).to.equal(aliceAddr);
      expect(dep.shares).to.equal(expectedShares);
      expect(dep.state).to.equal(0); // ACTIVE

      const lockupSecs = await freshVault.lockupSecs();
      expect(dep.lockupUntil).to.equal(dep.createdAt.add(lockupSecs));
    });

    it("refunds excess HBAR", async () => {
      const aliceAddr = await alice.getAddress();

      const baseAmount = ethers.utils.parseUnits("100", 8); // HBAR side
      const quoteAmount = ethers.utils.parseUnits("100", 8);
      const excessHBAR = ethers.utils.parseUnits("7", 8);

      const Vault = await ethers.getContractFactory("PLEXProRataVault");
      const hbarVault = (await Vault.deploy(
        ethers.constants.AddressZero, // BASE = HBAR
        token1.address,               // QUOTE = token1
        distributor.address,
        await deployer.getAddress(),  // manager
        initOwnerBips,
        WEEK_SECS,
        DAY_SECS,
        WEEK_SECS
      )) as PLEXProRataVault;

      await hbarVault.deployed();

      await token1.connect(deployer).approve(hbarVault.address, quoteAmount);

      const expectedShares = expectedInitialShares(baseAmount, quoteAmount, 8, 8);

      await expect(
        hbarVault.connect(deployer).initialize(
          baseAmount,
          quoteAmount,
          0,
          aliceAddr,
          await futureDeadline(),
          { value: baseAmount.add(excessHBAR) }
        )
      )
        .to.emit(hbarVault, "VaultInitialized")
        .withArgs(
          await deployer.getAddress(),
          aliceAddr,
          baseAmount,
          quoteAmount,
          baseAmount,
          quoteAmount,
          expectedShares
        );

      // If excess HBAR was not refunded, this would equal baseAmount + excessHBAR.
      const vaultHBARBalance = await ethers.provider.getBalance(hbarVault.address);
      expect(vaultHBARBalance).to.equal(baseAmount);

      const vaultQuoteBalance = await token1.balanceOf(hbarVault.address);
      expect(vaultQuoteBalance).to.equal(quoteAmount);

      expect(await hbarVault.totalShares()).to.equal(expectedShares);
      expect(await hbarVault.userShares(aliceAddr)).to.equal(expectedShares);
    });

    it("rejects zero amounts", async () => {
      const aliceAddr = await alice.getAddress();

      const baseAmount = ethers.utils.parseUnits("1000", 8);
      const quoteAmount = ethers.utils.parseUnits("1000", 8);

      const freshVaultA = await deployFreshVault();

      await expect(
        freshVaultA.connect(deployer).initialize(
          0,
          quoteAmount,
          0,
          aliceAddr,
          await futureDeadline()
        )
      ).to.be.revertedWith("amount=0");

      const freshVaultB = await deployFreshVault();

      await expect(
        freshVaultB.connect(deployer).initialize(
          baseAmount,
          0,
          0,
          aliceAddr,
          await futureDeadline()
        )
      ).to.be.revertedWith("amount=0");
    });

    it("rejects expired deadline", async () => {
      const aliceAddr = await alice.getAddress();

      const baseAmount = ethers.utils.parseUnits("1000", 8);
      const quoteAmount = ethers.utils.parseUnits("1000", 8);

      const freshVault = await deployFreshVault();

      await expect(
        freshVault.connect(deployer).initialize(
          baseAmount,
          quoteAmount,
          0,
          aliceAddr,
          await expiredDeadline()
        )
      ).to.be.revertedWith("expired");
    });
  });
  // ─────────────────────────────────────────────────────────────
  // Admin: scheduleOwnerFeeBips
  // ─────────────────────────────────────────────────────────────
  describe("admin: scheduleOwnerFeeBips", () => {
    it("only owner can schedule and enforces max cap", async () => {
      // non-owner blocked
      await expect(
        vault.connect(alice).scheduleOwnerFeeBips(1000)
      )
        .to.be.revertedWithCustomError(
          vault,
          "OwnableUnauthorizedAccount"
        )
        .withArgs(await alice.getAddress());

      // above cap (0.3% / week) blocked
      await expect(
        vault.scheduleOwnerFeeBips(3001)
      ).to.be.revertedWith("rate>0.3%");
    });

    it("schedules fee with 1-week delay and enforces cooldown", async () => {
      // schedule first change
      const tx = await vault.scheduleOwnerFeeBips(1500);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      if (!block) throw new Error("block not found");

      const nowTs = block.timestamp;
      const expectedEffectiveTs = nowTs + WEEK_SECS;

      // check storage
      expect(await vault.pendingOwnerFeeBips()).to.equal(1500);
      expect(await vault.pendingOwnerFeeTs()).to.equal(expectedEffectiveTs);
      expect(await vault.lastFeeChangeTs()).to.equal(nowTs);

      // event
      await expect(tx)
        .to.emit(vault, "OwnerFeeRateScheduled")
        .withArgs(1500, expectedEffectiveTs);

      // cooldown: cannot change again within <1 week
      await expect(
        vault.scheduleOwnerFeeBips(1000)
      ).to.be.revertedWith("fee change cooldown");

      // move time forward >1 week and schedule again
      await increaseTime(WEEK_SECS + 1);

      const tx2 = await vault.scheduleOwnerFeeBips(500);
      const receipt2 = await tx2.wait();

      // second schedule should update pending params
      const block2 = await ethers.provider.getBlock(receipt2.blockNumber);
      if (!block2) throw new Error("block2 not found");
      const expectedEffectiveTs2 = block2.timestamp + WEEK_SECS;

      expect(await vault.pendingOwnerFeeBips()).to.equal(500);
      expect(await vault.pendingOwnerFeeTs()).to.equal(expectedEffectiveTs2);
      expect(await vault.lastFeeChangeTs()).to.equal(block2.timestamp);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // View: ownerFeeInfo
  // ─────────────────────────────────────────────────────────────
  describe("view: ownerFeeInfo", () => {
    it("initial values", async () => {
      const info = await vault.ownerFeeInfo();

      expect(info.currentBips).to.equal(initOwnerBips);
      expect(info.pendingBips).to.equal(0);
      expect(info.pendingEffectiveTs).to.equal(0);
      expect(info.lastChangeTs).to.equal(0);
      // lastAccrualTs is set in constructor to deploy time, just assert > 0
      expect(info.lastAccrualTs).to.be.gt(0);
      expect(info.feeShares).to.equal(0);
    });

    it("reflects scheduled fee as pending and flips currentBips after effectiveTs", async () => {
      // schedule 0.1% / week
      const tx = await vault.scheduleOwnerFeeBips(1001);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      if (!block) throw new Error("block not found");

      const scheduledTs = block.timestamp;
      const effectiveTs = scheduledTs + WEEK_SECS;

      // Immediately after scheduling:
      let info = await vault.ownerFeeInfo();
      // storage ownerFeeBips is still 0, so currentBips is 0
      expect(info.currentBips).to.equal(initOwnerBips);
      expect(info.pendingBips).to.equal(1001);
      expect(info.pendingEffectiveTs).to.equal(effectiveTs);
      expect(info.lastChangeTs).to.equal(scheduledTs);

      // Just before effective timestamp: still sees old rate
      await setNextBlockTimestamp(effectiveTs - 1);
      info = await vault.ownerFeeInfo();
      expect(info.currentBips).to.equal(initOwnerBips);

      // After effective timestamp: view treats pending as current,
      // even if storage ownerFeeBips hasn't been updated by _accrueMgmtFee yet.
      await setNextBlockTimestamp(effectiveTs + 1);
      info = await vault.ownerFeeInfo();
      expect(info.currentBips).to.equal(1001);
      expect(info.pendingBips).to.equal(1001);
      expect(info.pendingEffectiveTs).to.equal(effectiveTs);

      // Direct storage check: ownerFeeBips is still 0 until some mutating
      // call triggers _accrueMgmtFee (this is expected).
      const storedRate = await vault.ownerFeeBips();
      expect(storedRate).to.equal(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Management fee
  // ─────────────────────────────────────────────────────────────
  describe("management fee accrual", () => {

    async function futureDeadline(seconds = 3600): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp + seconds;
    }
    /**
     * helper:
     *  - owner initializes the vault with Alice as receiver
     *  - owner schedules a new feeBips
     *  - we time-travel until the new rate is active
     *  - we impersonate the distributor to call onAirdropFunded
     *    which triggers _accrueMgmtFee and mints ownerFeeShares
     */
    async function setupVaultWithAccruedFees(newBips: number = 1_000) {
      const aliceAddr = await alice.getAddress();

      const depositAmount = ONE.mul(1_000); // 1000 units on each side

      // Owner/deployer initializes the vault, with Alice receiving the initial shares.
      await token0.connect(deployer).approve(vault.address, depositAmount);
      await token1.connect(deployer).approve(vault.address, depositAmount);

      const initDeadline = await futureDeadline();

      await vault.connect(deployer).initialize(
        depositAmount,
        depositAmount,
        0,          // minSharesOut
        aliceAddr,  // receiver
        initDeadline
      );

      const depositorShares = await vault.userShares(aliceAddr);
      expect(depositorShares).to.be.gt(0);

      const totalBeforeAccrual = await vault.totalShares();
      expect(totalBeforeAccrual).to.equal(depositorShares);

      // Schedule a new owner fee rate.
      const tx = await vault.scheduleOwnerFeeBips(newBips);
      const rcpt = await tx.wait();
      const block = await ethers.provider.getBlock(rcpt!.blockNumber);
      if (!block) throw new Error("block not found");

      const feeDelay = (await vault.feeChangeDelaySecs()).toNumber();
      const effectiveTs = block.timestamp + feeDelay;

      // Jump to when that rate is active, plus one day of active accrual.
      await setNextBlockTimestamp(effectiveTs + DAY_SECS);

      // Impersonate the distributor and call onAirdropFunded to trigger _accrueMgmtFee.
      const distAddr = distributor.address;

      await network.provider.send("hardhat_setBalance", [
        distAddr,
        "0x8AC7230489E80000", // 10 ETH
      ]);

      await network.provider.send("hardhat_impersonateAccount", [distAddr]);
      const distSigner = await ethers.getSigner(distAddr);

      await vault.connect(distSigner).onAirdropFunded(token1.address, 1);

      await network.provider.send("hardhat_stopImpersonatingAccount", [distAddr]);

      const feeShares = await vault.ownerFeeShares();
      expect(feeShares).to.be.gt(0);

      return {
        depositAmount,
        totalBeforeAccrual,
        feeShares,
        depositorShares,
      };
    }

    it("accrues the notice window at the old rate at the exact effective timestamp", async () => {
      const aliceAddr = await alice.getAddress();
      const depositAmount = ONE.mul(1_000);

      await token0.connect(deployer).approve(vault.address, depositAmount);
      await token1.connect(deployer).approve(vault.address, depositAmount);
      await vault.connect(deployer).initialize(
        depositAmount,
        depositAmount,
        0,
        aliceAddr,
        await futureDeadline()
      );

      // The current rate is zero; the scheduled non-zero rate must only apply
      // to time strictly after its effective timestamp.
      await vault.scheduleOwnerFeeBips(3_000);
      const effectiveTs = (await vault.pendingOwnerFeeTs()).toNumber();

      await network.provider.send("hardhat_setBalance", [
        distributor.address,
        "0x8AC7230489E80000",
      ]);
      await network.provider.send("hardhat_impersonateAccount", [distributor.address]);
      const distributorSigner = await ethers.getSigner(distributor.address);

      await network.provider.send("evm_setNextBlockTimestamp", [effectiveTs]);
      await vault.connect(distributorSigner).onAirdropFunded(token1.address, 1);

      await network.provider.send("hardhat_stopImpersonatingAccount", [distributor.address]);

      expect(await vault.ownerFeeBips()).to.equal(3_000);
      expect(await vault.pendingOwnerFeeTs()).to.equal(0);
      expect(await vault.ownerFeeShares()).to.equal(0);
    });

    it("accrues owner fee shares once the scheduled rate becomes active", async () => {
      const {
        feeShares,
        depositorShares,
        totalBeforeAccrual,
      } = await setupVaultWithAccruedFees(2_000); // 0.2%/week

      const totalAfter = await vault.totalShares();

      expect(feeShares).to.be.gt(0);
      expect(totalAfter).to.be.gt(totalBeforeAccrual);

      // In the pro-rata vault there are no dead shares, so total = depositor shares + owner fee shares.
      expect(totalAfter).to.equal(depositorShares.add(feeShares));

      // Equivalent check: feeShares are exactly the increase in totalShares after setup accrual.
      expect(feeShares).to.equal(totalAfter.sub(totalBeforeAccrual));
    });

    it("ownerRedeemFees pays pro-rata BASE and QUOTE when inventory is balanced", async () => {
      const ownerAddr = await deployer.getAddress();

      await setupVaultWithAccruedFees(1_000);

      const feeSharesBefore = await vault.ownerFeeShares();
      expect(feeSharesBefore).to.be.gt(0);

      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const supplyBefore = await vault.totalShares();

      // Sanity: initialized with equal units.
      expect(baseBalBefore).to.equal(quoteBalBefore);

      const ownerBaseBefore = await token0.balanceOf(ownerAddr);
      const ownerQuoteBefore = await token1.balanceOf(ownerAddr);

      // Use MaxUint256 because ownerRedeemFees() accrues fees first, then clamps to available.
      await vault.connect(deployer).ownerRedeemFees(
        ethers.constants.MaxUint256,
        0,
        0
      );

      const ownerBaseAfter = await token0.balanceOf(ownerAddr);
      const ownerQuoteAfter = await token1.balanceOf(ownerAddr);

      const deltaBase = ownerBaseAfter.sub(ownerBaseBefore);
      const deltaQuote = ownerQuoteAfter.sub(ownerQuoteBefore);

      expect(deltaBase.add(deltaQuote)).to.be.gt(0);

      // Balanced inventory means pro-rata redemption should pay equal units,
      // allowing 1 unit due to integer rounding / possible 1-second fee accrual.
      expect(absDiff(deltaBase, deltaQuote).lte(1)).to.equal(true);

      const baseBalAfter = await token0.balanceOf(vault.address);
      const quoteBalAfter = await token1.balanceOf(vault.address);

      // Vault should remain balanced up to rounding.
      expect(absDiff(baseBalAfter, quoteBalAfter).lte(1)).to.equal(true);

      // Owner burned all currently available fee shares.
      expect(await vault.ownerFeeShares()).to.equal(0);

      // Optional sanity: balances decreased by what owner received.
      expect(baseBalAfter).to.equal(baseBalBefore.sub(deltaBase));
      expect(quoteBalAfter).to.equal(quoteBalBefore.sub(deltaQuote));

      // Optional loose expectation from virtual-offset formula using pre-redeem values.
      // Because ownerRedeemFees accrues internally, exact burn can be slightly larger
      // than feeSharesBefore if a later timestamp was mined. So don't use exact equality here.
      const roughExpectedBase = sharesToAsset(feeSharesBefore, baseBalBefore, supplyBefore);
      expect(deltaBase.gte(roughExpectedBase)).to.equal(true);
    });

    it("ownerRedeemFees pays proportional inventory when inventory is imbalanced", async () => {
      const ownerAddr = await deployer.getAddress();

      await setupVaultWithAccruedFees(1_000);

      const feeSharesBefore = await vault.ownerFeeShares();
      expect(feeSharesBefore).to.be.gt(0);

      // Introduce BASE-heavy inventory by donating extra BASE directly to the vault.
      // Use a meaningful amount so proportional output difference is visible after rounding.
      const extraBase = ONE.mul(100); // 100 TK0
      await token0.connect(deployer).transfer(vault.address, extraBase);

      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const supplyBefore = await vault.totalShares();

      expect(baseBalBefore).to.be.gt(quoteBalBefore);

      const imbalanceBefore = baseBalBefore.sub(quoteBalBefore);

      const ownerBaseBefore = await token0.balanceOf(ownerAddr);
      const ownerQuoteBefore = await token1.balanceOf(ownerAddr);

      await vault.connect(deployer).ownerRedeemFees(
        ethers.constants.MaxUint256,
        0,
        0
      );

      const ownerBaseAfter = await token0.balanceOf(ownerAddr);
      const ownerQuoteAfter = await token1.balanceOf(ownerAddr);

      const deltaBase = ownerBaseAfter.sub(ownerBaseBefore);
      const deltaQuote = ownerQuoteAfter.sub(ownerQuoteBefore);

      expect(deltaBase.add(deltaQuote)).to.be.gt(0);

      // In the pro-rata vault, redemption follows the inventory ratio.
      // Since BASE inventory is larger, owner should receive more BASE than QUOTE.
      expect(deltaBase).to.be.gt(deltaQuote);

      const baseBalAfter = await token0.balanceOf(vault.address);
      const quoteBalAfter = await token1.balanceOf(vault.address);

      expect(baseBalAfter).to.equal(baseBalBefore.sub(deltaBase));
      expect(quoteBalAfter).to.equal(quoteBalBefore.sub(deltaQuote));

      // Pro-rata redemption reduces absolute imbalance when the owner receives more BASE than QUOTE.
      const imbalanceAfter = baseBalAfter.sub(quoteBalAfter);
      expect(imbalanceAfter.lt(imbalanceBefore)).to.equal(true);

      expect(await vault.ownerFeeShares()).to.equal(0);

      // Optional loose expectation from pre-redeem virtual-offset formula.
      // Exact equality is avoided because ownerRedeemFees accrues again internally.
      const roughExpectedBase = sharesToAsset(feeSharesBefore, baseBalBefore, supplyBefore);
      const roughExpectedQuote = sharesToAsset(feeSharesBefore, quoteBalBefore, supplyBefore);

      expect(deltaBase.gte(roughExpectedBase)).to.equal(true);
      expect(deltaQuote.gte(roughExpectedQuote)).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Emergency mode
  // ─────────────────────────────────────────────────────────────
  describe("emergency mode", () => {

    async function futureDeadline(seconds = 3600): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp + seconds;
    }

    /**
     * Initializes the pro-rata vault with deployer funds and sends
     * the initial deposit shares to `receiver`.
     */
    async function initializeVaultFor(receiver: string, amount: BigNumber) {
      await token0.connect(deployer).approve(vault.address, amount);
      await token1.connect(deployer).approve(vault.address, amount);

      const deadline = await futureDeadline();

      const tx = await vault.connect(deployer).initialize(
        amount,
        amount,
        0,        // minSharesOut
        receiver,
        deadline
      );

      await tx.wait();

      expect(await vault.initialized()).to.equal(true);
    }

    it("only vault owner or distributor owner can enable, and it is one-way", async () => {
      const [deployerSigner, aliceSigner, bobSigner] = await ethers.getSigners();

      const deployerAddr = await deployerSigner.getAddress();
      const aliceAddr = await aliceSigner.getAddress();
      const bobAddr = await bobSigner.getAddress();

      // 1) Non-owner and not distributor owner cannot enable.
      await expect(
        vault.connect(aliceSigner).enableEmergencyMode()
      ).to.be.revertedWith("emergency: not authorized");

      // 2) Vault owner can enable.
      await expect(vault.connect(deployerSigner).enableEmergencyMode())
        .to.emit(vault, "EmergencyModeEnabled")
        .withArgs(deployerAddr);

      expect(await vault.emergencyMode()).to.equal(true);

      // 3) Cannot be enabled twice.
      await expect(
        vault.connect(deployerSigner).enableEmergencyMode()
      ).to.be.revertedWith("emergency: already enabled");

      // 4) Fresh setup: distributor owner, different from vault owner, can enable.
      const Distributor = await ethers.getContractFactory("AirdropDistributor");
      const distributor2 = (await Distributor.deploy()) as AirdropDistributor;
      await distributor2.deployed();

      const Vault = await ethers.getContractFactory("PLEXProRataVault");
      const vault2 = (await Vault.deploy(
        token0.address,
        token1.address,
        distributor2.address,
        deployerAddr,     // manager
        initOwnerBips,
        WEEK_SECS,
        DAY_SECS,
        WEEK_SECS
      )) as PLEXProRataVault;
      await vault2.deployed();

      // vault2 owner becomes Bob, distributor2 owner becomes Alice.
      await vault2.connect(deployerSigner).transferOwnership(bobAddr);
      await distributor2.connect(deployerSigner).transferOwnership(aliceAddr);

      // Alice is now distributor owner, so she may enable emergency mode.
      await expect(
        vault2.connect(aliceSigner).enableEmergencyMode()
      )
        .to.emit(vault2, "EmergencyModeEnabled")
        .withArgs(aliceAddr);

      expect(await vault2.emergencyMode()).to.equal(true);
    });

    it("blocks new deposits once emergency mode is enabled", async () => {
      const aliceAddr = await alice.getAddress();

      const initAmount = ONE.mul(1_000);
      await initializeVaultFor(await deployer.getAddress(), initAmount);

      // Fund Alice for a public pro-rata deposit attempt.
      const depositAmount = ONE.mul(100);

      await token0.transfer(aliceAddr, depositAmount);
      await token1.transfer(aliceAddr, depositAmount);

      await token0.connect(alice).approve(vault.address, depositAmount);
      await token1.connect(alice).approve(vault.address, depositAmount);

      // Deposit works before emergency.
      await vault.connect(alice).depositProRata(
        depositAmount,
        depositAmount,
        0, // minSharesOut
        await futureDeadline()
      );

      // Enable emergency.
      await vault.enableEmergencyMode();
      expect(await vault.emergencyMode()).to.equal(true);

      // Further deposits are blocked.
      await expect(
        vault.connect(alice).depositProRata(
          depositAmount,
          depositAmount,
          0,
          await futureDeadline()
        )
      ).to.be.revertedWith("emergency: deposits disabled");
    });

    it("emergencyWithdrawFromDeposit is disabled when not in emergency mode", async () => {
      const aliceAddr = await alice.getAddress();
      const initAmount = ONE.mul(500);

      await initializeVaultFor(aliceAddr, initAmount);

      const userDeps = await vault.depositsOf(aliceAddr);
      expect(userDeps.length).to.eq(1);

      const depId = userDeps[0];

      await expect(
        vault.connect(alice).emergencyWithdrawFromDeposit(depId)
      ).to.be.revertedWith("emergency: disabled");
    });

    it("emergencyWithdrawFromDeposit ignores lockup and pays strict pro-rata BASE/QUOTE", async () => {
      const aliceAddr = await alice.getAddress();

      const initAmount = ONE.mul(1_000);
      await initializeVaultFor(aliceAddr, initAmount);

      const userDeps = await vault.depositsOf(aliceAddr);
      expect(userDeps.length).to.eq(1);

      const depId = userDeps[0];

      const depBefore = await vault.deposits(depId);
      const shares = depBefore.shares;
      expect(shares).to.be.gt(0);

      // Lockup should still be active immediately after initialization.
      const nowBlock = await ethers.provider.getBlock("latest");
      expect(depBefore.lockupUntil).to.be.gt(nowBlock!.timestamp);

      // Enable emergency mode.
      await vault.enableEmergencyMode();
      expect(await vault.emergencyMode()).to.equal(true);

      // Snapshot vault balances and totalShares BEFORE emergency withdraw.
      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const totalSharesBefore = await vault.totalShares();

      // Expected strict raw pro-rata.
      const expectedBaseOut = baseBalBefore.mul(shares).div(totalSharesBefore);
      const expectedQuoteOut = quoteBalBefore.mul(shares).div(totalSharesBefore);

      const aliceBaseBefore = await token0.balanceOf(aliceAddr);
      const aliceQuoteBefore = await token1.balanceOf(aliceAddr);

      // Emergency withdraw should work even though lockup has not passed.
      await vault.connect(alice).emergencyWithdrawFromDeposit(depId);

      const aliceBaseAfter = await token0.balanceOf(aliceAddr);
      const aliceQuoteAfter = await token1.balanceOf(aliceAddr);

      const deltaBase = aliceBaseAfter.sub(aliceBaseBefore);
      const deltaQuote = aliceQuoteAfter.sub(aliceQuoteBefore);

      expect(deltaBase).to.equal(expectedBaseOut);
      expect(deltaQuote).to.equal(expectedQuoteOut);

      // User deposit list should now be empty.
      const depsAfter = await vault.depositsOf(aliceAddr);
      expect(depsAfter.length).to.eq(0);

      // Deposit record should be deleted.
      const depAfter = await vault.deposits(depId);
      expect(depAfter.user).to.equal(ethers.constants.AddressZero);
      expect(depAfter.shares).to.equal(0);
    });

    it("ownerRedeemFeesEmergency can only be used in emergency mode, and pays strict pro-rata", async () => {
      const [deployerSigner, aliceSigner] = await ethers.getSigners();

      const ownerAddr = await deployerSigner.getAddress();
      const aliceAddr = await aliceSigner.getAddress();

      const initAmount = ONE.mul(1_000);

      // Initialize with Alice as the initial depositor / receiver.
      await initializeVaultFor(aliceAddr, initAmount);

      // Owner cannot use emergency fee redemption before emergency mode.
      await expect(
        vault.connect(deployerSigner).ownerRedeemFeesEmergency(1)
      ).to.be.revertedWith("emergency: disabled");

      // Schedule a non-zero fee rate, effective after feeChangeDelaySecs.
      const newFeeBips = 1_000; // 0.1% / week
      const tx = await vault.connect(deployerSigner).scheduleOwnerFeeBips(newFeeBips);
      const rcpt = await tx.wait();
      const block = await ethers.provider.getBlock(rcpt!.blockNumber);
      if (!block) throw new Error("block not found");

      const feeDelay = (await vault.feeChangeDelaySecs()).toNumber();
      const effectiveTs = block.timestamp + feeDelay;

      // Move forward so the new rate is active.
      await setNextBlockTimestamp(effectiveTs + DAY_SECS);

      // Enable emergency mode.
      await vault.connect(deployerSigner).enableEmergencyMode();

      // Impersonate distributor to call onAirdropFunded and trigger fee accrual.
      const distAddr = distributor.address;

      await network.provider.send("hardhat_setBalance", [
        distAddr,
        "0x8AC7230489E80000", // 10 ETH
      ]);

      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [distAddr],
      });

      const distSigner = await ethers.getSigner(distAddr);

      // This calls _accrueMgmtFee() internally and should mint ownerFeeShares.
      await vault.connect(distSigner).onAirdropFunded(token1.address, 1);

      await network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [distAddr],
      });

      let feeShares = await vault.ownerFeeShares();
      expect(feeShares).to.be.gt(0);

      // Non-owner cannot redeem fee shares.
      await expect(
        vault.connect(aliceSigner).ownerRedeemFeesEmergency(feeShares)
      )
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
        .withArgs(aliceAddr);

      // Snapshot owner balances.
      const ownerBaseBefore = await token0.balanceOf(ownerAddr);
      const ownerQuoteBefore = await token1.balanceOf(ownerAddr);

      // We intentionally set the next timestamp slightly forward.
      // If _accrueMgmtFee() mints a tiny bit more inside ownerRedeemFeesEmergency,
      // the expected calculation below accounts for it by reconstructing tsBefore.
      const lastAccrualTs = (await vault.lastFeeAccrual()).toNumber();
      const latestBlock = await ethers.provider.getBlock("latest");
      const targetTs = Math.max(lastAccrualTs, latestBlock!.timestamp) + 1;

      await network.provider.send("evm_setNextBlockTimestamp", [targetTs]);

      feeShares = await vault.ownerFeeShares();

      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);

      // Redeem the fee shares currently known before the tx.
      await vault.connect(deployerSigner).ownerRedeemFeesEmergency(feeShares);

      const totalSharesAfter = await vault.totalShares();

      // Internal supply before burn = totalSharesAfter + feeShares burned.
      // This accounts for any tiny additional fee accrual inside the redeem tx.
      const tsBeforeInternal = totalSharesAfter.add(feeShares);

      const expectedBaseOut = baseBalBefore.mul(feeShares).div(tsBeforeInternal);
      const expectedQuoteOut = quoteBalBefore.mul(feeShares).div(tsBeforeInternal);

      const ownerBaseAfter = await token0.balanceOf(ownerAddr);
      const ownerQuoteAfter = await token1.balanceOf(ownerAddr);

      const deltaBase = ownerBaseAfter.sub(ownerBaseBefore);
      const deltaQuote = ownerQuoteAfter.sub(ownerQuoteBefore);

      expect(deltaBase).to.equal(expectedBaseOut);
      expect(deltaQuote).to.equal(expectedQuoteOut);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Deposits: general
  // ─────────────────────────────────────────────────────────────
  describe("deposits", () => {
    const ONE = BigNumber.from(10).pow(8); // token decimals = 8

    const VIRTUAL_SHARES = BigNumber.from(1_000);
    const VIRTUAL_ASSET = BigNumber.from(1);

    async function futureDeadline(seconds = 3600): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp + seconds;
    }

    async function initializeVault(
      baseAmount: BigNumber,
      quoteAmount: BigNumber,
      receiver?: string
    ) {
      const receiverAddr = receiver ?? (await deployer.getAddress());

      await token0.connect(deployer).approve(vault.address, baseAmount);
      await token1.connect(deployer).approve(vault.address, quoteAmount);

      await vault.connect(deployer).initialize(
        baseAmount,
        quoteAmount,
        0, // minSharesOut
        receiverAddr,
        await futureDeadline()
      );

      expect(await vault.initialized()).to.equal(true);
    }

    async function fundAndApproveAlice(baseAmount: BigNumber, quoteAmount: BigNumber) {
      const aliceAddr = await alice.getAddress();

      await token0.transfer(aliceAddr, baseAmount);
      await token1.transfer(aliceAddr, quoteAmount);

      await token0.connect(alice).approve(vault.address, baseAmount);
      await token1.connect(alice).approve(vault.address, quoteAmount);
    }

    it("deposit reverts before initialize", async () => {
      const amount = ONE.mul(100);

      await expect(
        vault.connect(alice).depositProRata(
          amount,
          amount,
          0, // minSharesOut
          await futureDeadline()
        )
      ).to.be.revertedWith("not initialized");
    });

    it("deposit follows current inventory ratio", async () => {
      const aliceAddr = await alice.getAddress();

      // Initialize the vault at a 2:1 BASE:QUOTE inventory ratio.
      const initBase = ONE.mul(2_000);
      const initQuote = ONE.mul(1_000);

      await initializeVault(initBase, initQuote);

      // Alice offers 200 BASE and 200 QUOTE.
      // Since the vault ratio is 2:1, BASE should be the limiting side,
      // and only about 100 QUOTE should be consumed.
      const baseMax = ONE.mul(200);
      const quoteMax = ONE.mul(200);

      await fundAndApproveAlice(baseMax, quoteMax);

      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const supplyBefore = await vault.totalShares();

      const expected = expectedDepositPreview(
        baseMax,
        quoteMax,
        baseBalBefore,
        quoteBalBefore,
        supplyBefore
      );

      expect(expected.sharesOut).to.be.gt(0);
      expect(expected.baseIn.lte(baseMax)).to.equal(true);
      expect(expected.quoteIn.lte(quoteMax)).to.equal(true);

      // With a 2:1 vault ratio and equal caps, quote should not be fully consumed.
      expect(expected.quoteIn.lt(quoteMax)).to.equal(true);

      // Public preview should match the same math.
      const preview = await vault.previewDepositProRata(baseMax, quoteMax);
      expect(preview.baseIn).to.equal(expected.baseIn);
      expect(preview.quoteIn).to.equal(expected.quoteIn);
      expect(preview.sharesOut).to.equal(expected.sharesOut);

      const aliceBaseBefore = await token0.balanceOf(aliceAddr);
      const aliceQuoteBefore = await token1.balanceOf(aliceAddr);

      await vault.connect(alice).depositProRata(
        baseMax,
        quoteMax,
        expected.sharesOut, // minSharesOut
        await futureDeadline()
      );

      const aliceBaseAfter = await token0.balanceOf(aliceAddr);
      const aliceQuoteAfter = await token1.balanceOf(aliceAddr);

      const baseSpent = aliceBaseBefore.sub(aliceBaseAfter);
      const quoteSpent = aliceQuoteBefore.sub(aliceQuoteAfter);

      expect(baseSpent).to.equal(expected.baseIn);
      expect(quoteSpent).to.equal(expected.quoteIn);

      // Vault balances increased by exactly the consumed amounts.
      expect(await token0.balanceOf(vault.address)).to.equal(baseBalBefore.add(expected.baseIn));
      expect(await token1.balanceOf(vault.address)).to.equal(quoteBalBefore.add(expected.quoteIn));

      // Alice received exactly previewed shares.
      expect(await vault.userShares(aliceAddr)).to.equal(expected.sharesOut);
    });

    it("limiting side determines shares", async () => {
      const aliceAddr = await alice.getAddress();

      // Vault ratio = 2 BASE : 1 QUOTE.
      const initBase = ONE.mul(2_000);
      const initQuote = ONE.mul(1_000);

      await initializeVault(initBase, initQuote);

      // Alice has lots of BASE but relatively little QUOTE.
      // QUOTE should determine the sharesOut.
      const baseMax = ONE.mul(1_000);
      const quoteMax = ONE.mul(100);

      await fundAndApproveAlice(baseMax, quoteMax);

      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const supplyBefore = await vault.totalShares();

      const expected = expectedDepositPreview(
        baseMax,
        quoteMax,
        baseBalBefore,
        quoteBalBefore,
        supplyBefore
      );

      expect(expected.sharesOut).to.be.gt(0);

      // QUOTE is the limiting side.
      expect(expected.sharesByQuote.lt(expected.sharesByBase)).to.equal(true);
      expect(expected.sharesOut).to.equal(expected.sharesByQuote);

      // Because QUOTE limits shares, not all BASE should be consumed.
      expect(expected.baseIn.lt(baseMax)).to.equal(true);
      expect(expected.quoteIn.lte(quoteMax)).to.equal(true);

      const aliceBaseBefore = await token0.balanceOf(aliceAddr);
      const aliceQuoteBefore = await token1.balanceOf(aliceAddr);

      await vault.connect(alice).depositProRata(
        baseMax,
        quoteMax,
        expected.sharesOut,
        await futureDeadline()
      );

      const aliceBaseAfter = await token0.balanceOf(aliceAddr);
      const aliceQuoteAfter = await token1.balanceOf(aliceAddr);

      expect(aliceBaseBefore.sub(aliceBaseAfter)).to.equal(expected.baseIn);
      expect(aliceQuoteBefore.sub(aliceQuoteAfter)).to.equal(expected.quoteIn);

      expect(await vault.userShares(aliceAddr)).to.equal(expected.sharesOut);
    });

    it("minSharesOut enforced", async () => {
      const aliceAddr = await alice.getAddress();

      const initAmount = ONE.mul(1_000);
      await initializeVault(initAmount, initAmount);

      const baseMax = ONE.mul(100);
      const quoteMax = ONE.mul(100);

      await fundAndApproveAlice(baseMax, quoteMax);

      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const supplyBefore = await vault.totalShares();

      const expected = expectedDepositPreview(
        baseMax,
        quoteMax,
        baseBalBefore,
        quoteBalBefore,
        supplyBefore
      );

      expect(expected.sharesOut).to.be.gt(0);

      // Asking for one more share than the deposit can mint should revert.
      await expect(
        vault.connect(alice).depositProRata(
          baseMax,
          quoteMax,
          expected.sharesOut.add(1),
          await futureDeadline()
        )
      ).to.be.revertedWith("slippage: shares");

      // Exact quoted minimum should succeed.
      await vault.connect(alice).depositProRata(
        baseMax,
        quoteMax,
        expected.sharesOut,
        await futureDeadline()
      );

      expect(await vault.userShares(aliceAddr)).to.equal(expected.sharesOut);
    });

    it("excess token cap is not consumed", async () => {
      const aliceAddr = await alice.getAddress();

      // Vault ratio = 2 BASE : 1 QUOTE.
      const initBase = ONE.mul(2_000);
      const initQuote = ONE.mul(1_000);

      await initializeVault(initBase, initQuote);

      // Alice provides a large QUOTE cap but BASE is the limiting side.
      const baseMax = ONE.mul(200);
      const quoteMax = ONE.mul(1_000);

      await fundAndApproveAlice(baseMax, quoteMax);

      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const supplyBefore = await vault.totalShares();

      const expected = expectedDepositPreview(
        baseMax,
        quoteMax,
        baseBalBefore,
        quoteBalBefore,
        supplyBefore
      );

      expect(expected.sharesOut).to.be.gt(0);

      // BASE should be limiting; excess QUOTE should remain with Alice.
      expect(expected.sharesByBase.lt(expected.sharesByQuote)).to.equal(true);
      expect(expected.sharesOut).to.equal(expected.sharesByBase);
      expect(expected.quoteIn.lt(quoteMax)).to.equal(true);

      const aliceBaseBefore = await token0.balanceOf(aliceAddr);
      const aliceQuoteBefore = await token1.balanceOf(aliceAddr);

      await vault.connect(alice).depositProRata(
        baseMax,
        quoteMax,
        expected.sharesOut,
        await futureDeadline()
      );

      const aliceBaseAfter = await token0.balanceOf(aliceAddr);
      const aliceQuoteAfter = await token1.balanceOf(aliceAddr);

      const baseSpent = aliceBaseBefore.sub(aliceBaseAfter);
      const quoteSpent = aliceQuoteBefore.sub(aliceQuoteAfter);

      expect(baseSpent).to.equal(expected.baseIn);
      expect(quoteSpent).to.equal(expected.quoteIn);

      // Critical check: the whole quote cap was NOT consumed.
      expect(quoteSpent.lt(quoteMax)).to.equal(true);
      expect(aliceQuoteAfter).to.equal(aliceQuoteBefore.sub(expected.quoteIn));

      // Vault only received the computed pro-rata amounts.
      expect(await token0.balanceOf(vault.address)).to.equal(baseBalBefore.add(expected.baseIn));
      expect(await token1.balanceOf(vault.address)).to.equal(quoteBalBefore.add(expected.quoteIn));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Deposits: share minting & pro-rata inventory policy
  // ─────────────────────────────────────────────────────────────
  describe("deposits: share minting and pro-rata inventory policy", () => {

    async function futureDeadline(seconds = 3600): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp + seconds;
    }

    function assetToShares(
      amount: BigNumber,
      balance: BigNumber,
      supply: BigNumber,
      virtualAsset: BigNumber = VIRTUAL_ASSET
    ): BigNumber {
      return amount
        .mul(supply.add(VIRTUAL_SHARES))
        .div(balance.add(virtualAsset));
    }

    function expectedDepositPreview(
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

    async function initializeVault(
      baseAmount: BigNumber,
      quoteAmount: BigNumber,
      receiver?: string
    ) {
      const receiverAddr = receiver ?? (await deployer.getAddress());

      await token0.connect(deployer).approve(vault.address, baseAmount);
      await token1.connect(deployer).approve(vault.address, quoteAmount);

      await vault.connect(deployer).initialize(
        baseAmount,
        quoteAmount,
        0,
        receiverAddr,
        await futureDeadline()
      );

      expect(await vault.initialized()).to.equal(true);
    }

    async function fundAndApprove(
      signer: any,
      addr: string,
      baseAmount: BigNumber,
      quoteAmount: BigNumber
    ) {
      await token0.transfer(addr, baseAmount);
      await token1.transfer(addr, quoteAmount);

      await token0.connect(signer).approve(vault.address, baseAmount);
      await token1.connect(signer).approve(vault.address, quoteAmount);
    }

    it("mints the correct number of shares for initialization and second pro-rata deposit", async () => {
      const [, aliceSigner, bobSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();
      const bobAddr = await bobSigner.getAddress();

      const amount1 = ethers.utils.parseUnits("1000", 8);
      const amount2 = ethers.utils.parseUnits("2000", 8);

      // Initial controlled initialization, with Alice receiving the first lot.
      await token0.connect(deployer).approve(vault.address, amount1);
      await token1.connect(deployer).approve(vault.address, amount1);

      const expectedShares1 = expectedInitialShares(amount1, amount1);

      await vault.connect(deployer).initialize(
        amount1,
        amount1,
        expectedShares1,
        aliceAddr,
        await futureDeadline()
      );

      const totalSharesAfter1 = await vault.totalShares();
      const aliceShares = await vault.userShares(aliceAddr);

      expect(totalSharesAfter1).to.equal(expectedShares1);
      expect(aliceShares).to.equal(expectedShares1);

      const dep0 = await vault.deposits(0);
      expect(dep0.user).to.equal(aliceAddr);
      expect(dep0.shares).to.equal(expectedShares1);

      // Bob makes a normal pro-rata deposit.
      await fundAndApprove(bobSigner, bobAddr, amount2, amount2);

      const supplyBefore2 = await vault.totalShares();
      const baseBalBefore2 = await token0.balanceOf(vault.address);
      const quoteBalBefore2 = await token1.balanceOf(vault.address);

      const expected2 = expectedDepositPreview(
        amount2,
        amount2,
        baseBalBefore2,
        quoteBalBefore2,
        supplyBefore2
      );

      await vault.connect(bobSigner).depositProRata(
        amount2,
        amount2,
        expected2.sharesOut,
        await futureDeadline()
      );

      const totalSharesAfter2 = await vault.totalShares();
      const bobShares = await vault.userShares(bobAddr);

      expect(bobShares).to.equal(expected2.sharesOut);
      expect(totalSharesAfter2).to.equal(supplyBefore2.add(expected2.sharesOut));

      const dep1 = await vault.deposits(1);
      expect(dep1.user).to.equal(bobAddr);
      expect(dep1.shares).to.equal(expected2.sharesOut);
    });

    it("accepts only the current inventory ratio and does not consume excess quote cap", async () => {
      const [, aliceSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();

      // Initialize at 1:1 token-unit ratio.
      const initAmount = ethers.utils.parseUnits("1000", 8);
      await initializeVault(initAmount, initAmount);

      const baseMax = ethers.utils.parseUnits("1000", 8);
      const quoteMax = ethers.utils.parseUnits("2000", 8); // excess quote cap

      await fundAndApprove(aliceSigner, aliceAddr, baseMax, quoteMax);

      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const supplyBefore = await vault.totalShares();

      const expected = expectedDepositPreview(
        baseMax,
        quoteMax,
        baseBalBefore,
        quoteBalBefore,
        supplyBefore
      );

      // Since inventory is 1:1 and baseMax is smaller, quote should not be fully consumed.
      expect(expected.baseIn).to.equal(baseMax);
      expect(expected.quoteIn.lt(quoteMax)).to.equal(true);

      const aliceBaseBefore = await token0.balanceOf(aliceAddr);
      const aliceQuoteBefore = await token1.balanceOf(aliceAddr);

      await vault.connect(aliceSigner).depositProRata(
        baseMax,
        quoteMax,
        expected.sharesOut,
        await futureDeadline()
      );

      const aliceBaseAfter = await token0.balanceOf(aliceAddr);
      const aliceQuoteAfter = await token1.balanceOf(aliceAddr);

      const baseSpent = aliceBaseBefore.sub(aliceBaseAfter);
      const quoteSpent = aliceQuoteBefore.sub(aliceQuoteAfter);

      expect(baseSpent).to.equal(expected.baseIn);
      expect(quoteSpent).to.equal(expected.quoteIn);

      expect(quoteSpent.lt(quoteMax)).to.equal(true);

      expect(await token0.balanceOf(vault.address)).to.equal(baseBalBefore.add(expected.baseIn));
      expect(await token1.balanceOf(vault.address)).to.equal(quoteBalBefore.add(expected.quoteIn));
    });

    it("rejects one-sided deposits after initialization", async () => {
      const [, aliceSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();

      const initAmount = ethers.utils.parseUnits("1000", 8);
      await initializeVault(initAmount, initAmount);

      const extraBase = ethers.utils.parseUnits("500", 8);
      const extraQuote = ethers.utils.parseUnits("500", 8);

      await token0.transfer(aliceAddr, extraBase);
      await token1.transfer(aliceAddr, extraQuote);

      await token0.connect(aliceSigner).approve(vault.address, extraBase);
      await token1.connect(aliceSigner).approve(vault.address, extraQuote);

      await expect(
        vault.connect(aliceSigner).depositProRata(
          extraBase,
          0,
          0,
          await futureDeadline()
        )
      ).to.be.revertedWith("shares=0");

      await expect(
        vault.connect(aliceSigner).depositProRata(
          0,
          extraQuote,
          0,
          await futureDeadline()
        )
      ).to.be.revertedWith("shares=0");
    });

    it("after direct inventory donation, deposits follow the new inventory ratio instead of rebalancing", async () => {
      const [, bobSigner] = await ethers.getSigners();
      const bobAddr = await bobSigner.getAddress();

      const initAmount = ethers.utils.parseUnits("1000", 8);
      await initializeVault(initAmount, initAmount);

      // Donate quote directly, changing inventory ratio from 1:1 to approximately 1:2.
      const quoteDonation = ethers.utils.parseUnits("1000", 8);
      await token1.transfer(vault.address, quoteDonation);

      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      expect(quoteBalBefore.gt(baseBalBefore)).to.equal(true);

      const baseMax = ethers.utils.parseUnits("1000", 8);
      const quoteMax = ethers.utils.parseUnits("1000", 8);

      await fundAndApprove(bobSigner, bobAddr, baseMax, quoteMax);

      const supplyBefore = await vault.totalShares();

      const expected = expectedDepositPreview(
        baseMax,
        quoteMax,
        baseBalBefore,
        quoteBalBefore,
        supplyBefore
      );

      // Since quote inventory is larger, quote is the limiting side here.
      // The vault should consume all/almost all quote cap and less base.
      expect(expected.baseIn.lt(baseMax)).to.equal(true);
      expect(expected.quoteIn.lte(quoteMax)).to.equal(true);

      const bobBaseBefore = await token0.balanceOf(bobAddr);
      const bobQuoteBefore = await token1.balanceOf(bobAddr);

      await vault.connect(bobSigner).depositProRata(
        baseMax,
        quoteMax,
        expected.sharesOut,
        await futureDeadline()
      );

      const bobBaseAfter = await token0.balanceOf(bobAddr);
      const bobQuoteAfter = await token1.balanceOf(bobAddr);

      expect(bobBaseBefore.sub(bobBaseAfter)).to.equal(expected.baseIn);
      expect(bobQuoteBefore.sub(bobQuoteAfter)).to.equal(expected.quoteIn);

      expect(await token0.balanceOf(vault.address)).to.equal(baseBalBefore.add(expected.baseIn));
      expect(await token1.balanceOf(vault.address)).to.equal(quoteBalBefore.add(expected.quoteIn));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Deposit lot storage
  // ─────────────────────────────────────────────────────────────
  describe("deposit lot storage", () => {
    async function futureDeadline(seconds = 3600): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp + seconds;
    }

    async function initializeVault(
      baseAmount: BigNumber,
      quoteAmount: BigNumber,
      receiver?: string
    ) {
      const receiverAddr = receiver ?? (await deployer.getAddress());

      await token0.connect(deployer).approve(vault.address, baseAmount);
      await token1.connect(deployer).approve(vault.address, quoteAmount);

      await vault.connect(deployer).initialize(
        baseAmount,
        quoteAmount,
        0, // minSharesOut
        receiverAddr,
        await futureDeadline()
      );

      expect(await vault.initialized()).to.equal(true);
    }

    async function fundApproveUser(
      signer: any,
      addr: string,
      baseAmount: BigNumber,
      quoteAmount: BigNumber
    ) {
      await token0.transfer(addr, baseAmount);
      await token1.transfer(addr, quoteAmount);

      await token0.connect(signer).approve(vault.address, baseAmount);
      await token1.connect(signer).approve(vault.address, quoteAmount);
    }

    async function passLockup() {
      const lockupSecs = (await vault.lockupSecs()).toNumber();
      await increaseTime(lockupSecs + 1);
    }

    it("assigns monotonically increasing depositIds and never reuses them", async () => {
      const aliceAddr = await alice.getAddress();
      const deployerAddr = await deployer.getAddress();

      const initAmt = ONE.mul(1_000);
      const amt = ONE.mul(100);

      // Initialize with deployer as receiver so the vault stays alive
      // after Alice withdraws her own lot.
      await initializeVault(initAmt, initAmt, deployerAddr);

      // Initialization created depositId 0 for deployer.
      let depositsLen = await vault.depositsLength();
      expect(depositsLen).to.equal(1);

      // Alice's first public deposit should get id 1.
      await fundApproveUser(alice, aliceAddr, amt, amt);

      await vault.connect(alice).depositProRata(
        amt,
        amt,
        0,
        await futureDeadline()
      );

      let aliceDeposits = await vault.depositsOf(aliceAddr);
      expect(aliceDeposits.length).to.equal(1);

      const firstId = aliceDeposits[0];
      expect(firstId).to.equal(1);

      let firstLot = await vault.deposits(firstId);
      expect(firstLot.user).to.equal(aliceAddr);
      expect(firstLot.shares).to.be.gt(0);

      // Wait out lockup, then withdraw all from Alice's first lot.
      await passLockup();

      await vault.connect(alice).withdrawAllFromDeposit(
        firstId,
        0, // minBaseOut
        0, // minQuoteOut
        await futureDeadline()
      );

      aliceDeposits = await vault.depositsOf(aliceAddr);
      expect(aliceDeposits.length).to.equal(0);

      // Slot is cleared: user == 0, shares == 0.
      firstLot = await vault.deposits(firstId);
      expect(firstLot.user).to.equal(ethers.constants.AddressZero);
      expect(firstLot.shares).to.equal(0);

      depositsLen = await vault.depositsLength();
      expect(depositsLen).to.equal(2); // id 0 deployer init lot, id 1 cleared

      // Alice's second public deposit should get id 2, not reuse id 1.
      await fundApproveUser(alice, aliceAddr, amt, amt);

      await vault.connect(alice).depositProRata(
        amt,
        amt,
        0,
        await futureDeadline()
      );

      aliceDeposits = await vault.depositsOf(aliceAddr);
      expect(aliceDeposits.length).to.equal(1);

      const secondId = aliceDeposits[0];

      // id must be strictly greater than firstId.
      expect(secondId.gt(firstId)).to.equal(true);
      expect(secondId).to.equal(2);

      depositsLen = await vault.depositsLength();
      expect(depositsLen).to.equal(3); // ids 0, 1, 2 allocated; id 1 cleared

      const secondLot = await vault.deposits(secondId);
      expect(secondLot.user).to.equal(aliceAddr);
      expect(secondLot.shares).to.be.gt(0);
    });

    it("keeps depositId in _userDeposits on partial withdraw and clears it only when shares go to zero", async () => {
      const aliceAddr = await alice.getAddress();
      const amt = ONE.mul(200);

      // Initialize directly to Alice, creating Alice's lot id 0.
      await initializeVault(amt, amt, aliceAddr);

      let ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(1);

      const depId = ids[0];

      let lot = await vault.deposits(depId);
      expect(lot.user).to.equal(aliceAddr);

      const fullShares = lot.shares;
      expect(fullShares).to.be.gt(0);

      await passLockup();

      // Partial withdraw half the shares.
      const halfShares = fullShares.div(2);

      await vault.connect(alice).withdrawFromDeposit(
        depId,
        halfShares,
        0, // minBaseOut
        0, // minQuoteOut
        await futureDeadline()
      );

      // Deposit id should still be present.
      ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(1);
      expect(ids[0]).to.equal(depId);

      lot = await vault.deposits(depId);
      expect(lot.user).to.equal(aliceAddr);
      expect(lot.shares).to.equal(fullShares.sub(halfShares));

      // Withdraw the rest.
      await vault.connect(alice).withdrawFromDeposit(
        depId,
        lot.shares,
        0,
        0,
        await futureDeadline()
      );

      // Now it should be removed.
      ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(0);

      lot = await vault.deposits(depId);
      expect(lot.user).to.equal(ethers.constants.AddressZero);
      expect(lot.shares).to.equal(0);
    });

    it("removing a deposit for one user does not affect another user's deposits", async () => {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();
      const deployerAddr = await deployer.getAddress();

      const initAmt = ONE.mul(1_000);
      const amt = ONE.mul(100);

      // Keep the vault alive with deployer's initialization lot.
      await initializeVault(initAmt, initAmt, deployerAddr);

      await fundApproveUser(alice, aliceAddr, amt.mul(2), amt.mul(2));
      await fundApproveUser(bob, bobAddr, amt.mul(2), amt.mul(2));

      // Alice deposits twice.
      await vault.connect(alice).depositProRata(
        amt,
        amt,
        0,
        await futureDeadline()
      );

      await vault.connect(alice).depositProRata(
        amt,
        amt,
        0,
        await futureDeadline()
      );

      // Bob deposits once.
      await vault.connect(bob).depositProRata(
        amt,
        amt,
        0,
        await futureDeadline()
      );

      let aliceIds = await vault.depositsOf(aliceAddr);
      let bobIds = await vault.depositsOf(bobAddr);

      expect(aliceIds.length).to.equal(2);
      expect(bobIds.length).to.equal(1);

      const aliceDepToWithdraw = aliceIds[0];

      await passLockup();

      await vault.connect(alice).withdrawAllFromDeposit(
        aliceDepToWithdraw,
        0,
        0,
        await futureDeadline()
      );

      // Alice should have exactly one remaining deposit.
      aliceIds = await vault.depositsOf(aliceAddr);
      expect(aliceIds.length).to.equal(1);
      expect(aliceIds[0]).to.not.equal(aliceDepToWithdraw);

      // Bob should still have his one deposit, unchanged.
      bobIds = await vault.depositsOf(bobAddr);
      expect(bobIds.length).to.equal(1);

      const bobLot = await vault.deposits(bobIds[0]);
      expect(bobLot.user).to.equal(bobAddr);
      expect(bobLot.shares).to.be.gt(0);
    });

    it("emergencyWithdrawFromDeposit clears the lot and removes depositId from _userDeposits", async () => {
      const aliceAddr = await alice.getAddress();
      const amt = ONE.mul(100);

      // Initialize with Alice as receiver, creating Alice's first lot.
      await initializeVault(amt, amt, aliceAddr);

      let ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(1);

      const depId = ids[0];

      let lot = await vault.deposits(depId);
      expect(lot.user).to.equal(aliceAddr);
      expect(lot.shares).to.be.gt(0);

      // Enable emergency mode.
      await vault.enableEmergencyMode();

      // Emergency withdraw ignores lockup.
      await vault.connect(alice).emergencyWithdrawFromDeposit(depId);

      // Mapping cleared.
      ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(0);

      lot = await vault.deposits(depId);
      expect(lot.user).to.equal(ethers.constants.AddressZero);
      expect(lot.shares).to.equal(0);
    });

    it("removes a middle deposit id from _userDeposits using swap-and-pop", async () => {
      const aliceAddr = await alice.getAddress();
      const deployerAddr = await deployer.getAddress();

      const initAmt = ONE.mul(1_000);
      const depositAmt = ONE.mul(1_000);
      const totalNeeded = depositAmt.mul(3);

      // Keep the vault alive with deployer's initialization lot.
      await initializeVault(initAmt, initAmt, deployerAddr);

      await fundApproveUser(alice, aliceAddr, totalNeeded, totalNeeded);

      // Three Alice deposits.
      await vault.connect(alice).depositProRata(
        depositAmt,
        depositAmt,
        0,
        await futureDeadline()
      );

      await vault.connect(alice).depositProRata(
        depositAmt,
        depositAmt,
        0,
        await futureDeadline()
      );

      await vault.connect(alice).depositProRata(
        depositAmt,
        depositAmt,
        0,
        await futureDeadline()
      );

      let deps = await vault.depositsOf(aliceAddr);
      expect(deps.length).to.equal(3);

      const id0 = deps[0];
      const id1 = deps[1]; // withdraw this one, the "middle"
      const id2 = deps[2];

      await passLockup();

      await vault.connect(alice).withdrawAllFromDeposit(
        id1,
        0,
        0,
        await futureDeadline()
      );

      // After swap-and-pop, exactly two ids remain: {id0, id2}, order not guaranteed.
      deps = await vault.depositsOf(aliceAddr);
      expect(deps.length).to.equal(2);

      const remaining = deps.map((x: BigNumber) => x.toNumber()).sort();
      const expectedRemaining = [id0.toNumber(), id2.toNumber()].sort();

      expect(remaining).to.deep.equal(expectedRemaining);

      // Withdrawn lot struct should be cleared.
      const dep1 = await vault.deposits(id1);
      expect(dep1.user).to.equal(ethers.constants.AddressZero);
      expect(dep1.shares).to.equal(0);
    });
  });

  describe("HBAR deposits: pro-rata msg.value accounting", () => {
    async function futureDeadline(seconds = 3600): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp + seconds;
    }

    it("BASE=HBAR: underpaying msg.value reverts; sufficient msg.value succeeds and refunds excess", async () => {
      const [, aliceSigner] = await ethers.getSigners();

      const deployerAddr = await deployer.getAddress();
      const aliceAddr = await aliceSigner.getAddress();

      // Deploy a pro-rata vault where BASE is native HBAR and QUOTE is token1.
      const VaultFactory = await ethers.getContractFactory("PLEXProRataVault");
      const hbarVault = (await VaultFactory.deploy(
        ethers.constants.AddressZero, // BASE = HBAR
        token1.address,               // QUOTE = token1
        distributor.address,
        deployerAddr,                 // manager
        0,                            // ownerFeeBips_ = 0 for deterministic shares
        WEEK_SECS,
        DAY_SECS,
        WEEK_SECS
      )) as PLEXProRataVault;

      await hbarVault.deployed();

      // ─────────────────────────────────────────────────────────────
      // 1) Initialize the HBAR vault.
      //    The initializer is manager/owner-only, so deployer does this.
      // ─────────────────────────────────────────────────────────────
      const initBase = ethers.utils.parseUnits("10", 8);  // 10 HBAR
      const initQuote = ethers.utils.parseUnits("10", 8); // 10 token1

      await token1.connect(deployer).approve(hbarVault.address, initQuote);

      await expect(
        hbarVault.connect(deployer).initialize(
          initBase,
          initQuote,
          0, // minSharesOut
          deployerAddr,
          await futureDeadline(),
          { value: initBase }
        )
      )
        .to.emit(hbarVault, "VaultInitialized")
        .withArgs(
          deployerAddr,
          deployerAddr,
          initBase,
          initQuote,
          initBase,
          initQuote,
          anyValue
        );

      expect(await hbarVault.initialized()).to.equal(true);

      const vaultHBARAfterInit = await ethers.provider.getBalance(hbarVault.address);
      const vaultQuoteAfterInit = await token1.balanceOf(hbarVault.address);

      expect(vaultHBARAfterInit).to.equal(initBase);
      expect(vaultQuoteAfterInit).to.equal(initQuote);

      // ─────────────────────────────────────────────────────────────
      // 2) Alice previews a public pro-rata deposit.
      // ─────────────────────────────────────────────────────────────
      const baseMax = ethers.utils.parseUnits("5", 8);  // 5 HBAR cap
      const quoteMax = ethers.utils.parseUnits("5", 8); // 5 token1 cap

      await token1.transfer(aliceAddr, quoteMax);
      await token1.connect(aliceSigner).approve(hbarVault.address, quoteMax);

      const [baseIn, quoteIn, sharesOut] =
        await hbarVault.callStatic.previewDepositProRata(baseMax, quoteMax);

      expect(baseIn).to.be.gt(0);
      expect(quoteIn).to.be.gt(0);
      expect(sharesOut).to.be.gt(0);

      // ─────────────────────────────────────────────────────────────
      // 3) Underpaying HBAR should revert.
      // ─────────────────────────────────────────────────────────────
      await expect(
        hbarVault.connect(aliceSigner).depositProRata(
          baseMax,
          quoteMax,
          0, // minSharesOut
          await futureDeadline(),
          { value: baseIn.sub(1) }
        )
      ).to.be.revertedWith("HBAR<required");

      // ─────────────────────────────────────────────────────────────
      // 4) Sufficient/excess msg.value should succeed.
      //    Only baseIn should remain in the vault; excess HBAR is refunded.
      // ─────────────────────────────────────────────────────────────
      const hbarBefore = await ethers.provider.getBalance(hbarVault.address);
      const quoteBefore = await token1.balanceOf(hbarVault.address);

      const excessHBAR = ethers.utils.parseUnits("1", 8);

      await expect(
        hbarVault.connect(aliceSigner).depositProRata(
          baseMax,
          quoteMax,
          sharesOut, // exact previewed minSharesOut
          await futureDeadline(),
          { value: baseIn.add(excessHBAR) }
        )
      )
        .to.emit(hbarVault, "DepositedProRata")
        .withArgs(
          aliceAddr,
          BigNumber.from(1), // depositId 0 was initializer's lot
          baseIn,
          quoteIn,
          sharesOut,
          hbarBefore,
          quoteBefore
        );

      const hbarAfter = await ethers.provider.getBalance(hbarVault.address);
      const quoteAfter = await token1.balanceOf(hbarVault.address);

      // Critical checks:
      // - vault only retains the required HBAR, not the excess
      // - quote side increased by exactly quoteIn
      expect(hbarAfter).to.equal(hbarBefore.add(baseIn));
      expect(quoteAfter).to.equal(quoteBefore.add(quoteIn));

      const aliceDeps = await hbarVault.depositsOf(aliceAddr);
      expect(aliceDeps.length).to.equal(1);

      const dep = await hbarVault.deposits(aliceDeps[0]);
      expect(dep.user).to.equal(aliceAddr);
      expect(dep.shares).to.equal(sharesOut);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Deposits: slippage enforcement
  // ─────────────────────────────────────────────────────────────
  describe("deposits: slippage enforcement", () => {
    async function futureDeadline(seconds = 3600): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp + seconds;
    }

    async function initializeVault(
      baseAmount: BigNumber,
      quoteAmount: BigNumber,
      receiver?: string
    ) {
      const receiverAddr = receiver ?? (await deployer.getAddress());

      await token0.connect(deployer).approve(vault.address, baseAmount);
      await token1.connect(deployer).approve(vault.address, quoteAmount);

      await vault.connect(deployer).initialize(
        baseAmount,
        quoteAmount,
        0, // minSharesOut
        receiverAddr,
        await futureDeadline()
      );

      expect(await vault.initialized()).to.equal(true);
    }

    async function fundApproveUser(
      signer: any,
      addr: string,
      baseAmount: BigNumber,
      quoteAmount: BigNumber
    ) {
      await token0.transfer(addr, baseAmount);
      await token1.transfer(addr, quoteAmount);

      await token0.connect(signer).approve(vault.address, baseAmount);
      await token1.connect(signer).approve(vault.address, quoteAmount);
    }

    it("reverts with slippage: shares when QUOTE inventory increases after preview", async () => {
      const [, aliceSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();

      // Initialize vault at 1:1 token-unit ratio.
      const initAmount = ONE.mul(1_000);
      await initializeVault(initAmount, initAmount, await deployer.getAddress());

      // Alice wants to deposit up to 100/100.
      const baseMax = ONE.mul(100);
      const quoteMax = ONE.mul(100);

      await fundApproveUser(aliceSigner, aliceAddr, baseMax, quoteMax);

      // Alice previews against current 1:1 inventory.
      const [basePreviewBefore, quotePreviewBefore, sharesPreviewBefore] =
        await vault.callStatic.previewDepositProRata(baseMax, quoteMax);

      expect(basePreviewBefore).to.be.gt(0);
      expect(quotePreviewBefore).to.be.gt(0);
      expect(sharesPreviewBefore).to.be.gt(0);

      // Before Alice's tx lands, someone donates QUOTE directly.
      // This changes the vault ratio and reduces the shares Alice can mint
      // with the same 100/100 caps.
      const quoteDonation = ONE.mul(1_000);
      await token1.transfer(vault.address, quoteDonation);

      const [basePreviewAfter, quotePreviewAfter, sharesPreviewAfter] =
        await vault.callStatic.previewDepositProRata(baseMax, quoteMax);

      expect(sharesPreviewAfter).to.be.lt(sharesPreviewBefore);

      // With stale minSharesOut from the old preview, Alice's tx should revert.
      await expect(
        vault.connect(aliceSigner).depositProRata(
          baseMax,
          quoteMax,
          sharesPreviewBefore, // stale minSharesOut
          await futureDeadline()
        )
      ).to.be.revertedWith("slippage: shares");

      // Sanity: using the updated minSharesOut should succeed.
      const aliceBaseBefore = await token0.balanceOf(aliceAddr);
      const aliceQuoteBefore = await token1.balanceOf(aliceAddr);

      await expect(
        vault.connect(aliceSigner).depositProRata(
          baseMax,
          quoteMax,
          sharesPreviewAfter,
          await futureDeadline()
        )
      ).to.not.be.reverted;

      const aliceBaseAfter = await token0.balanceOf(aliceAddr);
      const aliceQuoteAfter = await token1.balanceOf(aliceAddr);

      expect(aliceBaseBefore.sub(aliceBaseAfter)).to.equal(basePreviewAfter);
      expect(aliceQuoteBefore.sub(aliceQuoteAfter)).to.equal(quotePreviewAfter);
    });

    it("reverts with slippage: shares when BASE inventory increases after preview", async () => {
      const [, aliceSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();

      // Initialize vault at 1:1 token-unit ratio.
      const initAmount = ONE.mul(1_000);
      await initializeVault(initAmount, initAmount, await deployer.getAddress());

      // Alice wants to deposit up to 100/100.
      const baseMax = ONE.mul(100);
      const quoteMax = ONE.mul(100);

      await fundApproveUser(aliceSigner, aliceAddr, baseMax, quoteMax);

      // Alice previews against current 1:1 inventory.
      const [basePreviewBefore, quotePreviewBefore, sharesPreviewBefore] =
        await vault.callStatic.previewDepositProRata(baseMax, quoteMax);

      expect(basePreviewBefore).to.be.gt(0);
      expect(quotePreviewBefore).to.be.gt(0);
      expect(sharesPreviewBefore).to.be.gt(0);

      // Before Alice's tx lands, someone donates BASE directly.
      // This changes the vault ratio in the opposite direction and reduces
      // the shares Alice can mint with the same caps.
      const baseDonation = ONE.mul(1_000);
      await token0.transfer(vault.address, baseDonation);

      const [basePreviewAfter, quotePreviewAfter, sharesPreviewAfter] =
        await vault.callStatic.previewDepositProRata(baseMax, quoteMax);

      expect(sharesPreviewAfter).to.be.lt(sharesPreviewBefore);

      // With stale minSharesOut from the old preview, Alice's tx should revert.
      await expect(
        vault.connect(aliceSigner).depositProRata(
          baseMax,
          quoteMax,
          sharesPreviewBefore, // stale minSharesOut
          await futureDeadline()
        )
      ).to.be.revertedWith("slippage: shares");

      // Sanity: using the updated minSharesOut should succeed.
      const aliceBaseBefore = await token0.balanceOf(aliceAddr);
      const aliceQuoteBefore = await token1.balanceOf(aliceAddr);

      await expect(
        vault.connect(aliceSigner).depositProRata(
          baseMax,
          quoteMax,
          sharesPreviewAfter,
          await futureDeadline()
        )
      ).to.not.be.reverted;

      const aliceBaseAfter = await token0.balanceOf(aliceAddr);
      const aliceQuoteAfter = await token1.balanceOf(aliceAddr);

      expect(aliceBaseBefore.sub(aliceBaseAfter)).to.equal(basePreviewAfter);
      expect(aliceQuoteBefore.sub(aliceQuoteAfter)).to.equal(quotePreviewAfter);
    });
  });
  // ─────────────────────────────────────────────────────────────
  // Withdrawals
  // ─────────────────────────────────────────────────────────────
  describe("withdrawals", () => {

    async function futureDeadline(seconds = 3600): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp + seconds;
    }

    async function passLockup() {
      const lockupSecs = (await vault.lockupSecs()).toNumber();
      await increaseTime(lockupSecs + 1);
    }

    async function initializeVault(
      baseAmount: BigNumber,
      quoteAmount: BigNumber,
      receiver?: string
    ) {
      const receiverAddr = receiver ?? (await deployer.getAddress());

      await token0.connect(deployer).approve(vault.address, baseAmount);
      await token1.connect(deployer).approve(vault.address, quoteAmount);

      await vault.connect(deployer).initialize(
        baseAmount,
        quoteAmount,
        0, // minSharesOut
        receiverAddr,
        await futureDeadline()
      );

      expect(await vault.initialized()).to.equal(true);
    }

    async function fundApproveUser(
      signer: any,
      addr: string,
      baseAmount: BigNumber,
      quoteAmount: BigNumber
    ) {
      await token0.transfer(addr, baseAmount);
      await token1.transfer(addr, quoteAmount);

      await token0.connect(signer).approve(vault.address, baseAmount);
      await token1.connect(signer).approve(vault.address, quoteAmount);
    }

    async function makeInitialLotForAlice(amount = ONE.mul(1_000)) {
      const aliceAddr = await alice.getAddress();

      await initializeVault(amount, amount, aliceAddr);

      const ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(1);

      const depId = ids[0];
      const dep = await vault.deposits(depId);

      expect(dep.user).to.equal(aliceAddr);
      expect(dep.shares).to.be.gt(0);

      return { depId, dep, amount };
    }

    // ─────────────────────────────────────────────────────────────
    // Withdrawals: safety & access control
    // ─────────────────────────────────────────────────────────────
    describe("withdrawals: safety & access control", () => {
      it("enforces lockup and reverts withdrawals before lockup with 'locked'", async () => {
        const { depId, dep } = await makeInitialLotForAlice();

        await expect(
          vault.connect(alice).withdrawFromDeposit(
            depId,
            dep.shares,
            0,
            0,
            await futureDeadline()
          )
        ).to.be.revertedWith("locked");
      });

      it("reverts when trying to withdraw more than lot.shares with 'bad shares'", async () => {
        const { depId, dep } = await makeInitialLotForAlice();

        await passLockup();

        const tooMany = dep.shares.add(1);

        await expect(
          vault.connect(alice).withdrawFromDeposit(
            depId,
            tooMany,
            0,
            0,
            await futureDeadline()
          )
        ).to.be.revertedWith("bad shares");
      });

      it("allows only the lot owner to withdraw (non-owner gets 'not owner')", async () => {
        const { depId, dep } = await makeInitialLotForAlice();

        await expect(
          vault.connect(bob).withdrawFromDeposit(
            depId,
            dep.shares,
            0,
            0,
            await futureDeadline()
          )
        ).to.be.revertedWith("not owner");
      });

      it("enforces withdrawal deadline", async () => {
        const { depId, dep } = await makeInitialLotForAlice();

        await passLockup();

        const latest = await ethers.provider.getBlock("latest");
        const expired = latest!.timestamp - 1;

        await expect(
          vault.connect(alice).withdrawFromDeposit(
            depId,
            dep.shares,
            0,
            0,
            expired
          )
        ).to.be.revertedWith("expired");
      });

      it("enforces minBaseOut/minQuoteOut slippage", async () => {
        const { depId, dep } = await makeInitialLotForAlice();

        await passLockup();

        const baseBalBefore = await token0.balanceOf(vault.address);
        const quoteBalBefore = await token1.balanceOf(vault.address);
        const supplyBefore = await vault.totalShares();

        const expectedBase = sharesToAsset(dep.shares, baseBalBefore, supplyBefore);
        const expectedQuote = sharesToAsset(dep.shares, quoteBalBefore, supplyBefore);

        await expect(
          vault.connect(alice).withdrawFromDeposit(
            depId,
            dep.shares,
            expectedBase.add(1),
            0,
            await futureDeadline()
          )
        ).to.be.revertedWith("slippage: base");

        await expect(
          vault.connect(alice).withdrawFromDeposit(
            depId,
            dep.shares,
            0,
            expectedQuote.add(1),
            await futureDeadline()
          )
        ).to.be.revertedWith("slippage: quote");
      });
    });

    // ─────────────────────────────────────────────────────────────
    // Withdrawals: preview vs actual
    // ─────────────────────────────────────────────────────────────
    describe("withdrawals: preview vs actual", () => {
      it("previewWithdrawProRata matches actual partial withdrawal", async () => {
        const aliceAddr = await alice.getAddress();

        const { depId, dep } = await makeInitialLotForAlice();

        await passLockup();

        const halfShares = dep.shares.div(2);

        const preview = await vault.previewWithdrawProRata(halfShares);
        const expectedBase = preview.baseOut;
        const expectedQuote = preview.quoteOut;

        const baseBefore = await token0.balanceOf(aliceAddr);
        const quoteBefore = await token1.balanceOf(aliceAddr);

        await vault.connect(alice).withdrawFromDeposit(
          depId,
          halfShares,
          expectedBase,
          expectedQuote,
          await futureDeadline()
        );

        const baseAfter = await token0.balanceOf(aliceAddr);
        const quoteAfter = await token1.balanceOf(aliceAddr);

        const gotBase = baseAfter.sub(baseBefore);
        const gotQuote = quoteAfter.sub(quoteBefore);

        expect(gotBase).to.equal(expectedBase);
        expect(gotQuote).to.equal(expectedQuote);
      });
    });

    // ─────────────────────────────────────────────────────────────
    // Withdrawals: multi-user fairness
    // ─────────────────────────────────────────────────────────────
    describe("withdrawals: multi-user fairness", () => {
      it("two users withdrawing at different times get pro-rata inventory according to shares", async () => {
        const aliceAddr = await alice.getAddress();
        const bobAddr = await bob.getAddress();

        const aliceAmt = ONE.mul(1_000);
        const bobAmt = ONE.mul(3_000);

        // Alice initializes the vault and receives the initial lot.
        await initializeVault(aliceAmt, aliceAmt, aliceAddr);

        // Bob joins with a larger pro-rata deposit.
        await fundApproveUser(bob, bobAddr, bobAmt, bobAmt);

        await vault.connect(bob).depositProRata(
          bobAmt,
          bobAmt,
          0,
          await futureDeadline()
        );

        const aliceDeposits = await vault.depositsOf(aliceAddr);
        const bobDeposits = await vault.depositsOf(bobAddr);

        expect(aliceDeposits.length).to.equal(1);
        expect(bobDeposits.length).to.equal(1);

        const aliceDepId = aliceDeposits[0];
        const bobDepId = bobDeposits[0];

        await passLockup();

        // ------- Alice withdraws first -------
        const aliceLot = await vault.deposits(aliceDepId);
        const aliceShares = aliceLot.shares;

        const baseBalBeforeA = await token0.balanceOf(vault.address);
        const quoteBalBeforeA = await token1.balanceOf(vault.address);
        const totalSharesBeforeA = await vault.totalShares();

        const expectedAliceBase = sharesToAsset(
          aliceShares,
          baseBalBeforeA,
          totalSharesBeforeA
        );

        const expectedAliceQuote = sharesToAsset(
          aliceShares,
          quoteBalBeforeA,
          totalSharesBeforeA
        );

        const aliceBaseBefore = await token0.balanceOf(aliceAddr);
        const aliceQuoteBefore = await token1.balanceOf(aliceAddr);

        await vault.connect(alice).withdrawAllFromDeposit(
          aliceDepId,
          expectedAliceBase,
          expectedAliceQuote,
          await futureDeadline()
        );

        const aliceBaseAfter = await token0.balanceOf(aliceAddr);
        const aliceQuoteAfter = await token1.balanceOf(aliceAddr);

        const aliceDeltaBase = aliceBaseAfter.sub(aliceBaseBefore);
        const aliceDeltaQuote = aliceQuoteAfter.sub(aliceQuoteBefore);

        expect(aliceDeltaBase).to.equal(expectedAliceBase);
        expect(aliceDeltaQuote).to.equal(expectedAliceQuote);

        // Inventory was balanced, so the two outputs should be equal or within 1 unit.
        expect(absDiff(aliceDeltaBase, aliceDeltaQuote).lte(1)).to.equal(true);

        // ------- Bob withdraws afterwards -------
        const bobLot = await vault.deposits(bobDepId);
        const bobShares = bobLot.shares;

        const baseBalBeforeB = await token0.balanceOf(vault.address);
        const quoteBalBeforeB = await token1.balanceOf(vault.address);
        const totalSharesBeforeB = await vault.totalShares();

        const expectedBobBase = sharesToAsset(
          bobShares,
          baseBalBeforeB,
          totalSharesBeforeB
        );

        const expectedBobQuote = sharesToAsset(
          bobShares,
          quoteBalBeforeB,
          totalSharesBeforeB
        );

        const bobBaseBefore = await token0.balanceOf(bobAddr);
        const bobQuoteBefore = await token1.balanceOf(bobAddr);

        await vault.connect(bob).withdrawAllFromDeposit(
          bobDepId,
          expectedBobBase,
          expectedBobQuote,
          await futureDeadline()
        );

        const bobBaseAfter = await token0.balanceOf(bobAddr);
        const bobQuoteAfter = await token1.balanceOf(bobAddr);

        const bobDeltaBase = bobBaseAfter.sub(bobBaseBefore);
        const bobDeltaQuote = bobQuoteAfter.sub(bobQuoteBefore);

        expect(bobDeltaBase).to.equal(expectedBobBase);
        expect(bobDeltaQuote).to.equal(expectedBobQuote);
        expect(absDiff(bobDeltaBase, bobDeltaQuote).lte(1)).to.equal(true);

        expect(await vault.userShares(aliceAddr)).to.equal(0);
        expect(await vault.userShares(bobAddr)).to.equal(0);
        expect(await vault.totalShares()).to.equal(0);

        // Because normal withdrawals use virtual offsets, dust may remain.
        const finalBase = await token0.balanceOf(vault.address);
        const finalQuote = await token1.balanceOf(vault.address);
        expect(finalBase.gte(0)).to.equal(true);
        expect(finalQuote.gte(0)).to.equal(true);
      });
    });

    // ─────────────────────────────────────────────────────────────
    // Withdrawals: interaction with management fee shares
    // ─────────────────────────────────────────────────────────────
    describe("withdrawals: interaction with management fee shares", () => {
      it("user withdrawal after fee accrual gets pro-rata payout and does not burn owner fee-shares", async () => {
        const [deployerSigner, aliceSigner] = await ethers.getSigners();
        const aliceAddr = await aliceSigner.getAddress();

        const depositAmount = ONE.mul(1_000);

        // Alice receives the initialized lot.
        await initializeVault(depositAmount, depositAmount, aliceAddr);

        const aliceDeposits = await vault.depositsOf(aliceAddr);
        expect(aliceDeposits.length).to.equal(1);

        const aliceDepId = aliceDeposits[0];

        // Schedule a non-zero management fee rate effective after feeChangeDelaySecs.
        const newFeeBips = 1_000;
        const tx = await vault.connect(deployerSigner).scheduleOwnerFeeBips(newFeeBips);
        const rcpt = await tx.wait();

        const block = await ethers.provider.getBlock(rcpt!.blockNumber);
        if (!block) throw new Error("block not found");

        const feeDelay = (await vault.feeChangeDelaySecs()).toNumber();
        const effectiveTs = block.timestamp + feeDelay;

        await setNextBlockTimestamp(effectiveTs + DAY_SECS);

        // Trigger _accrueMgmtFee by impersonating distributor and calling onAirdropFunded.
        const distAddr = distributor.address;

        await network.provider.send("hardhat_setBalance", [
          distAddr,
          "0x8AC7230489E80000",
        ]);

        await network.provider.request({
          method: "hardhat_impersonateAccount",
          params: [distAddr],
        });

        const distSigner = await ethers.getSigner(distAddr);

        await vault.connect(distSigner).onAirdropFunded(token1.address, 1);

        await network.provider.request({
          method: "hardhat_stopImpersonatingAccount",
          params: [distAddr],
        });

        const ownerFeeSharesBefore = await vault.ownerFeeShares();
        expect(ownerFeeSharesBefore).to.be.gt(0);

        await passLockup();

        const aliceLot = await vault.deposits(aliceDepId);
        const aliceSharesBefore = await vault.userShares(aliceAddr);
        expect(aliceSharesBefore).to.equal(aliceLot.shares);

        const baseBalBefore = await token0.balanceOf(vault.address);
        const quoteBalBefore = await token1.balanceOf(vault.address);
        const totalSharesBefore = await vault.totalShares();

        const expectedBase = sharesToAsset(
          aliceLot.shares,
          baseBalBefore,
          totalSharesBefore
        );

        const expectedQuote = sharesToAsset(
          aliceLot.shares,
          quoteBalBefore,
          totalSharesBefore
        );

        const aliceBaseBefore = await token0.balanceOf(aliceAddr);
        const aliceQuoteBefore = await token1.balanceOf(aliceAddr);

        await vault.connect(aliceSigner).withdrawAllFromDeposit(
          aliceDepId,
          0,
          0,
          await futureDeadline()
        );

        const aliceBaseAfter = await token0.balanceOf(aliceAddr);
        const aliceQuoteAfter = await token1.balanceOf(aliceAddr);

        const deltaBase = aliceBaseAfter.sub(aliceBaseBefore);
        const deltaQuote = aliceQuoteAfter.sub(aliceQuoteBefore);

        // Because withdrawAll calls _accrueMgmtFee again, exact equality can be off
        // if another second of fee accrual occurs. The important behavior is pro-rata
        // and owner fee shares remain.
        expect(deltaBase).to.be.gt(0);
        expect(deltaQuote).to.be.gt(0);
        expect(absDiff(deltaBase, deltaQuote).lte(1)).to.equal(true);

        expect(await vault.userShares(aliceAddr)).to.equal(0);

        const ownerFeeSharesAfter = await vault.ownerFeeShares();
        expect(ownerFeeSharesAfter).to.be.gte(ownerFeeSharesBefore);

        const totalSharesAfter = await vault.totalShares();

        // After Alice exits, all remaining shares are owner fee shares.
        expect(totalSharesAfter).to.equal(ownerFeeSharesAfter);
      });
    });

    it("burns the correct number of shares on partial and full withdraw", async () => {
      const aliceAddr = await alice.getAddress();
      const depositAmt = ONE.mul(1_000);

      await initializeVault(depositAmt, depositAmt, aliceAddr);

      let aliceDeposits = await vault.depositsOf(aliceAddr);
      expect(aliceDeposits.length).to.equal(1);

      const depId = aliceDeposits[0];

      let lotBefore = await vault.deposits(depId);
      const userSharesBefore = await vault.userShares(aliceAddr);
      const totalSharesBefore = await vault.totalShares();

      expect(lotBefore.shares).to.equal(userSharesBefore);
      expect(totalSharesBefore).to.equal(userSharesBefore);

      await passLockup();

      // ------------- Partial withdraw -------------
      const halfShares = lotBefore.shares.div(2);

      await vault.connect(alice).withdrawFromDeposit(
        depId,
        halfShares,
        0,
        0,
        await futureDeadline()
      );

      let lotMid = await vault.deposits(depId);
      const userSharesMid = await vault.userShares(aliceAddr);
      const totalSharesMid = await vault.totalShares();

      expect(lotMid.shares).to.equal(lotBefore.shares.sub(halfShares));
      expect(userSharesMid).to.equal(userSharesBefore.sub(halfShares));
      expect(totalSharesMid).to.equal(totalSharesBefore.sub(halfShares));

      aliceDeposits = await vault.depositsOf(aliceAddr);
      expect(aliceDeposits.length).to.equal(1);
      expect(aliceDeposits[0]).to.equal(depId);

      // ------------- Full withdraw remaining shares -------------
      const remaining = lotMid.shares;

      await vault.connect(alice).withdrawFromDeposit(
        depId,
        remaining,
        0,
        0,
        await futureDeadline()
      );

      const lotAfter = await vault.deposits(depId);
      const userSharesAfter = await vault.userShares(aliceAddr);
      const totalSharesAfter = await vault.totalShares();

      expect(lotAfter.user).to.equal(ethers.constants.AddressZero);
      expect(lotAfter.shares).to.equal(0);

      expect(userSharesAfter).to.equal(0);
      expect(totalSharesAfter).to.equal(0);

      aliceDeposits = await vault.depositsOf(aliceAddr);
      expect(aliceDeposits.length).to.equal(0);
    });

    it("withdraw returns pro-rata inventory in balanced state", async () => {
      const aliceAddr = await alice.getAddress();
      const depositAmt = ONE.mul(1_000);

      await initializeVault(depositAmt, depositAmt, aliceAddr);

      const ids = await vault.depositsOf(aliceAddr);
      const depId = ids[0];

      await passLockup();

      const lot = await vault.deposits(depId);
      const sharesToBurn = lot.shares;

      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const supplyBefore = await vault.totalShares();

      const expectedBase = sharesToAsset(sharesToBurn, baseBalBefore, supplyBefore);
      const expectedQuote = sharesToAsset(sharesToBurn, quoteBalBefore, supplyBefore);

      const baseBefore = await token0.balanceOf(aliceAddr);
      const quoteBefore = await token1.balanceOf(aliceAddr);

      await vault.connect(alice).withdrawFromDeposit(
        depId,
        sharesToBurn,
        expectedBase,
        expectedQuote,
        await futureDeadline()
      );

      const baseAfter = await token0.balanceOf(aliceAddr);
      const quoteAfter = await token1.balanceOf(aliceAddr);

      const deltaBase = baseAfter.sub(baseBefore);
      const deltaQuote = quoteAfter.sub(quoteBefore);

      expect(deltaBase).to.equal(expectedBase);
      expect(deltaQuote).to.equal(expectedQuote);
      expect(absDiff(deltaBase, deltaQuote).lte(1)).to.equal(true);
    });

    it("withdraw returns pro-rata inventory when BASE inventory is larger", async () => {
      const aliceAddr = await alice.getAddress();
      const depositAmt = ONE.mul(1_000);

      await initializeVault(depositAmt, depositAmt, aliceAddr);

      const extraBase = ONE.mul(100);
      await token0.transfer(vault.address, extraBase);

      const ids = await vault.depositsOf(aliceAddr);
      const depId = ids[0];

      await passLockup();

      const lot = await vault.deposits(depId);
      const halfShares = lot.shares.div(2);

      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const supplyBefore = await vault.totalShares();

      expect(baseBalBefore).to.be.gt(quoteBalBefore);

      const expectedBase = sharesToAsset(halfShares, baseBalBefore, supplyBefore);
      const expectedQuote = sharesToAsset(halfShares, quoteBalBefore, supplyBefore);

      expect(expectedBase).to.be.gt(expectedQuote);

      const baseBefore = await token0.balanceOf(aliceAddr);
      const quoteBefore = await token1.balanceOf(aliceAddr);

      await vault.connect(alice).withdrawFromDeposit(
        depId,
        halfShares,
        expectedBase,
        expectedQuote,
        await futureDeadline()
      );

      const baseAfter = await token0.balanceOf(aliceAddr);
      const quoteAfter = await token1.balanceOf(aliceAddr);

      expect(baseAfter.sub(baseBefore)).to.equal(expectedBase);
      expect(quoteAfter.sub(quoteBefore)).to.equal(expectedQuote);

      const lotAfter = await vault.deposits(depId);
      expect(lotAfter.shares).to.equal(lot.shares.sub(halfShares));
    });

    it("withdraw returns pro-rata inventory when QUOTE inventory is larger", async () => {
      const aliceAddr = await alice.getAddress();
      const depositAmt = ONE.mul(1_000);

      await initializeVault(depositAmt, depositAmt, aliceAddr);

      const extraQuote = ONE.mul(100);
      await token1.transfer(vault.address, extraQuote);

      const ids = await vault.depositsOf(aliceAddr);
      const depId = ids[0];

      await passLockup();

      const lot = await vault.deposits(depId);
      const halfShares = lot.shares.div(2);

      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const supplyBefore = await vault.totalShares();

      expect(quoteBalBefore).to.be.gt(baseBalBefore);

      const expectedBase = sharesToAsset(halfShares, baseBalBefore, supplyBefore);
      const expectedQuote = sharesToAsset(halfShares, quoteBalBefore, supplyBefore);

      expect(expectedQuote).to.be.gt(expectedBase);

      const baseBefore = await token0.balanceOf(aliceAddr);
      const quoteBefore = await token1.balanceOf(aliceAddr);

      await vault.connect(alice).withdrawFromDeposit(
        depId,
        halfShares,
        expectedBase,
        expectedQuote,
        await futureDeadline()
      );

      const baseAfter = await token0.balanceOf(aliceAddr);
      const quoteAfter = await token1.balanceOf(aliceAddr);

      expect(baseAfter.sub(baseBefore)).to.equal(expectedBase);
      expect(quoteAfter.sub(quoteBefore)).to.equal(expectedQuote);

      const lotAfter = await vault.deposits(depId);
      expect(lotAfter.shares).to.equal(lot.shares.sub(halfShares));
    });

    it("deletes the deposit and updates storage correctly on full withdraw", async () => {
      const aliceAddr = await alice.getAddress();
      const depositAmt = ONE.mul(500);

      await initializeVault(depositAmt, depositAmt, aliceAddr);

      let ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(1);

      const depId = ids[0];

      let lot = await vault.deposits(depId);
      const shares = lot.shares;

      const totalSharesBefore = await vault.totalShares();
      const userSharesBefore = await vault.userShares(aliceAddr);

      expect(totalSharesBefore).to.equal(shares);
      expect(userSharesBefore).to.equal(shares);

      await passLockup();

      await vault.connect(alice).withdrawAllFromDeposit(
        depId,
        0,
        0,
        await futureDeadline()
      );

      lot = await vault.deposits(depId);

      expect(lot.user).to.equal(ethers.constants.AddressZero);
      expect(lot.shares).to.equal(0);

      expect(await vault.totalShares()).to.equal(0);
      expect(await vault.userShares(aliceAddr)).to.equal(0);

      ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Airdrop rewards
  // ─────────────────────────────────────────────────────────────
  describe("airdrop rewards", () => {

    async function futureDeadline(seconds = 3600): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp + seconds;
    }

    async function initializeFor(receiver: string, amount: BigNumber) {
      await token0.connect(deployer).approve(vault.address, amount);
      await token1.connect(deployer).approve(vault.address, amount);

      await vault.connect(deployer).initialize(
        amount,
        amount,
        0, // minSharesOut
        receiver,
        await futureDeadline()
      );

      expect(await vault.initialized()).to.equal(true);
    }

    async function depositFor(
      signer: any,
      userAddr: string,
      baseAmount: BigNumber,
      quoteAmount: BigNumber,
      minSharesOut: BigNumber = BigNumber.from(0)
    ) {
      await token0.transfer(userAddr, baseAmount);
      await token1.transfer(userAddr, quoteAmount);

      await token0.connect(signer).approve(vault.address, baseAmount);
      await token1.connect(signer).approve(vault.address, quoteAmount);

      await vault.connect(signer).depositProRata(
        baseAmount,
        quoteAmount,
        minSharesOut,
        await futureDeadline()
      );
    }

    async function impersonateDistributor() {
      const distAddr = distributor.address;

      await network.provider.send("hardhat_setBalance", [
        distAddr,
        "0x8AC7230489E80000",
      ]);

      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [distAddr],
      });

      return ethers.getSigner(distAddr);
    }

    async function stopImpersonatingDistributor() {
      await network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [distributor.address],
      });
    }

    beforeEach(async () => {
      await distributor.modifyAllowed(token1.address, true);
    });

    it("does not lose a small stream when an account forces frequent updates", async () => {
      const [holder, funder, griefer] = await ethers.getSigners();

      const ERC20 = await ethers.getContractFactory("ERC20Mock");
      const base = await ERC20.deploy("Base", "BASE", 8, 100_000_000);
      const quote = await ERC20.deploy("Quote", "QUOTE", 8, 100_000_000);
      const reward = await ERC20.deploy("Reward", "RWD", 8, 10_000_000);
      await Promise.all([base.deployed(), quote.deployed(), reward.deployed()]);

      const Distributor = await ethers.getContractFactory("AirdropDistributor");
      const testDistributor = await Distributor.deploy();
      await testDistributor.deployed();
      await testDistributor.modifyAllowed(reward.address, true);

      const Vault = await ethers.getContractFactory("PLEXProRataVault");
      const deployVault = async () => {
        const instance = await Vault.deploy(
          base.address,
          quote.address,
          testDistributor.address,
          holder.address,
          0,
          WEEK_SECS,
          DAY_SECS,
          WEEK_SECS
        );
        await instance.deployed();

        const depositAmount = ONE.mul(4_000_000);
        await base.approve(instance.address, depositAmount);
        await quote.approve(instance.address, depositAmount);
        const latest = await ethers.provider.getBlock("latest");
        await instance.initialize(
          depositAmount,
          depositAmount,
          0,
          holder.address,
          latest!.timestamp + 3_600
        );
        return instance;
      };

      const griefed = await deployVault();
      const control = await deployVault();

      const fundAmount = ONE.mul(1_000);
      await reward.transfer(funder.address, fundAmount.mul(2));
      await reward.connect(funder).approve(testDistributor.address, fundAmount.mul(2));
      await testDistributor
        .connect(funder)
        .fund(griefed.address, reward.address, fundAmount);
      await testDistributor
        .connect(funder)
        .fund(control.address, reward.address, fundAmount);

      const start = (await ethers.provider.getBlock("latest"))!.timestamp;
      for (let elapsed = 5; elapsed <= 100; elapsed += 5) {
        await network.provider.send("evm_setNextBlockTimestamp", [start + elapsed]);
        await griefed.connect(griefer).claimRewards(reward.address);
      }

      await network.provider.send("evm_setNextBlockTimestamp", [start + 101]);
      const griefedBefore = await reward.balanceOf(holder.address);
      await griefed.claimRewards(reward.address);
      const griefedClaim = (await reward.balanceOf(holder.address)).sub(griefedBefore);

      const controlBefore = await reward.balanceOf(holder.address);
      await control.claimRewards(reward.address);
      const controlClaim = (await reward.balanceOf(holder.address)).sub(controlBefore);

      const rewardState = await griefed.rewards(reward.address);
      expect(rewardState.perShare).to.be.gt(0);
      expect(rewardState.perShareRemainder).to.be.lt(await griefed.totalShares());
      expect(griefedClaim).to.equal(controlClaim);
      expect(griefedClaim).to.be.gt(1_000_000);
    });

    it("single depositor accrues and can claim streaming rewards funded via distributor", async () => {
      const [, aliceSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();

      const vestingSecs = await vault.vestingSecs();

      // Alice receives the initial shares.
      const depositAmt = ONE.mul(1_000);
      await initializeFor(aliceAddr, depositAmt);

      const aliceShares = await vault.userShares(aliceAddr);
      const totalShares = await vault.totalShares();
      expect(totalShares).to.equal(aliceShares);

      // Fund rewards: 1 token/sec over full vesting.
      const rewardPerSec = ONE;
      const amount = vestingSecs.mul(rewardPerSec);

      await token1.approve(distributor.address, amount);
      await distributor.fund(vault.address, token1.address, amount);

      await increaseTime(vestingSecs.toNumber() + 10);

      const balBefore = await token1.balanceOf(aliceAddr);
      await vault.connect(aliceSigner).claimRewards(token1.address);
      const balAfter = await token1.balanceOf(aliceAddr);

      const claimed = balAfter.sub(balBefore);
      const diff = bnAbs(claimed, amount);

      expect(diff.lte(ONE)).to.equal(true);

      const credited = await distributor.credited(vault.address, token1.address);
      const totalClaimed = await distributor.claimed(vault.address, token1.address);
      const remaining = credited.sub(totalClaimed);

      expect(remaining.lte(ONE)).to.equal(true);
    });

    it("two depositors receive rewards approximately proportional to their shares", async () => {
      const [, aliceSigner, bobSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();
      const bobAddr = await bobSigner.getAddress();

      const vestingSecs = await vault.vestingSecs();

      // Alice initializes with 2000/2000.
      const aliceAmt = ONE.mul(2_000);
      await initializeFor(aliceAddr, aliceAmt);

      // Bob deposits 1000/1000.
      const bobAmt = ONE.mul(1_000);
      await depositFor(bobSigner, bobAddr, bobAmt, bobAmt);

      const aliceShares = await vault.userShares(aliceAddr);
      const bobShares = await vault.userShares(bobAddr);
      const totalShares = await vault.totalShares();

      expect(aliceShares.gt(bobShares)).to.equal(true);
      expect(aliceShares.add(bobShares)).to.equal(totalShares);

      const rewardPerSec = ONE;
      const amount = vestingSecs.mul(rewardPerSec);

      await token1.approve(distributor.address, amount);
      await distributor.fund(vault.address, token1.address, amount);

      await increaseTime(vestingSecs.toNumber() + 5);

      const aBefore = await token1.balanceOf(aliceAddr);
      const bBefore = await token1.balanceOf(bobAddr);

      await vault.connect(aliceSigner).claimRewards(token1.address);
      await vault.connect(bobSigner).claimRewards(token1.address);

      const aAfter = await token1.balanceOf(aliceAddr);
      const bAfter = await token1.balanceOf(bobAddr);

      const aDelta = aAfter.sub(aBefore);
      const bDelta = bAfter.sub(bBefore);
      const totalClaimed = aDelta.add(bDelta);

      const idealAlice = amount.mul(aliceShares).div(totalShares);
      const idealBob = amount.mul(bobShares).div(totalShares);

      expect(bnAbs(totalClaimed, amount).lte(ONE.mul(2))).to.equal(true);
      expect(bnAbs(aDelta, idealAlice).lte(ONE)).to.equal(true);
      expect(bnAbs(bDelta, idealBob).lte(ONE)).to.equal(true);

      expect(aDelta.gt(bDelta)).to.equal(true);
    });

    it("supports multiple overlapping fundings and streams the full combined amount up to dust", async () => {
      const [, aliceSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();

      const vestingSecs = await vault.vestingSecs();

      const depositAmt = ONE.mul(1_000);
      await initializeFor(aliceAddr, depositAmt);

      const aliceShares = await vault.userShares(aliceAddr);
      const totalShares = await vault.totalShares();
      expect(totalShares).to.equal(aliceShares);

      const rewardPerSec = ONE;
      const amount1 = vestingSecs.mul(rewardPerSec);

      await token1.approve(distributor.address, amount1);
      const tx1 = await distributor.fund(vault.address, token1.address, amount1);
      const rcpt1 = await tx1.wait();
      const block1 = await ethers.provider.getBlock(rcpt1.blockNumber);
      if (!block1) throw new Error("block1 not found");

      const t0 = block1.timestamp;

      const half = vestingSecs.div(2);
      const remaining = vestingSecs.sub(half);
      const amount2 = remaining.mul(rewardPerSec);
      const totalFunded = amount1.add(amount2);

      await network.provider.send("evm_setNextBlockTimestamp", [t0 + half.toNumber()]);
      await network.provider.send("evm_mine", []);

      await token1.approve(distributor.address, amount2);
      await distributor.fund(vault.address, token1.address, amount2);

      const R = await vault.rewards(token1.address);
      const periodFinish = R.periodFinish.toNumber();

      await network.provider.send("evm_setNextBlockTimestamp", [periodFinish + 5]);
      await network.provider.send("evm_mine", []);

      const before = await token1.balanceOf(aliceAddr);
      await vault.connect(aliceSigner).claimRewards(token1.address);
      const after = await token1.balanceOf(aliceAddr);

      const claimed = after.sub(before);
      expect(bnAbs(claimed, totalFunded).lte(ONE)).to.equal(true);

      const credited = await distributor.credited(vault.address, token1.address);
      const totalClaimed = await distributor.claimed(vault.address, token1.address);
      const remainingLedger = credited.sub(totalClaimed);

      expect(remainingLedger.lte(ONE)).to.equal(true);
    });

    it("single depositor can claim multiple reward tokens via claimAllRewards", async () => {
      const [, aliceSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();

      const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");
      const rewardB = (await ERC20MockFactory.deploy(
        "RewardB",
        "RWD",
        8,
        INITIAL_MINT
      )) as ERC20Mock;
      await rewardB.deployed();

      await distributor.modifyAllowed(rewardB.address, true);

      const ONE_A = ONE;
      const ONE_B = BigNumber.from(10).pow(await rewardB.decimals());
      const vestingSecs = await vault.vestingSecs();

      const depositAmt = ONE_A.mul(1_000);
      await initializeFor(aliceAddr, depositAmt);

      const aliceShares = await vault.userShares(aliceAddr);
      const totalShares = await vault.totalShares();
      expect(aliceShares).to.equal(totalShares);

      const amountA = vestingSecs.mul(ONE_A);
      await token1.approve(distributor.address, amountA);
      await distributor.fund(vault.address, token1.address, amountA);

      const amountB = vestingSecs.mul(ONE_B.mul(2));
      await rewardB.approve(distributor.address, amountB);
      await distributor.fund(vault.address, rewardB.address, amountB);

      await increaseTime(vestingSecs.toNumber() + 10);

      const balA_before = await token1.balanceOf(aliceAddr);
      const balB_before = await rewardB.balanceOf(aliceAddr);

      await vault.connect(aliceSigner).claimAllRewards();

      const balA_after = await token1.balanceOf(aliceAddr);
      const balB_after = await rewardB.balanceOf(aliceAddr);

      const claimedA = balA_after.sub(balA_before);
      const claimedB = balB_after.sub(balB_before);

      expect(bnAbs(claimedA, amountA).lte(ONE_A)).to.equal(true);
      expect(bnAbs(claimedB, amountB).lte(ONE_B)).to.equal(true);
    });

    it("two depositors claim multiple reward tokens proportionally via claimAllRewards", async () => {
      const [, aliceSigner, bobSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();
      const bobAddr = await bobSigner.getAddress();

      const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");
      const rewardB = (await ERC20MockFactory.deploy(
        "RewardB",
        "RWD",
        8,
        INITIAL_MINT
      )) as ERC20Mock;
      await rewardB.deployed();

      await distributor.modifyAllowed(rewardB.address, true);

      const ONE_A = ONE;
      const ONE_B = BigNumber.from(10).pow(await rewardB.decimals());
      const vestingSecs = await vault.vestingSecs();

      const aliceAmt = ONE_A.mul(2_000);
      const bobAmt = ONE_A.mul(1_000);

      await initializeFor(aliceAddr, aliceAmt);
      await depositFor(bobSigner, bobAddr, bobAmt, bobAmt);

      const aliceShares = await vault.userShares(aliceAddr);
      const bobShares = await vault.userShares(bobAddr);
      const totalShares = await vault.totalShares();

      expect(aliceShares.add(bobShares)).to.equal(totalShares);
      expect(aliceShares.gt(bobShares)).to.equal(true);

      const amountA = vestingSecs.mul(ONE_A);
      const amountB = vestingSecs.mul(ONE_B.mul(3));

      await token1.approve(distributor.address, amountA);
      await distributor.fund(vault.address, token1.address, amountA);

      await rewardB.approve(distributor.address, amountB);
      await distributor.fund(vault.address, rewardB.address, amountB);

      await increaseTime(vestingSecs.toNumber() + 10);

      const a_token1_before = await token1.balanceOf(aliceAddr);
      const a_rewardB_before = await rewardB.balanceOf(aliceAddr);

      const b_token1_before = await token1.balanceOf(bobAddr);
      const b_rewardB_before = await rewardB.balanceOf(bobAddr);

      await vault.connect(aliceSigner).claimAllRewards();
      await vault.connect(bobSigner).claimAllRewards();

      const a_token1_after = await token1.balanceOf(aliceAddr);
      const a_rewardB_after = await rewardB.balanceOf(aliceAddr);

      const b_token1_after = await token1.balanceOf(bobAddr);
      const b_rewardB_after = await rewardB.balanceOf(bobAddr);

      const a_deltaA = a_token1_after.sub(a_token1_before);
      const a_deltaB = a_rewardB_after.sub(a_rewardB_before);

      const b_deltaA = b_token1_after.sub(b_token1_before);
      const b_deltaB = b_rewardB_after.sub(b_rewardB_before);

      const totalClaimedA = a_deltaA.add(b_deltaA);
      const totalClaimedB = a_deltaB.add(b_deltaB);

      const idealAliceA = amountA.mul(aliceShares).div(totalShares);
      const idealBobA = amountA.mul(bobShares).div(totalShares);

      const idealAliceB = amountB.mul(aliceShares).div(totalShares);
      const idealBobB = amountB.mul(bobShares).div(totalShares);

      expect(bnAbs(totalClaimedA, amountA).lte(ONE_A.mul(2))).to.equal(true);
      expect(bnAbs(totalClaimedB, amountB).lte(ONE_B.mul(2))).to.equal(true);

      expect(bnAbs(a_deltaA, idealAliceA).lte(ONE_A)).to.equal(true);
      expect(bnAbs(b_deltaA, idealBobA).lte(ONE_A)).to.equal(true);

      expect(bnAbs(a_deltaB, idealAliceB).lte(ONE_B)).to.equal(true);
      expect(bnAbs(b_deltaB, idealBobB).lte(ONE_B)).to.equal(true);

      expect(a_deltaA.gt(b_deltaA)).to.equal(true);
      expect(a_deltaB.gt(b_deltaB)).to.equal(true);
    });

    it("claimAllRewards does not revert if one reward token claim fails; emits RewardClaimFailed and keeps accrued intact", async () => {
      const [, aliceSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();

      const depositAmt = ONE.mul(1_000);
      await initializeFor(aliceAddr, depositAmt);

      const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");
      const goodReward = (await ERC20MockFactory.deploy(
        "GoodReward",
        "GOOD",
        8,
        INITIAL_MINT
      )) as ERC20Mock;
      await goodReward.deployed();

      const BadRewardTokenFactory = await ethers.getContractFactory("BadRewardToken");
      const badReward = await BadRewardTokenFactory.deploy(
        "BadReward",
        "BAD",
        8,
        distributor.address,
        ethers.utils.parseUnits("1000000000", 8)
      );
      await badReward.deployed();

      await distributor.modifyAllowed(goodReward.address, true);
      await distributor.modifyAllowed(badReward.address, true);

      const rewardAmount = ONE.mul(1_000_000);

      await goodReward.approve(distributor.address, rewardAmount);
      await distributor.fund(vault.address, goodReward.address, rewardAmount);

      await badReward.approve(distributor.address, rewardAmount);
      await distributor.fund(vault.address, badReward.address, rewardAmount);

      await increaseTime(DAY_SECS);

      expect(await goodReward.balanceOf(aliceAddr)).to.equal(0);
      expect(await badReward.balanceOf(aliceAddr)).to.equal(0);

      const tx = await vault.connect(aliceSigner).claimAllRewards();

      await expect(tx)
        .to.emit(vault, "RewardClaimed")
        .withArgs(goodReward.address, aliceAddr, anyValue);

      await expect(tx)
        .to.emit(vault, "RewardClaimFailed")
        .withArgs(badReward.address, aliceAddr, anyValue);

      await tx.wait();

      expect(await goodReward.balanceOf(aliceAddr)).to.be.gt(0);
      expect(await badReward.balanceOf(aliceAddr)).to.equal(0);

      const goodState = await vault.userRewards(aliceAddr, goodReward.address);
      const badState = await vault.userRewards(aliceAddr, badReward.address);

      expect(goodState.accrued).to.equal(0);
      expect(badState.accrued).to.be.gt(0);
    });

    it("owner can write off a permanently stuck reward accrual; non-owner cannot", async () => {
      const [, aliceSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();

      const depositAmt = ONE.mul(1_000);
      await initializeFor(aliceAddr, depositAmt);

      const BadRewardTokenFactory = await ethers.getContractFactory("BadRewardToken");
      const badReward = await BadRewardTokenFactory.deploy(
        "BadReward",
        "BAD",
        8,
        distributor.address,
        ethers.utils.parseUnits("1000000000", 8)
      );
      await badReward.deployed();

      await distributor.modifyAllowed(badReward.address, true);

      const rewardAmount = ONE.mul(1_000_000);
      await badReward.approve(distributor.address, rewardAmount);
      await distributor.fund(vault.address, badReward.address, rewardAmount);

      // Advance past the stream's end so the full amount has vested and no
      // further rewards accrue after the write-off.
      await increaseTime(WEEK_SECS + DAY_SECS);

      // Claim fails (token permanently non-transferable), so the accrual is stuck.
      await vault.connect(aliceSigner).claimRewards(badReward.address);
      const stuck = await vault.userRewards(aliceAddr, badReward.address);
      expect(stuck.accrued).to.be.gt(0);

      // Non-owner cannot write off.
      await expect(
        vault.connect(aliceSigner).ownerWriteOffReward(aliceAddr, badReward.address)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");

      // Owner writes off the stuck accrual, clearing the strand.
      await expect(
        vault.connect(deployer).ownerWriteOffReward(aliceAddr, badReward.address)
      )
        .to.emit(vault, "RewardWrittenOff")
        .withArgs(badReward.address, aliceAddr, anyValue);

      const cleared = await vault.userRewards(aliceAddr, badReward.address);
      expect(cleared.accrued).to.equal(0);

      // Nothing left to write off.
      await expect(
        vault.connect(deployer).ownerWriteOffReward(aliceAddr, badReward.address)
      ).to.be.revertedWith("nothing accrued");
    });

    it("owner cannot destroy a claimable reward: healthy token pays the user instead", async () => {
      const [, aliceSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();

      const depositAmt = ONE.mul(1_000);
      await initializeFor(aliceAddr, depositAmt);

      // A normal, transferable reward token.
      const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");
      const goodReward = (await ERC20MockFactory.deploy(
        "GoodReward",
        "GOOD",
        8,
        INITIAL_MINT
      )) as ERC20Mock;
      await goodReward.deployed();

      await distributor.modifyAllowed(goodReward.address, true);

      const rewardAmount = ONE.mul(1_000_000);
      await goodReward.approve(distributor.address, rewardAmount);
      await distributor.fund(vault.address, goodReward.address, rewardAmount);

      // Stream fully vests; the user has NOT claimed.
      await increaseTime(WEEK_SECS + DAY_SECS);

      const balBefore = await goodReward.balanceOf(aliceAddr);

      // Owner calls the write-off on a healthy token. Because the token is
      // transferable, the vault pays the user rather than destroying the reward.
      const tx = await vault
        .connect(deployer)
        .ownerWriteOffReward(aliceAddr, goodReward.address);

      await expect(tx)
        .to.emit(vault, "RewardClaimed")
        .withArgs(goodReward.address, aliceAddr, anyValue);
      await expect(tx).to.not.emit(vault, "RewardWrittenOff");

      const balAfter = await goodReward.balanceOf(aliceAddr);
      expect(balAfter.sub(balBefore)).to.be.gt(0);

      // Accrual is cleared because it was paid out, not written off.
      const state = await vault.userRewards(aliceAddr, goodReward.address);
      expect(state.accrued).to.equal(0);
    });

    describe("airdrop rewards: onAirdropFunded access control & input sanity", () => {
      it("reverts if called by a non-distributor", async () => {
        await expect(
          vault.onAirdropFunded(token1.address, 1)
        ).to.be.revertedWith("only distributor");

        await expect(
          vault.connect(alice).onAirdropFunded(token1.address, 1)
        ).to.be.revertedWith("only distributor");
      });

      it("reverts if rewardToken is the zero address, even when called by distributor", async () => {
        const distSigner = await impersonateDistributor();

        await expect(
          vault.connect(distSigner).onAirdropFunded(ethers.constants.AddressZero, 1)
        ).to.be.revertedWith("HBAR reward unsupported");

        await stopImpersonatingDistributor();
      });

      it("reverts if netAmount is zero, even when called by distributor", async () => {
        const distSigner = await impersonateDistributor();

        await expect(
          vault.connect(distSigner).onAirdropFunded(token1.address, 0)
        ).to.be.revertedWith("net=0");

        await stopImpersonatingDistributor();
      });

      it("accepts a valid call from the distributor and updates reward state", async () => {
        const distSigner = await impersonateDistributor();

        const rewardToken = token1.address;
        const amount = BigNumber.from(1_000_000);

        const before = await vault.rewards(rewardToken);

        await vault.connect(distSigner).onAirdropFunded(rewardToken, amount);

        const after = await vault.rewards(rewardToken);

        expect(after.rate).to.not.equal(before.rate);
        expect(after.perShare.gte(before.perShare)).to.equal(true);

        await stopImpersonatingDistributor();
      });
    });

    describe("airdrop rewards: no depositors / carry behavior", () => {
      it("accrues rewards into carry when there are no eligible shares", async () => {
        expect(await vault.totalShares()).to.equal(0);

        const rewardToken = token1.address;
        const vestingSecs = await vault.vestingSecs();
        const netAmount = vestingSecs; // rate = 1 unit/sec

        const distSigner = await impersonateDistributor();

        const tx = await vault.connect(distSigner).onAirdropFunded(rewardToken, netAmount);
        const rcpt = await tx.wait();
        const block = await ethers.provider.getBlock(rcpt.blockNumber);
        if (!block) throw new Error("block not found");

        const t0 = block.timestamp;

        let R = await vault.rewards(rewardToken);
        const rate = R.rate;

        expect(R.perShare).to.equal(0);
        expect(rate.mul(vestingSecs)).to.equal(netAmount);
        expect(R.carry).to.equal(0);
        expect(R.lastUpdate).to.equal(t0);
        expect(R.periodFinish).to.equal(t0 + vestingSecs.toNumber());

        const half = Math.floor(vestingSecs.toNumber() / 2);
        await setNextBlockTimestamp(t0 + half);

        await vault.claimRewards(rewardToken);

        R = await vault.rewards(rewardToken);

        const expectedCarry = rate.mul(half);

        expect(R.perShare).to.equal(0);
        expect(bnAbs(R.carry, expectedCarry).lte(1)).to.equal(true);
        expect(bnAbs(R.lastUpdate, BigNumber.from(t0 + half)).lte(1)).to.equal(true);

        await stopImpersonatingDistributor();
      });

      it("rolls accumulated carry into the next stream when funded again with no depositors", async () => {
        expect(await vault.totalShares()).to.equal(0);

        const rewardToken = token1.address;
        const vestingSecs = await vault.vestingSecs();
        const vestingNum = vestingSecs.toNumber();

        const netAmount1 = vestingSecs;
        const netAmount2 = vestingSecs.mul(2);

        const distSigner = await impersonateDistributor();

        let tx = await vault.connect(distSigner).onAirdropFunded(rewardToken, netAmount1);
        let rcpt = await tx.wait();
        let block = await ethers.provider.getBlock(rcpt.blockNumber);
        if (!block) throw new Error("block not found");

        const t0 = block.timestamp;

        await setNextBlockTimestamp(t0 + vestingNum + 1);

        await vault.claimRewards(rewardToken);

        let R = await vault.rewards(rewardToken);

        expect(R.rate).to.equal(0);
        expect(R.lastUpdate).to.equal(R.periodFinish);
        expect(R.carry).to.equal(netAmount1);

        const carryBefore = R.carry;

        tx = await vault.connect(distSigner).onAirdropFunded(rewardToken, netAmount2);
        rcpt = await tx.wait();
        block = await ethers.provider.getBlock(rcpt.blockNumber);
        if (!block) throw new Error("block not found");

        const t1 = block.timestamp;

        R = await vault.rewards(rewardToken);

        const totalToStream = carryBefore.add(netAmount2);
        const expectedRate = totalToStream.div(vestingSecs);
        const expectedRemainder = totalToStream.sub(expectedRate.mul(vestingSecs));

        expect(R.periodFinish).to.equal(t1 + vestingNum);
        expect(R.rate).to.equal(expectedRate);
        expect(R.carry).to.equal(expectedRemainder);
        expect(R.lastUpdate).to.equal(t1);

        await stopImpersonatingDistributor();
      });
    });

    describe("airdrop rewards: join mid-stream", () => {
      beforeEach(async () => {
        await distributor.modifyAllowed(token1.address, true);
      });

      it("sets perSharePaid for a late depositor so they don't earn past rewards", async () => {
        const [, aliceSigner, bobSigner] = await ethers.getSigners();
        const aliceAddr = await aliceSigner.getAddress();
        const bobAddr = await bobSigner.getAddress();

        const rewardToken = token1;
        const depositAmt = ONE.mul(1_000);

        await initializeFor(aliceAddr, depositAmt);

        const rewardAmount = ONE.mul(1_000_000);

        await token1.approve(distributor.address, rewardAmount);
        await distributor.fund(vault.address, rewardToken.address, rewardAmount);

        await increaseTime(Math.floor(WEEK_SECS / 4));

        await depositFor(bobSigner, bobAddr, depositAmt, depositAmt);

        const bobShares = await vault.userShares(bobAddr);
        expect(bobShares).to.be.gt(0);

        const bobUR = await vault.userRewards(bobAddr, rewardToken.address);
        const R = await vault.rewards(rewardToken.address);

        expect(bobUR.accrued).to.equal(0);
        expect(bobUR.perSharePaid).to.equal(R.perShare);
      });

      it("late depositor earns less than early depositor with equal deposits", async () => {
        const [, aliceSigner, bobSigner] = await ethers.getSigners();
        const aliceAddr = await aliceSigner.getAddress();
        const bobAddr = await bobSigner.getAddress();

        const rewardToken = token1;
        const depositAmt = ONE.mul(1_000);
        const vestingSecs = (await vault.vestingSecs()).toNumber();

        await initializeFor(aliceAddr, depositAmt);

        const aliceShares = await vault.userShares(aliceAddr);
        expect(aliceShares).to.be.gt(0);

        const rewardAmount = ONE.mul(1_000_000);

        await rewardToken.approve(distributor.address, rewardAmount);
        await distributor.fund(vault.address, rewardToken.address, rewardAmount);

        await increaseTime(Math.floor(vestingSecs / 2));

        await depositFor(bobSigner, bobAddr, depositAmt, depositAmt);

        const bobShares = await vault.userShares(bobAddr);

        // Equal pro-rata deposit should be extremely close, but virtual offsets may make it not exact.
        const shareDiff = bnAbs(aliceShares, bobShares);
        expect(shareDiff.mul(10_000).div(aliceShares).lte(1)).to.equal(true);

        await increaseTime(Math.floor(vestingSecs / 2) + 5);

        const aliceBefore = await rewardToken.balanceOf(aliceAddr);
        const bobBefore = await rewardToken.balanceOf(bobAddr);

        await vault.connect(aliceSigner).claimRewards(rewardToken.address);
        await vault.connect(bobSigner).claimRewards(rewardToken.address);

        const aliceAfter = await rewardToken.balanceOf(aliceAddr);
        const bobAfter = await rewardToken.balanceOf(bobAddr);

        const aliceDelta = aliceAfter.sub(aliceBefore);
        const bobDelta = bobAfter.sub(bobBefore);

        expect(bobDelta).to.be.gt(0);
        expect(aliceDelta).to.be.gt(bobDelta);

        const ratioBps = aliceDelta.mul(10_000).div(bobDelta);
        expect(ratioBps).to.be.closeTo(BigNumber.from(30_000), BigNumber.from(1_000));
      });

      it("late depositor mid-stream has perSharePaid synced and cannot earn past rewards", async () => {
        const [, aliceSigner, bobSigner] = await ethers.getSigners();
        const aliceAddr = await aliceSigner.getAddress();
        const bobAddr = await bobSigner.getAddress();

        const rewardToken = token1;
        const depositAmt = ONE.mul(1_000);

        await initializeFor(aliceAddr, depositAmt);

        const rewardAmount = ONE.mul(1_000_000);

        await rewardToken.approve(distributor.address, rewardAmount);
        await distributor.fund(vault.address, rewardToken.address, rewardAmount);

        await increaseTime(Math.floor(WEEK_SECS / 3));

        await depositFor(bobSigner, bobAddr, depositAmt, depositAmt);

        const R = await vault.rewards(rewardToken.address);
        const U = await vault.userRewards(bobAddr, rewardToken.address);

        expect(U.perSharePaid).to.equal(R.perShare);
        expect(U.accrued).to.equal(0);
      });

      it("user exits to 0 shares and re-enters later without earning during the gap", async () => {
        const [, aliceSigner] = await ethers.getSigners();
        const aliceAddr = await aliceSigner.getAddress();
        const deployerAddr = await deployer.getAddress();

        const depositAmt = ONE.mul(1_000);
        const rewardToken = token1;

        // Keep vault alive with deployer shares, so Alice can exit and later re-enter.
        await initializeFor(deployerAddr, depositAmt);
        await depositFor(aliceSigner, aliceAddr, depositAmt, depositAmt);

        const rewardAmount = ONE.mul(1_000_000);

        await rewardToken.approve(distributor.address, rewardAmount);
        await distributor.fund(vault.address, rewardToken.address, rewardAmount);

        await increaseTime(24 * 60 * 60 + 5);

        const depositIds = await vault.depositsOf(aliceAddr);
        await vault.connect(aliceSigner).withdrawAllFromDeposit(
          depositIds[0],
          0,
          0,
          await futureDeadline()
        );

        expect(await vault.userShares(aliceAddr)).to.equal(0);

        await vault.connect(aliceSigner).claimRewards(rewardToken.address);

        const afterClaim = await vault.userRewards(aliceAddr, rewardToken.address);
        expect(afterClaim.accrued).to.equal(0);

        await increaseTime(Math.floor(WEEK_SECS / 4));

        await depositFor(aliceSigner, aliceAddr, depositAmt, depositAmt);

        const R = await vault.rewards(rewardToken.address);
        const U = await vault.userRewards(aliceAddr, rewardToken.address);

        expect(U.perSharePaid).to.equal(R.perShare);
      });

      it("late depositor mid-stream syncs perSharePaid for multiple reward tokens", async () => {
        const [deployerSigner, aliceSigner, bobSigner] = await ethers.getSigners();
        const aliceAddr = await aliceSigner.getAddress();
        const bobAddr = await bobSigner.getAddress();

        const depositAmt = ONE.mul(1_000);

        const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");
        const reward2 = await ERC20MockFactory.deploy("Reward2", "R2", 8, INITIAL_MINT);
        await reward2.deployed();

        await distributor.modifyAllowed(reward2.address, true);

        await initializeFor(aliceAddr, depositAmt);

        const amt1 = ONE.mul(500_000);
        const amt2 = ONE.mul(700_000);

        await token1.connect(deployerSigner).approve(distributor.address, amt1);
        await distributor.fund(vault.address, token1.address, amt1);

        await reward2.connect(deployerSigner).approve(distributor.address, amt2);
        await distributor.fund(vault.address, reward2.address, amt2);

        await increaseTime(Math.floor(WEEK_SECS / 3));

        await depositFor(bobSigner, bobAddr, depositAmt, depositAmt);

        const R1 = await vault.rewards(token1.address);
        const U1 = await vault.userRewards(bobAddr, token1.address);

        expect(U1.perSharePaid).to.equal(R1.perShare);
        expect(U1.accrued).to.equal(0);

        const R2 = await vault.rewards(reward2.address);
        const U2 = await vault.userRewards(bobAddr, reward2.address);

        expect(U2.perSharePaid).to.equal(R2.perShare);
        expect(U2.accrued).to.equal(0);
      });

      it("sum of claims cannot exceed distributor credited amount", async () => {
        const [, aliceSigner, bobSigner] = await ethers.getSigners();
        const aliceAddr = await aliceSigner.getAddress();
        const bobAddr = await bobSigner.getAddress();

        const depositAmt = ONE.mul(1_000);
        const rewardToken = token1;

        await initializeFor(aliceAddr, depositAmt);
        await depositFor(bobSigner, bobAddr, depositAmt, depositAmt);

        const rewardAmount = ONE.mul(1_000_000);

        await rewardToken.approve(distributor.address, rewardAmount);
        await distributor.fund(vault.address, rewardToken.address, rewardAmount);

        await increaseTime(Math.floor(WEEK_SECS / 3));
        await vault.connect(aliceSigner).claimRewards(rewardToken.address);

        await increaseTime(Math.floor(WEEK_SECS / 3));
        await vault.connect(bobSigner).claimRewards(rewardToken.address);

        await increaseTime(Math.floor(WEEK_SECS / 3));
        await vault.connect(aliceSigner).claimRewards(rewardToken.address);
        await vault.connect(bobSigner).claimRewards(rewardToken.address);

        const credited = await distributor.credited(vault.address, rewardToken.address);
        const claimed = await distributor.claimed(vault.address, rewardToken.address);

        expect(claimed).to.be.lte(credited);
      });

      it("management fee shares do not earn / dilute airdrops", async () => {
        const [deployerSigner, aliceSigner] = await ethers.getSigners();

        const deployerAddr = await deployerSigner.getAddress();
        const aliceAddr = await aliceSigner.getAddress();

        const depositAmt = ONE.mul(1_000);

        const VaultF = await ethers.getContractFactory("PLEXProRataVault");
        const feeBips = 1_000;

        const feeVault = (await VaultF.deploy(
          token0.address,
          token1.address,
          distributor.address,
          deployerAddr,
          feeBips,
          WEEK_SECS,
          DAY_SECS,
          WEEK_SECS
        )) as PLEXProRataVault;

        await feeVault.deployed();

        await token0.connect(deployerSigner).approve(feeVault.address, depositAmt);
        await token1.connect(deployerSigner).approve(feeVault.address, depositAmt);

        await feeVault.connect(deployerSigner).initialize(
          depositAmt,
          depositAmt,
          0,
          aliceAddr,
          await futureDeadline()
        );

        await network.provider.send("evm_increaseTime", [WEEK_SECS + 1]);
        await network.provider.send("evm_mine");

        await feeVault.connect(deployerSigner).scheduleOwnerFeeBips(feeBips);

        const ownerFeeShares = await feeVault.ownerFeeShares();
        expect(ownerFeeShares).to.be.gt(0);

        const ERC20MockF = await ethers.getContractFactory("ERC20Mock");
        const reward = await ERC20MockF.deploy("Reward", "RWD", 8, INITIAL_MINT);
        await reward.deployed();

        await distributor.modifyAllowed(reward.address, true);

        const rewardAmount = ONE.mul(1_000_000);

        await reward.approve(distributor.address, rewardAmount);
        await distributor.fund(feeVault.address, reward.address, rewardAmount);

        const vesting = await feeVault.vestingSecs();

        await network.provider.send("evm_increaseTime", [vesting.toNumber() + 3]);
        await network.provider.send("evm_mine");

        const aliceRewardBefore = await reward.balanceOf(aliceAddr);
        await feeVault.connect(aliceSigner).claimRewards(reward.address);
        const aliceRewardAfter = await reward.balanceOf(aliceAddr);

        const aliceClaimed = aliceRewardAfter.sub(aliceRewardBefore);

        const ownerRewardBefore = await reward.balanceOf(deployerAddr);
        await feeVault.connect(deployerSigner).claimRewards(reward.address);
        const ownerRewardAfter = await reward.balanceOf(deployerAddr);

        const ownerClaimed = ownerRewardAfter.sub(ownerRewardBefore);
        expect(ownerClaimed).to.equal(0);

        const remaining = await distributor.remaining(feeVault.address, reward.address);

        const tol = ONE.mul(5);

        expect(bnAbs(aliceClaimed.add(remaining), rewardAmount)).to.be.lte(tol);
        expect(rewardAmount.sub(aliceClaimed).lte(tol)).to.equal(true);
      });

      it("emergency withdraw settles rewards so accrued rewards are still claimable", async () => {
        const [deployerSigner, aliceSigner] = await ethers.getSigners();
        const aliceAddr = await aliceSigner.getAddress();

        const depositAmt = ONE.mul(1_000);

        const ERC20MockF = await ethers.getContractFactory("ERC20Mock");
        const reward = await ERC20MockF.deploy("Reward", "RWD", 8, INITIAL_MINT);
        await reward.deployed();

        await distributor.modifyAllowed(reward.address, true);

        await initializeFor(aliceAddr, depositAmt);

        const depositIds = await vault.depositsOf(aliceAddr);
        const depositId = depositIds[0];

        const rewardAmount = ONE.mul(100_000);

        await reward.approve(distributor.address, rewardAmount);
        await distributor.fund(vault.address, reward.address, rewardAmount);

        await network.provider.send("evm_increaseTime", [DAY_SECS]);
        await network.provider.send("evm_mine");

        await vault.connect(deployerSigner).enableEmergencyMode();

        await vault.connect(aliceSigner).emergencyWithdrawFromDeposit(depositId);

        const ur = await vault.userRewards(aliceAddr, reward.address);
        expect(ur.accrued).to.be.gt(0);

        const balBefore = await reward.balanceOf(aliceAddr);
        await vault.connect(aliceSigner).claimRewards(reward.address);
        const balAfter = await reward.balanceOf(aliceAddr);

        expect(balAfter.sub(balBefore)).to.equal(ur.accrued);

        const urAfter = await vault.userRewards(aliceAddr, reward.address);
        expect(urAfter.accrued).to.equal(0);

        await network.provider.send("evm_increaseTime", [(await vault.vestingSecs()).toNumber()]);
        await network.provider.send("evm_mine");

        const balMid = await reward.balanceOf(aliceAddr);
        await vault.connect(aliceSigner).claimRewards(reward.address);
        const balEnd = await reward.balanceOf(aliceAddr);

        expect(balEnd).to.equal(balMid);

        const Rbefore = await vault.rewards(reward.address);
        const carryBefore = Rbefore.carry;
        expect(carryBefore).to.be.gt(0);

        const refill = ONE.mul(10_000);

        await reward.approve(distributor.address, refill);
        await distributor.fund(vault.address, reward.address, refill);

        const Rafter = await vault.rewards(reward.address);

        const vestingSecs = await vault.vestingSecs();
        const totalToStream = carryBefore.add(refill);

        const expectedRate = totalToStream.div(vestingSecs);
        const expectedCarryRemainder = totalToStream.sub(expectedRate.mul(vestingSecs));

        expect(Rafter.rate).to.equal(expectedRate);
        expect(Rafter.carry).to.equal(expectedCarryRemainder);
      });
    });
  });
  describe("airdrop rewards: state machine fuzz (anti-steal)", () => {
    // deterministic PRNG (mulberry32)
    function mulberry32(seed: number) {
      return function () {
        let t = (seed += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function randInt(rng: () => number, min: number, max: number) {
      return Math.floor(rng() * (max - min + 1)) + min;
    }

    async function futureDeadline(seconds = 3600): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp + seconds;
    }

    async function initializeVault(receiver: string, amount: BigNumber) {
      await token0.connect(deployer).approve(vault.address, amount);
      await token1.connect(deployer).approve(vault.address, amount);

      await vault.connect(deployer).initialize(
        amount,
        amount,
        0, // minSharesOut
        receiver,
        await futureDeadline()
      );

      expect(await vault.initialized()).to.equal(true);
    }

    it("random sequence cannot create retroactive rewards on 0->>0 shares transitions", async () => {
      const rng = mulberry32(1337);

      const [deployerSigner, aliceSigner, bobSigner, carolSigner] =
        await ethers.getSigners();

      const deployerAddr = await deployerSigner.getAddress();
      const aliceAddr = await aliceSigner.getAddress();
      const bobAddr = await bobSigner.getAddress();
      const carolAddr = await carolSigner.getAddress();

      const depositUnit = ONE.mul(100);
      const STEP_COUNT = 80;

      // Keep the pro-rata vault alive with a sentinel LP.
      // Fuzz users may churn to 0 shares; deployer remains in the vault.
      await initializeVault(deployerAddr, depositUnit);

      // ---- deploy 2 reward tokens (avoid mixing with BASE/QUOTE) ----
      const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");

      const rewardA = (await ERC20MockFactory.deploy(
        "RewardA",
        "RWA",
        8,
        INITIAL_MINT
      )) as ERC20Mock;
      await rewardA.deployed();

      const rewardB = (await ERC20MockFactory.deploy(
        "RewardB",
        "RWB",
        8,
        INITIAL_MINT
      )) as ERC20Mock;
      await rewardB.deployed();

      await distributor.modifyAllowed(rewardA.address, true);
      await distributor.modifyAllowed(rewardB.address, true);

      await rewardA
        .connect(deployerSigner)
        .approve(distributor.address, ethers.constants.MaxUint256);
      await rewardB
        .connect(deployerSigner)
        .approve(distributor.address, ethers.constants.MaxUint256);

      // Users approve vault for deposits.
      for (const s of [aliceSigner, bobSigner, carolSigner]) {
        await token0.connect(s).approve(vault.address, ethers.constants.MaxUint256);
        await token1.connect(s).approve(vault.address, ethers.constants.MaxUint256);
      }

      // Seed both reward streams.
      await distributor.fund(vault.address, rewardA.address, ONE.mul(50_000));
      await distributor.fund(vault.address, rewardB.address, ONE.mul(80_000));

      const fundedRewardTokens: string[] = [rewardA.address, rewardB.address];

      const lastPerShare: Record<string, BigNumber> = {
        [rewardA.address]: BigNumber.from(0),
        [rewardB.address]: BigNumber.from(0),
      };

      async function assertPerShareMonotonic() {
        for (const rt of fundedRewardTokens) {
          const R = await vault.rewards(rt);
          expect(R.perShare.gte(lastPerShare[rt])).to.equal(true);
          lastPerShare[rt] = R.perShare;
        }
      }

      async function maybeTopUpForDeposit(userAddr: string) {
        const bal0 = await token0.balanceOf(userAddr);
        const bal1 = await token1.balanceOf(userAddr);

        if (bal0.lt(depositUnit)) {
          await token0.transfer(userAddr, depositUnit.sub(bal0));
        }

        if (bal1.lt(depositUnit)) {
          await token1.transfer(userAddr, depositUnit.sub(bal1));
        }
      }

      async function pickUnlockedDepositId(
        userAddr: string
      ): Promise<BigNumber | null> {
        const ids = await vault.depositsOf(userAddr);
        if (ids.length === 0) return null;

        const latest = await ethers.provider.getBlock("latest");
        const nowTs = latest!.timestamp;

        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const d = await vault.deposits(id);

          if (
            d.shares.gt(0) &&
            d.user.toLowerCase() === userAddr.toLowerCase() &&
            BigNumber.from(nowTs).gte(d.lockupUntil)
          ) {
            return id;
          }
        }

        return null;
      }

      function signerFor(userAddr: string) {
        if (userAddr === aliceAddr) return aliceSigner;
        if (userAddr === bobAddr) return bobSigner;
        return carolSigner;
      }

      async function invariantNoRetroRewardsOnJoin(
        userAddr: string,
        depositBlockTs: number,
        didJoinFromZero: boolean
      ) {
        if (!didJoinFromZero) return;

        // A) perSharePaid must be synced and accrued must be zero.
        for (const rt of fundedRewardTokens) {
          const R = await vault.rewards(rt);
          const U = await vault.userRewards(userAddr, rt);

          expect(U.perSharePaid).to.equal(R.perShare);
          expect(U.accrued).to.equal(0);
        }

        // B) immediate claim must not scoop old rewards.
        const balBeforeA = await rewardA.balanceOf(userAddr);
        const balBeforeB = await rewardB.balanceOf(userAddr);

        const claimTx = await vault.connect(signerFor(userAddr)).claimAllRewards();
        const claimRcpt = await claimTx.wait();
        const claimBlock = await ethers.provider.getBlock(claimRcpt.blockNumber);
        const claimTs = claimBlock!.timestamp;

        const dt = Math.max(0, claimTs - depositBlockTs);

        const balAfterA = await rewardA.balanceOf(userAddr);
        const balAfterB = await rewardB.balanceOf(userAddr);

        const gotA = balAfterA.sub(balBeforeA);
        const gotB = balAfterB.sub(balBeforeB);

        const RA = await vault.rewards(rewardA.address);
        const RB = await vault.rewards(rewardB.address);

        // Safe upper bound: total emission over dt seconds.
        // If retroactive rewards are claimable, this will be hugely exceeded.
        const boundA = RA.rate.mul(dt).add(ONE);
        const boundB = RB.rate.mul(dt).add(ONE);

        expect(gotA).to.be.lte(boundA);
        expect(gotB).to.be.lte(boundB);
      }

      const users = [
        { signer: aliceSigner, addr: aliceAddr },
        { signer: bobSigner, addr: bobAddr },
        { signer: carolSigner, addr: carolAddr },
      ];

      for (let step = 0; step < STEP_COUNT; step++) {
        const roll = randInt(rng, 0, 99);

        // 0-19: time travel
        if (roll < 20) {
          const seconds =
            rng() < 0.7
              ? randInt(rng, 1, 3000)
              : randInt(rng, DAY_SECS + 1, 3 * DAY_SECS);

          await increaseTime(seconds);
          await assertPerShareMonotonic();
          continue;
        }

        // 20-34: fund rewards
        if (roll < 35) {
          const which = rng() < 0.5 ? rewardA : rewardB;
          const amt = ONE.mul(randInt(rng, 1_000, 50_000));

          await distributor.fund(vault.address, which.address, amt);
          await assertPerShareMonotonic();
          continue;
        }

        // 35-64: deposit
        if (roll < 65) {
          const u = users[randInt(rng, 0, users.length - 1)];

          await maybeTopUpForDeposit(u.addr);

          const preShares = await vault.userShares(u.addr);
          const didJoinFromZero = preShares.eq(0);

          // If the user had old settled rewards from a previous position,
          // clear them before testing the 0 -> >0 anti-steal invariant.
          if (didJoinFromZero) {
            await vault.connect(u.signer).claimAllRewards();

            for (const rt of fundedRewardTokens) {
              const U = await vault.userRewards(u.addr, rt);
              expect(U.accrued).to.equal(0);
            }
          }

          const tx = await vault.connect(u.signer).depositProRata(
            depositUnit,
            depositUnit,
            0, // minSharesOut
            await futureDeadline()
          );

          const rcpt = await tx.wait();
          const blk = await ethers.provider.getBlock(rcpt.blockNumber);
          const depositTs = blk!.timestamp;

          const postShares = await vault.userShares(u.addr);
          if (didJoinFromZero) expect(postShares).to.be.gt(0);

          await invariantNoRetroRewardsOnJoin(
            u.addr,
            depositTs,
            didJoinFromZero
          );

          await assertPerShareMonotonic();
          continue;
        }

        // 65-84: withdraw
        if (roll < 85) {
          const u = users[randInt(rng, 0, users.length - 1)];
          const depId = await pickUnlockedDepositId(u.addr);

          if (!depId) {
            await assertPerShareMonotonic();
            continue;
          }

          const d = await vault.deposits(depId);
          if (d.shares.eq(0)) {
            await assertPerShareMonotonic();
            continue;
          }

          const burn =
            rng() < 0.4
              ? d.shares
              : d.shares.div(2).gt(0)
                ? d.shares.div(2)
                : d.shares;

          await vault.connect(u.signer).withdrawFromDeposit(
            depId,
            burn,
            0,
            0,
            await futureDeadline()
          );

          await assertPerShareMonotonic();
          continue;
        }

        // 85-99: claim actions
        {
          const u = users[randInt(rng, 0, users.length - 1)];

          if (rng() < 0.5) {
            await vault.connect(u.signer).claimAllRewards();
          } else {
            const which = rng() < 0.5 ? rewardA.address : rewardB.address;
            await vault.connect(u.signer).claimRewards(which);
          }

          await assertPerShareMonotonic();
        }
      }

      // Final sanity: no one can have perSharePaid > perShare for funded tokens.
      for (const u of users) {
        for (const rt of fundedRewardTokens) {
          const R = await vault.rewards(rt);
          const U = await vault.userRewards(u.addr, rt);
          expect(U.perSharePaid).to.be.lte(R.perShare);
        }
      }

      // Distributor claimed never exceeds credited.
      for (const rt of fundedRewardTokens) {
        const credited = await distributor.credited(vault.address, rt);
        const claimed = await distributor.claimed(vault.address, rt);
        expect(claimed).to.be.lte(credited);
      }
    });
  });
  describe("airdrop rewards: forced re-entry fuzz (anti-steal)", () => {
    async function futureDeadline(seconds = 3600): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp + seconds;
    }

    async function ensureUserHasDepositTokens(userAddr: string, amount: BigNumber) {
      const b0 = await token0.balanceOf(userAddr);
      const b1 = await token1.balanceOf(userAddr);

      if (b0.lt(amount)) await token0.transfer(userAddr, amount.sub(b0));
      if (b1.lt(amount)) await token1.transfer(userAddr, amount.sub(b1));
    }

    it("repeated 0->>0 re-entries cannot claim past stream rewards", async () => {
      const [deployerSigner, aliceSigner, bobSigner] =
        await ethers.getSigners();

      const aliceAddr = await aliceSigner.getAddress();
      const bobAddr = await bobSigner.getAddress();

      const depositAmt = ONE.mul(1_000);
      const fundAmtA = ONE.mul(500_000);
      const fundAmtB = ONE.mul(800_000);

      const LOCKUP = (await vault.lockupSecs()).toNumber();
      const VESTING = (await vault.vestingSecs()).toNumber();

      // Deploy 2 reward tokens distinct from BASE/QUOTE.
      const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");

      const rewardA = (await ERC20MockFactory.deploy(
        "RewardA",
        "RWA",
        8,
        INITIAL_MINT
      )) as ERC20Mock;
      await rewardA.deployed();

      const rewardB = (await ERC20MockFactory.deploy(
        "RewardB",
        "RWB",
        8,
        INITIAL_MINT
      )) as ERC20Mock;
      await rewardB.deployed();

      await distributor.modifyAllowed(rewardA.address, true);
      await distributor.modifyAllowed(rewardB.address, true);

      await rewardA
        .connect(deployerSigner)
        .approve(distributor.address, ethers.constants.MaxUint256);
      await rewardB
        .connect(deployerSigner)
        .approve(distributor.address, ethers.constants.MaxUint256);

      await token0
        .connect(aliceSigner)
        .approve(vault.address, ethers.constants.MaxUint256);
      await token1
        .connect(aliceSigner)
        .approve(vault.address, ethers.constants.MaxUint256);
      await token0
        .connect(bobSigner)
        .approve(vault.address, ethers.constants.MaxUint256);
      await token1
        .connect(bobSigner)
        .approve(vault.address, ethers.constants.MaxUint256);

      // Bob is the permanent LP. The manager initializes the vault with Bob as receiver.
      await token0.connect(deployerSigner).approve(vault.address, depositAmt);
      await token1.connect(deployerSigner).approve(vault.address, depositAmt);

      await vault.connect(deployerSigner).initialize(
        depositAmt,
        depositAmt,
        0,
        bobAddr,
        await futureDeadline()
      );

      expect(await vault.userShares(bobAddr)).to.be.gt(0);

      // Fund both rewards to start streaming.
      await distributor.fund(vault.address, rewardA.address, fundAmtA);
      await distributor.fund(vault.address, rewardB.address, fundAmtB);

      const funded = [rewardA.address, rewardB.address];

      async function withdrawAllLots(userSigner: any, userAddr: string) {
        const ids = await vault.depositsOf(userAddr);

        for (const id of ids) {
          const d = await vault.deposits(id);

          if (
            d.shares.gt(0) &&
            d.user.toLowerCase() === userAddr.toLowerCase()
          ) {
            await vault.connect(userSigner).withdrawFromDeposit(
              id,
              d.shares,
              0,
              0,
              await futureDeadline()
            );
          }
        }
      }

      async function assertJoinSync(userAddr: string) {
        for (const rt of funded) {
          const R = await vault.rewards(rt);
          const U = await vault.userRewards(userAddr, rt);

          expect(U.perSharePaid).to.equal(R.perShare);
          expect(U.accrued).to.equal(0);
        }
      }

      async function assertImmediateClaimNotPast(
        userSigner: any,
        userAddr: string,
        depositBlockTs: number
      ) {
        const balBeforeA = await rewardA.balanceOf(userAddr);
        const balBeforeB = await rewardB.balanceOf(userAddr);

        const tx = await vault.connect(userSigner).claimAllRewards();
        const rcpt = await tx.wait();
        const blk = await ethers.provider.getBlock(rcpt.blockNumber);
        const claimTs = blk!.timestamp;

        const dt = Math.max(0, claimTs - depositBlockTs);

        const balAfterA = await rewardA.balanceOf(userAddr);
        const balAfterB = await rewardB.balanceOf(userAddr);

        const gotA = balAfterA.sub(balBeforeA);
        const gotB = balAfterB.sub(balBeforeB);

        const RA = await vault.rewards(rewardA.address);
        const RB = await vault.rewards(rewardB.address);

        const slack = ONE;
        const boundA = RA.rate.mul(dt).add(slack);
        const boundB = RB.rate.mul(dt).add(slack);

        expect(gotA).to.be.lte(boundA);
        expect(gotB).to.be.lte(boundB);
      }

      const CYCLES = 4;

      for (let i = 0; i < CYCLES; i++) {
        // If Alice is out, deposit her in.
        if ((await vault.userShares(aliceAddr)).eq(0)) {
          // Clear any old accrued reward before testing re-entry behavior.
          await vault.connect(aliceSigner).claimAllRewards();

          for (const rt of funded) {
            const U = await vault.userRewards(aliceAddr, rt);
            expect(U.accrued).to.equal(0);
          }

          await ensureUserHasDepositTokens(aliceAddr, depositAmt);

          const tx = await vault.connect(aliceSigner).depositProRata(
            depositAmt,
            depositAmt,
            0,
            await futureDeadline()
          );

          await tx.wait();

          await assertJoinSync(aliceAddr);
        }

        // Wait so Alice can withdraw.
        await increaseTime(LOCKUP + 2);

        // Clear any legitimately accrued rewards before exit.
        await vault.connect(aliceSigner).claimAllRewards();

        // Exit fully.
        await withdrawAllLots(aliceSigner, aliceAddr);
        expect(await vault.userShares(aliceAddr)).to.equal(0);

        // Claim rewards settled during withdrawal so the next re-entry starts clean.
        await vault.connect(aliceSigner).claimAllRewards();

        const afterExit = await vault.userRewards(aliceAddr, rewardA.address);
        expect(afterExit.accrued).to.equal(0);

        // Let stream accrue to Bob only.
        await increaseTime(Math.floor(VESTING / (CYCLES + 1)));

        // If stream ended, re-fund both streams.
        const R = await vault.rewards(rewardA.address);
        if (R.rate.eq(0)) {
          await distributor.fund(vault.address, rewardA.address, ONE.mul(200_000));
          await distributor.fund(vault.address, rewardB.address, ONE.mul(200_000));
        }

        // Alice re-enters from 0 shares.
        const preShares = await vault.userShares(aliceAddr);
        expect(preShares).to.equal(0);

        await ensureUserHasDepositTokens(aliceAddr, depositAmt);

        const depTx = await vault.connect(aliceSigner).depositProRata(
          depositAmt,
          depositAmt,
          0,
          await futureDeadline()
        );

        const depRcpt = await depTx.wait();
        const depBlk = await ethers.provider.getBlock(depRcpt.blockNumber);
        const depTs = depBlk!.timestamp;

        const postShares = await vault.userShares(aliceAddr);
        expect(postShares).to.be.gt(0);

        await assertJoinSync(aliceAddr);
        await assertImmediateClaimNotPast(aliceSigner, aliceAddr, depTs);
      }

      for (const rt of funded) {
        const credited = await distributor.credited(vault.address, rt);
        const claimed = await distributor.claimed(vault.address, rt);
        expect(claimed).to.be.lte(credited);
      }

      await vault.connect(bobSigner).claimAllRewards();
      await vault.connect(aliceSigner).claimAllRewards();

      const bobA = await rewardA.balanceOf(bobAddr);
      const aliceA = await rewardA.balanceOf(aliceAddr);

      expect(bobA).to.be.gte(aliceA);
    });
  });
  // ─────────────────────────────────────────────────────────────
  // Virtual offset
  // ─────────────────────────────────────────────────────────────
  describe("virtual offset", () => {

    async function futureDeadline(seconds = 3600): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp + seconds;
    }

    async function passLockup() {
      const lockupSecs = (await vault.lockupSecs()).toNumber();
      await increaseTime(lockupSecs + 1);
    }

    async function initializeVault(
      baseAmount: BigNumber,
      quoteAmount: BigNumber,
      receiver?: string
    ) {
      const receiverAddr = receiver ?? (await deployer.getAddress());

      await token0.connect(deployer).approve(vault.address, baseAmount);
      await token1.connect(deployer).approve(vault.address, quoteAmount);

      await vault.connect(deployer).initialize(
        baseAmount,
        quoteAmount,
        0,
        receiverAddr,
        await futureDeadline()
      );

      expect(await vault.initialized()).to.equal(true);
    }

    async function parseDepositedProRata(receipt: any) {
      const ev = receipt.events?.find((e: any) => e.event === "DepositedProRata");
      expect(ev, "DepositedProRata event not found").to.exist;

      const args = ev.args;

      return {
        user: args.user,
        depositId: args.depositId,
        baseIn: args.baseIn,
        quoteIn: args.quoteIn,
        sharesMinted: args.sharesMinted,
        baseBalanceBefore: args.baseBalanceBefore,
        quoteBalanceBefore: args.quoteBalanceBefore,
      };
    }

    it("post-initialization deposit uses virtual-offset share math", async () => {
      const bobAddr = await bob.getAddress();

      // Use tiny amounts so the virtual offsets materially affect the result.
      // With 8-decimal tokens, 1 raw unit normalizes to 1e10 and initial shares = 1e10.
      const tiny = BigNumber.from(1);

      await initializeVault(tiny, tiny);

      const supplyBefore = await vault.totalShares();
      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);

      expect(baseBalBefore).to.equal(tiny);
      expect(quoteBalBefore).to.equal(tiny);
      expect(supplyBefore).to.be.gt(0);

      await token0.transfer(bobAddr, tiny);
      await token1.transfer(bobAddr, tiny);
      await token0.connect(bob).approve(vault.address, tiny);
      await token1.connect(bob).approve(vault.address, tiny);

      const expected = expectedDepositPreview(
        tiny,
        tiny,
        baseBalBefore,
        quoteBalBefore,
        supplyBefore
      );

      // This should be roughly half of the initial shares because
      // balance + virtualAsset = 2 while amount = 1.
      expect(expected.sharesOut).to.equal(
        tiny.mul(supplyBefore.add(VIRTUAL_SHARES)).div(tiny.add(VIRTUAL_ASSET))
      );

      const tx = await vault.connect(bob).depositProRata(
        tiny,
        tiny,
        expected.sharesOut,
        await futureDeadline()
      );

      const rcpt = await tx.wait();
      const dep = await parseDepositedProRata(rcpt);

      expect(dep.user).to.equal(bobAddr);
      expect(dep.baseIn).to.equal(expected.baseIn);
      expect(dep.quoteIn).to.equal(expected.quoteIn);
      expect(dep.sharesMinted).to.equal(expected.sharesOut);
      expect(dep.baseBalanceBefore).to.equal(baseBalBefore);
      expect(dep.quoteBalanceBefore).to.equal(quoteBalBefore);

      expect(await vault.userShares(bobAddr)).to.equal(expected.sharesOut);
      expect(await vault.totalShares()).to.equal(supplyBefore.add(expected.sharesOut));
    });

    it("donation attack mitigation: tuned direct donation would force 0 shares without virtual offset, but mints >0 with offset", async () => {
      const bobAddr = await bob.getAddress();

      const tiny = BigNumber.from(1);

      // Initialize with 1 raw unit each side.
      await initializeVault(tiny, tiny);

      const supplyAfterInit = await vault.totalShares();
      expect(supplyAfterInit).to.be.gt(0);

      // Donate exactly enough that the old no-virtual formula would mint zero
      // for a 1-unit later deposit:
      //
      // noVirtualShares = 1 * supply / (supply + 1) = 0
      //
      // But with virtual offset:
      // virtualShares = 1 * (supply + 1000) / (supply + 1 + 1) = 1
      const donation = supplyAfterInit;

      await token0.connect(deployer).transfer(vault.address, donation);
      await token1.connect(deployer).transfer(vault.address, donation);

      const baseBalBeforeBob = await token0.balanceOf(vault.address);
      const quoteBalBeforeBob = await token1.balanceOf(vault.address);

      expect(baseBalBeforeBob).to.equal(tiny.add(donation));
      expect(quoteBalBeforeBob).to.equal(tiny.add(donation));

      await token0.transfer(bobAddr, tiny);
      await token1.transfer(bobAddr, tiny);
      await token0.connect(bob).approve(vault.address, tiny);
      await token1.connect(bob).approve(vault.address, tiny);

      const noVirtualSharesByBase = tiny.mul(supplyAfterInit).div(baseBalBeforeBob);
      const noVirtualSharesByQuote = tiny.mul(supplyAfterInit).div(quoteBalBeforeBob);
      const noVirtualShares = noVirtualSharesByBase.lt(noVirtualSharesByQuote)
        ? noVirtualSharesByBase
        : noVirtualSharesByQuote;

      expect(noVirtualShares).to.equal(0);

      const expected = expectedDepositPreview(
        tiny,
        tiny,
        baseBalBeforeBob,
        quoteBalBeforeBob,
        supplyAfterInit
      );

      expect(expected.sharesOut).to.be.gt(0);

      const tx = await vault.connect(bob).depositProRata(
        tiny,
        tiny,
        expected.sharesOut,
        await futureDeadline()
      );

      const rcpt = await tx.wait();
      const dep = await parseDepositedProRata(rcpt);

      expect(dep.sharesMinted).to.equal(expected.sharesOut);
      expect(dep.sharesMinted).to.be.gt(0);
      expect(dep.baseIn).to.equal(tiny);
      expect(dep.quoteIn).to.equal(tiny);

      expect(await vault.userShares(bobAddr)).to.equal(expected.sharesOut);
    });

    it("previewDepositProRata matches actual deposit after direct token donation changes the ratio", async () => {
      const aliceAddr = await alice.getAddress();

      const initBase = ONE.mul(1_000);
      const initQuote = ONE.mul(1_000);

      await initializeVault(initBase, initQuote);

      // Direct donation changes the pro-rata inventory ratio.
      const extraQuote = ONE.mul(500);
      await token1.transfer(vault.address, extraQuote);

      const baseMax = ONE.mul(200);
      const quoteMax = ONE.mul(400);

      await token0.transfer(aliceAddr, baseMax);
      await token1.transfer(aliceAddr, quoteMax);

      await token0.connect(alice).approve(vault.address, baseMax);
      await token1.connect(alice).approve(vault.address, quoteMax);

      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const supplyBefore = await vault.totalShares();

      const expected = expectedDepositPreview(
        baseMax,
        quoteMax,
        baseBalBefore,
        quoteBalBefore,
        supplyBefore
      );

      const preview = await vault.previewDepositProRata(baseMax, quoteMax);

      expect(preview.baseIn).to.equal(expected.baseIn);
      expect(preview.quoteIn).to.equal(expected.quoteIn);
      expect(preview.sharesOut).to.equal(expected.sharesOut);

      const aliceBaseBefore = await token0.balanceOf(aliceAddr);
      const aliceQuoteBefore = await token1.balanceOf(aliceAddr);

      const tx = await vault.connect(alice).depositProRata(
        baseMax,
        quoteMax,
        preview.sharesOut,
        await futureDeadline()
      );

      const rcpt = await tx.wait();
      const dep = await parseDepositedProRata(rcpt);

      const aliceBaseAfter = await token0.balanceOf(aliceAddr);
      const aliceQuoteAfter = await token1.balanceOf(aliceAddr);

      expect(aliceBaseBefore.sub(aliceBaseAfter)).to.equal(preview.baseIn);
      expect(aliceQuoteBefore.sub(aliceQuoteAfter)).to.equal(preview.quoteIn);

      expect(dep.baseIn).to.equal(preview.baseIn);
      expect(dep.quoteIn).to.equal(preview.quoteIn);
      expect(dep.sharesMinted).to.equal(preview.sharesOut);
      expect(dep.baseBalanceBefore).to.equal(baseBalBefore);
      expect(dep.quoteBalanceBefore).to.equal(quoteBalBefore);

      expect(await vault.totalShares()).to.equal(supplyBefore.add(preview.sharesOut));
    });

    it("previewWithdrawProRata matches actual withdrawal", async () => {
      const aliceAddr = await alice.getAddress();

      const initAmount = ONE.mul(1_000);

      await initializeVault(initAmount, initAmount, aliceAddr);

      // Donate extra BASE so this also verifies imbalanced inventory.
      const extraBase = ONE.mul(123);
      await token0.transfer(vault.address, extraBase);

      const ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(1);

      const depId = ids[0];
      const lot = await vault.deposits(depId);

      const sharesToBurn = lot.shares.div(2);
      expect(sharesToBurn).to.be.gt(0);

      await passLockup();

      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const supplyBefore = await vault.totalShares();

      const expectedBase = sharesToAsset(
        sharesToBurn,
        baseBalBefore,
        supplyBefore,
        VIRTUAL_ASSET
      );

      const expectedQuote = sharesToAsset(
        sharesToBurn,
        quoteBalBefore,
        supplyBefore,
        VIRTUAL_ASSET
      );

      const preview = await vault.previewWithdrawProRata(sharesToBurn);

      expect(preview.baseOut).to.equal(expectedBase);
      expect(preview.quoteOut).to.equal(expectedQuote);

      const aliceBaseBefore = await token0.balanceOf(aliceAddr);
      const aliceQuoteBefore = await token1.balanceOf(aliceAddr);

      await vault.connect(alice).withdrawFromDeposit(
        depId,
        sharesToBurn,
        preview.baseOut,
        preview.quoteOut,
        await futureDeadline()
      );

      const aliceBaseAfter = await token0.balanceOf(aliceAddr);
      const aliceQuoteAfter = await token1.balanceOf(aliceAddr);

      expect(aliceBaseAfter.sub(aliceBaseBefore)).to.equal(preview.baseOut);
      expect(aliceQuoteAfter.sub(aliceQuoteBefore)).to.equal(preview.quoteOut);

      const lotAfter = await vault.deposits(depId);
      expect(lotAfter.shares).to.equal(lot.shares.sub(sharesToBurn));
    });
  });
  // ─────────────────────────────────────────────────────────────
  // Manager rebalance: SaucerSwap V1
  // ─────────────────────────────────────────────────────────────
  describe("manager rebalance: SaucerSwap V1", () => {

    const WHBAR = "0x0000000000000000000000000000000000163b5a";
    const SAUCER_V1_ROUTER = "0x00000000000000000000000000000000002e7a5d";

    let mockV1Router: any;

    async function futureDeadline(seconds = 3600): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp + seconds;
    }

    async function pinMockV1Router() {
      const RouterMock = await ethers.getContractFactory("MockSaucerV1Router");
      const impl = await RouterMock.deploy();
      await impl.deployed();

      const runtime = await ethers.provider.getCode(impl.address);

      await network.provider.send("hardhat_setCode", [
        SAUCER_V1_ROUTER,
        runtime,
      ]);

      const router = await ethers.getContractAt(
        "MockSaucerV1Router",
        SAUCER_V1_ROUTER
      );

      await router.setAmountOut(0);

      return router;
    }

    async function initializeTokenTokenVault(
      v = vault,
      receiver?: string,
      amount: BigNumber = ONE.mul(1_000)
    ) {
      const receiverAddr = receiver ?? (await deployer.getAddress());

      await token0.connect(deployer).approve(v.address, amount);
      await token1.connect(deployer).approve(v.address, amount);

      await v.connect(deployer).initialize(
        amount,
        amount,
        0,
        receiverAddr,
        await futureDeadline()
      );

      expect(await v.initialized()).to.equal(true);
    }

    async function deployProRataVault(base: string, quote: string) {
      const Vault = await ethers.getContractFactory("PLEXProRataVault");

      const v = (await Vault.deploy(
        base,
        quote,
        distributor.address,
        await deployer.getAddress(), // manager
        0,                           // ownerFeeBips
        WEEK_SECS,
        DAY_SECS,
        WEEK_SECS
      )) as PLEXProRataVault;

      await v.deployed();
      return v;
    }

    async function initializeHbarBaseVault(v: PLEXProRataVault) {
      const initBase = ONE.mul(1_000);  // HBAR side
      const initQuote = ONE.mul(1_000); // token1 side

      await token1.connect(deployer).approve(v.address, initQuote);

      await v.connect(deployer).initialize(
        initBase,
        initQuote,
        0,
        await deployer.getAddress(),
        await futureDeadline(),
        { value: initBase }
      );

      expect(await v.initialized()).to.equal(true);
    }

    async function initializeHbarQuoteVault(v: PLEXProRataVault) {
      const initBase = ONE.mul(1_000);  // token0 side
      const initQuote = ONE.mul(1_000); // HBAR side

      await token0.connect(deployer).approve(v.address, initBase);

      await v.connect(deployer).initialize(
        initBase,
        initQuote,
        0,
        await deployer.getAddress(),
        await futureDeadline(),
        { value: initQuote }
      );

      expect(await v.initialized()).to.equal(true);
    }

    beforeEach(async () => {
      mockV1Router = await pinMockV1Router();
    });

    it("only manager can call", async () => {
      const amountIn = ONE.mul(10);
      const amountOutMin = ONE.mul(5);

      const path = [token0.address, token1.address];

      await expect(
        vault.connect(alice).managerRebalanceSaucerV1(
          true,
          amountIn,
          amountOutMin,
          await futureDeadline(),
          path
        )
      ).to.be.revertedWith("not manager/owner");
    });

    it("reverts in emergency mode", async () => {
      await initializeTokenTokenVault();

      await vault.enableEmergencyMode();

      const amountIn = ONE.mul(10);
      const amountOutMin = ONE.mul(5);

      const path = [token0.address, token1.address];

      await expect(
        vault.connect(deployer).managerRebalanceSaucerV1(
          true,
          amountIn,
          amountOutMin,
          await futureDeadline(),
          path
        )
      ).to.be.revertedWith("emergency: swaps disabled");
    });

    it("bad tokenIn path reverts", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(10);
      const amountOutMin = ONE.mul(5);

      // baseToQuote=true means tokenIn must be BASE/token0.
      const badPath = [token1.address, token0.address];

      await expect(
        vault.connect(deployer).managerRebalanceSaucerV1(
          true,
          amountIn,
          amountOutMin,
          await futureDeadline(),
          badPath
        )
      ).to.be.revertedWith("bad tokenIn");
    });

    it("bad tokenOut path reverts", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(10);
      const amountOutMin = ONE.mul(5);

      // baseToQuote=true means tokenOut must be QUOTE/token1.
      const badPath = [token0.address, token0.address];

      await expect(
        vault.connect(deployer).managerRebalanceSaucerV1(
          true,
          amountIn,
          amountOutMin,
          await futureDeadline(),
          badPath
        )
      ).to.be.revertedWith("bad tokenOut");
    });

    it("token -> token rebalance succeeds", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(100);     // token0 in
      const amountOutMin = ONE.mul(50);  // token1 out

      const path = [token0.address, token1.address];

      // Fund the hardcoded router with output token.
      await token1.transfer(SAUCER_V1_ROUTER, amountOutMin);

      const vaultBaseBefore = await token0.balanceOf(vault.address);
      const vaultQuoteBefore = await token1.balanceOf(vault.address);
      const routerBaseBefore = await token0.balanceOf(SAUCER_V1_ROUTER);

      await expect(
        vault.connect(deployer).managerRebalanceSaucerV1(
          true, // BASE -> QUOTE
          amountIn,
          amountOutMin,
          await futureDeadline(),
          path
        )
      )
        .to.emit(vault, "ManagerRebalance")
        .withArgs(
          1,
          true,
          token0.address,
          token1.address,
          amountIn,
          amountOutMin,
          amountOutMin
        );

      const vaultBaseAfter = await token0.balanceOf(vault.address);
      const vaultQuoteAfter = await token1.balanceOf(vault.address);
      const routerBaseAfter = await token0.balanceOf(SAUCER_V1_ROUTER);

      expect(vaultBaseBefore.sub(vaultBaseAfter)).to.equal(amountIn);
      expect(vaultQuoteAfter.sub(vaultQuoteBefore)).to.equal(amountOutMin);

      // Router pulled exactly amountIn from the vault.
      expect(routerBaseAfter.sub(routerBaseBefore)).to.equal(amountIn);
    });

    it("HBAR -> token rebalance succeeds", async () => {
      const hbarVault = await deployProRataVault(
        ethers.constants.AddressZero, // BASE = HBAR
        token1.address                // QUOTE = token1
      );

      await initializeHbarBaseVault(hbarVault);

      const amountIn = ONE.mul(100);     // HBAR in
      const amountOutMin = ONE.mul(50);  // token1 out

      const path = [WHBAR, token1.address];

      // Fund router with output token.
      await token1.transfer(SAUCER_V1_ROUTER, amountOutMin);

      const hbarBefore = await ethers.provider.getBalance(hbarVault.address);
      const quoteBefore = await token1.balanceOf(hbarVault.address);

      await hbarVault.connect(deployer).managerRebalanceSaucerV1(
        true, // BASE(HBAR) -> QUOTE(token1)
        amountIn,
        amountOutMin,
        await futureDeadline(),
        path
      );

      const hbarAfter = await ethers.provider.getBalance(hbarVault.address);
      const quoteAfter = await token1.balanceOf(hbarVault.address);

      expect(hbarBefore.sub(hbarAfter)).to.equal(amountIn);
      expect(quoteAfter.sub(quoteBefore)).to.equal(amountOutMin);
    });

    it("token -> HBAR rebalance succeeds", async () => {
      const hbarVault = await deployProRataVault(
        token0.address,                // BASE = token0
        ethers.constants.AddressZero   // QUOTE = HBAR
      );

      await initializeHbarQuoteVault(hbarVault);

      const amountIn = ONE.mul(100);     // token0 in
      const amountOutMin = ONE.mul(50);  // HBAR out

      const path = [token0.address, WHBAR];

      // Fund router with native HBAR so it can pay the vault.
      await network.provider.send("hardhat_setBalance", [
        SAUCER_V1_ROUTER,
        amountOutMin.toHexString(),
      ]);

      const baseBefore = await token0.balanceOf(hbarVault.address);
      const hbarBefore = await ethers.provider.getBalance(hbarVault.address);

      await hbarVault.connect(deployer).managerRebalanceSaucerV1(
        true, // BASE(token0) -> QUOTE(HBAR)
        amountIn,
        amountOutMin,
        await futureDeadline(),
        path
      );

      const baseAfter = await token0.balanceOf(hbarVault.address);
      const hbarAfter = await ethers.provider.getBalance(hbarVault.address);

      expect(baseBefore.sub(baseAfter)).to.equal(amountIn);
      expect(hbarAfter.sub(hbarBefore)).to.equal(amountOutMin);
    });

    it("amountOutMin enforced", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(100);
      const amountOutMin = ONE.mul(50);
      const actualOut = amountOutMin.sub(1);

      const path = [token0.address, token1.address];

      await mockV1Router.setAmountOut(actualOut);

      // Fund router enough that the only failure is slippage.
      await token1.transfer(SAUCER_V1_ROUTER, amountOutMin);

      await expect(
        vault.connect(deployer).managerRebalanceSaucerV1(
          true,
          amountIn,
          amountOutMin,
          await futureDeadline(),
          path
        )
      ).to.be.revertedWith("MockV1: slippage");
    });

    it("exact amountIn spent", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(123);
      const amountOutMin = ONE.mul(77);

      const path = [token0.address, token1.address];

      await token1.transfer(SAUCER_V1_ROUTER, amountOutMin);

      const vaultBaseBefore = await token0.balanceOf(vault.address);
      const vaultQuoteBefore = await token1.balanceOf(vault.address);

      const routerBaseBefore = await token0.balanceOf(SAUCER_V1_ROUTER);

      await vault.connect(deployer).managerRebalanceSaucerV1(
        true,
        amountIn,
        amountOutMin,
        await futureDeadline(),
        path
      );

      const vaultBaseAfter = await token0.balanceOf(vault.address);
      const vaultQuoteAfter = await token1.balanceOf(vault.address);

      const routerBaseAfter = await token0.balanceOf(SAUCER_V1_ROUTER);

      expect(vaultBaseBefore.sub(vaultBaseAfter)).to.equal(amountIn);
      expect(routerBaseAfter.sub(routerBaseBefore)).to.equal(amountIn);

      expect(vaultQuoteAfter.sub(vaultQuoteBefore)).to.equal(amountOutMin);
    });

    it("WHBAR intermediate hop rebalance succeeds", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(100);     // token0 in
      const amountOutMin = ONE.mul(50);  // token1 out

      // token0 -> WHBAR -> token1
      const path = [token0.address, WHBAR, token1.address];

      await token1.transfer(SAUCER_V1_ROUTER, amountOutMin);

      const vaultBaseBefore = await token0.balanceOf(vault.address);
      const vaultQuoteBefore = await token1.balanceOf(vault.address);

      await expect(
        vault.connect(deployer).managerRebalanceSaucerV1(
          true, // BASE -> QUOTE
          amountIn,
          amountOutMin,
          await futureDeadline(),
          path
        )
      )
        .to.emit(vault, "ManagerRebalance")
        .withArgs(
          1,
          true,
          token0.address,
          token1.address,
          amountIn,
          amountOutMin,
          amountOutMin
        );

      const vaultBaseAfter = await token0.balanceOf(vault.address);
      const vaultQuoteAfter = await token1.balanceOf(vault.address);

      expect(vaultBaseBefore.sub(vaultBaseAfter)).to.equal(amountIn);
      expect(vaultQuoteAfter.sub(vaultQuoteBefore)).to.equal(amountOutMin);
    });

    it("non-WHBAR intermediate hop reverts", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(10);
      const amountOutMin = ONE.mul(5);

      // Middle hop is token0 (not WHBAR) -> disallowed.
      const badPath = [token0.address, token0.address, token1.address];

      await expect(
        vault.connect(deployer).managerRebalanceSaucerV1(
          true,
          amountIn,
          amountOutMin,
          await futureDeadline(),
          badPath
        )
      ).to.be.revertedWith("bad hop");
    });

    it("path longer than one intermediate hop reverts", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(10);
      const amountOutMin = ONE.mul(5);

      // Four tokens (two intermediate hops) -> disallowed even via WHBAR.
      const badPath = [token0.address, WHBAR, WHBAR, token1.address];

      await expect(
        vault.connect(deployer).managerRebalanceSaucerV1(
          true,
          amountIn,
          amountOutMin,
          await futureDeadline(),
          badPath
        )
      ).to.be.revertedWith("bad path");
    });
  });
  // ─────────────────────────────────────────────────────────────
  // Manager rebalance: SaucerSwap V2
  // ─────────────────────────────────────────────────────────────
  describe("manager rebalance: SaucerSwap V2", () => {
    const ONE = BigNumber.from(10).pow(8);

    const WHBAR = "0x0000000000000000000000000000000000163b5a";
    const SAUCER_V2_ROUTER = "0x00000000000000000000000000000000003c437a";

    const FEE = 500; // arbitrary v2 fee tier for encoded mock path

    let mockV2Router: any;

    async function futureDeadline(seconds = 3600): Promise<number> {
      const latest = await ethers.provider.getBlock("latest");
      return latest!.timestamp + seconds;
    }

    function encodeV2Path(tokens: string[], fees: number[]): string {
      if (tokens.length !== fees.length + 1) {
        throw new Error("bad v2 path input");
      }

      const types: string[] = [];
      const values: any[] = [];

      for (let i = 0; i < fees.length; i++) {
        types.push("address", "uint24");
        values.push(tokens[i], fees[i]);
      }

      types.push("address");
      values.push(tokens[tokens.length - 1]);

      return ethers.utils.solidityPack(types, values);
    }

    async function pinMockV2Router() {
      const RouterMock = await ethers.getContractFactory("MockSaucerV2Router");
      const impl = await RouterMock.deploy();
      await impl.deployed();

      const runtime = await ethers.provider.getCode(impl.address);

      await network.provider.send("hardhat_setCode", [
        SAUCER_V2_ROUTER,
        runtime,
      ]);

      const router = await ethers.getContractAt(
        "MockSaucerV2Router",
        SAUCER_V2_ROUTER
      );

      await router.setAmountOut(0);

      return router;
    }

    async function deployProRataVault(base: string, quote: string) {
      const Vault = await ethers.getContractFactory("PLEXProRataVault");

      const v = (await Vault.deploy(
        base,
        quote,
        distributor.address,
        await deployer.getAddress(), // manager
        0,                           // ownerFeeBips
        WEEK_SECS,
        DAY_SECS,
        WEEK_SECS
      )) as PLEXProRataVault;

      await v.deployed();
      return v;
    }

    async function initializeTokenTokenVault(
      v = vault,
      receiver?: string,
      amount: BigNumber = ONE.mul(1_000)
    ) {
      const receiverAddr = receiver ?? (await deployer.getAddress());

      await token0.connect(deployer).approve(v.address, amount);
      await token1.connect(deployer).approve(v.address, amount);

      await v.connect(deployer).initialize(
        amount,
        amount,
        0,
        receiverAddr,
        await futureDeadline()
      );

      expect(await v.initialized()).to.equal(true);
    }

    async function initializeHbarBaseVault(v: PLEXProRataVault) {
      const initBase = ONE.mul(1_000);  // HBAR side
      const initQuote = ONE.mul(1_000); // token1 side

      await token1.connect(deployer).approve(v.address, initQuote);

      await v.connect(deployer).initialize(
        initBase,
        initQuote,
        0,
        await deployer.getAddress(),
        await futureDeadline(),
        { value: initBase }
      );

      expect(await v.initialized()).to.equal(true);
    }

    async function initializeHbarQuoteVault(v: PLEXProRataVault) {
      const initBase = ONE.mul(1_000);  // token0 side
      const initQuote = ONE.mul(1_000); // HBAR side

      await token0.connect(deployer).approve(v.address, initBase);

      await v.connect(deployer).initialize(
        initBase,
        initQuote,
        0,
        await deployer.getAddress(),
        await futureDeadline(),
        { value: initQuote }
      );

      expect(await v.initialized()).to.equal(true);
    }

    beforeEach(async () => {
      mockV2Router = await pinMockV2Router();
    });

    it("bad encoded path length reverts", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(10);
      const amountOutMin = ONE.mul(5);

      const badPath = "0x1234";

      await expect(
        vault.connect(deployer).managerRebalanceSaucerV2(
          true,
          amountIn,
          amountOutMin,
          await futureDeadline(),
          badPath
        )
      ).to.be.revertedWith("bad path");
    });

    it("bad first token reverts", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(10);
      const amountOutMin = ONE.mul(5);

      // baseToQuote=true means first token must be BASE/token0.
      const badPath = encodeV2Path(
        [token1.address, token0.address],
        [FEE]
      );

      await expect(
        vault.connect(deployer).managerRebalanceSaucerV2(
          true,
          amountIn,
          amountOutMin,
          await futureDeadline(),
          badPath
        )
      ).to.be.revertedWith("bad tokenIn");
    });

    it("bad last token reverts", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(10);
      const amountOutMin = ONE.mul(5);

      // baseToQuote=true means last token must be QUOTE/token1.
      const badPath = encodeV2Path(
        [token0.address, token0.address],
        [FEE]
      );

      await expect(
        vault.connect(deployer).managerRebalanceSaucerV2(
          true,
          amountIn,
          amountOutMin,
          await futureDeadline(),
          badPath
        )
      ).to.be.revertedWith("bad tokenOut");
    });

    it("token -> token exactInput succeeds", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(100);     // token0 in
      const amountOutMin = ONE.mul(50);  // token1 out

      const path = encodeV2Path(
        [token0.address, token1.address],
        [FEE]
      );

      // Fund hardcoded router with output token.
      await token1.transfer(SAUCER_V2_ROUTER, amountOutMin);

      const vaultBaseBefore = await token0.balanceOf(vault.address);
      const vaultQuoteBefore = await token1.balanceOf(vault.address);
      const routerBaseBefore = await token0.balanceOf(SAUCER_V2_ROUTER);

      await expect(
        vault.connect(deployer).managerRebalanceSaucerV2(
          true,
          amountIn,
          amountOutMin,
          await futureDeadline(),
          path
        )
      )
        .to.emit(vault, "ManagerRebalance")
        .withArgs(
          2,
          true,
          token0.address,
          token1.address,
          amountIn,
          amountOutMin,
          amountOutMin
        );

      const vaultBaseAfter = await token0.balanceOf(vault.address);
      const vaultQuoteAfter = await token1.balanceOf(vault.address);
      const routerBaseAfter = await token0.balanceOf(SAUCER_V2_ROUTER);

      expect(vaultBaseBefore.sub(vaultBaseAfter)).to.equal(amountIn);
      expect(vaultQuoteAfter.sub(vaultQuoteBefore)).to.equal(amountOutMin);
      expect(routerBaseAfter.sub(routerBaseBefore)).to.equal(amountIn);
    });

    it("HBAR -> token multicall/refund path succeeds", async () => {
      const hbarVault = await deployProRataVault(
        ethers.constants.AddressZero, // BASE = HBAR
        token1.address                // QUOTE = token1
      );

      await initializeHbarBaseVault(hbarVault);

      const amountIn = ONE.mul(100);     // HBAR in
      const amountOutMin = ONE.mul(50);  // token1 out

      const path = encodeV2Path(
        [WHBAR, token1.address],
        [FEE]
      );

      // Fund router with output token.
      await token1.transfer(SAUCER_V2_ROUTER, amountOutMin);

      const hbarBefore = await ethers.provider.getBalance(hbarVault.address);
      const quoteBefore = await token1.balanceOf(hbarVault.address);

      await expect(
        hbarVault.connect(deployer).managerRebalanceSaucerV2(
          true, // BASE(HBAR) -> QUOTE(token1)
          amountIn,
          amountOutMin,
          await futureDeadline(),
          path
        )
      )
        .to.emit(hbarVault, "ManagerRebalance")
        .withArgs(
          2,
          true,
          ethers.constants.AddressZero,
          token1.address,
          amountIn,
          amountOutMin,
          amountOutMin
        );

      const hbarAfter = await ethers.provider.getBalance(hbarVault.address);
      const quoteAfter = await token1.balanceOf(hbarVault.address);

      expect(hbarBefore.sub(hbarAfter)).to.equal(amountIn);
      expect(quoteAfter.sub(quoteBefore)).to.equal(amountOutMin);
    });

    it("token -> HBAR multicall/unwrap path succeeds", async () => {
      const hbarVault = await deployProRataVault(
        token0.address,                // BASE = token0
        ethers.constants.AddressZero   // QUOTE = HBAR
      );

      await initializeHbarQuoteVault(hbarVault);

      const amountIn = ONE.mul(100);     // token0 in
      const amountOutMin = ONE.mul(50);  // HBAR out

      const path = encodeV2Path(
        [token0.address, WHBAR],
        [FEE]
      );

      // Fund router with native HBAR so unwrapWHBAR can pay vault.
      await network.provider.send("hardhat_setBalance", [
        SAUCER_V2_ROUTER,
        amountOutMin.toHexString(),
      ]);

      const baseBefore = await token0.balanceOf(hbarVault.address);
      const hbarBefore = await ethers.provider.getBalance(hbarVault.address);
      const routerBaseBefore = await token0.balanceOf(SAUCER_V2_ROUTER);

      await expect(
        hbarVault.connect(deployer).managerRebalanceSaucerV2(
          true, // BASE(token0) -> QUOTE(HBAR)
          amountIn,
          amountOutMin,
          await futureDeadline(),
          path
        )
      )
        .to.emit(hbarVault, "ManagerRebalance")
        .withArgs(
          2,
          true,
          token0.address,
          ethers.constants.AddressZero,
          amountIn,
          amountOutMin,
          amountOutMin
        );

      const baseAfter = await token0.balanceOf(hbarVault.address);
      const hbarAfter = await ethers.provider.getBalance(hbarVault.address);
      const routerBaseAfter = await token0.balanceOf(SAUCER_V2_ROUTER);

      expect(baseBefore.sub(baseAfter)).to.equal(amountIn);
      expect(hbarAfter.sub(hbarBefore)).to.equal(amountOutMin);
      expect(routerBaseAfter.sub(routerBaseBefore)).to.equal(amountIn);
    });

    it("amountOutMin enforced", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(100);
      const amountOutMin = ONE.mul(50);
      const actualOut = amountOutMin.sub(1);

      const path = encodeV2Path(
        [token0.address, token1.address],
        [FEE]
      );

      await mockV2Router.setAmountOut(actualOut);

      // No output funding needed because mock reverts before paying.
      await expect(
        vault.connect(deployer).managerRebalanceSaucerV2(
          true,
          amountIn,
          amountOutMin,
          await futureDeadline(),
          path
        )
      ).to.be.revertedWith("MockV2: slippage");
    });

    it("exact amountIn spent", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(123);
      const amountOutMin = ONE.mul(77);

      const path = encodeV2Path(
        [token0.address, token1.address],
        [FEE]
      );

      await token1.transfer(SAUCER_V2_ROUTER, amountOutMin);

      const vaultBaseBefore = await token0.balanceOf(vault.address);
      const vaultQuoteBefore = await token1.balanceOf(vault.address);
      const routerBaseBefore = await token0.balanceOf(SAUCER_V2_ROUTER);

      await vault.connect(deployer).managerRebalanceSaucerV2(
        true,
        amountIn,
        amountOutMin,
        await futureDeadline(),
        path
      );

      const vaultBaseAfter = await token0.balanceOf(vault.address);
      const vaultQuoteAfter = await token1.balanceOf(vault.address);
      const routerBaseAfter = await token0.balanceOf(SAUCER_V2_ROUTER);

      expect(vaultBaseBefore.sub(vaultBaseAfter)).to.equal(amountIn);
      expect(routerBaseAfter.sub(routerBaseBefore)).to.equal(amountIn);
      expect(vaultQuoteAfter.sub(vaultQuoteBefore)).to.equal(amountOutMin);
    });

    it("WHBAR intermediate hop exactInput succeeds", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(100);     // token0 in
      const amountOutMin = ONE.mul(50);  // token1 out

      // token0 -> WHBAR -> token1
      const path = encodeV2Path(
        [token0.address, WHBAR, token1.address],
        [FEE, FEE]
      );

      await token1.transfer(SAUCER_V2_ROUTER, amountOutMin);

      const vaultBaseBefore = await token0.balanceOf(vault.address);
      const vaultQuoteBefore = await token1.balanceOf(vault.address);

      await vault.connect(deployer).managerRebalanceSaucerV2(
        true,
        amountIn,
        amountOutMin,
        await futureDeadline(),
        path
      );

      const vaultBaseAfter = await token0.balanceOf(vault.address);
      const vaultQuoteAfter = await token1.balanceOf(vault.address);

      expect(vaultBaseBefore.sub(vaultBaseAfter)).to.equal(amountIn);
      expect(vaultQuoteAfter.sub(vaultQuoteBefore)).to.equal(amountOutMin);
    });

    it("non-WHBAR intermediate hop reverts", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(10);
      const amountOutMin = ONE.mul(5);

      // Middle hop is token0 (not WHBAR) -> disallowed.
      const badPath = encodeV2Path(
        [token0.address, token0.address, token1.address],
        [FEE, FEE]
      );

      await expect(
        vault.connect(deployer).managerRebalanceSaucerV2(
          true,
          amountIn,
          amountOutMin,
          await futureDeadline(),
          badPath
        )
      ).to.be.revertedWith("bad hop");
    });

    it("path longer than one intermediate hop reverts", async () => {
      await initializeTokenTokenVault();

      const amountIn = ONE.mul(10);
      const amountOutMin = ONE.mul(5);

      // Two intermediate hops (89 bytes) -> disallowed even via WHBAR.
      const badPath = encodeV2Path(
        [token0.address, WHBAR, WHBAR, token1.address],
        [FEE, FEE, FEE]
      );

      await expect(
        vault.connect(deployer).managerRebalanceSaucerV2(
          true,
          amountIn,
          amountOutMin,
          await futureDeadline(),
          badPath
        )
      ).to.be.revertedWith("bad path");
    });
  });
});
