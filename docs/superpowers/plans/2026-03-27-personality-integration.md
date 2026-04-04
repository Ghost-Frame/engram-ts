# Personality Profile Auto-Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically inject cached personality profiles into /recall and /context responses so every agent interaction is personality-aware without configuration.

**Architecture:** The personality system already extracts signals during the post_store job pipeline (server-split.ts:180-181) and caches synthesized profiles in the `personality_profiles` table. The profiles are synthesized via LLM on-demand at `POST /profile/synthesize`. This plan adds read-side injection: when `/recall` or `/context` is called, we read the cached profile from SQLite (zero-cost DB read, no LLM call) and include it in the response. If the profile is stale (`is_stale=1`), we still serve it but queue a background re-synthesis job. If no profile exists at all, we skip silently.

**Tech Stack:** Bun + TypeScript, SQLite (better-sqlite3), existing job queue system (`enqueueJob`), node:test for testing.

---

### Task 1: Add `getAnyPersonalityProfile` DB prepared statement

We need a new query that returns the profile regardless of staleness. The existing `getCachedPersonalityProfile` filters `is_stale = 0`, which is correct for the `/profile/synthesize` endpoint (it forces re-synthesis when stale). But for `/recall` and `/context`, we want to serve stale profiles to avoid blocking on LLM calls.

**Files:**
- Modify: `src/db/index.ts:1860-1872`
- Modify: `src/intelligence/personality.ts:214-217`

- [ ] **Step 1:** In `src/db/index.ts`, after the `getCachedPersonalityProfile` statement (line 1862), add a new prepared statement:

```typescript
export const getAnyPersonalityProfile = db.prepare(
  `SELECT profile, is_stale FROM personality_profiles WHERE user_id = ?`
);
```

This returns both the profile text and the staleness flag, regardless of `is_stale` value.

- [ ] **Step 2:** In `src/intelligence/personality.ts`, add a new function after `getCachedProfile` (line 217). Import the new statement and expose a function that returns `{ profile: string; isStale: boolean } | null`:

```typescript
import { ..., getAnyPersonalityProfile } from "../db/index.ts";

export function getProfileForInjection(userId: number): { profile: string; isStale: boolean } | null {
  const row = getAnyPersonalityProfile.get(userId) as { profile: string; is_stale: number } | undefined;
  if (!row) return null;
  return { profile: row.profile, isStale: !!row.is_stale };
}
```

**Verification:** `grep -n "getAnyPersonalityProfile" src/db/index.ts src/intelligence/personality.ts` - should show both files.

---

### Task 2: Register `profile_resynthesize` job handler

When a stale profile is detected during recall/context, we need to queue background re-synthesis without blocking the response. We'll reuse the existing `enqueueJob` + `registerJobHandler` infrastructure.

**Files:**
- Modify: `server-split.ts:137` area (after the post_store handler registration)
- Modify: `src/intelligence/personality.ts` (add dedup guard)

- [ ] **Step 3:** In `server-split.ts`, after the `registerJobHandler("post_store", ...)` block (around line 185-200 area, after the post_store handler closes), add a new job handler:

```typescript
registerJobHandler("profile_resynthesize", async (payload) => {
  const { userId } = payload;
  if (!userId) return;
  try {
    await synthesizePersonalityProfile(userId);
    log.info({ msg: "profile_resynthesized_bg", userId });
  } catch (e: any) {
    log.warn({ msg: "profile_resynthesize_failed", userId, error: e.message });
    throw e; // Let job queue retry
  }
});
```

Import `synthesizePersonalityProfile` - it is already imported in `server-split.ts` at line 89 via `src/intelligence/personality.ts`. Verify that `synthesizePersonalityProfile` is already listed in the import. If not, add it.

