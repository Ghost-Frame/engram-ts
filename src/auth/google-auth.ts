// ============================================================================
// GOOGLE CLOUD AUTH -- Shared JWT service account authentication for Vertex AI
// Used by both embedding and LLM providers
// ============================================================================

import { createSign } from "crypto";
import { readFileSync } from "fs";
import { GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT } from "../config/index.ts";
import { log } from "../config/logger.ts";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id: string;
}

let _saKey: ServiceAccountKey | null = null;
let _accessToken: string | null = null;
let _tokenExpiry = 0;

export function loadServiceAccountKey(): ServiceAccountKey | null {
  if (_saKey) return _saKey;
  if (!GOOGLE_APPLICATION_CREDENTIALS) return null;
  try {
    const raw = JSON.parse(readFileSync(GOOGLE_APPLICATION_CREDENTIALS, "utf-8"));
    _saKey = { client_email: raw.client_email, private_key: raw.private_key, project_id: raw.project_id };
    return _saKey;
  } catch (e: any) {
    log.error({ msg: "failed_to_load_service_account", path: GOOGLE_APPLICATION_CREDENTIALS, error: e.message });
    return null;
  }
}

function base64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function getVertexAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (_accessToken && now < _tokenExpiry - 60) return _accessToken;

  const sa = loadServiceAccountKey();
  if (!sa) throw new Error("No service account key configured (set GOOGLE_APPLICATION_CREDENTIALS)");

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));

  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = base64url(sign.sign(sa.private_key));

  const jwt = `${header}.${payload}.${signature}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google token exchange failed (${resp.status}): ${text}`);
  }

  const data = await resp.json() as { access_token: string; expires_in: number };
  _accessToken = data.access_token;
  _tokenExpiry = now + data.expires_in;
  log.info({ msg: "vertex_token_acquired", expires_in: data.expires_in });
  return _accessToken;
}

export function getProjectId(): string {
  return GOOGLE_CLOUD_PROJECT || loadServiceAccountKey()?.project_id || "";
}
