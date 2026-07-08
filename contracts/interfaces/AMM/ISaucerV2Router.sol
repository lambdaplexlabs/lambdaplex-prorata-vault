// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISaucerV2Router {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(
        ExactInputParams calldata params
    ) external payable returns (uint256 amountOut);

    function multicall(
        bytes[] calldata data
    ) external payable returns (bytes[] memory results);

    function unwrapWHBAR(
        uint256 amountMinimum,
        address recipient
    ) external payable;
    
    function refundETH() external payable;
}