- [ ] **Step 4:** In `src/intelligence/personality.ts`, add a helper function `queueResynthesisIfStale` that enqueues the job with dedup (don't queue if a pending job already exists for this user):

```typescript
import { enqueueJob } from "../jobs/index.ts";

const resynthPending = new Set<number>(); // In-process dedup guard

export function queueResynthesisIfStale(userId: number): void {
  if (resynthPending.has(userId)) return;
  resynthPending.add(userId);
  try {
    enqueueJob("profile_resynthesize", { userId }, 2);
  } finally {
    // Clear after 60s to allow re-queuing if the job takes long
    setTimeout(() => resynthPending.delete(userId), 60_000);
  }
}
```

**Verification:** `grep -n "profile_resynthesize" server-split.ts src/intelligence/personality.ts` - should show both registrations.

---

### Task 3: Write failing tests for /recall personality injection

TDD: write the tests first, then implement.

**Files:**
- Modify: `tests/api.test.mjs`

- [ ] **Step 5:** In `tests/api.test.mjs`, add a new describe block after the existing "Recall" describe block (after line 80). Insert before the "Scratchpad" section:

```javascript
// ============================================================================
// PERSONALITY IN RECALL
// ============================================================================
describe("Recall personality injection", () => {
  it("POST /recall response has personality_profile field", async () => {
    const { status, data } = await api("/recall", {
      method: "POST",
      body: { query: "personality test" },
    });
    assert.ok(status === 200 || status === 201, `expected 2xx, got ${status}`);
    // personality_profile should be present (string or null depending on whether signals exist)
    assert.ok("personality_profile" in data, "response should include personality_profile key");
  });
});
```

**Verification:** Run `ENGRAM_URL=http://127.0.0.1:4201 node --test tests/api.test.mjs` - this test should FAIL because `/recall` doesn't return `personality_profile` yet.

---

### Task 4: Inject personality profile into /recall endpoint

**Files:**
- Modify: `src/routes/index.ts:4300-4435` (the /recall handler)

- [ ] **Step 6:** At the top of `src/routes/index.ts`, verify the import from `src/intelligence/personality.ts` at line 100 already includes `getCachedProfile`. Add `getProfileForInjection` and `queueResynthesisIfStale` to that import:

```typescript
import { extractPersonalitySignals, synthesizePersonalityProfile, getCachedProfile, getProfileForInjection, queueResynthesisIfStale } from "../intelligence/personality.ts";
```

- [ ] **Step 7:** In the `/recall` handler, after the `recordUsage` call (line 4402) and before the `return json({` on line 4404, add the personality profile lookup:

```typescript
// Personality profile injection (cached, never blocks on LLM)
let personalityProfile: string | null = null;
try {
  const pp = getProfileForInjection(auth.user_id);
  if (pp) {
    personalityProfile = pp.profile;
    if (pp.isStale) queueResynthesisIfStale(auth.user_id);
  }
} catch {}
```

- [ ] **Step 8:** In the `return json({...})` block (line 4404-4431), add `personality_profile: personalityProfile` after the `working_memory` spread and before `count`:

Change line 4430 from:
```typescript
...(workingMemory ? { working_memory: workingMemory } : {}),
count: sorted.length,
```
to:
```typescript
...(workingMemory ? { working_memory: workingMemory } : {}),
personality_profile: personalityProfile,
count: sorted.length,
```

Note: We always include the key (even when null) so callers can reliably check for it without guessing whether the field exists.

**Verification:** Run `ENGRAM_URL=http://127.0.0.1:4201 node --test tests/api.test.mjs` - the "Recall personality injection" test should now PASS.

---

### Task 5: Write failing tests for /context personality injection

**Files:**
- Modify: `tests/api.test.mjs`

- [ ] **Step 9:** In `tests/api.test.mjs`, add a new describe block after the "Recall personality injection" block:

```javascript
// ============================================================================
// PERSONALITY IN CONTEXT
// ============================================================================
describe("Context personality injection", () => {
  it("POST /context at depth 2+ includes personality in breakdown", async () => {
    const { status, data } = await api("/context", {
      method: "POST",
      body: { query: "personality context test", depth: 2, max_tokens: 4000 },
    });
    assert.ok(status === 200 || status === 201, `expected 2xx, got ${status}`);
    // breakdown should have a personality key
    assert.ok("personality" in data.breakdown, "breakdown should include personality count");
  });

  it("POST /context at depth 1 does NOT include personality", async () => {
    const { status, data } = await api("/context", {
      method: "POST",
      body: { query: "personality context test", depth: 1, max_tokens: 2000 },
    });
    assert.ok(status === 200 || status === 201, `expected 2xx, got ${status}`);
    // At depth 1, personality should not be included
    assert.equal(data.breakdown.personality, 0, "depth 1 should have 0 personality blocks");
  });
});
```

**Verification:** Run tests - both should FAIL.

---

### Task 6: Inject personality profile into /context endpoint

**Files:**
- Modify: `src/routes/index.ts:2473-2966` (the /context handler)

- [ ] **Step 10:** In the `/context` handler, after the depth/layer toggle declarations (around line 2544), add a personality toggle. Insert after the `doIncludeWorkingMemory` line (2544):

```typescript
const doIncludePersonality = depth >= 2;
```

- [ ] **Step 11:** In the context assembly section (after `doIncludeCurrentState` block which ends around line 2849, and before the `doIncludePreferences` block at line 2852), inject the personality profile. Place it here so agents read personality before preferences/memories. Insert between lines 2849 and 2851:

```typescript
// Intelligence Layer: Personality Profile
let personalityBlockTokens = 0;
if (doIncludePersonality) {
  try {
    const pp = getProfileForInjection(auth.user_id);
    if (pp) {
      if (pp.isStale) queueResynthesisIfStale(auth.user_id);
      const profileText = pp.profile;
      const tokens = estimateTokens(profileText);
      // Cap personality at 10% of budget to leave room for memories
      if (tokens <= tokenBudget * 0.10) {
        contextParts.push("## Personality\n" + profileText);
        personalityBlockTokens = tokens;
        usedTokens += tokens;
      }
    }
  } catch {}
}
```

- [ ] **Step 12:** In the response JSON (around line 2956-2964), add `personality` to the breakdown object. Change:

```typescript
breakdown: {
  static: staticBlocks.length,
  semantic: semanticBlocks.length,
  evolution: evolutionBlocks.length,
  episode: episodeBlocks.length,
  linked: linkedBlocks.length,
  recent: recentBlocks.length,
  inference: inferenceBlocks.length,
},
```

to:

```typescript
breakdown: {
  static: staticBlocks.length,
  semantic: semanticBlocks.length,
  evolution: evolutionBlocks.length,
  episode: episodeBlocks.length,
  linked: linkedBlocks.length,
  recent: recentBlocks.length,
  inference: inferenceBlocks.length,
  personality: personalityBlockTokens > 0 ? 1 : 0,
},
```

**Verification:** Run tests - both context personality tests should PASS.

---

### Task 7: Update MCP tool to surface personality in memory_recall

The MCP `memory_recall` handler currently only formats memories. It should also pass through the personality_profile string if present.

**Files:**
- Modify: `mcp-server.ts:377-388`

- [ ] **Step 13:** In the `memory_recall` case (mcp-server.ts, around line 377-388), after formatting the memories text, append the personality profile if it exists in the response. Change:

```typescript
case "memory_recall": {
  const result = await engram("/recall", "POST", {
    query: args!.query,
    limit: args!.limit ?? 10,
  });
  const memories: any[] = result.memories ?? [];
  if (memories.length === 0) return { content: [{ type: "text", text: "No memories found." }] };
  const text = memories
    .map((m) => `[${m.category}] (id:${m.id}, source:${m.source ?? "unknown"}) ${m.content}`)
    .join("\n\n");
  return { content: [{ type: "text", text }] };
}
```

to:

```typescript
case "memory_recall": {
  const result = await engram("/recall", "POST", {
    query: args!.query,
    limit: args!.limit ?? 10,
  });
  const memories: any[] = result.memories ?? [];
  if (memories.length === 0) return { content: [{ type: "text", text: "No memories found." }] };
  let text = memories
    .map((m) => `[${m.category}] (id:${m.id}, source:${m.source ?? "unknown"}) ${m.content}`)
    .join("\n\n");
  if (result.personality_profile) {
    text = `## Personality\n${result.personality_profile}\n\n---\n\n${text}`;
  }
  return { content: [{ type: "text", text }] };
}
```

**Verification:** The MCP `memory_context` tool already passes through `result.context` which will now include the `## Personality` section. No changes needed for `memory_context`. Verify by searching the output: `grep -n "memory_context" mcp-server.ts` - it returns `result.context` which is the assembled string.

