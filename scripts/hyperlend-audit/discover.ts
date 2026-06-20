/**
 * PASO 0 — On-chain discovery and verification.
 *
 * Verifies every known contract address, discovers all reserves,
 * fetches liquidation bonus params, and saves a machine-readable
 * discovered-config.json for subsequent steps to use.
 *
 * READ-ONLY. No transactions. No private key.
 */

import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import {
  KNOWN_ADDRESSES,
  CHAIN_ID,
  LIQUIDATION_CALL_SIGNATURE,
  POOL_ABI,
  POOL_ADDRESSES_PROVIDER_ABI,
  ORACLE_ABI,
  DATA_PROVIDER_ABI,
  ERC20_ABI,
} from './config';
import { MultiProvider, withRetry } from './rpc';
import { initDb, upsertAsset } from './db';
import type { DiscoveredConfig, AssetInfo } from './types';

export const DISCOVERED_CONFIG_PATH = path.resolve(__dirname, 'discovered-config.json');

// ---- Helpers ----

async function isContractDeployed(provider: ethers.JsonRpcProvider, address: string): Promise<boolean> {
  const code = await provider.getCode(address);
  return code !== '0x' && code.length > 2;
}

async function tryGetPoolDataProvider(
  mp: MultiProvider,
  providerAddr: string,
): Promise<string> {
  const pap = new ethers.Contract(providerAddr, POOL_ADDRESSES_PROVIDER_ABI, mp.provider);
  try {
    return await withRetry(() => pap.getPoolDataProvider() as Promise<string>, 'getPoolDataProvider');
  } catch {
    // Some Aave forks use getAddress(bytes32) with keccak id
    try {
      const id = ethers.keccak256(ethers.toUtf8Bytes('DATA_PROVIDER'));
      const addr = await withRetry(
        () => pap.getFunction('getAddress(bytes32)')(id) as Promise<string>,
        'getAddress(DATA_PROVIDER)',
      );
      if (addr && addr !== ethers.ZeroAddress) return addr;
    } catch { /* ignore */ }
  }
  return ethers.ZeroAddress;
}

async function fetchReserveInfo(
  mp: MultiProvider,
  reserveAddr: string,
  dataProvider: string,
): Promise<AssetInfo> {
  const erc20 = new ethers.Contract(reserveAddr, ERC20_ABI, mp.provider);
  const dp = new ethers.Contract(dataProvider, DATA_PROVIDER_ABI, mp.provider);

  const [symbol, name, decimals] = await Promise.all([
    withRetry(() => erc20.symbol() as Promise<string>, `symbol(${reserveAddr})`).catch(() => 'UNKNOWN'),
    withRetry(() => erc20.name() as Promise<string>, `name(${reserveAddr})`).catch(() => 'UNKNOWN'),
    withRetry(() => erc20.decimals() as Promise<bigint>, `decimals(${reserveAddr})`).catch(() => 18n),
  ]);

  let liquidationBonusBps = 0;
  let liquidationThresholdBps = 0;
  let ltvBps = 0;
  if (dataProvider !== ethers.ZeroAddress) {
    try {
      const cfg = await withRetry(
        () => dp.getReserveConfigurationData(reserveAddr) as Promise<[bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean]>,
        `getReserveConfigurationData(${reserveAddr})`,
      );
      // cfg: [decimals, ltv, liquidationThreshold, liquidationBonus, ...]
      ltvBps = Number(cfg[1]);
      liquidationThresholdBps = Number(cfg[2]);
      liquidationBonusBps = Number(cfg[3]);
    } catch (err) {
      console.warn(`    [discover] Could not fetch config for ${symbol} (${reserveAddr}): ${String(err).slice(0, 80)}`);
    }
  }

  return {
    address: reserveAddr.toLowerCase(),
    symbol: symbol as string,
    name: name as string,
    decimals: Number(decimals),
    liquidationBonusBps,
    liquidationThresholdBps,
    ltvBps,
  };
}

async function getBaseCurrencyUnit(mp: MultiProvider, oracleAddr: string): Promise<string> {
  const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, mp.provider);
  try {
    const unit = await withRetry(() => oracle.BASE_CURRENCY_UNIT() as Promise<bigint>, 'BASE_CURRENCY_UNIT');
    return unit.toString();
  } catch {
    return '100000000'; // Default: 1e8 (8 decimal USD pricing as in Aave V3)
  }
}

