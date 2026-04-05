// SSRF-safe fetch: validates resolved IPs and revalidates on redirects
import { resolve4 } from "node:dns/promises";

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,
  /^0\./,
  /^::1$/,
  /^fc/,
  /^fd/,
];

function isPrivateIp(ip: string): boolean {
  return PRIVATE_RANGES.some(r => r.test(ip));
}

async function validateHostname(hostname: string): Promise<void> {
  // Skip IP literals
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`Hostname ${hostname} resolves to private IP`);
    return;
  }
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error(`Hostname ${hostname} is a local/internal address`);
  }
  let ips: string[];
  try {
    ips = await resolve4(hostname);
  } catch {
    throw new Error(`DNS resolution failed for ${hostname}`);
  }
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      throw new Error(`Hostname ${hostname} resolves to private IP ${ip}`);
    }
  }
}

const MAX_REDIRECTS = 5;

export async function safeFetch(url: string, options: RequestInit = {}): Promise<Response> {
  let currentUrl = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const parsed = new URL(currentUrl);
    await validateHostname(parsed.hostname);
    const resp = await fetch(currentUrl, {
      ...options,
      redirect: "manual",
      signal: options.signal || AbortSignal.timeout(15000),
    });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) throw new Error("Redirect with no Location header");
      currentUrl = new URL(location, currentUrl).toString();
      if (i === MAX_REDIRECTS) throw new Error("Too many redirects");
      continue;
    }
    return resp;
  }
  throw new Error("Too many redirects");
}
