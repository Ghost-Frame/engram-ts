import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { ARTIFACT_DIR, ARTIFACT_SIZE_THRESHOLD } from "../config/index.ts";
import { log } from "../config/logger.ts";

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
}

export function processArtifact(input: ArtifactInput): StoredArtifact {
  const data = Buffer.from(input.data_base64, "base64");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const mime = input.mime_type || "application/octet-stream";
  const size = data.length;

  if (size <= ARTIFACT_SIZE_THRESHOLD) {
    return {
      filename: input.filename,
      mime_type: mime,
      size_bytes: size,
      sha256,
      storage_mode: "inline",
      data,
      disk_path: null,
    };
  }

  // Disk storage
  const prefix = sha256.slice(0, 2);
  const dir = resolve(ARTIFACT_DIR, prefix);
  const filePath = join(dir, sha256);

  if (!existsSync(filePath)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, data);
  }

  return {
    filename: input.filename,
    mime_type: mime,
    size_bytes: size,
    sha256,
    storage_mode: "disk",
    data: null,
    disk_path: filePath,
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
