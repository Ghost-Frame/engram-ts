import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("parseEncryptionKey", () => {
  it("accepts 64-char hex", async () => {
    const { parseEncryptionKey } = await import("../src/artifacts/encryption.ts");
    const key = parseEncryptionKey("a".repeat(64));
    assert.ok(key instanceof Buffer);
    assert.equal(key.length, 32);
  });

  it("accepts 44-char base64", async () => {
    const { parseEncryptionKey } = await import("../src/artifacts/encryption.ts");
    const b64 = Buffer.alloc(32, 0xab).toString("base64");
    const key = parseEncryptionKey(b64);
    assert.ok(key instanceof Buffer);
    assert.equal(key.length, 32);
  });

  it("rejects invalid input", async () => {
    const { parseEncryptionKey } = await import("../src/artifacts/encryption.ts");
    assert.throws(() => parseEncryptionKey("too-short"), /Invalid encryption key format/);
    assert.throws(() => parseEncryptionKey("x".repeat(64)), /Invalid encryption key format/);
  });
});

describe("deriveUserKey", () => {
  it("produces 32-byte key", async () => {
    const { deriveUserKey } = await import("../src/artifacts/encryption.ts");
    const master = Buffer.alloc(32, 0xaa);
    const key = deriveUserKey(master, 42);
    assert.equal(key.length, 32);
  });

  it("produces different keys for different users", async () => {
    const { deriveUserKey } = await import("../src/artifacts/encryption.ts");
    const master = Buffer.alloc(32, 0xaa);
    const key1 = deriveUserKey(master, 1);
    const key2 = deriveUserKey(master, 2);
    assert.notDeepEqual(key1, key2);
  });
});

describe("encrypt/decrypt round-trip", () => {
  it("encrypts and decrypts correctly", async () => {
    const { encryptArtifact, decryptArtifact } = await import("../src/artifacts/encryption.ts");
    const master = Buffer.alloc(32, 0xbb);
    const plaintext = Buffer.from("Hello, encrypted world!");
    const userId = 7;

    const encrypted = encryptArtifact(plaintext, master, userId);
    assert.ok(encrypted.length > plaintext.length);
    assert.notDeepEqual(encrypted, plaintext);

    const decrypted = decryptArtifact(encrypted, master, userId);
    assert.deepEqual(decrypted, plaintext);
  });

  it("encrypted format is [12 IV][16 tag][ciphertext]", async () => {
    const { encryptArtifact } = await import("../src/artifacts/encryption.ts");
    const master = Buffer.alloc(32, 0xcc);
    const plaintext = Buffer.from("test data");

    const encrypted = encryptArtifact(plaintext, master, 1);
    assert.equal(encrypted.length, 12 + 16 + plaintext.length);
  });

  it("decrypt with wrong user fails", async () => {
    const { encryptArtifact, decryptArtifact } = await import("../src/artifacts/encryption.ts");
    const master = Buffer.alloc(32, 0xdd);
    const plaintext = Buffer.from("secret data");

    const encrypted = encryptArtifact(plaintext, master, 1);
    assert.throws(() => decryptArtifact(encrypted, master, 2));
  });

  it("decrypt with wrong key fails", async () => {
    const { encryptArtifact, decryptArtifact } = await import("../src/artifacts/encryption.ts");
    const master1 = Buffer.alloc(32, 0xee);
    const master2 = Buffer.alloc(32, 0xff);
    const plaintext = Buffer.from("secret data");

    const encrypted = encryptArtifact(plaintext, master1, 1);
    assert.throws(() => decryptArtifact(encrypted, master2, 1));
  });
});

describe("initEncryption", () => {
  it("empty string disables encryption", async () => {
    const { initEncryption, isEncryptionEnabled } = await import("../src/artifacts/encryption.ts");
    initEncryption("");
    assert.equal(isEncryptionEnabled(), false);
  });

  it("valid hex enables encryption", async () => {
    const { initEncryption, isEncryptionEnabled } = await import("../src/artifacts/encryption.ts");
    initEncryption("a".repeat(64));
    assert.equal(isEncryptionEnabled(), true);
  });

  it("invalid key throws", async () => {
    const { initEncryption } = await import("../src/artifacts/encryption.ts");
    assert.throws(() => initEncryption("bad-key"), /Invalid encryption key format/);
  });
});
