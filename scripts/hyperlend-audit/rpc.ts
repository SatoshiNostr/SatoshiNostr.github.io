import { ethers } from 'ethers';

export interface RpcConfig {
  urls: string[];              // [archive, fallback1, fallback2, ...]
  publicRpcUrl: string;        // rate-limited public endpoint (last resort)
  publicRateLimit: number;     // max req/min for public RPC
}

// ---- Sleep utility ----
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- Token-bucket rate limiter ----
export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillPerMs: number;
  private lastRefill: number;

  constructor(requestsPerMinute: number) {
    this.maxTokens = requestsPerMinute;
    this.tokens = requestsPerMinute;
    this.refillPerMs = requestsPerMinute / 60_000;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = (1 - this.tokens) / this.refillPerMs + 5;
      await sleep(waitMs);
      this.refill();
    }
    this.tokens = Math.max(0, this.tokens - 1);
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.maxTokens, this.tokens + (now - this.lastRefill) * this.refillPerMs);
    this.lastRefill = now;
  }
}

// ---- Retry with exponential backoff ----
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 5,
  baseDelayMs = 2_000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const errMsg = String(err);
      // Don't retry on non-recoverable errors
      if (errMsg.includes('invalid address') || errMsg.includes('call revert')) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      const isRateLimit = errMsg.includes('429') || errMsg.includes('rate') || errMsg.includes('limit');
      const waitMs = isRateLimit ? delay * 2 : delay;
      if (attempt < maxAttempts) {
        console.warn(`  [rpc] ${label} attempt ${attempt}/${maxAttempts} failed, retrying in ${waitMs}ms: ${errMsg.slice(0, 120)}`);
        await sleep(waitMs);
      }
    }
  }
  throw new Error(`[rpc] ${label} failed after ${maxAttempts} attempts: ${String(lastError)}`);
}

// ---- Multi-provider wrapper with fallback and rate limiting ----
export class MultiProvider {
  private readonly providers: ethers.JsonRpcProvider[];
  private readonly rateLimiters: (RateLimiter | null)[];
  private current: number = 0;

  constructor(urls: string[], publicRpcRequestsPerMin = 100) {
    if (!urls.length) throw new Error('No RPC URLs configured. Set HYPEREVM_RPC_URL in .env');
    this.providers = urls.map(u => new ethers.JsonRpcProvider(u, 999));
    // Rate-limit only the last URL (assumed to be the public RPC)
    this.rateLimiters = urls.map((_, i) =>
      i === urls.length - 1 && urls.length > 1
        ? new RateLimiter(publicRpcRequestsPerMin)
        : null
    );
    this.current = 0;
  }

  get provider(): ethers.JsonRpcProvider {
    return this.providers[this.current];
  }

  // Acquire rate-limit token for current provider if needed
  async acquireRateLimit(): Promise<void> {
    const rl = this.rateLimiters[this.current];
    if (rl) await rl.acquire();
  }

  // Rotate to next provider on persistent failure
  rotate(): void {
    this.current = (this.current + 1) % this.providers.length;
    console.warn(`  [rpc] Rotated to provider index ${this.current}`);
  }

  // General-purpose call with fallback rotation
  async call<T>(fn: (p: ethers.JsonRpcProvider) => Promise<T>, label: string): Promise<T> {
    const startIdx = this.current;
    for (let i = 0; i < this.providers.length; i++) {
      const idx = (startIdx + i) % this.providers.length;
      const provider = this.providers[idx];
      const rl = this.rateLimiters[idx];
      try {
        if (rl) await rl.acquire();
        return await withRetry(() => fn(provider), label, 3, 1_500);
      } catch (err) {
        console.warn(`  [rpc] Provider ${idx} failed for "${label}", trying next: ${String(err).slice(0, 100)}`);
        this.current = (idx + 1) % this.providers.length;
      }
    }
    throw new Error(`[rpc] All providers failed for: ${label}`);
  }
}

// ---- Chunked getLogs with adaptive sizing and resume support ----
export interface GetLogsOptions {
  address: string;
  topics: (string | null)[];
  fromBlock: number;
  toBlock: number;
  chunkSize: number;
  maxChunkSize: number;
  onChunk?: (from: number, to: number, count: number) => void;
}

export async function getLogsChunked(
  mp: MultiProvider,
  opts: GetLogsOptions,
): Promise<ethers.Log[]> {
  const allLogs: ethers.Log[] = [];
  let from = opts.fromBlock;
  let chunk = opts.chunkSize;

  while (from <= opts.toBlock) {
    const to = Math.min(from + chunk - 1, opts.toBlock);
    try {
      await mp.acquireRateLimit();
      const logs = await withRetry(
        () => mp.provider.getLogs({ address: opts.address, topics: opts.topics, fromBlock: from, toBlock: to }),
        `getLogs(${from}-${to})`,
        4,
        2_000,
      );
      allLogs.push(...logs);
      opts.onChunk?.(from, to, logs.length);
      from = to + 1;
      // Slightly grow chunk on success (up to max)
      chunk = Math.min(Math.floor(chunk * 1.1), opts.maxChunkSize);
    } catch (err) {
      const msg = String(err);
      const isRangeError = msg.includes('block range') || msg.includes('too large') || msg.includes('limit') || msg.includes('exceed');
      if (isRangeError && chunk > 50) {
        chunk = Math.max(50, Math.floor(chunk / 2));
        console.warn(`  [rpc] Reducing chunk size to ${chunk} due to range error`);
        // Retry same range with smaller chunk — don't advance from
      } else {
        // Try rotating provider
        mp.rotate();
        await sleep(3_000);
      }
    }
  }

  return allLogs;
}

// ---- Block timestamp binary search ----
export async function estimateBlockAtTimestamp(
  mp: MultiProvider,
  targetTs: number,
): Promise<number> {
  const latest = await mp.call(p => p.getBlock('latest'), 'getBlock(latest)');
  if (!latest) throw new Error('Could not fetch latest block');

  // Sample block ~10k blocks back to estimate block time
  const sampleN = Math.max(0, latest.number - 10_000);
  const sample = await mp.call(p => p.getBlock(sampleN), `getBlock(${sampleN})`);
  if (!sample) throw new Error(`Could not fetch sample block ${sampleN}`);

  const secPerBlock = (latest.timestamp - sample.timestamp) / (latest.number - sample.number);
  const estimatedBlock = Math.max(
    0,
    Math.floor(latest.number - (latest.timestamp - targetTs) / secPerBlock),
  );

  console.log(`  [rpc] Actual block time: ${secPerBlock.toFixed(2)}s/block`);
  console.log(`  [rpc] Estimated block for ${new Date(targetTs * 1000).toISOString()}: #${estimatedBlock}`);
  return estimatedBlock;
}
