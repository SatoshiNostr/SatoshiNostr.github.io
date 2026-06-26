#!/usr/bin/env node
/**
 * TAREA 2 — Parser de logs del atlas-solver (Railway / local)
 * Lee desde stdin o archivo dado por argumento.
 * Si no hay log estructurado → documenta el hallazgo y propone el patch.
 *
 * Uso:
 *   npx @railway/cli@latest logs --lines 1000 | node bot/forensic-atlas-log-parser.js
 *   node bot/forensic-atlas-log-parser.js /tmp/atlas.log
 */

const fs   = require("fs");
const path = require("path");
const readline = require("readline");

// ── Clean window ───────────────────────────────────────────────────────────
const CLEAN_START_MS = 1750291200000; // 2026-06-19 00:00:00 UTC in ms

// ── Patterns to look for ───────────────────────────────────────────────────
const PATTERNS = {
  // SVR auction events
  auctionSeen:    /auction|svr.*bid|bid.*svr|solver.*auction/i,
  bidSent:        /bid.*sent|send.*bid|submitting.*bid|bid.*submit/i,
  bidWon:         /won|WON|winner.*us|our.*bid.*win/i,
  bidLost:        /lost|LOST|outbid|winner.*not.*us/i,
  // Structured [svr] format (proposed)
  structuredSVR:  /\[svr\].*auction=/i,
  // Aave scanner events
  liquidationSeen:/LiquidationCall|liquidat/i,
  hfCacheRestore: /hfCache.*restored?|restored?.*hfCache|partial.*restore/i,
  coldStart:      /cold.?start|starting.*fresh|no.*cache/i,
  restart:        /Server.*started|app.*started|process.*start|Connected to/i,
  crash:          /FATAL|uncaughtException|unhandledRejection|crashed|OOM/i,
  // WebSocket SVR
  wsSvr:          /svr.*ws|ws.*svr|svr-bid-endpoint|chain\.link.*solver/i,
  wsConnected:    /SVR.*connected|subscribed.*SVR|SVR.*subscribed/i,
  wsDisconnected: /SVR.*disconnect|ws.*close|reconnect/i,
};

// ── Timestamp extraction ───────────────────────────────────────────────────
function extractTimestamp(line) {
  // ISO 8601
  const isoMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/);
  if (isoMatch) return new Date(isoMatch[1]).getTime();
  // Common log format: [HH:MM:SS] or timestamp prefix
  const epochMatch = line.match(/^(\d{13})/);
  if (epochMatch) return parseInt(epochMatch[1]);
  return null;
}

