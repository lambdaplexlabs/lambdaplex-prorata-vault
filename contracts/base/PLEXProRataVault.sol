// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../libraries/PRBMathCommon.sol";
import "../libraries/SafeERC20.sol";
import "../interfaces/IAirdropDistributor.sol";
import "../interfaces/IERC20.sol";
import "../interfaces/AMM/ISaucerV1Router.sol";
import "../interfaces/AMM/ISaucerV2Router.sol";

/* ─────────────────────────── Utilities ─────────────────────────── */

interface IOwnable {
    function owner() external view returns (address);
}

/* ───────────────────────── Oracle-free proportional basket vault ───────────────────────── */

/// @notice Oracle-free two-token vault.
///         Shares represent a pro-rata claim on the current BASE and QUOTE inventories.
///         Deposits after initialization must match the current inventory ratio.
///         Withdrawals return pro-rata BASE and QUOTE.
/// @dev This vault intentionally does NOT attempt to maintain 50/50 by value.
///      It should be presented as a "pro-rata inventory vault", not a value-balanced vault.
contract PLEXProRataVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ───────────────────────── Pair config ───────────────────────── */

    // If BASE or QUOTE equals address(0), that side is native HBAR.
    address public immutable BASE;
    address public immutable QUOTE;

    // Decimals are needed only for initial geometric-mean share mint.
    // For HBAR, use 8.
    uint8 public immutable BASE_DECIMALS;
    uint8 public immutable QUOTE_DECIMALS;

    IAirdropDistributor public distributor;
    event DistributorSet(address indexed distributor);

    address public manager;
    event ManagerSet(address indexed manager);

    bool public initialized;

    event VaultInitialized(
        address indexed initializer,
        address indexed receiver,
        uint256 baseIn,
        uint256 quoteIn,
        uint256 baseBalanceAfter,
        uint256 quoteBalanceAfter,
        uint256 sharesMinted
    );

    uint64 public immutable vestingSecs;
    uint64 public immutable lockupSecs;
    uint64 public immutable feeChangeDelaySecs;

    /* ───────────────────────── Global math ───────────────────────── */

    uint256 public constant BPS = 1_000_000;
    uint64 public constant WEEK_SECS = 7 days;

    uint256 public constant MAX_REWARD_TOKENS = 30;

    /// @dev Virtual offset used in pro-rata share conversions after initialization.
    ///      These are not real minted shares or real assets; they only affect conversion math.
    uint256 private constant VIRTUAL_SHARES = 1e3;
    uint256 private constant VIRTUAL_BASE = 1;
    uint256 private constant VIRTUAL_QUOTE = 1;

    uint256 private constant ONE_18 = 1e18;

    /* ───────────────────────── Shares ───────────────────────── */

    uint256 public totalShares;
    mapping(address => uint256) public userShares;

    /* ───────────────────────── Emergency mode ───────────────────────── */

    bool public emergencyMode;
    event EmergencyModeEnabled(address indexed by);

    /* ───────────────────────── Deposit lots ───────────────────────── */

    enum DepState {
        ACTIVE,
        WITHDRAWN
    }

    struct Deposit {
        address user;
        uint96 shares;
        uint64 createdAt;
        uint64 lockupUntil;
        uint8 state;
    }

    Deposit[] public deposits;
    mapping(address => uint256[]) public _userDeposits;

    event DepositedProRata(
        address indexed user,
        uint256 indexed depositId,
        uint256 baseIn,
        uint256 quoteIn,
        uint256 sharesMinted,
        uint256 baseBalanceBefore,
        uint256 quoteBalanceBefore
    );

    event WithdrawalFinalized(
        uint256 indexed depositId,
        address indexed user,
        uint256 baseOut,
        uint256 quoteOut,
        uint256 sharesBurned
    );

    /* ───────────────────────── Streaming rewards ───────────────────────── */

    struct RewardData {
        uint256 perShare;        // cumulative reward tokens per eligible share, 1e18 scale
        uint256 rate;            // reward tokens per second
        uint128 carry;           // unallocated reward tokens / rounding leftovers
        uint64 lastUpdate;
        uint64 periodFinish;
        uint64 campaignStart;
    }

    struct UserReward {
        uint256 perSharePaid;
        uint256 accrued;
    }

    address[] public rewardTokens;
    mapping(address => RewardData) public rewards;
    mapping(address => mapping(address => UserReward)) public userRewards;

    event RewardStreamConfigured(
        address indexed rewardToken,
        uint256 amountNet,
        uint64 campaignStart,
        uint64 vestingSecs,
        uint256 newRate,
        uint256 carry,
        uint64 periodFinish
    );

    event RewardClaimed(
        address indexed rewardToken,
        address indexed user,
        uint256 amount
    );

    event RewardClaimFailed(
        address indexed rewardToken,
        address indexed user,
        uint256 amount
    );

    /* ───────────────────────── Management fee ───────────────────────── */

    uint32 public constant MAX_OWNER_FEE_BIPS = 3_000; // 0.3% / week

    uint32 public ownerFeeBips;
    uint32 public pendingOwnerFeeBips;
    uint64 public pendingOwnerFeeTs;

    uint64 public lastFeeChangeTs;
    uint64 public lastFeeAccrual;

    uint256 public ownerFeeShares;

    event OwnerFeeRateScheduled(uint32 newBips, uint64 effectiveTs);
    event OwnerFeeRateApplied(
        uint32 previousBips,
        uint32 newBips,
        uint64 effectiveTs
    );
    event OwnerFeeAccrued(
        uint256 sharesMinted,
        uint64 fromTs,
        uint64 toTs,
        uint32 rateBips
    );
    event OwnerFeeRedeemed(
        uint256 sharesBurned,
        uint256 baseOut,
        uint256 quoteOut
    );

    /* ───────────────────────── SaucerSwap rebalance config ───────────────────────── */

    // SaucerSwap mainnet addresses
    address public constant WHBAR =
        0x0000000000000000000000000000000000163B59;
    address public constant SAUCER_V1_FACTORY =
        0x0000000000000000000000000000000000103780;
    address public constant SAUCER_V1_ROUTER =
        0x00000000000000000000000000000000002E7A5D;
    address public constant SAUCER_V2_FACTORY =
        0x00000000000000000000000000000000003c3951;
    address public constant SAUCER_V2_ROUTER =
        0x00000000000000000000000000000000003c437A;
    event ManagerRebalance(
        uint8 indexed ammVersion, // 1 = Saucer V1, 2 = Saucer V2
        bool indexed baseToQuote,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 amountOutActual
    );

    /* ───────────────────────── Constructor ───────────────────────── */

    constructor(
        address base_,
        address quote_,
        address distributor_,
        address manager_,
        uint32 ownerFeeBips_,
        uint64 vestingSecs_,
        uint64 lockupSecs_,
        uint64 feeChangeDelaySecs_
    ) Ownable(msg.sender) {
        require(base_ != quote_, "pair identical");
        require(vestingSecs_ > 0 && vestingSecs_ <= 7 days, "vesting bounds");
        require(lockupSecs_ > 0 && lockupSecs_ <= 7 days, "lockup bounds");
        require(
            feeChangeDelaySecs_ >= 1 days && feeChangeDelaySecs_ <= 30 days,
            "delay bounds"
        );
        require(ownerFeeBips_ <= MAX_OWNER_FEE_BIPS, "rate>0.3%");

        BASE = base_;
        QUOTE = quote_;
        
        BASE_DECIMALS = base_ == address(0) ? 8 : IERC20(base_).decimals();
        QUOTE_DECIMALS = quote_ == address(0) ? 8 : IERC20(quote_).decimals();

        require(BASE_DECIMALS <= 77 && QUOTE_DECIMALS <= 77, "dec too big");

        if (distributor_ != address(0)) {
            distributor = IAirdropDistributor(distributor_);
            emit DistributorSet(distributor_);
        }

        if (manager_ != address(0)) {
            manager = manager_;
            emit ManagerSet(manager_);
        }

        ownerFeeBips = ownerFeeBips_;
        vestingSecs = vestingSecs_;
        lockupSecs = lockupSecs_;
        feeChangeDelaySecs = feeChangeDelaySecs_;

        lastFeeAccrual = uint64(block.timestamp);
    }

    /* ───────────────────────── Modifiers ───────────────────────── */

    modifier onlyInitialized() {
        require(initialized, "not initialized");
        _;
    }

    modifier onlyUninitialized() {
        require(!initialized, "already initialized");
        _;
    }

    modifier onlyManagerOrOwner() {
        require(msg.sender == owner() || msg.sender == manager, "not manager/owner");
        _;
    }

    /* ───────────────────────── Admin ───────────────────────── */

    function setManager(address manager_) external onlyOwner {
        require(manager_ != address(0), "manager=0");
        manager = manager_;
        emit ManagerSet(manager_);
    }

    function scheduleOwnerFeeBips(uint32 newBips) external onlyOwner {
        require(newBips <= MAX_OWNER_FEE_BIPS, "rate>0.3%");

        _accrueMgmtFee();

        uint64 nowTs = uint64(block.timestamp);
        require(
            lastFeeChangeTs == 0 ||
                nowTs >= lastFeeChangeTs + feeChangeDelaySecs,
            "fee change cooldown"
        );

        pendingOwnerFeeBips = newBips;
        pendingOwnerFeeTs = nowTs + feeChangeDelaySecs;
        lastFeeChangeTs = nowTs;

        emit OwnerFeeRateScheduled(newBips, pendingOwnerFeeTs);
    }

    function ownerFeeInfo()
        external
        view
        returns (
            uint32 currentBips,
            uint32 pendingBips,
            uint64 pendingEffectiveTs,
            uint64 lastChangeTs,
            uint64 lastAccrualTs,
            uint256 feeShares
        )
    {
        uint64 nowTs = uint64(block.timestamp);

        uint32 effBips = ownerFeeBips;
        if (pendingOwnerFeeTs != 0 && nowTs >= pendingOwnerFeeTs) {
            effBips = pendingOwnerFeeBips;
        }

        currentBips = effBips;
        pendingBips = pendingOwnerFeeBips;
        pendingEffectiveTs = pendingOwnerFeeTs;
        lastChangeTs = lastFeeChangeTs;
        lastAccrualTs = lastFeeAccrual;
        feeShares = ownerFeeShares;
    }

    /// @dev This vault is intentionally not reinitializable.
    ///      If all shares are burned and the vault loses its inventory ratio,
    ///      public deposits may become permanently unavailable.
    ///      Vault owner/operator is responsible for avoiding full depletion
    ///      if they want the vault to remain active.
    function initialize(
        uint256 baseAmount,
        uint256 quoteAmount,
        uint256 minSharesOut,
        address receiver,
        uint64 deadline
    )
        external
        payable
        nonReentrant
        onlyManagerOrOwner
        onlyUninitialized
        returns (uint256 depositId)
    {
        require(block.timestamp <= deadline, "expired");
        require(receiver != address(0), "receiver=0");
        require(baseAmount > 0 && quoteAmount > 0, "amount=0");

        _accrueMgmtFee();

        // Pre-call balances. Native HBAR balance already includes msg.value.
        uint256 baseBalBefore = _vaultBalance(BASE);
        uint256 quoteBalBefore = _vaultBalance(QUOTE);

        if (BASE == address(0)) {
            require(baseBalBefore >= msg.value, "HBAR accounting");
            baseBalBefore -= msg.value;
        }

        if (QUOTE == address(0)) {
            require(quoteBalBefore >= msg.value, "HBAR accounting");
            quoteBalBefore -= msg.value;
        }

        uint256 requiredHBAR = _requiredHBAR(baseAmount, quoteAmount);
        require(msg.value >= requiredHBAR, "HBAR<required");
        if (BASE != address(0)) {
            uint256 pre = IERC20(BASE).balanceOf(address(this));
            IERC20(BASE).safeTransferFrom(msg.sender, address(this), baseAmount);
            require(
                IERC20(BASE).balanceOf(address(this)) - pre == baseAmount,
                "FOT_FORBIDDEN:BASE"
            );
        }

        if (QUOTE != address(0)) {
            uint256 pre = IERC20(QUOTE).balanceOf(address(this));
            IERC20(QUOTE).safeTransferFrom(msg.sender, address(this), quoteAmount);
            require(
                IERC20(QUOTE).balanceOf(address(this)) - pre == quoteAmount,
                "FOT_FORBIDDEN:QUOTE"
            );
        }

        // Include any pre-init donations in the initial basket.
        uint256 baseBalanceAfter = baseBalBefore + baseAmount;
        uint256 quoteBalanceAfter = quoteBalBefore + quoteAmount;

        require(baseBalanceAfter > 0 && quoteBalanceAfter > 0, "empty side");

        uint256 sharesOut = _initialShares(baseBalanceAfter, quoteBalanceAfter);
        require(sharesOut > 0, "shares=0");
        require(sharesOut >= minSharesOut, "slippage: shares");
        require(sharesOut <= type(uint96).max, "shares overflow");

        // Checkpoint receiver so pre-existing reward streams cannot be back-claimed.
        _settleRewards(receiver);

        depositId = _allocDepositSlot();

        uint64 nowU64 = uint64(block.timestamp);
        Deposit storage d = deposits[depositId];
        d.user = receiver;
        d.shares = uint96(sharesOut);
        d.createdAt = nowU64;
        d.lockupUntil = nowU64 + lockupSecs;
        d.state = uint8(DepState.ACTIVE);

        _userDeposits[receiver].push(depositId);

        totalShares = sharesOut;
        userShares[receiver] = sharesOut;
        initialized = true;

        emit VaultInitialized(
            msg.sender,
            receiver,
            baseAmount,
            quoteAmount,
            baseBalanceAfter,
            quoteBalanceAfter,
            sharesOut
        );

        emit DepositedProRata(
            receiver,
            depositId,
            baseAmount,
            quoteAmount,
            sharesOut,
            baseBalBefore,
            quoteBalBefore
        );

        uint256 refund = msg.value - requiredHBAR;
        if (refund != 0) {
            (bool ok, ) = payable(msg.sender).call{value: refund}("");
            require(ok, "HBAR_REFUND_FAILED");
        }
    }

    /* ───────────────────────── Token helpers ───────────────────────── */

    function _vaultBalance(address token) internal view returns (uint256) {
        return
            token == address(0)
                ? address(this).balance
                : IERC20(token).balanceOf(address(this));
    }

    function _transferOut(
        address token,
        address payable to,
        uint256 amount
    ) internal {
        if (amount == 0) return;

        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "HBAR_TRANSFER_FAILED");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function _requiredHBAR(uint256 baseAmount, uint256 quoteAmount)
        internal
        view
        returns (uint256 required)
    {
        if (BASE == address(0)) required += baseAmount;
        if (QUOTE == address(0)) required += quoteAmount;
    }

    /* ───────────────────────── Share conversion helpers ───────────────────────── */

    function _assetToShares(
        uint256 amount,
        uint256 balance,
        uint256 supply,
        uint256 virtualAsset
    ) internal pure returns (uint256) {
        return
            PRBMathCommon.mulDiv(
                amount,
                supply + VIRTUAL_SHARES,
                balance + virtualAsset
            );
    }

    function _sharesToAsset(
        uint256 shares,
        uint256 balance,
        uint256 supply,
        uint256 virtualAsset
    ) internal pure returns (uint256 amount) {
        amount = PRBMathCommon.mulDiv(
            shares,
            balance + virtualAsset,
            supply + VIRTUAL_SHARES
        );

        // Defensive cap. In normal cases amount <= balance.
        if (amount > balance) amount = balance;
    }

    function _normalizeTo18(uint256 amount, uint8 decimals_)
        internal
        pure
        returns (uint256)
    {
        return PRBMathCommon.mulDiv(amount, ONE_18, 10 ** uint256(decimals_));
    }

    function _initialShares(
        uint256 baseAmount,
        uint256 quoteAmount
    ) internal view returns (uint256) {
        uint256 baseNorm = _normalizeTo18(baseAmount, BASE_DECIMALS);
        uint256 quoteNorm = _normalizeTo18(quoteAmount, QUOTE_DECIMALS);

        require(baseNorm > 0 && quoteNorm > 0, "initial: dust");

        // Hedera token supply constraints make this safe for HTS-style tokens.
        // For arbitrary ERC20s, this require gives a clean overflow failure.
        require(
            baseNorm <= type(uint256).max / quoteNorm,
            "initial: overflow"
        );

        return _sqrt(baseNorm * quoteNorm);
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : ((a - 1) / b) + 1;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;

        uint256 z = (x + 1) / 2;
        y = x;

        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    function _mulDivUp(
        uint256 x,
        uint256 y,
        uint256 denominator
    ) internal pure returns (uint256) {
        if (x == 0 || y == 0) return 0;

        uint256 z = PRBMathCommon.mulDiv(x, y, denominator);

        if (mulmod(x, y, denominator) != 0) {
            z += 1;
        }

        return z;
    }

    /* ───────────────────────── Deposit preview ───────────────────────── */
    
    function previewDepositProRata(
        uint256 baseMax,
        uint256 quoteMax
    )
        external onlyInitialized
        view
        returns (
            uint256 baseIn,
            uint256 quoteIn,
            uint256 sharesOut
        )
    {
        return
            _previewDepositProRataFromBalances(
                baseMax,
                quoteMax,
                _vaultBalance(BASE),
                _vaultBalance(QUOTE),
                totalShares
            );
    }

    function _previewDepositProRataFromBalances(
        uint256 baseMax,
        uint256 quoteMax,
        uint256 baseBal,
        uint256 quoteBal,
        uint256 supply
    )
        internal
        pure
        returns (
            uint256 baseIn,
            uint256 quoteIn,
            uint256 sharesOut
        )
    {
        require(supply > 0, "not initialized");
        require(baseBal > 0 && quoteBal > 0, "bad inventory");

        uint256 sharesByBase = _assetToShares(
            baseMax,
            baseBal,
            supply,
            VIRTUAL_BASE
        );

        uint256 sharesByQuote = _assetToShares(
            quoteMax,
            quoteBal,
            supply,
            VIRTUAL_QUOTE
        );

        sharesOut = sharesByBase < sharesByQuote ? sharesByBase : sharesByQuote;
        if (sharesOut == 0) return (0, 0, 0);

        uint256 denom = supply + VIRTUAL_SHARES;

        baseIn = _mulDivUp(sharesOut, baseBal + VIRTUAL_BASE, denom);
        quoteIn = _mulDivUp(sharesOut, quoteBal + VIRTUAL_QUOTE, denom);

        require(baseIn <= baseMax && quoteIn <= quoteMax, "preview: cap");
    }

    /* ───────────────────────── Deposits ───────────────────────── */

    /// @notice Deposit in the vault's current inventory ratio.
    /// @param baseMax Maximum BASE units the user is willing to provide.
    /// @param quoteMax Maximum QUOTE units the user is willing to provide.
    /// @param minSharesOut Minimum shares to mint.
    /// @param deadline Latest timestamp allowed.
    /// @dev For native HBAR, msg.value is treated as a cap and excess is refunded.
    function depositProRata(
        uint256 baseMax,
        uint256 quoteMax,
        uint256 minSharesOut,
        uint64 deadline
    ) external payable nonReentrant onlyInitialized returns (uint256 depositId) {
        require(!emergencyMode, "emergency: deposits disabled");
        require(block.timestamp <= deadline, "expired");

        _accrueMgmtFee();

        // Pre-call balances. Native HBAR balance already includes msg.value.
        uint256 baseBalBefore = _vaultBalance(BASE);
        uint256 quoteBalBefore = _vaultBalance(QUOTE);

        if (BASE == address(0)) {
            require(baseBalBefore >= msg.value, "HBAR accounting");
            baseBalBefore -= msg.value;
        }
        if (QUOTE == address(0)) {
            require(quoteBalBefore >= msg.value, "HBAR accounting");
            quoteBalBefore -= msg.value;
        }

        (uint256 baseIn, uint256 quoteIn, uint256 sharesOut) =
            _previewDepositProRataFromBalances(
                baseMax,
                quoteMax,
                baseBalBefore,
                quoteBalBefore,
                totalShares
            );

        require(sharesOut > 0, "shares=0");
        require(sharesOut >= minSharesOut, "slippage: shares");
        require(sharesOut <= type(uint96).max, "shares overflow");

        uint256 requiredHBAR = _requiredHBAR(baseIn, quoteIn);
        require(msg.value >= requiredHBAR, "HBAR<required");

        if (baseIn > 0 && BASE != address(0)) {
            uint256 pre = IERC20(BASE).balanceOf(address(this));
            IERC20(BASE).safeTransferFrom(msg.sender, address(this), baseIn);
            require(
                IERC20(BASE).balanceOf(address(this)) - pre == baseIn,
                "FOT_FORBIDDEN:BASE"
            );
        }

        if (quoteIn > 0 && QUOTE != address(0)) {
            uint256 pre = IERC20(QUOTE).balanceOf(address(this));
            IERC20(QUOTE).safeTransferFrom(msg.sender, address(this), quoteIn);
            require(
                IERC20(QUOTE).balanceOf(address(this)) - pre == quoteIn,
                "FOT_FORBIDDEN:QUOTE"
            );
        }

        _settleRewards(msg.sender);

        depositId = _allocDepositSlot();

        uint64 nowU64 = uint64(block.timestamp);
        Deposit storage d = deposits[depositId];
        d.user = msg.sender;
        d.shares = uint96(sharesOut);
        d.createdAt = nowU64;
        d.lockupUntil = nowU64 + lockupSecs;
        d.state = uint8(DepState.ACTIVE);

        _userDeposits[msg.sender].push(depositId);

        totalShares += sharesOut;
        userShares[msg.sender] += sharesOut;

        emit DepositedProRata(
            msg.sender,
            depositId,
            baseIn,
            quoteIn,
            sharesOut,
            baseBalBefore,
            quoteBalBefore
        );

        uint256 refund = msg.value - requiredHBAR;
        if (refund != 0) {
            (bool ok, ) = payable(msg.sender).call{value: refund}("");
            require(ok, "HBAR_REFUND_FAILED");
        }
    }

    /* ───────────────────────── Withdrawals ───────────────────────── */

    function previewWithdrawProRata(uint256 shares)
        external
        view
        returns (uint256 baseOut, uint256 quoteOut)
    {
        require(shares > 0 && totalShares > 0, "bad shares");

        uint256 supply = totalShares;
        baseOut = _sharesToAsset(
            shares,
            _vaultBalance(BASE),
            supply,
            VIRTUAL_BASE
        );
        quoteOut = _sharesToAsset(
            shares,
            _vaultBalance(QUOTE),
            supply,
            VIRTUAL_QUOTE
        );
    }

    function withdrawFromDeposit(
        uint256 depositId,
        uint256 sharesToBurn,
        uint256 minBaseOut,
        uint256 minQuoteOut,
        uint64 deadline
    ) public nonReentrant onlyInitialized {
        require(block.timestamp <= deadline, "expired");

        _accrueMgmtFee();

        Deposit storage d = deposits[depositId];
        address user = d.user;

        require(user == msg.sender, "not owner");
        require(d.state == uint8(DepState.ACTIVE), "withdrawn");
        require(block.timestamp >= d.lockupUntil, "locked");
        require(
            sharesToBurn > 0 && sharesToBurn <= uint256(d.shares),
            "bad shares"
        );

        _settleRewards(user);

        uint256 supplyBefore = totalShares;
        require(supplyBefore >= sharesToBurn, "supply");

        uint256 baseOut = _sharesToAsset(
            sharesToBurn,
            _vaultBalance(BASE),
            supplyBefore,
            VIRTUAL_BASE
        );
        uint256 quoteOut = _sharesToAsset(
            sharesToBurn,
            _vaultBalance(QUOTE),
            supplyBefore,
            VIRTUAL_QUOTE
        );

        require(baseOut >= minBaseOut, "slippage: base");
        require(quoteOut >= minQuoteOut, "slippage: quote");

        d.shares = uint96(uint256(d.shares) - sharesToBurn);
        totalShares = supplyBefore - sharesToBurn;

        uint256 us = userShares[user];
        userShares[user] = us >= sharesToBurn ? us - sharesToBurn : 0;

        if (d.shares == 0) {
            d.state = uint8(DepState.WITHDRAWN);
            _removeUserDeposit(user, depositId);
            _deleteDeposit(depositId);
        }

        _transferOut(BASE, payable(user), baseOut);
        _transferOut(QUOTE, payable(user), quoteOut);

        emit WithdrawalFinalized(
            depositId,
            user,
            baseOut,
            quoteOut,
            sharesToBurn
        );
    }

    function withdrawAllFromDeposit(
        uint256 depositId,
        uint256 minBaseOut,
        uint256 minQuoteOut,
        uint64 deadline
    ) external onlyInitialized {
        uint256 sh = deposits[depositId].shares;
        withdrawFromDeposit(
            depositId,
            sh,
            minBaseOut,
            minQuoteOut,
            deadline
        );
    }

    /* ───────────────────────── Owner fee redemption ───────────────────────── */

    function ownerRedeemFees(
        uint256 feeSharesToBurn,
        uint256 minBaseOut,
        uint256 minQuoteOut
    ) external onlyOwner nonReentrant onlyInitialized {
        _accrueMgmtFee();
        uint256 available = ownerFeeShares;
        uint256 burn = feeSharesToBurn > available
            ? available
            : feeSharesToBurn;
        require(burn > 0, "no feeShares");

        uint256 supplyBefore = totalShares;
        require(supplyBefore >= burn, "supply");

        uint256 baseOut = _sharesToAsset(
            burn,
            _vaultBalance(BASE),
            supplyBefore,
            VIRTUAL_BASE
        );
        uint256 quoteOut = _sharesToAsset(
            burn,
            _vaultBalance(QUOTE),
            supplyBefore,
            VIRTUAL_QUOTE
        );

        require(baseOut >= minBaseOut, "slippage: base");
        require(quoteOut >= minQuoteOut, "slippage: quote");

        ownerFeeShares = available - burn;
        totalShares = supplyBefore - burn;

        _transferOut(BASE, payable(owner()), baseOut);
        _transferOut(QUOTE, payable(owner()), quoteOut);

        emit OwnerFeeRedeemed(burn, baseOut, quoteOut);
    }

    /* ───────────────────────── Deposit lot helpers ───────────────────────── */

    function depositsLength() external view returns (uint256) {
        return deposits.length;
    }

    function depositsOf(address user) external view returns (uint256[] memory) {
        return _userDeposits[user];
    }

    function _allocDepositSlot() internal returns (uint256 id) {
        id = deposits.length;
        deposits.push();
    }

    function _deleteDeposit(uint256 id) internal {
        delete deposits[id];
    }

    function _removeUserDeposit(address user, uint256 id) internal {
        uint256[] storage arr = _userDeposits[user];
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == id) {
                uint256 last = arr.length - 1;
                if (i != last) arr[i] = arr[last];
                arr.pop();
                break;
            }
        }
    }

    /* ───────────────────────── Rewards ───────────────────────── */

    function _ensureListedReward(address rt) internal {
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            if (rewardTokens[i] == rt) return;
        }
        require(rewardTokens.length < MAX_REWARD_TOKENS, "too many reward tokens");
        rewardTokens.push(rt);
    }

    function _eligibleShares() internal view returns (uint256) {
        uint256 ts = totalShares;
        uint256 fee = ownerFeeShares;
        return ts > fee ? (ts - fee) : 0;
    }

    function _updateReward(address rt) internal {
        RewardData storage R = rewards[rt];

        uint64 t = uint64(block.timestamp);
        uint64 capped = t < R.periodFinish ? t : R.periodFinish;

        if (capped > R.lastUpdate) {
            uint256 dt = uint256(capped - R.lastUpdate);

            if (dt > 0) {
                uint256 eligible = _eligibleShares();

                if (eligible == 0) {
                    R.carry += SafeCast.toUint128(R.rate * dt);
                } else {
                    R.perShare += (R.rate * dt * 1e18) / eligible;
                }
            }

            R.lastUpdate = capped;

            if (capped == R.periodFinish) {
                R.rate = 0;
            }
        }
    }

    function _settleRewards(address user) internal {
        uint256 len = rewardTokens.length;
        if (len == 0) return;

        uint256 sh = userShares[user];

        for (uint256 i = 0; i < len; i++) {
            address rt = rewardTokens[i];

            _updateReward(rt);

            RewardData storage R = rewards[rt];
            UserReward storage U = userRewards[user][rt];

            if (sh != 0) {
                uint256 delta = R.perShare - U.perSharePaid;
                if (delta != 0) {
                    U.accrued += (sh * delta) / 1e18;
                }
            }

            U.perSharePaid = R.perShare;
        }
    }

    function onAirdropFunded(address rewardToken, uint256 netAmount) external {
        require(msg.sender == address(distributor), "only distributor");
        require(rewardToken != address(0), "HBAR reward unsupported");
        require(netAmount > 0, "net=0");

        _accrueMgmtFee();
        _updateReward(rewardToken);
        _ensureListedReward(rewardToken);

        RewardData storage R = rewards[rewardToken];
        uint64 nowU64 = uint64(block.timestamp);

        uint256 leftover = 0;
        if (nowU64 < R.periodFinish && R.rate > 0) {
            leftover = R.rate * uint256(R.periodFinish - nowU64);
        }

        uint256 totalToStream = leftover + uint256(R.carry) + netAmount;

        if (nowU64 < R.periodFinish) {
            uint256 remainingTime = uint256(R.periodFinish - nowU64);

            if (R.campaignStart == 0) {
                R.campaignStart = nowU64;
            }

            R.rate = totalToStream / remainingTime;
            R.carry = SafeCast.toUint128(
                totalToStream - R.rate * remainingTime
            );
            R.lastUpdate = nowU64;

            emit RewardStreamConfigured(
                rewardToken,
                netAmount,
                R.campaignStart,
                uint64(remainingTime),
                R.rate,
                R.carry,
                R.periodFinish
            );
        } else {
            R.rate = totalToStream / vestingSecs;
            R.carry = SafeCast.toUint128(
                totalToStream - R.rate * vestingSecs
            );
            R.lastUpdate = nowU64;
            R.campaignStart = nowU64;
            R.periodFinish = nowU64 + vestingSecs;

            emit RewardStreamConfigured(
                rewardToken,
                netAmount,
                R.campaignStart,
                vestingSecs,
                R.rate,
                R.carry,
                R.periodFinish
            );
        }
    }

    function claimRewards(address rewardToken) external nonReentrant {
        require(address(distributor) != address(0), "distributor not set");

        _settleRewards(msg.sender);

        UserReward storage U = userRewards[msg.sender][rewardToken];
        uint256 amt = U.accrued;

        if (amt > 0) {
            try distributor.claimTo(rewardToken, msg.sender, amt) {
                U.accrued = 0;
                emit RewardClaimed(rewardToken, msg.sender, amt);
            } catch {
                emit RewardClaimFailed(rewardToken, msg.sender, amt);
            }
        }
    }

    function claimAllRewards() external nonReentrant {
        require(address(distributor) != address(0), "distributor not set");

        _settleRewards(msg.sender);

        for (uint256 i = 0; i < rewardTokens.length; i++) {
            address rt = rewardTokens[i];

            UserReward storage U = userRewards[msg.sender][rt];
            uint256 amt = U.accrued;

            if (amt > 0) {
                try distributor.claimTo(rt, msg.sender, amt) {
                    U.accrued = 0;
                    emit RewardClaimed(rt, msg.sender, amt);
                } catch {
                    emit RewardClaimFailed(rt, msg.sender, amt);
                }
            }
        }
    }

    /* ───────────────────────── Management fee accrual ───────────────────────── */

    function _applyPendingFee(uint64 effectiveTs) internal {
        uint32 previous = ownerFeeBips;
        uint32 next = pendingOwnerFeeBips;

        ownerFeeBips = next;
        pendingOwnerFeeBips = 0;
        pendingOwnerFeeTs = 0;

        emit OwnerFeeRateApplied(previous, next, effectiveTs);
    }

    function _applyPendingFeeIfDue(uint64 nowTs) internal {
        uint64 effTs = pendingOwnerFeeTs;

        if (effTs != 0 && nowTs >= effTs) {
            _applyPendingFee(effTs);
        }
    }

    function _accrueMgmtFee() internal {
        uint64 nowTs = uint64(block.timestamp);
        uint64 last = lastFeeAccrual;
        if (nowTs <= last) return;

        // Charge fees only when there are depositor shares.
        // This avoids self-compounding owner fees when only ownerFeeShares remain.
        if (_eligibleShares() == 0) {
            lastFeeAccrual = nowTs;
            _applyPendingFeeIfDue(nowTs);
            return;
        }

        uint64 effTs = pendingOwnerFeeTs;

        if (effTs != 0 && last < effTs && nowTs > effTs) {
            _accrueLinear(last, effTs, ownerFeeBips);
            _applyPendingFee(effTs);
            _accrueLinear(effTs, nowTs, ownerFeeBips);
        } else {
            _applyPendingFeeIfDue(nowTs);
            _accrueLinear(last, nowTs, ownerFeeBips);
        }

        lastFeeAccrual = nowTs;
    }

    function _accrueLinear(
        uint64 fromTs,
        uint64 toTs,
        uint32 rateBips
    ) internal {
        if (toTs <= fromTs) return;
        if (rateBips == 0) return;

        uint256 den = BPS * uint256(WEEK_SECS);
        uint64 maxDt = uint64((den / rateBips) - 1);

        uint64 t = fromTs;

        while (t < toTs) {
            uint64 chunkEnd = toTs - t > maxDt ? t + maxDt : toTs;
            uint64 dt = chunkEnd - t;

            uint256 S = totalShares;
            uint256 depositorShares = _eligibleShares();

            if (depositorShares != 0 && S != 0) {
                uint256 num = uint256(rateBips) * uint256(dt);
                uint256 dS = (S * num) / (den - num);

                if (dS != 0) {
                    totalShares = S + dS;
                    ownerFeeShares += dS;

                    emit OwnerFeeAccrued(dS, t, chunkEnd, rateBips);
                }
            }

            t = chunkEnd;
        }
    }

    /* ───────────────────────── Emergency mode ───────────────────────── */

    function enableEmergencyMode() external {
        require(!emergencyMode, "emergency: already enabled");

        address d = address(distributor);
        address dOwner = address(0);

        if (d != address(0)) {
            try IOwnable(d).owner() returns (address o) {
                dOwner = o;
            } catch {}
        }

        require(
            msg.sender == owner() ||
                (dOwner != address(0) && msg.sender == dOwner),
            "emergency: not authorized"
        );

        emergencyMode = true;
        emit EmergencyModeEnabled(msg.sender);
    }

    /// @notice Emergency withdraw ignores lockup and uses strict raw pro-rata balances.
    function emergencyWithdrawFromDeposit(uint256 depositId)
        public
        nonReentrant
    {
        require(emergencyMode, "emergency: disabled");

        Deposit storage d = deposits[depositId];
        address user = d.user;

        require(user == msg.sender, "not owner");
        require(d.state == uint8(DepState.ACTIVE), "withdrawn");

        uint256 sh = d.shares;
        require(sh > 0, "no shares");

        _accrueMgmtFee();
        _settleRewards(user);

        uint256 supplyBefore = totalShares;
        require(supplyBefore >= sh, "supply");

        uint256 baseOut = PRBMathCommon.mulDiv(
            _vaultBalance(BASE),
            sh,
            supplyBefore
        );
        uint256 quoteOut = PRBMathCommon.mulDiv(
            _vaultBalance(QUOTE),
            sh,
            supplyBefore
        );

        d.shares = 0;
        d.state = uint8(DepState.WITHDRAWN);

        totalShares = supplyBefore - sh;

        uint256 us = userShares[user];
        userShares[user] = us >= sh ? us - sh : 0;

        _removeUserDeposit(user, depositId);
        _deleteDeposit(depositId);

        _transferOut(BASE, payable(user), baseOut);
        _transferOut(QUOTE, payable(user), quoteOut);

        emit WithdrawalFinalized(depositId, user, baseOut, quoteOut, sh);
    }

    function ownerRedeemFeesEmergency(uint256 feeSharesToBurn)
        external
        onlyOwner
        nonReentrant
    {
        require(emergencyMode, "emergency: disabled");
        require(
            feeSharesToBurn > 0 && feeSharesToBurn <= ownerFeeShares,
            "bad feeShares"
        );

        _accrueMgmtFee();

        uint256 supplyBefore = totalShares;
        require(supplyBefore >= feeSharesToBurn, "supply");

        uint256 baseOut = PRBMathCommon.mulDiv(
            _vaultBalance(BASE),
            feeSharesToBurn,
            supplyBefore
        );
        uint256 quoteOut = PRBMathCommon.mulDiv(
            _vaultBalance(QUOTE),
            feeSharesToBurn,
            supplyBefore
        );

        ownerFeeShares -= feeSharesToBurn;
        totalShares = supplyBefore - feeSharesToBurn;

        _transferOut(BASE, payable(owner()), baseOut);
        _transferOut(QUOTE, payable(owner()), quoteOut);

        emit OwnerFeeRedeemed(feeSharesToBurn, baseOut, quoteOut);
    }

    receive() external payable {}

    //-------------------- AMM Rebalances ---------------------

   function _ammToken(address vaultToken) internal pure returns (address) {
        return vaultToken == address(0) ? WHBAR : vaultToken;
    }

    function _tokensForDirection(bool baseToQuote)
        internal
        view
        returns (address tokenIn, address tokenOut)
    {
        tokenIn = baseToQuote ? BASE : QUOTE;
        tokenOut = baseToQuote ? QUOTE : BASE;
        require(tokenIn != tokenOut, "same token");
    }

    function _safeApprove(
        address token,
        address spender,
        uint256 amount
    ) internal {
        (bool success, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, amount)
        );

        require(success, "APPROVE_CALL_FAILED");

        if (ret.length > 0) {
            require(abi.decode(ret, (bool)), "APPROVE_FAILED");
        }
    }

    function _checkSwapInputs(
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) internal view {
        require(!emergencyMode, "emergency: swaps disabled");
        require(initialized, "not initialized");
        require(block.timestamp <= deadline, "expired");
        require(amountIn > 0, "amountIn=0");
        require(amountOutMin > 0, "amountOutMin=0");
    }

    function _checkV1Path(
        bool baseToQuote,
        address[] calldata path
    ) internal view returns (address tokenIn, address tokenOut) {
        require(path.length >= 2, "bad path");

        (tokenIn, tokenOut) = _tokensForDirection(baseToQuote);

        require(path[0] == _ammToken(tokenIn), "bad tokenIn");
        require(path[path.length - 1] == _ammToken(tokenOut), "bad tokenOut");
    }

    function _readV2Token(bytes calldata path, uint256 offset)
        internal
        pure
        returns (address token)
    {
        require(path.length >= offset + 20, "path oob");

        assembly {
            token := shr(96, calldataload(add(path.offset, offset)))
        }
    }

    function _checkV2Path(
        bool baseToQuote,
        bytes calldata path
    ) internal view returns (address tokenIn, address tokenOut) {
        // tokenA(20) + fee(3) + tokenB(20)
        require(path.length >= 43, "bad path");
        require((path.length - 20) % 23 == 0, "bad path len");

        (tokenIn, tokenOut) = _tokensForDirection(baseToQuote);

        address first = _readV2Token(path, 0);
        address last = _readV2Token(path, path.length - 20);

        require(first == _ammToken(tokenIn), "bad tokenIn");
        require(last == _ammToken(tokenOut), "bad tokenOut");
    }

    /// @notice Manager-only exact-input rebalance through SaucerSwap V1.
    /// @dev Supports token->token, HBAR->token, token->HBAR, and multihop paths.
    ///      If a vault side is HBAR, the route should use WHBAR as that endpoint.
    function managerRebalanceSaucerV1(
        bool baseToQuote,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline,
        address[] calldata path
    )
        external
        nonReentrant
        onlyManagerOrOwner
        returns (uint256 amountOutActual)
    {
        _checkSwapInputs(amountIn, amountOutMin, deadline);
        
        (address tokenIn, address tokenOut) = _checkV1Path(baseToQuote, path);

        _accrueMgmtFee();

        uint256 inBefore = _vaultBalance(tokenIn);
        uint256 outBefore = _vaultBalance(tokenOut);

        require(inBefore >= amountIn, "insufficient input");

        if (tokenIn == address(0)) {
            // HBAR -> token
            ISaucerV1Router(SAUCER_V1_ROUTER).swapExactETHForTokens{
                value: amountIn
            }(
                amountOutMin,
                path,
                address(this),
                deadline
            );
        } else if (tokenOut == address(0)) {
            // token -> HBAR
            _safeApprove(tokenIn, SAUCER_V1_ROUTER, amountIn);

            ISaucerV1Router(SAUCER_V1_ROUTER).swapExactTokensForETH(
                amountIn,
                amountOutMin,
                path,
                address(this),
                deadline
            );

            _safeApprove(tokenIn, SAUCER_V1_ROUTER, 0);
        } else {
            // token -> token
            _safeApprove(tokenIn, SAUCER_V1_ROUTER, amountIn);

            ISaucerV1Router(SAUCER_V1_ROUTER).swapExactTokensForTokens(
                amountIn,
                amountOutMin,
                path,
                address(this),
                deadline
            );

            _safeApprove(tokenIn, SAUCER_V1_ROUTER, 0);
        }

        uint256 inAfter = _vaultBalance(tokenIn);
        uint256 outAfter = _vaultBalance(tokenOut);

        require(inBefore >= inAfter, "input balance");
        require(inBefore - inAfter == amountIn, "input spent");
        require(outAfter >= outBefore, "output balance");

        amountOutActual = outAfter - outBefore;
        require(amountOutActual >= amountOutMin, "slippage");

        emit ManagerRebalance(
            1,
            baseToQuote,
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            amountOutActual
        );
    }

    /// @notice Manager-only exact-input rebalance through SaucerSwap V2.
    /// @dev Supports token->token, HBAR->token, token->HBAR, and multihop paths.
    ///      Path must be encoded as token|fee|token|fee|token.
    ///      If a vault side is HBAR, the route should use WHBAR as that endpoint.
    function managerRebalanceSaucerV2(
        bool baseToQuote,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline,
        bytes calldata path
    )
        external
        nonReentrant
        onlyManagerOrOwner
        returns (uint256 amountOutActual)
    {
        _checkSwapInputs(amountIn, amountOutMin, deadline);

        (address tokenIn, address tokenOut) = _checkV2Path(baseToQuote, path);

        _accrueMgmtFee();

        uint256 inBefore = _vaultBalance(tokenIn);
        uint256 outBefore = _vaultBalance(tokenOut);

        require(inBefore >= amountIn, "insufficient input");

        uint256 callValue = 0;

        if (tokenIn == address(0)) {
            // HBAR -> token.
            // The V2 path should start with WHBAR.
            callValue = amountIn;
        } else {
            _safeApprove(tokenIn, SAUCER_V2_ROUTER, amountIn);
        }

        address recipient = tokenOut == address(0)
            ? SAUCER_V2_ROUTER
            : address(this);

        bytes memory exactInputCall = abi.encodeWithSelector(
            ISaucerV2Router.exactInput.selector,
            ISaucerV2Router.ExactInputParams({
                path: path,
                recipient: recipient,
                deadline: deadline,
                amountIn: amountIn,
                amountOutMinimum: amountOutMin
            })
        );

        if (tokenOut == address(0)) {
            // token -> HBAR
            //
            // exactInput sends WHBAR to the router.
            // unwrapWHBAR unwraps it and sends native HBAR to this vault.
            bytes[] memory calls = new bytes[](2);

            calls[0] = exactInputCall;
            calls[1] = abi.encodeWithSelector(
                ISaucerV2Router.unwrapWHBAR.selector,
                amountOutMin,
                address(this)
            );

            ISaucerV2Router(SAUCER_V2_ROUTER).multicall(calls);
        } else if (tokenIn == address(0)) {
            // HBAR -> token
            //
            // The router receives native HBAR and handles wrapping internally.
            // refundETH is included defensively.
            bytes[] memory calls = new bytes[](2);

            calls[0] = exactInputCall;
            calls[1] = abi.encodeWithSelector(
                ISaucerV2Router.refundETH.selector
            );

            ISaucerV2Router(SAUCER_V2_ROUTER).multicall{value: callValue}(calls);
        } else {
            // token -> token
            ISaucerV2Router(SAUCER_V2_ROUTER).exactInput(
                ISaucerV2Router.ExactInputParams({
                    path: path,
                    recipient: address(this),
                    deadline: deadline,
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMin
                })
            );
        }

        if (tokenIn != address(0)) {
            _safeApprove(tokenIn, SAUCER_V2_ROUTER, 0);
        }

        uint256 inAfter = _vaultBalance(tokenIn);
        uint256 outAfter = _vaultBalance(tokenOut);

        require(inBefore >= inAfter, "input balance");
        require(inBefore - inAfter == amountIn, "input spent");
        require(outAfter >= outBefore, "output balance");

        amountOutActual = outAfter - outBefore;
        require(amountOutActual >= amountOutMin, "slippage");

        emit ManagerRebalance(
            2,
            baseToQuote,
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            amountOutActual
        );
    }
}