/**
 * PASO 1 — Historical backfill of LiquidationCall events.
 *
 * Fetches all LiquidationCall events for the configured period,
 * persists them to SQLite with idempotency (UNIQUE on tx_hash+log_index),
 * and also fetches transaction receipts for gas data.
 *
 * READ-ONLY. Idempotent — re-running continues from last checkpoint.
 */

import { ethers } from 'ethers';
import { loadDiscoveredConfig } from './discover';
import {
  initDb,
  batchUpsertLiquidations,
  getBackfillProgress,
  setBackfillProgress,
  countLiquidations,
} from './db';
import { MultiProvider, estimateBlockAtTimestamp, getLogsChunked, withRetry, sleep } from './rpc';
import type { LiquidationRaw } from './types';

// ---- Parse raw log into LiquidationRaw ----

function parseLog(log: ethers.Log, iface: ethers.Interface): Omit<LiquidationRaw, 'blockTimestamp' | 'gasUsed' | 'effectiveGasPrice'> {
  const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
  if (!parsed) throw new Error(`Could not parse log ${log.transactionHash}:${log.index}`);

  return {
    txHash: log.transactionHash,
    logIndex: log.index,
    blockNumber: log.blockNumber,
    liquidator: parsed.args['liquidator'] as string,
    borrower: parsed.args['user'] as string,
    collateralAsset: parsed.args['collateralAsset'] as string,
    debtAsset: parsed.args['debtAsset'] as string,
    debtToCover: (parsed.args['debtToCover'] as bigint).toString(),
    liquidatedCollateralAmount: (parsed.args['liquidatedCollateralAmount'] as bigint).toString(),
    receiveAToken: parsed.args['receiveAToken'] as boolean,
  };
}

// ---- Gas data fetch (batched, best-effort) ----

async function fetchGasData(
  mp: MultiProvider,
  txHashes: string[],
): Promise<Map<string, { gasUsed: number; effectiveGasPrice: string }>> {
  const result = new Map<string, { gasUsed: number; effectiveGasPrice: string }>();
  // Sequential — ethers v6 internally batches concurrent requests, which trips dRPC free-tier limit (max 3 per batch)
  for (let i = 0; i < txHashes.length; i++) {
    const hash = txHashes[i]!;
    try {
      const receipt = await withRetry(
        () => mp.provider.getTransactionReceipt(hash),
        `getReceipt(${hash.slice(0, 10)})`,
        3,
        1_000,
      );
      if (receipt) {
        result.set(hash, {
          gasUsed: Number(receipt.gasUsed),
          effectiveGasPrice: receipt.gasPrice.toString(),
        });
      }
    } catch {
      // Best-effort — gas data is optional for the audit
    }
    if (i % 20 === 0 || i === txHashes.length - 1) {
      process.stdout.write(`\r  [backfill] receipts: ${i + 1}/${txHashes.length}  `);
    }
    if (i > 0 && i % 10 === 0) await sleep(150);
  }
  return result;
}

// ---- Block timestamp cache ----

const blockTsCache = new Map<number, number>();

async function getBlockTimestamp(mp: MultiProvider, blockNumber: number): Promise<number> {
  if (blockTsCache.has(blockNumber)) return blockTsCache.get(blockNumber)!;
  const block = await withRetry(() => mp.provider.getBlock(blockNumber), `getBlock(${blockNumber})`, 3, 1_000);
  const ts = block?.timestamp ?? 0;
  blockTsCache.set(blockNumber, ts);
  return ts;
}

// ---- Main export ----

