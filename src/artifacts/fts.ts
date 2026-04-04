import { ARTIFACT_FTS_MAX_SIZE } from "../config/index.ts";
import { insertArtifactFTS, markArtifactIndexed } from "../db/index.ts";
import { log } from "../config/logger.ts";

const INDEXABLE_APP_TYPES = new Set([
  "application/json",
  "application/yaml",
  "application/x-yaml",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/toml",
  "application/x-sh",
  "application/x-python",
]);

export function isIndexableMimeType(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  return INDEXABLE_APP_TYPES.has(mime);
}

export function indexArtifact(artifactId: number, mimeType: string, data: Buffer): boolean {
  if (!isIndexableMimeType(mimeType)) return false;

  try {
    const text = data.subarray(0, ARTIFACT_FTS_MAX_SIZE).toString("utf-8");
    if (!text.trim()) return false;

    insertArtifactFTS.run(artifactId, text);
    markArtifactIndexed.run(artifactId);
    return true;
  } catch (e: any) {
    log.warn({ msg: "artifact_fts_index_failed", artifact_id: artifactId, error: e.message });
    return false;
  }
}
