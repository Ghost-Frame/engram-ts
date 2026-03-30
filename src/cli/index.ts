#!/usr/bin/env -S node --experimental-strip-types
import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, extname, basename } from "node:path";

// ---------------------------------------------------------------------------
// ANSI color helpers (only when stdout is a TTY)
// ---------------------------------------------------------------------------
const tty = process.stdout.isTTY;
const esc = (code: string) => (tty ? `\x1b[${code}m` : "");
const reset = () => esc("0");
const dim = (s: string) => `${esc("2")}${s}${reset()}`;
const bold = (s: string) => `${esc("1")}${s}${reset()}`;
const green = (s: string) => `${esc("32")}${s}${reset()}`;
const red = (s: string) => `${esc("31")}${s}${reset()}`;
const yellow = (s: string) => `${esc("33")}${s}${reset()}`;
const cyan = (s: string) => `${esc("36")}${s}${reset()}`;

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------
interface Config {
  url: string;
  apiKey: string;
  timeout: number;
  json: boolean;
  quiet: boolean;
}

function loadConfigFile(): { url?: string; apiKey?: string } {
  const cfgPath = join(homedir(), ".engram", "config.json");
  if (!existsSync(cfgPath)) return {};
  try {
    const raw = readFileSync(cfgPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function buildConfig(cliUrl?: string, cliKey?: string, cliTimeout?: string, jsonFlag?: boolean, quietFlag?: boolean): Config {
  const fileCfg = loadConfigFile();
  const url =
    cliUrl ||
    process.env.ENGRAM_URL ||
    fileCfg.url ||
    "http://localhost:4200";
  const apiKey =
    cliKey ||
    process.env.ENGRAM_API_KEY ||
    fileCfg.apiKey ||
    "";
  const timeout = cliTimeout ? parseInt(cliTimeout, 10) : 10000;
  return { url: url.replace(/\/$/, ""), apiKey, timeout, json: !!jsonFlag, quiet: !!quietFlag };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
async function api(
  cfg: Config,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeout);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
  };

  let res: Response;
  try {
    res = await fetch(`${cfg.url}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort") || msg.includes("AbortError") || (err instanceof Error && err.name === "AbortError")) {
      throw new Error(`Request timed out after ${cfg.timeout}ms`);
    }
    throw new Error(`Cannot connect to Engram at ${cfg.url}. Is the server running?`);
  }
  clearTimeout(timer);

  if (res.status === 401) throw new Error("Authentication failed. Check your API key.");
  if (res.status === 404) throw new Error("Endpoint not found. Check Engram version.");
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status}: ${detail || res.statusText}`);
  }

  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Truncate helper
// ---------------------------------------------------------------------------
function trunc(s: string, max = 80): string {
  if (!s) return "";
  const single = s.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return single.slice(0, max - 3) + "...";
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdStore(cfg: Config, args: string[], opts: Record<string, string | boolean | undefined>) {
  let content = args[0] ?? "";
  if (!content && opts["content"]) content = String(opts["content"]);
  if (!content) {
    die('Usage: engram-cli store <content> [options]');
  }

  // @file support
  if (content.startsWith("@")) {
    const filePath = content.slice(1);
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      die(`Cannot read file: ${filePath}`);
    }
  }

  const category = String(opts["category"] ?? "general");
  const source = String(opts["source"] ?? "cli");
  const importance = opts["importance"] ? parseInt(String(opts["importance"]), 10) : 5;
  const tagsRaw = opts["tags"] ? String(opts["tags"]).split(",").map(t => t.trim()).filter(Boolean) : [];
  const isStatic = !!opts["static"];
  const model = opts["model"] ? String(opts["model"]) : undefined;

  const bodyObj: Record<string, unknown> = { content, category, source, importance };
  if (tagsRaw.length) bodyObj["tags"] = tagsRaw;
  if (isStatic) bodyObj["static"] = true;
  if (model) bodyObj["model"] = model;

  const result = await api(cfg, "POST", "/store", bodyObj) as Record<string, unknown>;

  if (cfg.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  const id = result["id"] ?? result["memory_id"] ?? "?";
  if (cfg.quiet) {
    process.stdout.write(`${id}\n`);
    return;
  }
  process.stdout.write(green(`Stored memory #${id}`) + ` ${dim(`(${category}, importance ${importance})`)}\n`);
}

async function cmdSearch(cfg: Config, args: string[], opts: Record<string, string | boolean | undefined>) {
  const query = args[0];
  if (!query) die('Usage: engram-cli search <query> [options]');

  const limit = opts["limit"] ? parseInt(String(opts["limit"]), 10) : 10;
  const mode = opts["mode"] ? String(opts["mode"]) : undefined;
  const explain = !!opts["explain"];

  const bodyObj: Record<string, unknown> = { query, limit };
  if (mode) bodyObj["mode"] = mode;
  if (explain) bodyObj["explain"] = true;

  const result = await api(cfg, "POST", "/search", bodyObj) as Record<string, unknown>;

  if (cfg.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  const memories: unknown[] = Array.isArray(result) ? result : (result["memories"] as unknown[] ?? result["results"] as unknown[] ?? []);

  if (memories.length === 0) {
    process.stdout.write(yellow("No results found.\n"));
    return;
  }

  memories.forEach((m, i) => {
    const mem = m as Record<string, unknown>;
    const id = mem["id"] ?? "?";
    const score = mem["score"] !== undefined ? (Number(mem["score"]) * 100).toFixed(1) + "%" : "";
    const cat = String(mem["category"] ?? "");
    const content = trunc(String(mem["content"] ?? ""), 80);
    const created = mem["created_at"] ? dim(fmtDate(String(mem["created_at"]))) : "";
    const scoreStr = score ? cyan(score) : "";
    process.stdout.write(`${bold(`${i + 1}.`)} ${dim(`#${id}`)} ${scoreStr} ${yellow(`[${cat}]`)} ${content} ${created}\n`);
    if (explain && mem["scoring"]) {
      process.stdout.write(dim(`   Scoring: ${JSON.stringify(mem["scoring"])}\n`));
    }
  });
}

async function cmdContext(cfg: Config, args: string[], opts: Record<string, string | boolean | undefined>) {
  const query = args[0];
  if (!query) die('Usage: engram-cli context <query> [options]');

  const budget = opts["budget"] ? parseInt(String(opts["budget"]), 10) : 4000;
  const mode = opts["mode"] ? String(opts["mode"]) : undefined;
  const depth = opts["depth"] ? parseInt(String(opts["depth"]), 10) : undefined;

  const bodyObj: Record<string, unknown> = { query, budget };
  if (mode) bodyObj["mode"] = mode;
  if (depth !== undefined) bodyObj["depth"] = depth;

  const result = await api(cfg, "POST", "/context", bodyObj) as Record<string, unknown>;

  if (cfg.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  const contextText = String(result["context"] ?? result["text"] ?? result ?? "");
  process.stdout.write(contextText + "\n");

  if (!cfg.quiet) {
    const used = result["tokens_used"] ?? result["budget_used"] ?? result["utilization"];
    const total = result["budget"] ?? budget;
    if (used !== undefined) {
      process.stdout.write(dim(`\n-- Context: ${used}/${total} tokens used --\n`));
    }
  }
}

async function cmdRecall(cfg: Config, _args: string[], opts: Record<string, string | boolean | undefined>) {
  const context = opts["context"] ? String(opts["context"]) : undefined;
  const limit = opts["limit"] ? parseInt(String(opts["limit"]), 10) : 20;

  const bodyObj: Record<string, unknown> = { limit };
  if (context) bodyObj["context"] = context;

  const result = await api(cfg, "POST", "/recall", bodyObj) as Record<string, unknown>;

  if (cfg.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  const memories: unknown[] = Array.isArray(result)
    ? result
    : (result["memories"] as unknown[] ?? result["results"] as unknown[] ?? []);

  if (memories.length === 0) {
    process.stdout.write(yellow("No memories recalled.\n"));
    return;
  }

  // Group by recall_source
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const m of memories) {
    const mem = m as Record<string, unknown>;
    const src = String(mem["recall_source"] ?? mem["source"] ?? "general");
    if (!groups.has(src)) groups.set(src, []);
    groups.get(src)!.push(mem);
  }

  for (const [src, mems] of groups) {
    process.stdout.write(bold(cyan(`[${src}]`)) + "\n");
    for (const mem of mems) {
      const id = mem["id"] ?? "?";
      const content = trunc(String(mem["content"] ?? ""), 80);
      process.stdout.write(`  ${dim(`#${id}`)} ${content}\n`);
    }
  }
}

async function cmdList(cfg: Config, _args: string[], opts: Record<string, string | boolean | undefined>) {
  const limit = opts["limit"] ? parseInt(String(opts["limit"]), 10) : 20;
  const category = opts["category"] ? String(opts["category"]) : undefined;
  const source = opts["source"] ? String(opts["source"]) : undefined;

  const params = new URLSearchParams({ limit: String(limit) });
  if (category) params.set("category", category);
  if (source) params.set("source", source);

  const result = await api(cfg, "GET", `/list?${params.toString()}`) as Record<string, unknown>;

  if (cfg.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  const memories: unknown[] = Array.isArray(result)
    ? result
    : (result["memories"] as unknown[] ?? result["results"] as unknown[] ?? []);

  if (memories.length === 0) {
    process.stdout.write(yellow("No memories found.\n"));
    return;
  }

  // Table header
  const hId = bold("ID");
  const hCat = bold("Category");
  const hSrc = bold("Source");
  const hContent = bold("Content");
  const hDate = bold("Created");
  process.stdout.write(`${hId.padEnd(8)} ${hCat.padEnd(14)} ${hSrc.padEnd(14)} ${hContent.padEnd(50)} ${hDate}\n`);
  process.stdout.write(dim("-".repeat(110)) + "\n");

  for (const m of memories) {
    const mem = m as Record<string, unknown>;
    const id = String(mem["id"] ?? "?");
    const cat = String(mem["category"] ?? "");
    const src = String(mem["source"] ?? "");
    const content = trunc(String(mem["content"] ?? ""), 50);
    const created = mem["created_at"] ? fmtDate(String(mem["created_at"])) : "";
    process.stdout.write(`${id.padEnd(8)} ${cat.padEnd(14)} ${src.padEnd(14)} ${content.padEnd(50)} ${dim(created)}\n`);
  }
}

async function cmdForget(cfg: Config, args: string[], opts: Record<string, string | boolean | undefined>) {
  const id = args[0];
  if (!id) die('Usage: engram-cli forget <id> [--reason <text>]');

  const reason = opts["reason"] ? String(opts["reason"]) : undefined;
  const bodyObj: Record<string, unknown> = {};
  if (reason) bodyObj["reason"] = reason;

  await api(cfg, "POST", `/forget/${id}`, Object.keys(bodyObj).length ? bodyObj : undefined);

  if (cfg.json) {
    process.stdout.write(JSON.stringify({ id, action: "forgotten" }) + "\n");
    return;
  }
  process.stdout.write(green(`Forgot memory #${id}`) + "\n");
}

async function cmdDelete(cfg: Config, args: string[]) {
  const id = args[0];
  if (!id) die('Usage: engram-cli delete <id>');

  await api(cfg, "DELETE", `/memory/${id}`);

  if (cfg.json) {
    process.stdout.write(JSON.stringify({ id, action: "deleted" }) + "\n");
    return;
  }
  process.stdout.write(green(`Deleted memory #${id}`) + "\n");
}

async function cmdHealth(cfg: Config) {
  const result = await api(cfg, "GET", "/health") as Record<string, unknown>;

  if (cfg.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  const version = result["version"] ?? "?";
  const status = result["status"] ?? "ok";
  const statusStr = String(status).toLowerCase() === "ok" || String(status).toLowerCase() === "healthy"
    ? green("OK")
    : red(String(status));
  process.stdout.write(`Engram v${version} -- ${statusStr}\n`);
}

async function cmdStats(cfg: Config) {
  let result: Record<string, unknown>;

  // Try /admin/stats first, fall back to /health
  try {
    result = await api(cfg, "GET", "/admin/stats") as Record<string, unknown>;
  } catch {
    result = await api(cfg, "GET", "/health") as Record<string, unknown>;
  }

  if (cfg.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  // Extract stats from various possible shapes
  const stats = (result["stats"] as Record<string, unknown>) ?? result;

  const fields: [string, string][] = [
    ["Total memories", String(stats["total"] ?? stats["total_memories"] ?? "?")],
    ["Active", String(stats["active"] ?? stats["active_memories"] ?? "?")],
    ["Archived", String(stats["archived"] ?? stats["archived_memories"] ?? "?")],
    ["Forgotten", String(stats["forgotten"] ?? stats["forgotten_memories"] ?? "?")],
    ["Embeddings", String(stats["embeddings"] ?? stats["embedding_count"] ?? stats["total_embeddings"] ?? "?")],
    ["Version", String(result["version"] ?? "?")],
    ["Status", String(result["status"] ?? "?")],
  ];

  process.stdout.write(bold("Engram Statistics\n"));
  process.stdout.write(dim("-".repeat(30)) + "\n");
  for (const [label, value] of fields) {
    if (value !== "?" && value !== "undefined") {
      process.stdout.write(`${label.padEnd(16)} ${cyan(value)}\n`);
    }
  }
}

async function cmdIngest(cfg: Config, args: string[], opts: Record<string, string | boolean | undefined>) {
  const filePath = args[0];
  if (!filePath) die("Usage: engram-cli ingest <path> [options]");

  if (!existsSync(filePath)) die(`File not found: ${filePath}`);

  const mode = String(opts["mode"] ?? "extract");
  if (mode !== "extract" && mode !== "raw") {
    die("--mode must be 'extract' or 'raw'");
  }

  const ext = extname(filePath).toLowerCase();
  const filename = basename(filePath);

  // Determine format: explicit override, otherwise auto-detect from extension
  const formatOpt = opts["format"] ? String(opts["format"]) : undefined;
  const autoFormat: Record<string, string> = {
    ".txt": "text",
    ".md": "markdown",
    ".markdown": "markdown",
    ".html": "html",
    ".htm": "html",
    ".json": "json",
    ".csv": "csv",
    ".pdf": "pdf",
    ".docx": "docx",
    ".doc": "docx",
    ".zip": "zip",
  };
  const format = formatOpt ?? autoFormat[ext] ?? "text";

  const binaryFormats = new Set(["pdf", "docx", "doc", "zip"]);
  const isBinary = binaryFormats.has(ext.slice(1)) || (formatOpt !== undefined && binaryFormats.has(formatOpt));

  const source = opts["source"] ? String(opts["source"]) : filename;
  const category = String(opts["category"] ?? "general");
  const showProgress = !!opts["progress"];

  let bodyObj: Record<string, unknown>;

  if (isBinary) {
    const buf = readFileSync(filePath);
    const encoded = buf.toString("base64");
    bodyObj = { text: encoded, encoding: "base64", format, mode, source, category };
  } else {
    const text = readFileSync(filePath, "utf8");
    bodyObj = { text, format, mode, source, category };
  }

  if (!cfg.quiet) {
    process.stdout.write(dim(`Ingesting ${filename} (format: ${format}, mode: ${mode})...\n`));
  }

  const result = await api(cfg, "POST", "/import/bulk", bodyObj) as Record<string, unknown>;

  if (cfg.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  const jobId = result["job_id"] ?? result["id"] ?? "?";
  const chiasmTaskId = result["chiasm_task_id"] ?? result["task_id"] ?? undefined;
  const status = result["status"] ?? "submitted";

  process.stdout.write(green(`Ingest job submitted`) + "\n");
  process.stdout.write(`  ${bold("Job ID:")}    ${cyan(String(jobId))}\n`);
  if (chiasmTaskId !== undefined) {
    process.stdout.write(`  ${bold("Task ID:")}   ${cyan(String(chiasmTaskId))}\n`);
  }
  process.stdout.write(`  ${bold("Status:")}    ${String(status)}\n`);

  if (!showProgress) return;

  // Poll /axon/events?channel=ingestion until ingest.completed or ingest.error
  if (!cfg.quiet) {
    process.stdout.write(dim("\nWatching ingestion progress (Ctrl+C to stop)...\n"));
  }

  const pollInterval = 2000;
  const maxPolls = 150; // 5 minutes max
  let polls = 0;
  let lastEventId: string | undefined;

  while (polls < maxPolls) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));
    polls++;

    const params = new URLSearchParams({ channel: "ingestion", limit: "20" });
    if (lastEventId) params.set("after", lastEventId);

    let events: unknown[];
    try {
      const eventsResult = await api(cfg, "GET", `/axon/events?${params.toString()}`) as unknown;
      events = Array.isArray(eventsResult)
        ? eventsResult
        : ((eventsResult as Record<string, unknown>)["events"] as unknown[] ?? []);
    } catch {
      // transient error -- keep polling
      continue;
    }

    for (const ev of events) {
      const event = ev as Record<string, unknown>;
      const evType = String(event["type"] ?? "");
      const payload = (event["payload"] ?? {}) as Record<string, unknown>;
      lastEventId = String(event["id"] ?? lastEventId ?? "");

      // Filter to events matching our job
      const evJobId = payload["job_id"] ?? payload["id"];
      if (evJobId !== undefined && String(evJobId) !== String(jobId)) continue;

      if (evType === "ingest.progress" || evType === "ingest.update") {
        const pct = payload["percent"] !== undefined ? ` ${cyan(String(payload["percent"]) + "%")}` : "";
        const msg = payload["message"] ? ` ${String(payload["message"])}` : "";
        process.stdout.write(`  ${yellow("progress")}${pct}${msg}\n`);
      } else if (evType === "ingest.completed" || evType === "ingest.done") {
        const stored = payload["stored"] ?? payload["memories_stored"] ?? payload["count"];
        const storedStr = stored !== undefined ? ` (${stored} memories stored)` : "";
        process.stdout.write(green(`  Ingestion complete`) + storedStr + "\n");
        return;
      } else if (evType === "ingest.error" || evType === "ingest.failed") {
        const errMsg = payload["error"] ?? payload["message"] ?? "unknown error";
        process.stderr.write(red(`  Ingestion failed: ${String(errMsg)}`) + "\n");
        process.exit(1);
      }
    }
  }

  process.stdout.write(yellow("  Timed out waiting for completion. Job may still be running.\n"));
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------
function showHelp() {
  process.stdout.write(`${bold("engram-cli")} -- Engram Memory System CLI

${bold("Usage:")} engram-cli <command> [options]

${bold("Commands:")}
  ${cyan("store <content>")}     Store a memory
  ${cyan("search <query>")}      Search memories
  ${cyan("context <query>")}     Get agent context
  ${cyan("recall")}              Recall memories
  ${cyan("list")}                List recent memories
  ${cyan("forget <id>")}         Forget a memory
  ${cyan("delete <id>")}         Delete a memory
  ${cyan("health")}              Check server health
  ${cyan("stats")}               Show statistics
  ${cyan("ingest <path>")}       Ingest a file into memory

${bold("Global Options:")}
  ${yellow("--url <url>")}         Engram server URL (env: ENGRAM_URL)
  ${yellow("--api-key <key>")}     API key (env: ENGRAM_API_KEY)
  ${yellow("--json")}              Output raw JSON
  ${yellow("--quiet")}             Minimal output
  ${yellow("--timeout <ms>")}      Request timeout (default: 10000)
  ${yellow("-h, --help")}          Show this help

${bold("Environment:")}
  ENGRAM_URL          Server URL (default: http://localhost:4200)
  ENGRAM_API_KEY      Authentication key (required)
`);
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------
function die(msg: string): never {
  process.stderr.write(red(`Error: ${msg}`) + "\n");
  process.exit(1);
}

function dieApiError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith("Request timed out")) {
    process.stderr.write(red(`Error: ${msg}`) + "\n");
  } else if (msg.startsWith("Cannot connect")) {
    process.stderr.write(red(`Error: ${msg}`) + "\n");
  } else if (msg.startsWith("Authentication failed")) {
    process.stderr.write(red(`Error: ${msg}`) + "\n");
  } else if (msg.startsWith("Endpoint not found")) {
    process.stderr.write(red(`Error: ${msg}`) + "\n");
  } else {
    process.stderr.write(red(`Error: ${msg}`) + "\n");
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------
async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      // Global
      url: { type: "string" },
      "api-key": { type: "string" },
      json: { type: "boolean" },
      quiet: { type: "boolean" },
      timeout: { type: "string" },
      help: { type: "boolean", short: "h" },
      // store
      category: { type: "string" },
      source: { type: "string" },
      importance: { type: "string" },
      tags: { type: "string" },
      static: { type: "boolean" },
      model: { type: "string" },
      content: { type: "string" },
      // search
      limit: { type: "string" },
      mode: { type: "string" },
      explain: { type: "boolean" },
      // context
      budget: { type: "string" },
      depth: { type: "string" },
      // recall
      context: { type: "string" },
      // forget
      reason: { type: "string" },
      // ingest
      format: { type: "string" },
      progress: { type: "boolean" },
    },
  });

  if (values["help"] || positionals.length === 0) {
    showHelp();
    process.exit(0);
  }

  const [command, ...restArgs] = positionals;

  const cfg = buildConfig(
    values["url"] as string | undefined,
    values["api-key"] as string | undefined,
    values["timeout"] as string | undefined,
    values["json"] as boolean | undefined,
    values["quiet"] as boolean | undefined
  );

  // Validate API key for all commands except help
  if (!cfg.apiKey) {
    die("ENGRAM_API_KEY not set. Export it or use --api-key");
  }

  try {
    switch (command) {
      case "store":
        await cmdStore(cfg, restArgs, values as Record<string, string | boolean | undefined>);
        break;
      case "search":
        await cmdSearch(cfg, restArgs, values as Record<string, string | boolean | undefined>);
        break;
      case "context":
        await cmdContext(cfg, restArgs, values as Record<string, string | boolean | undefined>);
        break;
      case "recall":
        await cmdRecall(cfg, restArgs, values as Record<string, string | boolean | undefined>);
        break;
      case "list":
        await cmdList(cfg, restArgs, values as Record<string, string | boolean | undefined>);
        break;
      case "forget":
        await cmdForget(cfg, restArgs, values as Record<string, string | boolean | undefined>);
        break;
      case "delete":
        await cmdDelete(cfg, restArgs);
        break;
      case "health":
        await cmdHealth(cfg);
        break;
      case "stats":
        await cmdStats(cfg);
        break;
      case "ingest":
        await cmdIngest(cfg, restArgs, values as Record<string, string | boolean | undefined>);
        break;
      default:
        process.stderr.write(red(`Error: Unknown command '${command}'. Run with --help for usage.\n`));
        process.exit(1);
    }
  } catch (err) {
    dieApiError(err);
  }
}

main();