---

### Task 8: Run full test suite and verify

- [ ] **Step 14:** Run the complete test suite:

```bash
ENGRAM_URL=http://127.0.0.1:4201 node --test tests/api.test.mjs
```

All existing tests must pass. The new personality tests should pass (they check for the key's existence; the profile value will be null if no signals have been extracted yet, which is fine - the key is always present).

- [ ] **Step 15:** Manual integration test - curl the endpoints directly to verify the shape:

```bash
# Recall
curl -s http://127.0.0.1:4200/recall -X POST -H "Authorization: Bearer $ENGRAM_API_KEY" -H "Content-Type: application/json" -d '{"query":"test"}' | jq '.personality_profile'

# Context at depth 2
curl -s http://127.0.0.1:4200/context -X POST -H "Authorization: Bearer $ENGRAM_API_KEY" -H "Content-Type: application/json" -d '{"query":"test","depth":2}' | jq '.breakdown.personality'

# Context at depth 1 (should be 0)
curl -s http://127.0.0.1:4200/context -X POST -H "Authorization: Bearer $ENGRAM_API_KEY" -H "Content-Type: application/json" -d '{"query":"test","depth":1}' | jq '.breakdown.personality'
```

- [ ] **Step 16:** Commit all changes:

```bash
git add src/db/index.ts src/intelligence/personality.ts src/routes/index.ts server-split.ts mcp-server.ts tests/api.test.mjs
git commit -m "feat: auto-inject personality profile into /recall and /context responses"
```

---

## Summary of Changes

| File | Lines | Change |
|------|-------|--------|
| `src/db/index.ts` | ~1862 | Add `getAnyPersonalityProfile` prepared statement |
| `src/intelligence/personality.ts` | ~217 | Add `getProfileForInjection()` and `queueResynthesisIfStale()` |
| `server-split.ts` | ~185 | Register `profile_resynthesize` job handler |
| `src/routes/index.ts` | ~100 | Update import to include new functions |
| `src/routes/index.ts` | ~4402-4430 | Inject personality into /recall response |
| `src/routes/index.ts` | ~2544, ~2849, ~2956 | Inject personality into /context response |
| `mcp-server.ts` | ~377-388 | Surface personality in MCP memory_recall output |
| `tests/api.test.mjs` | ~80 | Add personality injection tests |

**Total new code:** ~60 lines of implementation, ~30 lines of tests.

**Zero breaking changes:** All existing response fields unchanged. `personality_profile` is additive in /recall. `personality` count is additive in /context breakdown. The `## Personality` section is a new context section that naturally integrates with existing sections.

**Performance impact:** One synchronous SQLite read per recall/context call (sub-millisecond). No LLM calls on the hot path. Background re-synthesis is fire-and-forget via the existing job queue.
