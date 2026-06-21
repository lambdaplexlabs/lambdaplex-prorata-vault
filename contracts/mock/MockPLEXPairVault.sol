// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import '../base/PLEXProRataVault.sol';

contract MockPLEXPairVault is PLEXProRataVault {

    constructor(
        address base_,
        address quote_,
        address distributor_,
        address manager_,
        uint32 ownerFeeBips_,
        uint64 vestingSecs_,
        uint64 lockupSecs_,
        uint64 feeChangeDelaySecs_
    ) PLEXProRataVault(
        base_,
        quote_,
        distributor_,
        manager_,
        ownerFeeBips_,
        vestingSecs_,
        lockupSecs_,
        feeChangeDelaySecs_
    ) {

    }
}