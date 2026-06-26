#!/usr/bin/env node
/**
 * TAREA 1 — Forensic de PRODUCCIÓN en la ventana limpia
 * Ventana: 2026-06-19 00:00 UTC → now
 * READ-ONLY. Zero transactions. Zero gas.
 */

const { ethers } = require("ethers");

// ── Constants ──────────────────────────────────────────────────────────────
const AAVE_POOL    = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const REF_BLOCK    = 474671740n;   // 2026-06-18 05:01:59 UTC (known reference)
const REF_TS       = 1750222919n;  // unix timestamp of REF_BLOCK (approx)
const CLEAN_START  = 1750291200n;  // 2026-06-19 00:00:00 UTC
// Known top competitors
const COMPETITORS  = [
  "0xd12810", "0x8888", "0x17a4", "0xacd4",
  "0x5745", "0xac27", "0xdb85"
].map(s => s.toLowerCase());

// Atlas metacall entry point (FastLane)
const ATLAS_ENTRY  = "0x8ad1ae9d".toLowerCase();

// Our wallet
const OUR_WALLET   = "0x6f38cE943280B90AD9144F4a61F79BCa10802f35".toLowerCase();
const OUR_CONTRACTS = [
  "0xf0549f84",   // V8
  "0x5D6CC365",   // V9
  "0x72B5961e",   // V10
].map(s => s.toLowerCase());

const LIQCALL_TOPIC = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";

// Public Arbitrum RPC endpoints (fallback chain)
const RPC_URLS = [
  "https://arb1.arbitrum.io/rpc",
  "https://arbitrum.llamarpc.com",
  "https://arbitrum-one.public.blastapi.io",
];

// ── Provider with fallback ─────────────────────────────────────────────────
async function getProvider() {
  for (const url of RPC_URLS) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      await p.getBlockNumber();
      console.log(`[rpc] connected: ${url}`);
      return p;
    } catch {
      console.warn(`[rpc] failed: ${url}`);
    }
  }
  throw new Error("All RPC endpoints failed");
}

// ── Block ↔ timestamp helpers ──────────────────────────────────────────────
// Arbitrum One: ~0.25s block time (250ms) post-Nitro
const ARB_BLOCK_TIME = 0.25;

async function tsToBlock(provider, targetTs) {
  const latestBlock = await provider.getBlock("latest");
  const latestTs    = Number(latestBlock.timestamp);
  const latestNum   = Number(latestBlock.number);
  const deltaS      = latestTs - Number(targetTs);
  const estimate    = Math.max(0, latestNum - Math.round(deltaS / ARB_BLOCK_TIME));
  // Refine via binary search (±10 blocks tolerance)
  return await refineBlock(provider, estimate, Number(targetTs));
}

async function refineBlock(provider, estBlock, targetTs) {
  let lo = Math.max(0, estBlock - 20000);
  let hi = estBlock + 20000;
  let iter = 0;
  while (hi - lo > 50 && iter < 25) {
    iter++;
    const mid  = Math.floor((lo + hi) / 2);
    const blk  = await provider.getBlock(mid);
    if (!blk) break;
    if (Number(blk.timestamp) < targetTs) lo = mid;
    else hi = mid;
  }
  return Math.floor((lo + hi) / 2);
}

// ── Fetch logs in chunks (avoid RPC 10k-block limit) ──────────────────────
async function fetchLogsChunked(provider, fromBlock, toBlock, chunkSize = 5000) {
  const logs = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = Math.min(cursor + chunkSize - 1, toBlock);
    process.stdout.write(`\r[logs] fetching blocks ${cursor}–${end}…   `);
    try {
      const chunk = await provider.getLogs({
        address: AAVE_POOL,
        topics:  [LIQCALL_TOPIC],
        fromBlock: cursor,
        toBlock:   end,
      });
      logs.push(...chunk);
    } catch (e) {
      console.warn(`\n[logs] chunk error ${cursor}-${end}: ${e.message}`);
    }
    cursor = end + 1;
  }
  process.stdout.write("\n");
  return logs;
}

// ── Parse LiquidationCall log ──────────────────────────────────────────────
function parseLiqLog(log) {
  // topics: [sig, collateralAsset, debtAsset, user]
  // data:   [debtToCover, liquidatedCollateralAmount, liquidator, receiveAToken]
  const collateralAsset = "0x" + log.topics[1].slice(26);
  const debtAsset       = "0x" + log.topics[2].slice(26);
  const user            = "0x" + log.topics[3].slice(26);
  const iface = new ethers.Interface([
    "event LiquidationCall(address indexed collateralAsset,address indexed debtAsset,address indexed user,uint256 debtToCover,uint256 liquidatedCollateralAmount,address liquidator,bool receiveAToken)"
  ]);
  const decoded = iface.parseLog(log);
  return {
    blockNumber: log.blockNumber,
    txHash:      log.transactionHash,
    user:        user.toLowerCase(),
    collateral:  collateralAsset.toLowerCase(),
    debt:        debtAsset.toLowerCase(),
    liquidator:  decoded.args[5].toLowerCase(),
    debtToCover: decoded.args[3],
    collateralAmt: decoded.args[4],
  };
}

