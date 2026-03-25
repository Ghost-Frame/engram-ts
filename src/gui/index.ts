// ============================================================================
// GUI — Web GUI authentication, cookie signing, HTML serving
// ============================================================================

import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { DATA_DIR, GUI_AUTH_MAX_ATTEMPTS, GUI_AUTH_WINDOW_MS, GUI_AUTH_LOCKOUT_MS } from "../config/index.ts";
import { log } from "../config/logger.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, "../..");

// GUI password resolution
export const GUI_PASSWORD = (() => {
  if (process.env.ENGRAM_GUI_PASSWORD) return process.env.ENGRAM_GUI_PASSWORD;
  if (process.env.MEGAMIND_GUI_PASSWORD) {
    log.warn({ msg: "deprecated_env", var: "MEGAMIND_GUI_PASSWORD", use: "ENGRAM_GUI_PASSWORD" });
    return process.env.MEGAMIND_GUI_PASSWORD;
  }
  log.error({ msg: "gui_password_missing", detail: "ENGRAM_GUI_PASSWORD is required unless ENGRAM_OPEN_ACCESS=1." });
  return null;
})();

export const GUI_AUTH_CONFIGURED = GUI_PASSWORD !== null;
// Returns cookie attributes; omits Secure when the request arrives over plain HTTP
// so that local/LAN access (http://) works without the cookie being silently discarded.
export function guiCookieAttributes(req?: Request): string {
  const isHttps = req
    ? (req.url.startsWith("https://") || req.headers.get("x-forwarded-proto") === "https")
    : false;
  return isHttps
    ? "Path=/; HttpOnly; Secure; SameSite=Strict"
    : "Path=/; HttpOnly; SameSite=Lax";
}

// HMAC secret for cookie signing (top-level await)
const GUI_HMAC_SECRET = await (async () => {
  if (process.env.ENGRAM_HMAC_SECRET) return process.env.ENGRAM_HMAC_SECRET;
  const secretFile = resolve(DATA_DIR, ".hmac_secret");
  try {
    return readFileSync(secretFile, "utf-8");
  } catch {
    const secret = randomUUID() + randomUUID();
    writeFileSync(secretFile, secret);
    log.info({ msg: "generated_hmac_secret", path: secretFile });
    return secret;
  }
})();

export const GUI_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

export function guiSignCookie(ts: number): string {
  const h = createHash("sha256");
  h.update(GUI_HMAC_SECRET + ":" + String(ts));
  return ts + "." + h.digest("hex");
}

export function guiVerifyCookie(cookie: string): boolean {
  const dot = cookie.indexOf(".");
  if (dot < 1) return false;
  const ts = cookie.substring(0, dot), sig = cookie.substring(dot + 1);
  const t = parseInt(ts);
  if (isNaN(t) || Date.now() / 1000 - t > GUI_COOKIE_MAX_AGE) return false;
  const h = createHash("sha256");
  h.update(GUI_HMAC_SECRET + ":" + ts);
  const expected = h.digest("hex");
  if (expected.length !== sig.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

export function guiAuthed(req: Request): boolean {
  if (!GUI_AUTH_CONFIGURED) return false;
  const ck = (req.headers.get("cookie") || "")
    .split(";").map(c => c.trim())
    .find(c => c.startsWith("engram_auth="));
  if (!ck) return false;
  return guiVerifyCookie(ck.split("=").slice(1).join("="));
}

// HTML serving — prefer SvelteKit build, fall back to legacy single HTML
const GUI_BUILD_DIR = resolve(SERVER_DIR, "gui/build");
const USE_SVELTE_BUILD = existsSync(resolve(GUI_BUILD_DIR, "index.html"));

function readGuiHtml(): string {
  return USE_SVELTE_BUILD
    ? readFileSync(resolve(GUI_BUILD_DIR, "index.html"), "utf-8")
    : readFileSync(resolve(SERVER_DIR, "engram-gui.html"), "utf-8");
}

let GUI_HTML = readGuiHtml();
let LOGIN_HTML = readFileSync(resolve(SERVER_DIR, "engram-login.html"), "utf-8");
const GUI_HOT_RELOAD = process.env.ENGRAM_HOT_RELOAD === "1";

if (USE_SVELTE_BUILD) log.info({ msg: "gui_mode", mode: "sveltekit", build: GUI_BUILD_DIR });

export function getGuiHtml(): string {
  if (GUI_HOT_RELOAD) return readGuiHtml();
  return GUI_HTML;
}

export function getLoginHtml(): string {
  if (GUI_HOT_RELOAD) return readFileSync(resolve(SERVER_DIR, "engram-login.html"), "utf-8");
  return LOGIN_HTML;
}

export function reloadGuiHtml(): void {
  GUI_HTML = readGuiHtml();
  LOGIN_HTML = readFileSync(resolve(SERVER_DIR, "engram-login.html"), "utf-8");
  log.info({ msg: "gui_reloaded", trigger: "SIGHUP" });
}

// Static asset serving for SvelteKit build output
const MIME_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

export function serveGuiAsset(pathname: string): Response | null {
  if (!USE_SVELTE_BUILD) return null;
  const filePath = resolve(GUI_BUILD_DIR, pathname.slice(1));
  if (!filePath.startsWith(GUI_BUILD_DIR)) return null;
  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath);
    return new Response(content, {
      headers: {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control": pathname.includes("/immutable/") ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  } catch {
    return null;
  }
}

// SvelteKit uses client-side routing; these paths all serve the same index.html
export const GUI_SPA_ROUTES = new Set(["/", "/gui", "/graph", "/search", "/inbox", "/timeline", "/entities", "/projects"]);
