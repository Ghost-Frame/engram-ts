import sys

with open(sys.argv[1], "r") as f:
    content = f.read()

patches = 0

# 1. Add community_id + pagerank_score to SELECT in /graph handler
old1 = """SELECT id, content, category, source, importance, confidence, created_at,
                    is_static, is_forgotten, is_archived, parent_memory_id, source_count,
                    version, forget_after"""
new1 = """SELECT id, content, category, source, importance, confidence, created_at,
                    is_static, is_forgotten, is_archived, parent_memory_id, source_count,
                    version, forget_after, community_id, pagerank_score"""
if old1 in content and "pagerank_score" not in content.split(old1)[0]:
    content = content.replace(old1, new1, 1)
    patches += 1
    print("PATCH 1: SELECT columns - OK")
else:
    print("PATCH 1: SELECT columns - SKIPPED")

# 2. Add community_id + pagerank to node object
old2 = "confidence: mem.confidence, group: mem.category,"
new2 = """confidence: mem.confidence, group: mem.community_id ?? mem.category,
            community_id: mem.community_id, pagerank_score: mem.pagerank_score,"""
if old2 in content:
    content = content.replace(old2, new2, 1)
    patches += 1
    print("PATCH 2: Node object fields - OK")
else:
    print("PATCH 2: Node object fields - SKIPPED")

# 3. Boost node size by pagerank
old3 = "size: Math.max(3, (mem.importance || 5) * 1.5),"
new3 = "size: Math.max(3, (mem.importance || 5) * 1.5 + (mem.pagerank_score || 0) * 3),"
if old3 in content:
    content = content.replace(old3, new3, 1)
    patches += 1
    print("PATCH 3: Node size boost - OK")
else:
    print("PATCH 3: Node size boost - SKIPPED")

# 4. Add /graph/timeline endpoint
marker = "        // Graph visualization page"
if marker in content and "/graph/timeline" not in content:
    timeline_code = '''
    // Temporal graph evolution: weekly aggregates of graph growth
    if (url.pathname === "/graph/timeline" && method === "GET") {
      try {
        const weeks = db.prepare(`
          SELECT strftime('%Y-%W', created_at) as week,
                 MIN(created_at) as week_start,
                 COUNT(*) as new_memories
          FROM memories
          WHERE user_id = ? AND is_forgotten = 0 AND is_archived = 0 AND is_latest = 1
          GROUP BY week ORDER BY week ASC
        `).all(auth.user_id) as any[];

        const edgeWeeks = db.prepare(`
          SELECT strftime('%Y-%W', ml.created_at) as week, COUNT(*) as new_links
          FROM memory_links ml
          JOIN memories m ON m.id = ml.source_id
          WHERE m.user_id = ?
          GROUP BY week ORDER BY week ASC
        `).all(auth.user_id) as any[];

        const edgeMap: Record<string, number> = {};
        let edgeTotal = 0;
        for (const w of edgeWeeks) { edgeTotal += w.new_links; edgeMap[w.week] = edgeTotal; }

        let memTotal = 0;
        const timeline = weeks.map((w: any) => {
          memTotal += w.new_memories;
          return {
            week: w.week, week_start: w.week_start,
            new_memories: w.new_memories, total_memories: memTotal,
            total_links: edgeMap[w.week] || 0,
          };
        });
        return json({ timeline, total_memories: memTotal, total_links: edgeTotal });
      } catch (e: any) {
        return safeError("Timeline", e);
      }
    }

'''
    content = content.replace(marker, timeline_code + marker, 1)
    patches += 1
    print("PATCH 4: /graph/timeline endpoint - OK")
else:
    print("PATCH 4: /graph/timeline - SKIPPED")

with open(sys.argv[1], "w") as f:
    f.write(content)

print(f"\nDone: {patches} patches applied")