export async function backfill(mp: MultiProvider): Promise<void> {
  console.log('\n=== PASO 1: Historical backfill ===');

  const cfg = loadDiscoveredConfig();
  const db = initDb();

  const daysBack = parseInt(process.env['DAYS_BACK'] ?? '60', 10);
  const chunkSize = parseInt(process.env['CHUNK_SIZE'] ?? '500', 10);
  const maxChunkSize = parseInt(process.env['MAX_CHUNK_SIZE'] ?? '2000', 10);

  const latestBlock = await withRetry(() => mp.provider.getBlockNumber(), 'getBlockNumber');
  const targetTs = Math.floor(Date.now() / 1000) - daysBack * 86_400;
  const fromBlock = await estimateBlockAtTimestamp(mp, targetTs);

  const existing = getBackfillProgress(db);
  let startBlock: number;

  if (existing && !existing.completed && existing.fromBlock === fromBlock && existing.toBlock === latestBlock) {
    startBlock = existing.currentBlock;
    console.log(`  [backfill] Resuming from block #${startBlock} (checkpoint found)`);
  } else {
    startBlock = fromBlock;
    console.log(`  [backfill] Starting fresh: blocks #${fromBlock} → #${latestBlock} (~${daysBack} days)`);
  }

  setBackfillProgress(db, {
    fromBlock,
    toBlock: latestBlock,
    currentBlock: startBlock,
    completed: false,
    lastUpdated: Math.floor(Date.now() / 1000),
  });

  const iface = new ethers.Interface([
    'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
  ]);

  let totalProcessed = 0;
  let chunkIdx = 0;

  const logs = await getLogsChunked(mp, {
    address: cfg.pool,
    topics: [cfg.liquidationCallTopic0],
    fromBlock: startBlock,
    toBlock: latestBlock,
    chunkSize,
    maxChunkSize,
    onChunk: (from, to, count) => {
      chunkIdx++;
      const pct = (((to - fromBlock) / (latestBlock - fromBlock)) * 100).toFixed(1);
      process.stdout.write(`\r  [backfill] chunk #${chunkIdx}: blocks ${from}-${to} | ${count} events | ${pct}%    `);
      // Update checkpoint
      setBackfillProgress(db, {
        fromBlock,
        toBlock: latestBlock,
        currentBlock: to + 1,
        completed: false,
        lastUpdated: Math.floor(Date.now() / 1000),
      });
    },
  });

  console.log(`\n  [backfill] getLogs complete. Total raw events: ${logs.length}`);
  if (logs.length === 0) {
    console.log('  [backfill] ℹ No liquidation events found in this period.');
    setBackfillProgress(db, { fromBlock, toBlock: latestBlock, currentBlock: latestBlock, completed: true, lastUpdated: Math.floor(Date.now() / 1000) });
    return;
  }

  // Group logs by block to fetch timestamps
  const blockNumbers = [...new Set(logs.map(l => l.blockNumber))];
  console.log(`  [backfill] Fetching timestamps for ${blockNumbers.length} unique blocks...`);
  // Sequential — ethers v6 batches concurrent getBlock() calls internally, tripping dRPC free-tier limit
  for (let i = 0; i < blockNumbers.length; i++) {
    await getBlockTimestamp(mp, blockNumbers[i]!);
    if (i % 20 === 0 || i === blockNumbers.length - 1) {
      process.stdout.write(`\r  [backfill] timestamps: ${i + 1}/${blockNumbers.length}  `);
    }
    if (i > 0 && i % 10 === 0) await sleep(150);
  }
  console.log();

  // Fetch gas data for unique tx hashes
  const uniqueTxHashes = [...new Set(logs.map(l => l.transactionHash))];
  console.log(`  [backfill] Fetching gas receipts for ${uniqueTxHashes.length} unique tx(s)...`);
  const gasData = await fetchGasData(mp, uniqueTxHashes);
  console.log(`  [backfill] Gas data retrieved for ${gasData.size}/${uniqueTxHashes.length} tx(s)`);

  // Parse and persist
  const liquidations: LiquidationRaw[] = [];
  for (const log of logs) {
    try {
      const partial = parseLog(log, iface);
      const ts = blockTsCache.get(log.blockNumber) ?? 0;
      const gas = gasData.get(log.transactionHash);
      liquidations.push({
        ...partial,
        blockTimestamp: ts,
        gasUsed: gas?.gasUsed ?? null,
        effectiveGasPrice: gas?.effectiveGasPrice ?? null,
      });
    } catch (err) {
      console.warn(`\n  [backfill] Could not parse log ${log.transactionHash}:${log.index} — ${String(err).slice(0, 80)}`);
    }
  }

  batchUpsertLiquidations(db, liquidations);
  totalProcessed = liquidations.length;

  setBackfillProgress(db, { fromBlock, toBlock: latestBlock, currentBlock: latestBlock, completed: true, lastUpdated: Math.floor(Date.now() / 1000) });

  const total = countLiquidations(db);
  console.log(`  [backfill] ✓ Stored ${totalProcessed} events. DB total: ${total} liquidations.`);
}