// ── Parse a single log line ────────────────────────────────────────────────
function parseLine(line, lineNum) {
  const ts    = extractTimestamp(line);
  const inWindow = ts ? ts >= CLEAN_START_MS : null; // null = unknown

  const matches = {};
  for (const [key, re] of Object.entries(PATTERNS)) {
    if (re.test(line)) matches[key] = true;
  }

  return { line: lineNum, ts, inWindow, matches, raw: line.trim() };
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const logFile = process.argv[2];
  let inputStream;

  if (logFile) {
    if (!fs.existsSync(logFile)) {
      console.error(`[error] File not found: ${logFile}`);
      process.exit(1);
    }
    inputStream = fs.createReadStream(logFile);
    console.log(`[input] reading from file: ${logFile}`);
  } else if (!process.stdin.isTTY) {
    inputStream = process.stdin;
    console.log("[input] reading from stdin");
  } else {
    console.log("[warn] no log file provided and no stdin. Usage:");
    console.log("  railway logs --lines 1000 | node bot/forensic-atlas-log-parser.js");
    console.log("  node bot/forensic-atlas-log-parser.js /tmp/atlas.log");
    printEmptyReport();
    return;
  }

  const rl = readline.createInterface({ input: inputStream });
  const results = [];
  let lineNum = 0;

  for await (const line of rl) {
    lineNum++;
    if (line.trim()) results.push(parseLine(line, lineNum));
  }

  console.log(`[parse] total lines: ${lineNum}`);

  // Filter to clean window where possible
  const inWindow     = results.filter(r => r.inWindow !== false);
  const unknownTs    = results.filter(r => r.inWindow === null);
  console.log(`[parse] lines with timestamp in clean window: ${inWindow.length}`);
  console.log(`[parse] lines with no parseable timestamp: ${unknownTs.length}`);

  // Count events
  const counts = {
    auctionsSeen:    0,
    bidsSent:        0,
    bidsWon:         0,
    bidsLost:        0,
    structuredLogs:  0,
    restarts:        0,
    crashes:         0,
    svrConnections:  0,
    svrDisconnects:  0,
    hfCacheRestores: 0,
    coldStarts:      0,
    liquidationsSeen: 0,
  };

  const interestingLines = [];

  for (const r of inWindow) {
    const m = r.matches;
    if (m.auctionSeen)     { counts.auctionsSeen++;     interestingLines.push({ ...r, tag: "AUCTION" }); }
    if (m.bidSent)         { counts.bidsSent++;          interestingLines.push({ ...r, tag: "BID_SENT" }); }
    if (m.bidWon)          { counts.bidsWon++;           interestingLines.push({ ...r, tag: "BID_WON" }); }
    if (m.bidLost)         { counts.bidsLost++;          interestingLines.push({ ...r, tag: "BID_LOST" }); }
    if (m.structuredSVR)   { counts.structuredLogs++;    interestingLines.push({ ...r, tag: "SVR_STRUCT" }); }
    if (m.restart)         { counts.restarts++;          interestingLines.push({ ...r, tag: "RESTART" }); }
    if (m.crash)           { counts.crashes++;           interestingLines.push({ ...r, tag: "CRASH" }); }
    if (m.wsConnected)     { counts.svrConnections++;    interestingLines.push({ ...r, tag: "SVR_CONN" }); }
    if (m.wsDisconnected)  { counts.svrDisconnects++;    interestingLines.push({ ...r, tag: "SVR_DISC" }); }
    if (m.hfCacheRestore)  { counts.hfCacheRestores++;  interestingLines.push({ ...r, tag: "HF_RESTORE" }); }
    if (m.coldStart)       { counts.coldStarts++;        interestingLines.push({ ...r, tag: "COLD_START" }); }
    if (m.liquidationSeen) { counts.liquidationsSeen++;  }
  }

  // Detect if SVR logging is structured or absent
  const hasStructuredLogs  = counts.structuredLogs > 0;
  const hasAnySVRData      = counts.auctionsSeen > 0 || counts.bidsSent > 0;

  // Print results
  console.log("\n");
  console.log("┌─────────────────────────────────────────────────────────────┐");
  console.log("│   TABLA 2 — SVR Auctions atlas-solver (ventana limpia)       │");
  console.log("├─────────────────────────────┬───────────────────────────────┤");
  console.log(`│ Subastas SVR vistas          │ ${String(counts.auctionsSeen).padStart(29)} │`);
  console.log(`│ Bids enviados                │ ${String(counts.bidsSent).padStart(29)} │`);
  console.log(`│ Bids ganados                 │ ${String(counts.bidsWon).padStart(29)} │`);
  console.log(`│ Bids perdidos                │ ${String(counts.bidsLost).padStart(29)} │`);
  console.log(`│ Logs SVR estructurados       │ ${String(counts.structuredLogs).padStart(29)} │`);
  console.log("├─────────────────────────────┼───────────────────────────────┤");
  console.log("│ === Uptime atlas-solver ===  │                               │");
  console.log(`│ Reinicios detectados         │ ${String(counts.restarts).padStart(29)} │`);
  console.log(`│ Crashes / fatales            │ ${String(counts.crashes).padStart(29)} │`);
  console.log(`│ SVR WebSocket conexiones     │ ${String(counts.svrConnections).padStart(29)} │`);
  console.log(`│ SVR WebSocket desconexiones  │ ${String(counts.svrDisconnects).padStart(29)} │`);
  console.log(`│ hfCache restores             │ ${String(counts.hfCacheRestores).padStart(29)} │`);
  console.log(`│ Cold-starts detectados       │ ${String(counts.coldStarts).padStart(29)} │`);
  console.log(`│ Liquidations vistas en log   │ ${String(counts.liquidationsSeen).padStart(29)} │`);
  console.log("└─────────────────────────────┴───────────────────────────────┘");

  // Key findings
  console.log("\n=== HALLAZGOS ===");
  if (!hasStructuredLogs && !hasAnySVRData) {
    console.log("  *** HALLAZGO #1 (CRÍTICO): El atlas-solver NO tiene logging estructurado ***");
    console.log("  No se encontró ningún log de tipo auction/bid/won/lost en la ventana limpia.");
    console.log("  → Estamos VOLANDO A CIEGAS: no sabemos si se están viendo subastas SVR.");
    console.log("  → Ver propuesta de patch additive al final de este reporte.");
  }
  if (counts.restarts > 1) {
    console.log(`  *** HALLAZGO: atlas-solver reiniciado ${counts.restarts}x en la ventana ***`);
  }
  if (counts.svrDisconnects > counts.svrConnections) {
    console.log("  *** HALLAZGO: Más desconexiones SVR que conexiones → posible flap del WS ***");
  }
  if (counts.coldStarts > 0) {
    console.log(`  *** HALLAZGO: ${counts.coldStarts} cold-starts detectados → revisa persistencia de cache ***`);
  }

  // Interesting lines sample
  if (interestingLines.length > 0) {
    console.log("\n--- Líneas relevantes (muestra) ---");
    for (const r of interestingLines.slice(0, 30)) {
      const tsStr = r.ts ? new Date(r.ts).toISOString() : "no-ts";
      console.log(`  [${r.tag}] ${tsStr} | ${r.raw.slice(0, 120)}`);
    }
  }

  // Print proposed patch for structured SVR logging
  if (!hasStructuredLogs) {
    printStructuredLoggingPatch();
  }

  return counts;
}

