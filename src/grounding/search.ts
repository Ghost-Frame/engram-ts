// ============================================================================
// SEARCH TOOLS - Coordinated search across providers
// Ported from OpenSpace grounding/core/search_tools.py (simplified)
// ============================================================================

import { log } from "../config/logger.ts";
import type { GroundingProvider, ToolResult } from "./types.ts";

export interface SearchResult {
  source: string;
  title: string;
  content: string;
  url?: string;
  score: number;
  metadata?: Record<string, any>;
}

export interface SearchProvider {
  name: string;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

/**
 * SearchCoordinator aggregates search results across multiple providers,
 * deduplicates, and ranks results.
 */
export class SearchCoordinator {
  private providers: SearchProvider[] = [];

  registerProvider(provider: SearchProvider): void {
    this.providers.push(provider);
    log.info({ msg: "search_provider_registered", name: provider.name });
  }

  /**
   * Search across all providers, merge and deduplicate results.
   */
  async search(query: string, limit: number = 10): Promise<SearchResult[]> {
    if (this.providers.length === 0) {
      return [];
    }

    // Fan out to all providers
    const promises = this.providers.map(async (provider) => {
      try {
        const results = await provider.search(query, limit);
        return results.map(r => ({ ...r, source: provider.name }));
      } catch (e: any) {
        log.warn({ msg: "search_provider_failed", provider: provider.name, error: e.message });
        return [];
      }
    });

    const allResults = (await Promise.all(promises)).flat();

    // Deduplicate by URL or content hash
    const seen = new Set<string>();
    const deduped: SearchResult[] = [];
    for (const result of allResults) {
      const key = result.url || result.content.slice(0, 100);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(result);
    }

    // Sort by score descending
    deduped.sort((a, b) => b.score - a.score);

    return deduped.slice(0, limit);
  }

  listProviders(): string[] {
    return this.providers.map(p => p.name);
  }
}

// --- Built-in: File search provider (grep-based) ---

export class FileSearchProvider implements SearchProvider {
  name = "file_search";
  private baseDirs: string[];

  constructor(baseDirs: string[] = []) {
    this.baseDirs = baseDirs;
  }

  async search(query: string, limit: number): Promise<SearchResult[]> {
    // Simple grep-based file search
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    const results: SearchResult[] = [];
    const escapedQuery = query.replace(/['"\\]/g, "\\$&");

    for (const dir of this.baseDirs) {
      try {
        const isWin = process.platform === "win32";
        const cmd = isWin
          ? `findstr /s /i /n "${escapedQuery}" "${dir}\\*"`
          : `grep -r -i -n -l "${escapedQuery}" "${dir}" 2>/dev/null | head -${limit}`;

        const { stdout } = await execAsync(cmd, { timeout: 10000, maxBuffer: 50000 });
        const lines = stdout.trim().split("\n").filter(Boolean);

        for (const line of lines.slice(0, limit)) {
          results.push({
            source: "file_search",
            title: line.split(":")[0] || line,
            content: line,
            score: 0.5,
          });
        }
      } catch { /* grep returns non-zero if no matches */ }
    }

    return results.slice(0, limit);
  }
}
