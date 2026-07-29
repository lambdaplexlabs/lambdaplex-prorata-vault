import { ethers, network } from "hardhat";

const DAY_SECS = 24 * 60 * 60;
const WEEK_SECS = 7 * DAY_SECS;
const MAX_DELAY_SECS = 30 * DAY_SECS;
const MAX_OWNER_FEE_BIPS = 3_000;

function addressEnv(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  if (!ethers.utils.isAddress(value)) {
    throw new Error(`${name} is not a valid EVM address: ${value}`);
  }
  return ethers.utils.getAddress(value);
}

function uintEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} is outside JavaScript's safe integer range`);
  }
  return value;
}

function requireRange(
  name: string,
  value: number,
  minimum: number,
  maximum: number
) {
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account is configured");

  const base = addressEnv("VAULT_BASE_ADDRESS");
  const quote = addressEnv("VAULT_QUOTE_ADDRESS");
  const distributor = addressEnv("VAULT_DISTRIBUTOR_ADDRESS");
  const manager = addressEnv("VAULT_MANAGER_ADDRESS", deployer.address);

  if (base === quote) {
    throw new Error("VAULT_BASE_ADDRESS and VAULT_QUOTE_ADDRESS must differ");
  }

  const ownerFeeBips = uintEnv("VAULT_OWNER_FEE_BIPS", 0);
  const vestingSecs = uintEnv("VAULT_VESTING_SECS", WEEK_SECS);
  const lockupSecs = uintEnv("VAULT_LOCKUP_SECS", DAY_SECS);
  const feeChangeDelaySecs = uintEnv(
    "VAULT_FEE_CHANGE_DELAY_SECS",
    WEEK_SECS
  );

  requireRange(
    "VAULT_OWNER_FEE_BIPS",
    ownerFeeBips,
    0,
    MAX_OWNER_FEE_BIPS
  );
  requireRange("VAULT_VESTING_SECS", vestingSecs, 1, WEEK_SECS);
  requireRange("VAULT_LOCKUP_SECS", lockupSecs, 1, WEEK_SECS);
  requireRange(
    "VAULT_FEE_CHANGE_DELAY_SECS",
    feeChangeDelaySecs,
    DAY_SECS,
    MAX_DELAY_SECS
  );

  const chain = await ethers.provider.getNetwork();
  const deployment = {
    contract: "PLEXProRataVaultHedera",
    network: network.name,
    chainId: chain.chainId,
    owner: deployer.address,
    base,
    quote,
    distributor,
    manager,
    ownerFeeBips,
    vestingSecs,
    lockupSecs,
    feeChangeDelaySecs,
  };

  console.log("Vault deployment configuration:");
  console.table(deployment);

  if (process.env.DRY_RUN?.toLowerCase() === "true") {
    console.log("DRY_RUN=true; configuration validated without broadcasting.");
    return;
  }

  if (network.name !== "hederaTestnet") {
    throw new Error(
      `Refusing to run testnet deployment on network '${network.name}'. ` +
        "Use --network hederaTestnet or set DRY_RUN=true."
    );
  }

  const vaultFactory = await ethers.getContractFactory(
    "PLEXProRataVaultHedera",
    deployer
  );
  const vault = await vaultFactory.deploy(
    base,
    quote,
    distributor,
    manager,
    ownerFeeBips,
    vestingSecs,
    lockupSecs,
    feeChangeDelaySecs
  );

  console.log("Deployment transaction:", vault.deployTransaction.hash);
  await vault.deployed();
  console.log("PLEXProRataVaultHedera deployed to:", vault.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
