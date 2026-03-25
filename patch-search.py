import sys

with open(sys.argv[1], "r") as f:
    content = f.read()

old = """r.score = rrf * decayBoost * sourceBoost * staticBoost * temporalBoost;

    // Contradiction penalty"""
new = """r.score = rrf * decayBoost * sourceBoost * staticBoost * temporalBoost;

    // PageRank centrality boost (0-15%)
    try {
      const prRow = db.prepare("SELECT COALESCE(pagerank_score, 0) as pr FROM memories WHERE id = ?").get(r.id) as { pr: number } | undefined;
      if (prRow && prRow.pr > 0) r.score *= (1 + prRow.pr * 0.15);
    } catch {}

    // Contradiction penalty"""

if old in content and "PageRank centrality" not in content:
    content = content.replace(old, new, 1)
    with open(sys.argv[1], "w") as f:
        f.write(content)
    print("Search centrality boost: APPLIED")
else:
    print("Search centrality boost: SKIPPED (already applied or pattern not found)")
