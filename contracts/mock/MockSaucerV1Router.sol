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

/// @dev Minimal SaucerSwap V1 router mock.
///      It does not simulate AMM math.
///      It only:
///      - pulls exact input
///      - pays configurable output
///      - enforces amountOutMin
///      - supports token->token, HBAR->token, token->HBAR
contract MockSaucerV1Router {
    address public constant WHBAR =
        0x0000000000000000000000000000000000163B59;

    uint256 public amountOutOverride;

    function setAmountOut(uint256 amountOut) external {
        amountOutOverride = amountOut;
    }

    function _amountOut(uint256 amountOutMin) internal view returns (uint256) {
        return amountOutOverride == 0 ? amountOutMin : amountOutOverride;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "MockV1: expired");
        require(path.length >= 2, "MockV1: bad path");

        address tokenIn = path[0];
        address tokenOut = path[path.length - 1];

        uint256 out = _amountOut(amountOutMin);
        require(out >= amountOutMin, "MockV1: slippage");

        require(
            IERC20Like(tokenIn).transferFrom(msg.sender, address(this), amountIn),
            "MockV1: pull failed"
        );

        require(
            IERC20Like(tokenOut).transfer(to, out),
            "MockV1: pay failed"
        );

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = out;
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "MockV1: expired");
        require(path.length >= 2, "MockV1: bad path");
        require(msg.value > 0, "MockV1: no HBAR");

        address tokenOut = path[path.length - 1];

        uint256 out = _amountOut(amountOutMin);
        require(out >= amountOutMin, "MockV1: slippage");

        require(
            IERC20Like(tokenOut).transfer(to, out),
            "MockV1: pay failed"
        );

        amounts = new uint256[](path.length);
        amounts[0] = msg.value;
        amounts[path.length - 1] = out;
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "MockV1: expired");
        require(path.length >= 2, "MockV1: bad path");

        address tokenIn = path[0];

        uint256 out = _amountOut(amountOutMin);
        require(out >= amountOutMin, "MockV1: slippage");

        require(
            IERC20Like(tokenIn).transferFrom(msg.sender, address(this), amountIn),
            "MockV1: pull failed"
        );

        (bool ok, ) = payable(to).call{value: out}("");
        require(ok, "MockV1: HBAR pay failed");

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = out;
    }

    receive() external payable {}
}