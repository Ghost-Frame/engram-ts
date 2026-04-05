// ============================================================================
// LOCAL MODEL CLIENT - Ollama-only inference, replaces callLLM
// No external API calls. Semaphore + circuit breaker for CPU-only hardware.
// ============================================================================

import { log } from "../config/logger.ts";

// --- Config (env vars) ---

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434/v1/chat/completions";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:14b";
const OLLAMA_TIMEOUT_BG = Number(process.env.OLLAMA_TIMEOUT || 60000);
const OLLAMA_TIMEOUT_HOT = Number(process.env.OLLAMA_TIMEOUT_HOT || 5000);
const OLLAMA_CONCURRENCY = Number(process.env.OLLAMA_CONCURRENCY || 1);
const CB_THRESHOLD = Number(process.env.OLLAMA_CIRCUIT_BREAKER_THRESHOLD || 3);
const CB_COOLDOWN = Number(process.env.OLLAMA_CIRCUIT_BREAKER_COOLDOWN || 30000);
const SEMAPHORE_MAX_QUEUE = 50;

// --- Semaphore ---

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  private max: number;
  constructor(max: number) { this.max = max; }

  tryAcquire(): boolean {
    if (this.active < this.max) { this.active++; return true; }
    return false;
  }

  async acquire(): Promise<boolean> {
    if (this.active < this.max) { this.active++; return true; }
    if (this.queue.length >= SEMAPHORE_MAX_QUEUE) return false;
    return new Promise(resolve => {
      this.queue.push(() => { this.active++; resolve(true); });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  get pending(): number { return this.queue.length; }
  get running(): number { return this.active; }
}

const sem = new Semaphore(OLLAMA_CONCURRENCY);

// --- Circuit Breaker ---

let cbFailures = 0;
let cbOpenUntil = 0;

function cbIsOpen(): boolean {
  if (cbFailures < CB_THRESHOLD) return false;
  if (Date.now() >= cbOpenUntil) {
    // Half-open: allow one probe to test recovery
    cbFailures = CB_THRESHOLD - 1;
    return false;
  }
  return true;
}

function cbRecordSuccess(): void {
  cbFailures = 0;
  cbOpenUntil = 0;
}

function cbRecordFailure(): void {
  cbFailures++;
  if (cbFailures >= CB_THRESHOLD) {
    cbOpenUntil = Date.now() + CB_COOLDOWN;
    log.warn({ msg: "ollama_circuit_open", cooldown_ms: CB_COOLDOWN, failures: cbFailures });
  }
}

// --- Availability ---

let _probeResult: boolean | null = null;

export async function probeLocalModel(): Promise<boolean> {
  const tagsUrl = OLLAMA_URL.replace(/\/v1\/chat\/completions$/, "").replace(/\/v1$/, "") + "/api/tags";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const resp = await fetch(tagsUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    _probeResult = resp.ok;
  } catch {
    _probeResult = false;
  }
  log.info({ msg: "ollama_probe", reachable: _probeResult, url: OLLAMA_URL, model: OLLAMA_MODEL });
  return _probeResult;
}

export function isLocalModelAvailable(): boolean {
  if (cbIsOpen()) return false;
  if (_probeResult === false) return false;
  // If never probed, assume available (will fail fast on first call)
  return true;
}

// --- Core inference ---

export interface LocalModelOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  priority?: "hot" | "background";
}

export async function callLocalModel(
  systemPrompt: string,
  userPrompt: string,
  opts?: LocalModelOptions,
): Promise<string> {
  const priority = opts?.priority ?? "background";
  const timeout = opts?.timeout ?? (priority === "hot" ? OLLAMA_TIMEOUT_HOT : OLLAMA_TIMEOUT_BG);
  const model = opts?.model ?? OLLAMA_MODEL;

  // Circuit breaker check
  if (cbIsOpen()) {
    throw new Error("ollama circuit breaker open");
  }

  // Semaphore: hot-path fast-fails, background queues
  let acquired: boolean;
  if (priority === "hot") {
    acquired = sem.tryAcquire();
    if (!acquired) {
      throw new Error("ollama busy (hot-path fast-fail)");
    }
  } else {
    acquired = await sem.acquire();
    if (!acquired) {
      throw new Error("ollama queue full");
    }
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    const resp = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: opts?.temperature ?? 0.1,
        max_tokens: opts?.maxTokens ?? 2000,
        stream: false,
      }),
      signal: ctrl.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`ollama ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data?.choices?.[0]?.message?.content ?? "";

    if (!text) {
      throw new Error("ollama returned empty response");
    }

    cbRecordSuccess();
    _probeResult = true;
    return text;
  } catch (e: any) {
    cbRecordFailure();
    throw e;
  } finally {
    sem.release();
  }
}

// --- Stats (for health endpoint) ---

export function localModelStats(): {
  available: boolean;
  circuit_breaker: "closed" | "open" | "half-open";
  failures: number;
  semaphore_running: number;
  semaphore_queued: number;
  model: string;
  url: string;
} {
  let cbState: "closed" | "open" | "half-open" = "closed";
  if (cbFailures >= CB_THRESHOLD) {
    cbState = Date.now() >= cbOpenUntil ? "half-open" : "open";
  }
  return {
    available: isLocalModelAvailable(),
    circuit_breaker: cbState,
    failures: cbFailures,
    semaphore_running: sem.running,
    semaphore_queued: sem.pending,
    model: OLLAMA_MODEL,
    url: OLLAMA_URL,
  };
}
