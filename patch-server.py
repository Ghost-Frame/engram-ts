import sys

with open(sys.argv[1], "r") as f:
    content = f.read()

old = """  await extractPersonalitySignals(content, memoryId, userId);
});"""
new = """  await extractPersonalitySignals(content, memoryId, userId);

  // 5. Community detection + PageRank (throttled: every 25th memory)
  try {
    const memCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM memories WHERE user_id = ? AND is_forgotten = 0"
    ).get(userId) as { cnt: number };
    if (memCount.cnt > 0 && memCount.cnt % 25 === 0) {
      const { detectCommunities } = await import("./src/graph/communities.ts");
      detectCommunities(userId);
      const { updatePageRankScores } = await import("./src/graph/pagerank.ts");
      updatePageRankScores(userId);
      log.info({ msg: "post_store_graph_analysis", memory_id: memoryId, total_memories: memCount.cnt });
    }
  } catch (e: any) {
    log.warn({ msg: "post_store_graph_analysis_failed", error: e.message });
  }
});"""

if old in content and "post_store_graph_analysis" not in content:
    content = content.replace(old, new, 1)
    with open(sys.argv[1], "w") as f:
        f.write(content)
    print("Auto graph analysis: APPLIED")
else:
    print("Auto graph analysis: SKIPPED (already applied or pattern not found)")
