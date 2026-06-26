#!/usr/bin/env node
/**
 * TAREA 3 — Auditoría de fracción de bid GANADORA de competidores
 * Analiza on-chain el bonus bruto vs neto vs devuelto en liquidaciones ganadoras.
 * READ-ONLY. Zero transactions. Zero gas.
 */

const { ethers } = require("ethers");

// ── Constants ──────────────────────────────────────────────────────────────
const AAVE_POOL   = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const LIQCALL_TOPIC = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";

// Known Atlas metacall entry point (FastLane)
const ATLAS_ENTRY_PREFIX = "0x8ad1ae9d";

// Reference liquidation from the task
const REF_TX = "0x1dca66bc000000000000000000000000000000000000000000000000000000000000155c767b";
const REF_TX_CLEAN = "0x1dca66bc"; // prefix

// Known competitors
const COMPETITORS = {
  "0xd12810": "#1 top",
  "0x8888":   "8888",
  "0x17a4":   "17a4",
  "0xacd4":   "acd4",
  "0x5745":   "5745",
  "0xac27":   "ac27",
  "0xdb85":   "db85",
};

// Aave V3 liquidation bonus: typically 5% = 1.05 factor for most assets
// Exact values from protocol config — but we estimate from on-chain amounts
const WETH_ADDR  = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1".toLowerCase();
const USDC_ADDR  = "0xaf88d065e77c8cc2239327c5edb3a432268e5831".toLowerCase();
const USDC_E     = "0xff970a61a04b1ca14834a43f5de4533ebddb5cc6".toLowerCase(); // USDC.e bridged

// Chainlink-like price sources for rough USD conversion
// We'll use the pool's own data where possible

const RPC_URLS = [
  "https://arb1.arbitrum.io/rpc",
  "https://arbitrum.llamarpc.com",
  "https://arbitrum-one.public.blastapi.io",
];

// ── Provider ───────────────────────────────────────────────────────────────
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

// ── Fetch recent logs ──────────────────────────────────────────────────────
async function fetchRecentLiquidations(provider, blocksBack = 80000) {
  const latest = await provider.getBlockNumber();
  const from   = latest - blocksBack;
  console.log(`[scan] fetching Aave V3 LiquidationCall events in blocks ${from}–${latest}`);
  const logs = [];
  const chunk = 5000;
  for (let start = from; start <= latest; start += chunk) {
    const end = Math.min(start + chunk - 1, latest);
    process.stdout.write(`\r[scan] ${start}–${end}…   `);
    try {
      const chunk_logs = await provider.getLogs({
        address: AAVE_POOL,
        topics:  [LIQCALL_TOPIC],
        fromBlock: start,
        toBlock:   end,
      });
      logs.push(...chunk_logs);
    } catch (e) {
      console.warn(`\n[warn] ${e.message}`);
    }
  }
  process.stdout.write("\n");
  return logs;
}

// ── Parse LiquidationCall ──────────────────────────────────────────────────
function parseLiqLog(log) {
  const iface = new ethers.Interface([
    "event LiquidationCall(address indexed collateralAsset,address indexed debtAsset,address indexed user,uint256 debtToCover,uint256 liquidatedCollateralAmount,address liquidator,bool receiveAToken)"
  ]);
  const decoded = iface.parseLog(log);
  return {
    blockNumber:    log.blockNumber,
    txHash:         log.transactionHash,
    user:           ("0x" + log.topics[3].slice(26)).toLowerCase(),
    collateral:     ("0x" + log.topics[1].slice(26)).toLowerCase(),
    debt:           ("0x" + log.topics[2].slice(26)).toLowerCase(),
    liquidator:     decoded.args[5].toLowerCase(),
    debtToCover:    decoded.args[3],
    collateralAmt:  decoded.args[4],
    receiveAToken:  decoded.args[6],
  };
}

// ── Get tx receipt and trace value flows ──────────────────────────────────
async function analyzeTxBidFraction(provider, txHash, event) {
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);
  if (!tx || !receipt) return null;

  // Detect if this is an Atlas metacall (via the entry point)
  const toAddr = tx.to?.toLowerCase() || "";
  const isAtlas = toAddr.startsWith(ATLAS_ENTRY_PREFIX.slice(0, 10));

  // For Atlas calls: value sent TO the Atlas contract represents the bid value
  // The bid value is what goes back to the searcher's payment (protocol fee)
  // Gross liquidation bonus ≈ collateral received - debt repaid (in same units)
  // If USDC debt + WETH collateral: need price oracle

  // Simplified approach: estimate bid fraction from the call value
  // Atlas metacall: msg.value = bid amount (returned to protocol/searcher)
  const callValue = tx.value;  // ETH/native sent with the call

  return {
    txHash,
    blockNumber: event.blockNumber,
    liquidator:  event.liquidator,
    isAtlas,
    callValue:   callValue.toString(),
    gasUsed:     receipt.gasUsed.toString(),
    gasPrice:    tx.gasPrice?.toString() || "0",
    gasCost:     ((receipt.gasUsed * (tx.gasPrice || 0n))).toString(),
    debtToCover: event.debtToCover.toString(),
    collateralAmt: event.collateralAmt.toString(),
    debt:        event.debt,
    collateral:  event.collateral,
  };
}

