// SSRF-safe fetch: validates resolved IPs (v4+v6), pins to validated IP to prevent DNS rebinding
import { resolve4, resolve6 } from "node:dns/promises";

const PRIVATE_RANGES_V4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,
  /^0\./,
];

const PRIVATE_RANGES_V6 = [
  /^::1$/,
  /^fe80:/i,
  /^fc/i,
  /^fd/i,
  /^::$/,
  /^::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i,
];

function isPrivateIp(ip: string): boolean {
  return PRIVATE_RANGES_V4.some(r => r.test(ip)) || PRIVATE_RANGES_V6.some(r => r.test(ip));
}

async function resolveAndValidate(hostname: string): Promise<string> {
  // Handle IPv4 literals
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`IP ${hostname} is private`);
    return hostname;
  }
  // Handle IPv6 literals
  if (hostname.startsWith("[") || hostname.includes(":")) {
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (isPrivateIp(bare)) throw new Error(`IP ${bare} is private`);
    return bare;
  }
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error(`Hostname ${hostname} is a local/internal address`);
  }

  // Resolve both A and AAAA records
  const [v4, v6] = await Promise.allSettled([
    resolve4(hostname),
    resolve6(hostname),
  ]);

  const ips: string[] = [];
  if (v4.status === "fulfilled") ips.push(...v4.value);
  if (v6.status === "fulfilled") ips.push(...v6.value);

  if (ips.length === 0) throw new Error(`DNS resolution failed for ${hostname}`);

  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      throw new Error(`Hostname ${hostname} resolves to private IP ${ip}`);
    }
  }

  return ips[0];
}

const MAX_REDIRECTS = 5;

export async function safeFetch(url: string, options: RequestInit = {}): Promise<Response> {
  let currentUrl = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const parsed = new URL(currentUrl);
    const resolvedIp = await resolveAndValidate(parsed.hostname);

    // Pin fetch to the validated IP to prevent DNS rebinding (TOCTOU)
    const pinnedUrl = new URL(currentUrl);
    pinnedUrl.hostname = resolvedIp.includes(":") ? `[${resolvedIp}]` : resolvedIp;

    const resp = await fetch(pinnedUrl.toString(), {
      ...options,
      redirect: "manual",
      signal: options.signal || AbortSignal.timeout(15000),
      headers: {
        ...Object.fromEntries(new Headers(options.headers as Record<string, string>).entries()),
        Host: parsed.host,
      },
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
