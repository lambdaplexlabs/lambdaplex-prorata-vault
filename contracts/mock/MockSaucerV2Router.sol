// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
}

/// @dev Minimal SaucerSwap V2 router mock.
///      It does not simulate AMM math.
///      It only:
///      - pulls exact input
///      - pays configurable output
///      - enforces amountOutMinimum
///      - supports token->token, HBAR->token, token->HBAR via multicall + unwrapWHBAR
contract MockSaucerV2Router {
    address public constant WHBAR =
        0x0000000000000000000000000000000000163B5a;

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    uint256 public amountOutOverride;
    uint256 public pendingUnwrap;

    function setAmountOut(uint256 amountOut) external {
        amountOutOverride = amountOut;
    }

    function _amountOut(uint256 amountOutMinimum) internal view returns (uint256) {
        return amountOutOverride == 0 ? amountOutMinimum : amountOutOverride;
    }

    function exactInput(ExactInputParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        require(block.timestamp <= params.deadline, "MockV2: expired");
        require(params.path.length >= 43, "MockV2: bad path");

        address tokenIn = _readToken(params.path, 0);
        address tokenOut = _readToken(params.path, params.path.length - 20);

        amountOut = _amountOut(params.amountOutMinimum);
        require(amountOut >= params.amountOutMinimum, "MockV2: slippage");

        if (msg.value == 0) {
            require(
                IERC20Like(tokenIn).transferFrom(
                    msg.sender,
                    address(this),
                    params.amountIn
                ),
                "MockV2: pull failed"
            );
        } else {
            require(msg.value == params.amountIn, "MockV2: bad value");
        }

        if (tokenOut == WHBAR && params.recipient == address(this)) {
            // Simulate router briefly custodying WHBAR before unwrap.
            pendingUnwrap += amountOut;
        } else {
            require(
                IERC20Like(tokenOut).transfer(params.recipient, amountOut),
                "MockV2: pay failed"
            );
        }
    }

    function multicall(bytes[] calldata data)
        external
        payable
        returns (bytes[] memory results)
    {
        results = new bytes[](data.length);

        for (uint256 i = 0; i < data.length; i++) {
            (bool ok, bytes memory ret) = address(this).delegatecall(data[i]);
            require(ok, "MockV2: multicall failed");
            results[i] = ret;
        }
    }

    function unwrapWHBAR(uint256 amountMinimum, address recipient) external payable {
        require(pendingUnwrap >= amountMinimum, "MockV2: insufficient WHBAR");

        uint256 amount = pendingUnwrap;
        pendingUnwrap = 0;

        (bool ok, ) = payable(recipient).call{value: amount}("");
        require(ok, "MockV2: HBAR pay failed");
    }

    function refundETH() external payable {
        // No-op for mock. Real router refunds unused native HBAR.
    }

    function _readToken(bytes calldata path, uint256 offset)
        internal
        pure
        returns (address token)
    {
        assembly {
            token := shr(96, calldataload(add(path.offset, offset)))
        }
    }

    receive() external payable {}
}