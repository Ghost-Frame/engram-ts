import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";
import { log } from "../config/logger.ts";

const HKDF_SALT = Buffer.from("engram-artifact");
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function parseEncryptionKey(raw: string): Buffer {
  if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  if (raw.length === 44) {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) return buf;
  }
  throw new Error("Invalid encryption key format: must be 64-char hex or 44-char base64");
}

export function deriveUserKey(masterKey: Buffer, userId: number): Buffer {
  const info = String(userId);
  return Buffer.from(hkdfSync("sha256", masterKey, HKDF_SALT, info, 32));
}

export function encryptArtifact(plaintext: Buffer, masterKey: Buffer, userId: number): Buffer {
  const userKey = deriveUserKey(masterKey, userId);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", userKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptArtifact(encrypted: Buffer, masterKey: Buffer, userId: number): Buffer {
  if (encrypted.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Encrypted data too short");
  }
  const userKey = deriveUserKey(masterKey, userId);
  const iv = encrypted.subarray(0, IV_LENGTH);
  const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encrypted.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", userKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

let _masterKey: Buffer | null = null;

export function initEncryption(keyString: string): void {
  if (!keyString) {
    _masterKey = null;
    log.info({ msg: "artifact_encryption", status: "disabled", reason: "no key configured" });
    return;
  }
  _masterKey = parseEncryptionKey(keyString);
  log.info({ msg: "artifact_encryption", status: "enabled" });
}

export function getMasterKey(): Buffer | null {
  return _masterKey;
}

export function isEncryptionEnabled(): boolean {
  return _masterKey !== null;
}