async function sampleRecentLiquidations(
  mp: MultiProvider,
  poolAddr: string,
  topic0: string,
  latestBlock: number,
): Promise<{ count: number; sample: ethers.Log[] }> {
  const lookback = Math.min(latestBlock, 5_000);
  try {
    const logs = await mp.call(
      p => p.getLogs({ address: poolAddr, topics: [topic0], fromBlock: latestBlock - lookback, toBlock: latestBlock }),
      `sampleLiquidations(last ${lookback} blocks)`,
    );
    return { count: logs.length, sample: logs.slice(0, 3) };
  } catch {
    return { count: -1, sample: [] };
  }
}

// ---- Main export ----

export async function discover(mp: MultiProvider): Promise<DiscoveredConfig> {
  console.log('\n=== PASO 0: On-chain discovery ===');
  const warnings: string[] = [];
  const provider = mp.provider;

  // 1. Verify chain ID
  const network = await withRetry(() => provider.getNetwork(), 'getNetwork');
  const chainId = Number(network.chainId);
  if (chainId !== CHAIN_ID) {
    warnings.push(`Expected chain ID ${CHAIN_ID}, got ${chainId}. Proceeding anyway.`);
    console.warn(`  [discover] ⚠ Chain ID mismatch: expected ${CHAIN_ID}, got ${chainId}`);
  } else {
    console.log(`  [discover] ✓ Chain ID: ${chainId}`);
  }

  // 2. Verify PoolAddressesProvider
  const papDeployed = await isContractDeployed(provider, KNOWN_ADDRESSES.poolAddressesProvider);
  if (!papDeployed) {
    warnings.push(`PoolAddressesProvider not deployed at ${KNOWN_ADDRESSES.poolAddressesProvider}`);
    console.warn(`  [discover] ✗ PoolAddressesProvider not found at ${KNOWN_ADDRESSES.poolAddressesProvider}`);
  } else {
    console.log(`  [discover] ✓ PoolAddressesProvider: ${KNOWN_ADDRESSES.poolAddressesProvider}`);
  }

  // 3. Resolve canonical addresses from PoolAddressesProvider
  const pap = new ethers.Contract(KNOWN_ADDRESSES.poolAddressesProvider, POOL_ADDRESSES_PROVIDER_ABI, provider);
  let poolAddr: string = KNOWN_ADDRESSES.pool;
  let oracleAddr: string = KNOWN_ADDRESSES.oracle;

  try {
    const [chainPool, chainOracle] = await Promise.all([
      withRetry(() => pap.getPool() as Promise<string>, 'getPool'),
      withRetry(() => pap.getPriceOracle() as Promise<string>, 'getPriceOracle'),
    ]);
    if (chainPool.toLowerCase() !== poolAddr.toLowerCase()) {
      warnings.push(`Pool address from provider (${chainPool}) differs from config (${poolAddr}). Using chain value.`);
      console.warn(`  [discover] ⚠ Pool mismatch — using chain: ${chainPool}`);
    } else {
      console.log(`  [discover] ✓ Pool confirmed: ${chainPool}`);
    }
    if (chainOracle.toLowerCase() !== oracleAddr.toLowerCase()) {
      warnings.push(`Oracle address from provider (${chainOracle}) differs from config (${oracleAddr}). Using chain value.`);
      console.warn(`  [discover] ⚠ Oracle mismatch — using chain: ${chainOracle}`);
    } else {
      console.log(`  [discover] ✓ Oracle confirmed: ${chainOracle}`);
    }
    poolAddr = chainPool;
    oracleAddr = chainOracle;
  } catch (err) {
    warnings.push(`Could not resolve addresses from PoolAddressesProvider: ${String(err).slice(0, 100)}`);
    console.warn(`  [discover] ⚠ Could not resolve from PAP, using config defaults`);
  }

  // 4. DataProvider
  const dataProviderAddr = await tryGetPoolDataProvider(mp, KNOWN_ADDRESSES.poolAddressesProvider);
  if (dataProviderAddr === ethers.ZeroAddress) {
    warnings.push('PoolDataProvider not discoverable; liquidation bonus will be 0 for all assets (ESTIMATED).');
    console.warn('  [discover] ⚠ DataProvider not found — liquidation bonus params will be missing');
  } else {
    console.log(`  [discover] ✓ DataProvider: ${dataProviderAddr}`);
  }

  // 5. Get reserves list from Pool
  const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
  let reserves: string[] = [];
  try {
    reserves = await withRetry(() => pool.getReservesList() as Promise<string[]>, 'getReservesList');
    console.log(`  [discover] ✓ Reserves (${reserves.length}): ${reserves.map(r => r.slice(0, 10)).join(', ')}…`);
  } catch (err) {
    warnings.push(`Could not fetch reserves list: ${String(err).slice(0, 100)}`);
    console.warn('  [discover] ⚠ Could not fetch reserves — asset symbols will be unknown');
  }

  // 6. Fetch and persist asset info
  const db = initDb();
  console.log(`  [discover] Fetching info for ${reserves.length} reserve(s)...`);
  for (const addr of reserves) {
    try {
      const info = await fetchReserveInfo(mp, addr, dataProviderAddr);
      upsertAsset(db, info);
      const bonus = info.liquidationBonusBps > 0
        ? `${(info.liquidationBonusBps / 100 - 100).toFixed(1)}% bonus`
        : 'bonus UNKNOWN';
      console.log(`    ${info.symbol.padEnd(8)} decimals=${info.decimals}  liqThreshold=${info.liquidationThresholdBps / 100}%  ${bonus}`);
    } catch (err) {
      console.warn(`    [discover] Failed to fetch info for ${addr}: ${String(err).slice(0, 80)}`);
    }
  }

  // 7. Oracle base currency unit
  const baseCurrencyUnit = await getBaseCurrencyUnit(mp, oracleAddr);
  console.log(`  [discover] Oracle base currency unit: ${baseCurrencyUnit} (${Math.log10(Number(baseCurrencyUnit)).toFixed(0)} decimals)`);

  // 8. Compute and verify LiquidationCall topic0
  const iface = new ethers.Interface([`event ${LIQUIDATION_CALL_SIGNATURE}`]);
  const eventFragment = iface.getEvent('LiquidationCall');
  if (!eventFragment) throw new Error('Could not parse LiquidationCall event fragment');
  const topic0 = eventFragment.topicHash;
  console.log(`  [discover] LiquidationCall topic0: ${topic0}`);

  // 9. Sample recent events to validate topic0
  const latestBlock = await withRetry(() => provider.getBlockNumber(), 'getBlockNumber');
  const { count: sampleCount, sample } = await sampleRecentLiquidations(mp, poolAddr, topic0, latestBlock);
  if (sampleCount === -1) {
    warnings.push('Could not sample recent liquidation events (may need archive or different RPC).');
    console.warn('  [discover] ⚠ Could not sample recent events to validate topic0');
  } else if (sampleCount === 0) {
    warnings.push('No liquidation events in the last 5000 blocks. Either no recent liquidations, or wrong topic0.');
    console.warn('  [discover] ⚠ No LiquidationCall events in last 5000 blocks');
  } else {
    console.log(`  [discover] ✓ Found ${sampleCount} LiquidationCall events in last 5000 blocks (sample tx: ${sample[0]?.transactionHash})`);
  }

  // 10. Save discovered config
  const config: DiscoveredConfig = {
    generatedAt: new Date().toISOString(),
    chainId,
    pool: poolAddr,
    poolAddressesProvider: KNOWN_ADDRESSES.poolAddressesProvider,
    oracle: oracleAddr,
    poolDataProvider: dataProviderAddr,
    poolImplementation: KNOWN_ADDRESSES.poolImplementation,
    liquidationCallTopic0: topic0,
    reserves: reserves.map(r => r.toLowerCase()),
    blockAtDiscovery: latestBlock,
    baseCurrencyUnit,
    warnings,
  };

  fs.writeFileSync(DISCOVERED_CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`\n  [discover] Config saved to: ${DISCOVERED_CONFIG_PATH}`);
  if (warnings.length) {
    console.warn(`  [discover] ⚠ ${warnings.length} warning(s) — REVIEW discovered-config.json before trusting results`);
  }

  return config;
}

export function loadDiscoveredConfig(): DiscoveredConfig {
  if (!fs.existsSync(DISCOVERED_CONFIG_PATH)) {
    throw new Error(
      `discovered-config.json not found. Run 'npm run discover' first.\nExpected at: ${DISCOVERED_CONFIG_PATH}`,
    );
  }
  return JSON.parse(fs.readFileSync(DISCOVERED_CONFIG_PATH, 'utf8')) as DiscoveredConfig;
}