function printEmptyReport() {
  console.log("\n");
  console.log("┌─────────────────────────────────────────────────────────────┐");
  console.log("│   TABLA 2 — SVR Auctions atlas-solver (ventana limpia)       │");
  console.log("├─────────────────────────────┬───────────────────────────────┤");
  console.log("│ Subastas SVR vistas          │                  SIN DATOS    │");
  console.log("│ Bids enviados                │ (Railway CLI no autenticado)  │");
  console.log("│ Bids ganados                 │                               │");
  console.log("│ Bids perdidos                │                               │");
  console.log("└─────────────────────────────┴───────────────────────────────┘");
  console.log("\n  ACCIÓN REQUERIDA: ejecutar desde máquina con Railway auth:");
  console.log("  npx @railway/cli@latest link -p atlas-deploy -s atlas-solver -e production");
  console.log("  npx @railway/cli@latest logs --lines 2000 | node bot/forensic-atlas-log-parser.js");
  printStructuredLoggingPatch();
}

function printStructuredLoggingPatch() {
  console.log(`
═══════════════════════════════════════════════════════════════
 PROPUESTA DE PATCH: logging estructurado SVR (additive-only)
═══════════════════════════════════════════════════════════════
Añadir a bot/atlas-solver.js (sin modificar lógica de puja):

// Wrapper de logging SVR estructurado — sólo añade logs, no toca la lógica
function logSVR(event) {
  const line = ['[svr]'];
  if (event.auction)    line.push('auction=' + event.auction);
  if (event.ourBid)     line.push('ourBid=' + event.ourBid);
  if (event.winnerBid)  line.push('winnerBid=' + event.winnerBid);
  if (event.result)     line.push('result=' + event.result);
  if (event.profit)     line.push('profit=' + event.profit);
  console.log(line.join(' '));
}

// Añadir en el handler de subastas (hooks mínimos, sin cambiar decisiones):
//   Al recibir subasta SVR:     logSVR({ auction: auctionId });
//   Al enviar bid:              logSVR({ auction: auctionId, ourBid: bidValue.toString() });
//   Al recibir resultado ganado: logSVR({ auction: auctionId, result: 'WON', profit: netProfit });
//   Al recibir resultado perdido: logSVR({ auction: auctionId, ourBid: ourBid, winnerBid: winnerBid, result: 'LOST' });
═══════════════════════════════════════════════════════════════`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