// ── Classify liquidator ────────────────────────────────────────────────────
function classifyLiquidator(addr) {
  if (addr.startsWith(OUR_WALLET.toLowerCase().slice(0, 8))) return "OUR_WALLET";
  for (const c of OUR_CONTRACTS) {
    if (addr.toLowerCase().startsWith(c.slice(0, 8))) return "OUR_CONTRACT";
  }
  for (const c of COMPETITORS) {
    if (addr.toLowerCase().startsWith(c.slice(0, 8))) return `COMPETITOR(${c})`;
  }
  if (addr.toLowerCase().startsWith(ATLAS_ENTRY.slice(0, 8))) return "ATLAS_ENTRY";
  return "UNKNOWN";
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const NOW = Date.now();
  console.log("=".repeat(60));
  console.log(" TAREA 1 — Forensic ventana limpia (producción Aave V3 Arb)");
  console.log("=".repeat(60));
  console.log(` Clean window start : 2026-06-19 00:00 UTC`);
  console.log(` Report time        : ${new Date(NOW).toISOString()}`);

  const provider = await getProvider();
  const latestNum = await provider.getBlockNumber();
  console.log(`[chain] latest block: ${latestNum}`);

  // Resolve start block
  console.log("[chain] resolving start block for 2026-06-19 00:00 UTC…");
  const startBlock = await tsToBlock(provider, CLEAN_START);
  console.log(`[chain] start block  : ${startBlock}`);
  console.log(`[chain] scanning     : ${latestNum - startBlock} blocks (~${((latestNum - startBlock) * ARB_BLOCK_TIME / 86400).toFixed(1)} days)`);

  // Fetch all LiquidationCall events in the window
  const logs = await fetchLogsChunked(provider, startBlock, latestNum, 4000);
  console.log(`[logs] total LiquidationCall events in window: ${logs.length}`);

  if (logs.length === 0) {
    console.log("\n[WARN] No liquidation events found. Possible causes:");
    console.log("  - RPC range limit hit");
    console.log("  - Market truly dry in this window");
    console.log("  - Block range calculation off");
    console.log(`\n  Verify: check block ${startBlock} timestamp on arbiscan.io`);
    return;
  }

  // Parse and classify
  const events = logs.map(parseLiqLog);
  const byBlock = {};
  for (const e of events) {
    if (!byBlock[e.blockNumber]) byBlock[e.blockNumber] = [];
    byBlock[e.blockNumber].push(e);
  }

  // Tally
  let totalMkt      = events.length;
  let wonByUs       = 0;
  let wonByComp     = 0;
  let wonByUnknown  = 0;
  let wonByAtlas    = 0;
  const competitorCounts = {};

  for (const e of events) {
    const cls = classifyLiquidator(e.liquidator);
    if (cls === "OUR_WALLET" || cls === "OUR_CONTRACT") {
      wonByUs++;
    } else if (cls.startsWith("COMPETITOR")) {
      wonByComp++;
      const key = cls;
      competitorCounts[key] = (competitorCounts[key] || 0) + 1;
    } else if (cls === "ATLAS_ENTRY") {
      wonByAtlas++;
    } else {
      wonByUnknown++;
    }
  }

  // Print results
  console.log("\n");
  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│   TABLA 1 — Liquidaciones Aave V3 Arb (ventana limpia)  │");
  console.log("├────────────────────────────┬────────────────────────────┤");
  console.log(`│ Total mercado (ventana)     │ ${String(totalMkt).padStart(26)} │`);
  console.log(`│ Ganadas por NOSOTROS        │ ${String(wonByUs).padStart(26)} │`);
  console.log(`│ Ganadas por competidores    │ ${String(wonByComp).padStart(26)} │`);
  console.log(`│ Ganadas vía Atlas entry     │ ${String(wonByAtlas).padStart(26)} │`);
  console.log(`│ Ganadas por otros           │ ${String(wonByUnknown).padStart(26)} │`);
  console.log("├────────────────────────────┴────────────────────────────┤");
  console.log("│   Detalle por competidor                                 │");
  console.log("├──────────────────────────────────────────────────────────┤");
  for (const [k, v] of Object.entries(competitorCounts).sort((a,b) => b[1]-a[1])) {
    console.log(`│  ${k.padEnd(30)} ${String(v).padStart(6)} liqs          │`);
  }
  console.log("└──────────────────────────────────────────────────────────┘");

  // Detailed listing (last 20)
  const sample = events.slice(-20);
  console.log("\n--- Sample (últimas 20 liquidaciones en ventana) ---");
  console.log("Block".padEnd(12) + "TxHash (8c)".padEnd(12) + "Borrower (8c)".padEnd(14) + "Liquidator (8c)".padEnd(16) + "Clase");
  console.log("-".repeat(80));
  for (const e of sample) {
    const cls = classifyLiquidator(e.liquidator);
    console.log(
      String(e.blockNumber).padEnd(12) +
      e.txHash.slice(0,10).padEnd(12) +
      e.user.slice(0,10).padEnd(14) +
      e.liquidator.slice(0,10).padEnd(16) +
      cls
    );
  }

  // Return structured data for the report
  return {
    totalMkt, wonByUs, wonByComp, wonByAtlas, wonByUnknown,
    competitorCounts,
    startBlock,
    endBlock: latestNum,
    events: events.slice(0, 5),  // first 5 for report
  };
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