// ── Estimate bid fraction from Atlas tx trace ──────────────────────────────
// In FastLane Atlas: solver submits a bid, winner gets to execute.
// The "bid" returned to Atlas = gross profit * bidFraction.
// We reconstruct: bidFraction ≈ callValue / estimatedGrossProfit
// Without oracle prices we can only flag if callValue > 0 (Atlas bid present).
function estimateBidFraction(analysis) {
  if (!analysis.isAtlas) return "N/A (not Atlas)";
  if (analysis.callValue === "0") return "callValue=0 (bid via ERC20 transfer)";
  // If bid is in ETH/native, we can't directly compare to USDC profit without price
  return `callValue=${ethers.formatEther(analysis.callValue)} ETH`;
}

// ── Filter competitor liquidations ─────────────────────────────────────────
function isCompetitor(addr) {
  const a = addr.toLowerCase();
  return Object.keys(COMPETITORS).some(prefix => a.startsWith(prefix.toLowerCase()));
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("=".repeat(60));
  console.log(" TAREA 3 — Bid fraction audit (competidores Aave V3 Arb)");
  console.log("=".repeat(60));

  const provider = await getProvider();

  // Fetch recent liquidations (~5.5 days back at 0.25s/block = ~1.9M blocks,
  // but we cap at 80k blocks = ~5.5 hours to stay within public RPC limits)
  const logs = await fetchRecentLiquidations(provider, 80000);
  console.log(`[scan] total events: ${logs.length}`);

  const events = logs.map(parseLiqLog);

  // Filter competitor wins
  const compEvents = events.filter(e => isCompetitor(e.liquidator));
  console.log(`[scan] competitor liquidations: ${compEvents.length}`);

  if (compEvents.length === 0) {
    console.log("\n[NOTE] No competitor liquidations found in last 80k blocks (~5.5h).");
    console.log("       Expand the window or check if market is dry.");
    return;
  }

  // Analyze top N competitor txs
  const toAnalyze = compEvents.slice(-Math.min(10, compEvents.length));
  console.log(`\n[analyze] fetching tx details for ${toAnalyze.length} competitor wins…`);

  const analyses = [];
  for (const e of toAnalyze) {
    process.stdout.write(`\r[analyze] ${e.txHash.slice(0,10)}…`);
    const a = await analyzeTxBidFraction(provider, e.txHash, e);
    if (a) {
      a.competitorPrefix = Object.keys(COMPETITORS).find(
        p => e.liquidator.toLowerCase().startsWith(p.toLowerCase())
      ) || "??";
      analyses.push(a);
    }
    await new Promise(r => setTimeout(r, 150)); // rate limit protection
  }
  process.stdout.write("\n");

  // Print table
  console.log("\n");
  console.log("┌──────────────────────────────────────────────────────────────────────────┐");
  console.log("│  TABLA 3 — Bid fraction implícita de competidores (últimos ~5.5h Arb)   │");
  console.log("├────────────┬──────────┬─────────┬──────────┬──────────┬─────────────────┤");
  console.log("│ Bloque     │ Compet.  │ isAtlas │ CallVal  │ GasUsed  │ BidEst          │");
  console.log("├────────────┼──────────┼─────────┼──────────┼──────────┼─────────────────┤");
  for (const a of analyses) {
    const bid = estimateBidFraction(a);
    console.log(
      "│ " + String(a.blockNumber).padEnd(10) +
      " │ " + a.competitorPrefix.padEnd(8) +
      " │ " + (a.isAtlas ? "YES    " : "NO     ") +
      " │ " + (a.callValue === "0" ? "0       " : ethers.formatEther(a.callValue).slice(0,8).padEnd(8)) +
      " │ " + String(a.gasUsed).padEnd(8) +
      " │ " + bid.slice(0,15).padEnd(15) +
      " │"
    );
  }
  console.log("└────────────┴──────────┴─────────┴──────────┴──────────┴─────────────────┘");

  // Atlas vs non-Atlas breakdown
  const atlasCount = analyses.filter(a => a.isAtlas).length;
  const nonAtlas   = analyses.length - atlasCount;
  console.log(`\n[summary] Atlas calls: ${atlasCount}/${analyses.length} | Direct: ${nonAtlas}/${analyses.length}`);

  // Check the specific reference tx if we can find it in logs
  const refEvent = events.find(e => e.txHash.toLowerCase().startsWith("0x1dca66bc"));
  if (refEvent) {
    console.log("\n[ref-tx] Found reference liquidation tx:");
    console.log(`  Block:      ${refEvent.blockNumber}`);
    console.log(`  TxHash:     ${refEvent.txHash}`);
    console.log(`  Liquidator: ${refEvent.liquidator}`);
    console.log(`  DebtToCover: ${refEvent.debtToCover}`);
    const refAnalysis = await analyzeTxBidFraction(provider, refEvent.txHash, refEvent);
    if (refAnalysis) {
      console.log(`  Is Atlas:   ${refAnalysis.isAtlas}`);
      console.log(`  Call value: ${ethers.formatEther(refAnalysis.callValue)} ETH`);
      console.log(`  Gas used:   ${refAnalysis.gasUsed}`);
      console.log(`  Gas cost:   ${ethers.formatEther(refAnalysis.gasCost)} ETH`);
    }
  }

  return analyses;
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
