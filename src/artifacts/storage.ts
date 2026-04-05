import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { ARTIFACT_DIR, ARTIFACT_SIZE_THRESHOLD } from "../config/index.ts";
import { log } from "../config/logger.ts";
import { getMasterKey, encryptArtifact } from "./encryption.ts";

export interface ArtifactInput {
  filename: string;
  mime_type?: string;
  data_base64: string;
}

export interface StoredArtifact {
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_mode: "inline" | "disk";
  data: Buffer | null;
  disk_path: string | null;
  encrypted: boolean;
  plaintextData: Buffer | null;
}

export function processArtifact(input: ArtifactInput, userId?: number): StoredArtifact {
  const data = Buffer.from(input.data_base64, "base64");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const mime = input.mime_type || "application/octet-stream";
  const size = data.length;

  let storedData = data;
  let encrypted = false;
  const masterKey = getMasterKey();
  if (masterKey && userId != null) {
    storedData = encryptArtifact(data, masterKey, userId) as Buffer<ArrayBuffer>;
    encrypted = true;
  }

  if (size <= ARTIFACT_SIZE_THRESHOLD) {
    return {
      filename: input.filename,
      mime_type: mime,
      size_bytes: size,
      sha256,
      storage_mode: "inline",
      data: storedData,
      disk_path: null,
      encrypted,
      plaintextData: data,
    };
  }

  // Disk storage
  const prefix = sha256.slice(0, 2);
  const baseDir = encrypted && userId != null
    ? resolve(ARTIFACT_DIR, String(userId), prefix)
    : resolve(ARTIFACT_DIR, prefix);
  const filePath = join(baseDir, sha256);

  if (!existsSync(filePath)) {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(filePath, storedData);
  }

  return {
    filename: input.filename,
    mime_type: mime,
    size_bytes: size,
    sha256,
    storage_mode: "disk",
    data: null,
    disk_path: filePath,
    encrypted,
    plaintextData: data,
  };
}

export function readArtifactFromDisk(diskPath: string): Buffer {
  return readFileSync(diskPath);
}

export function deleteArtifactFromDisk(diskPath: string): void {
  try {
    if (existsSync(diskPath)) {
      unlinkSync(diskPath);
      log.info({ msg: "artifact_disk_deleted", path: diskPath });
    }
  } catch (e: any) {
    log.warn({ msg: "artifact_disk_delete_failed", path: diskPath, error: e.message });
  }
}
