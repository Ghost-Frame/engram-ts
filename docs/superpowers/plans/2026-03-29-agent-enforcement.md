# Agent Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Force all agents to register with Axon on spawn, store at least one memory to Engram before completing, and provide a non-blank summary when closing a Chiasm task.

**Architecture:** Three enforcement layers  -  Eidolon gate blocks task completion if no Engram stores recorded this session and adds Axon auto-registration on spawn; Chiasm hard-rejects blank summaries at the HTTP layer; Claude Code session-end hook guarantees at least one Engram store and a non-blank Chiasm completion on session exit.

**Tech Stack:** Rust (Eidolon daemon at `~/eidolon/eidolon-daemon/` on Rocky), TypeScript/Bun (Chiasm at `C:\Users\Zan\Projects\chiasm\`), Bash (Claude Code hooks at `C:\Users\Zan\.claude\hooks\`)

---

## File Map

| File | Change |
|------|--------|
| `~/eidolon/eidolon-daemon/src/session.rs` | Add `engram_stores: usize` field to Session struct |
| `~/eidolon/eidolon-daemon/src/routes/gate.rs` | Track Engram store calls; add `gate_complete()` handler |
| `~/eidolon/eidolon-daemon/src/routes/mod.rs` | Export new `gate_complete` handler |
| `~/eidolon/eidolon-daemon/src/server.rs` | Add `POST /gate/complete` route |
| `~/eidolon/eidolon-daemon/src/routes/tasks.rs` | Publish `agent.online` to Axon after session spawn |
| `C:\Users\Zan\Projects\chiasm\src\routes\tasks.ts` | Hard 400 on blank summary when status=completed |
| `C:\Users\Zan\.claude\hooks\session-end.sh` | New hook: store to Engram, publish Axon, complete Chiasm task |
| `C:\Users\Zan\.claude\settings.json` | Add SessionEnd hook entry |

---

## Task 1: Add engram_stores counter to Eidolon Session

**Files:**
- Modify: `~/eidolon/eidolon-daemon/src/session.rs`

- [ ] **Step 1: Add field to Session struct**

SSH to Rocky: `ssh rocky`

Open `~/eidolon/eidolon-daemon/src/session.rs`. Find the `Session` struct. Add `pub engram_stores: usize,` after the `corrections` field:

```rust
pub struct Session {
    pub id: String,
    pub task: String,
    pub agent: String,
    pub model: String,
    pub status: SessionStatus,
    pub created_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub output_buffer: Vec<String>,
    pub output_tx: broadcast::Sender<String>,
    pub exit_code: Option<i32>,
    pub pid: Option<u32>,
    pub corrections: usize,
    pub engram_stores: usize,  // tracks stores this session
    pub error: Option<String>,
}
```

- [ ] **Step 2: Initialize to 0 in Session::new()**

In `Session::new()`, add `engram_stores: 0,` after `corrections: 0,`:

```rust
pub fn new(task: String, agent: String, model: String) -> Self {
    let (tx, _) = broadcast::channel(1024);
    Session {
        id: Uuid::new_v4().to_string(),
        task,
        agent,
        model,
        status: SessionStatus::Pending,
        created_at: Utc::now(),
        ended_at: None,
        output_buffer: Vec::new(),
        output_tx: tx,
        exit_code: None,
        pid: None,
        corrections: 0,
        engram_stores: 0,
        error: None,
    }
}
```

- [ ] **Step 3: Expose in to_json()**

In `Session::to_json()`, add `"engram_stores": self.engram_stores,`:

```rust
pub fn to_json(&self) -> serde_json::Value {
    serde_json::json!({
        "id": self.id,
        "task": self.task,
        "agent": self.agent,
        "model": self.model,
        "status": self.status,
        "created_at": self.created_at.to_rfc3339(),
        "ended_at": self.ended_at.map(|t| t.to_rfc3339()),
        "exit_code": self.exit_code,
        "corrections": self.corrections,
        "engram_stores": self.engram_stores,
        "error": self.error,
    })
}
```

- [ ] **Step 4: Verify it compiles**

```bash
ssh rocky "cd ~/eidolon && cargo check 2>&1 | tail -5"
```

Expected: no errors related to session.rs

- [ ] **Step 5: Commit**

```bash
ssh rocky "cd ~/eidolon && git add eidolon-daemon/src/session.rs && git commit -m 'feat: track engram_stores count per session'"
```

---

## Task 2: Track Engram store calls in the gate

**Files:**
- Modify: `~/eidolon/eidolon-daemon/src/routes/gate.rs`

- [ ] **Step 1: Locate the gate_check function on Rocky**

```bash
ssh rocky "grep -n 'pub async fn gate_check\|session_id\|tool_name' ~/eidolon/eidolon-daemon/src/routes/gate.rs | head -20"
```

Note the line numbers for where `tool_name` and `session_id` are extracted.

- [ ] **Step 2: Add Engram store tracking after session_id is extracted**

Find the section in `gate_check` where `session_id` and `tool_name` are extracted. Add this block immediately after (before the read-only fast path):

```rust
// Track Engram store calls for session enforcement
let is_engram_store =
    (tool_name == "Bash" && (
        command.contains("engram-cli store") ||
        command.contains("/store") && command.contains(&state.config.engram.url.as_str().split("//").last().unwrap_or(""))
    )) ||
    (tool_name.starts_with("mcp__") && tool_name.contains("store"));

if is_engram_store && session_id != "unknown" {
    let mut sessions = state.sessions.lock().await;
    if let Some(session) = sessions.get_session_mut(session_id) {
        session.engram_stores += 1;
        tracing::info!(
            "gate: engram store tracked session={} total={}",
            session_id, session.engram_stores
        );
    }
}
```

- [ ] **Step 3: Verify it compiles**

```bash
ssh rocky "cd ~/eidolon && cargo check 2>&1 | tail -5"
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
ssh rocky "cd ~/eidolon && git add eidolon-daemon/src/routes/gate.rs && git commit -m 'feat: track engram store calls per session in gate'"
```

---

## Task 3: Add gate/complete endpoint to Eidolon

This endpoint is what agents (and the session-end hook) call before completing a Chiasm task. It validates: session exists, engram_stores > 0, summary non-empty.

**Files:**
- Modify: `~/eidolon/eidolon-daemon/src/routes/gate.rs`
- Modify: `~/eidolon/eidolon-daemon/src/routes/mod.rs`
- Modify: `~/eidolon/eidolon-daemon/src/server.rs`

- [ ] **Step 1: Add CompleteRequest struct and gate_complete handler to gate.rs**

Add at the bottom of `gate.rs`:

```rust
#[derive(serde::Deserialize)]
pub struct CompleteRequest {
    pub session_id: String,
    pub summary: String,
}

pub async fn gate_complete(
    State(state): State<Arc<AppState>>,
    Json(input): Json<CompleteRequest>,
) -> Json<Value> {
    let summary = input.summary.trim().to_string();

    if summary.is_empty() {
        tracing::warn!("gate/complete: blocked -- blank summary session={}", input.session_id);
        return Json(json!({
            "allowed": false,
            "reason": "Summary is required before completing a task -- store what you did"
        }));
    }

    let sessions = state.sessions.lock().await;
    match sessions.get_session(&input.session_id) {
        None => {
            tracing::warn!("gate/complete: blocked -- session not found id={}", input.session_id);
            Json(json!({
                "allowed": false,
                "reason": format!("Session '{}' not found -- register with Eidolon before starting work", input.session_id)
            }))
        }
        Some(session) => {
            if session.engram_stores == 0 {
                tracing::warn!(
                    "gate/complete: blocked -- no engram stores session={} agent={}",
                    input.session_id, session.agent
                );
                Json(json!({
                    "allowed": false,
                    "reason": "No Engram stores this session -- store at least one memory before completing"
                }))
            } else {
                tracing::info!(
                    "gate/complete: allowed session={} agent={} stores={}",
                    input.session_id, session.agent, session.engram_stores
                );
                Json(json!({
                    "allowed": true,
                    "reason": format!("{} engram store(s) recorded", session.engram_stores)
                }))
            }
        }
    }
}
```

- [ ] **Step 2: Export gate_complete from routes/mod.rs**

In `~/eidolon/eidolon-daemon/src/routes/mod.rs`, ensure `gate` module exports `gate_complete`:

```rust
pub mod brain;
pub mod gate;
pub mod sessions;
pub mod tasks;
```

The `gate_complete` function is public (`pub async fn`) so it's accessible as `routes::gate::gate_complete`.

- [ ] **Step 3: Register route in server.rs**

In `build_router()` in `server.rs`, add the new route alongside the existing `/gate/check`:

```rust
.route("/gate/check", post(routes::gate::gate_check))
.route("/gate/complete", post(routes::gate::gate_complete))
```

- [ ] **Step 4: Verify it compiles**

```bash
ssh rocky "cd ~/eidolon && cargo check 2>&1 | tail -10"
```

Expected: no errors

- [ ] **Step 5: Build and test the endpoint**

```bash
ssh rocky "cd ~/eidolon && cargo build --release 2>&1 | tail -5"
```

Test with a blank summary (should return allowed: false):
```bash
ssh rocky "curl -s -X POST http://localhost:7701/gate/complete \
  -H 'Authorization: Bearer \$(cat ~/.config/eidolon/config.toml | grep api_key | head -1 | cut -d'\"' -f2)' \
  -H 'Content-Type: application/json' \
  -d '{\"session_id\": \"test\", \"summary\": \"\"}'"
```

Expected:
```json
{"allowed": false, "reason": "Summary is required before completing a task -- store what you did"}
```

- [ ] **Step 6: Restart and verify**

```bash
ssh rocky "sudo systemctl restart eidolon-daemon && sleep 2 && systemctl is-active eidolon-daemon"
```

Expected: `active`

- [ ] **Step 7: Commit**

```bash
ssh rocky "cd ~/eidolon && git add eidolon-daemon/src/routes/gate.rs eidolon-daemon/src/server.rs && git commit -m 'feat: add gate/complete endpoint for task completion enforcement'"
```

---

## Task 4: Axon auto-registration on agent spawn

**Files:**
- Modify: `~/eidolon/eidolon-daemon/src/routes/tasks.rs`

- [ ] **Step 1: Find the session creation point in tasks.rs**

```bash
ssh rocky "grep -n 'create_session\|SessionManager\|spawn\|submit_task' ~/eidolon/eidolon-daemon/src/routes/tasks.rs | head -20"
```

Note the line after the session is created and before the task is spawned.

- [ ] **Step 2: Add Axon publish after session creation**

After the session is created (after `sessions.create_session(...)` or equivalent), add:

```rust
// Auto-register agent with Axon
{
    let axon_url = format!("{}/axon/events", state.config.engram.url);
    let axon_key = state.config.engram.api_key.clone().unwrap_or_default();
    let agent_name = session_agent.clone(); // use whatever variable holds the agent name
    let session_id_axon = session_id.clone();
    let http = state.http_client.clone();
    tokio::spawn(async move {
        let _ = http
            .post(&axon_url)
            .header("Authorization", format!("Bearer {}", axon_key))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "type": "agent.online",
                "channel": "system",
                "source": agent_name,
                "payload": {
                    "session_id": session_id_axon
                }
            }))
            .send()
            .await;
    });
}
```

> Note: Replace `session_agent` and `session_id` with the actual variable names in the existing code. Run `grep -n 'agent\|session_id' ~/eidolon/eidolon-daemon/src/routes/tasks.rs | head -30` to find them.

- [ ] **Step 3: Verify it compiles**

```bash
ssh rocky "cd ~/eidolon && cargo check 2>&1 | tail -10"
```

- [ ] **Step 4: Build, restart, test**

```bash
ssh rocky "cd ~/eidolon && cargo build --release && sudo systemctl restart eidolon-daemon && sleep 2 && systemctl is-active eidolon-daemon"
```

Submit a test task and check Axon for the agent.online event:
```bash
ENGRAM_URL=http://<server-ip>:4200
ENGRAM_API_KEY=$(cat ~/.engram/config.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('apiKey',''))")

curl -s "$ENGRAM_URL/axon/events?limit=5" \
  -H "Authorization: Bearer $ENGRAM_API_KEY" | python3 -c "
import sys, json
events = json.load(sys.stdin)
for e in events:
    if e.get('type') == 'agent.online':
        print('FOUND:', e)
        break
else:
    print('NOT FOUND -- check logs')
"
```

- [ ] **Step 5: Commit**

```bash
ssh rocky "cd ~/eidolon && git add eidolon-daemon/src/routes/tasks.rs && git commit -m 'feat: auto-register agent with Axon on session spawn'"
```

---

## Task 5: Deploy Eidolon to the production host

The same binary runs on both Rocky (7701) and the production host (7700). After tasks 1-4 pass on Rocky, deploy to the production host.

**Files:**
- `~/eidolon/` on Rocky (build source)
- `/usr/local/bin/eidolon-daemon` on `<deployment-host>` (deployment target)

- [ ] **Step 1: Build release binary on Rocky**

```bash
ssh rocky "cd ~/eidolon && cargo build --release 2>&1 | tail -5"
```

Expected: `Compiling eidolon-daemon` ... `Finished release`

- [ ] **Step 2: Copy binary to the production host**

```bash
ssh rocky "scp ~/eidolon/target/release/eidolon-daemon <deployment-host>:/tmp/eidolon-daemon-new"
```

- [ ] **Step 3: Install and restart on the production host**

```bash
ssh <deployment-host> "sudo cp /tmp/eidolon-daemon-new /usr/local/bin/eidolon-daemon && sudo chmod +x /usr/local/bin/eidolon-daemon && sudo systemctl restart eidolon-daemon && sleep 2 && systemctl is-active eidolon-daemon"
```

Expected: `active`

- [ ] **Step 4: Verify gate/complete is live on the production host**

```bash
EIDOLON_KEY=$(~/.local/bin/cred get eidolon production --field key --raw 2>/dev/null || echo "")
curl -s -X POST http://<server-ip>:7700/gate/complete \
  -H "Authorization: Bearer $EIDOLON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "test", "summary": ""}'
```

Expected: `{"allowed":false,"reason":"Summary is required..."}`

---

## Task 6: Chiasm - Hard reject blank summary on completion

**Files:**
- Modify: `C:\Users\Zan\Projects\chiasm\src\routes\tasks.ts`

- [ ] **Step 1: Find the PATCH handler in tasks.ts**

```bash
grep -n "PATCH\|status.*completed\|summary" C:\Users\Zan\Projects\chiasm\src\routes\tasks.ts | head -20
```

Find the section that processes `PATCH /tasks/:id` and where `body.status` is handled.

- [ ] **Step 2: Add validation before the database update**

In the PATCH handler, after the body is parsed and before the SQL update, add:

```typescript
// Hard reject: completing a task requires a non-blank summary
if (body.status === "completed") {
  const summary = (body.summary ?? "").trim();
  if (!summary) {
    return error(res, 400, "summary is required when completing a task -- document what you did");
  }
}
```

- [ ] **Step 3: Test locally**

Start Chiasm locally if possible, or test against the running instance:

```bash
# Should return 400
curl -s -X PATCH "$CHIASM_URL/tasks/1" \
  -H "Authorization: Bearer $CHIASM_KEY_CLAUDE" \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(d)"
```

Expected: `{"error": "summary is required when completing a task - document what you did"}`

```bash
# Should return 200 (or 404 if task 1 doesn't exist -- that's fine, means validation passed)
curl -s -X PATCH "$CHIASM_URL/tasks/1" \
  -H "Authorization: Bearer $CHIASM_KEY_CLAUDE" \
  -H "Content-Type: application/json" \
  -d '{"status": "completed", "summary": "fixed the thing"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(d)"
```

Expected: task object or 404 (not 400)

- [ ] **Step 4: Commit**

```bash
cd C:\Users\Zan\Projects\chiasm
git add src/routes/tasks.ts
git commit -m "feat: require non-blank summary when completing tasks"
```

- [ ] **Step 5: Deploy to the production host**

```bash
ssh <deployment-host> "cd ~/chiasm && git pull && bun install && sudo systemctl restart chiasm && sleep 2 && systemctl is-active chiasm"
```

> Note: Adjust the deploy command to match the actual Chiasm deployment setup on the production host (check `systemctl cat chiasm` if unsure).

---

## Task 7: Claude Code session-end hook

**Files:**
- Create: `C:\Users\Zan\.claude\hooks\session-end.sh`
- Modify: `C:\Users\Zan\.claude\settings.json`

- [ ] **Step 1: Create session-end.sh**

Create `C:\Users\Zan\.claude\hooks\session-end.sh`:

```bash
#!/usr/bin/env bash
# session-end.sh - Fires on Claude Code SessionEnd
# Guarantees: at least one Engram store, Axon session.ended event, Chiasm task completed

set -uo pipefail

# Read hook event data from stdin
INPUT=$(cat 2>/dev/null || echo "{}")

# Get session ID from hook input (Claude Code provides this)
SESSION_ID=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('session_id', d.get('sessionId', 'unknown')))
except:
    print('unknown')
" 2>/dev/null || echo "unknown")

# Get Chiasm task ID registered at session start
CHIASM_TASK_ID=$(cat /tmp/chiasm-claude-task-id 2>/dev/null || echo "")

# Build a summary from recent Engram context (best-effort)
SUMMARY=$(~/.local/bin/engram-cli recall --limit 3 --json 2>/dev/null | python3 -c "
import sys, json
try:
    memories = json.load(sys.stdin)
    if memories:
        contents = [m.get('content','') for m in memories[:3]]
        print('Session ended. Recent work: ' + ' | '.join(c[:80] for c in contents if c))
    else:
        print('Claude Code session ended')
except:
    print('Claude Code session ended')
" 2>/dev/null || echo "Claude Code session ended")

# 1. Store session end to Engram (creates the required store for enforcement)
if [ -n "${ENGRAM_URL:-}" ] && [ -n "${ENGRAM_API_KEY:-}" ]; then
    curl -sf "${ENGRAM_URL}/store" \
        -X POST \
        -H "Authorization: Bearer ${ENGRAM_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "{\"content\": \"${SUMMARY//\"/\\\"}\", \"category\": \"task\", \"source\": \"claude-code\"}" \
        > /dev/null 2>&1 || true
fi

# 2. Publish Axon session.ended event
if [ -n "${ENGRAM_URL:-}" ] && [ -n "${ENGRAM_API_KEY:-}" ]; then
    curl -sf "${ENGRAM_URL}/axon/events" \
        -X POST \
        -H "Authorization: Bearer ${ENGRAM_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "{\"type\": \"session.ended\", \"channel\": \"system\", \"source\": \"claude-code\", \"payload\": {\"session_id\": \"${SESSION_ID}\"}}" \
        > /dev/null 2>&1 || true
fi

# 3. Complete Chiasm task with summary
if [ -n "${CHIASM_TASK_ID}" ] && [ -n "${CHIASM_URL:-}" ] && [ -n "${CHIASM_KEY_CLAUDE:-}" ]; then
    curl -sf "${CHIASM_URL}/tasks/${CHIASM_TASK_ID}" \
        -X PATCH \
        -H "Authorization: Bearer ${CHIASM_KEY_CLAUDE}" \
        -H "Content-Type: application/json" \
        -d "{\"status\": \"completed\", \"summary\": \"${SUMMARY//\"/\\\"}\"}" \
        > /dev/null 2>&1 || true
    rm -f /tmp/chiasm-claude-task-id
fi

exit 0
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x "C:\Users\Zan\.claude\hooks\session-end.sh"
```

On Windows in bash:
```bash
chmod +x /c/Users/Zan/.claude/hooks/session-end.sh
```

- [ ] **Step 3: Add SessionEnd hook to settings.json**

Open `C:\Users\Zan\.claude\settings.json`. Find the `"hooks"` array. Add a new entry alongside the existing SessionStart entry:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "C:\\Users\\Zan\\.claude\\hooks\\session-start-engram.sh",
            "timeout": 15000
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "C:\\Users\\Zan\\.claude\\hooks\\session-end.sh",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

> Note: Match the exact JSON structure already used in settings.json for SessionStart. The key format may differ  -  check the existing entries and mirror them exactly.

- [ ] **Step 4: Verify hook fires**

Start a new Claude Code session and immediately exit. Check:

```bash
# Axon should have a session.ended event
curl -s "$ENGRAM_URL/axon/events?limit=5" \
  -H "Authorization: Bearer $ENGRAM_API_KEY" | python3 -c "
import sys, json
for e in json.load(sys.stdin):
    if e.get('type') == 'session.ended':
        print('OK:', e)
        break
else:
    print('NOT FOUND')
"
```

- [ ] **Step 5: Commit**

```bash
cd /c/Users/Zan/.claude
git add hooks/session-end.sh settings.json
git commit -m "feat: add session-end hook for Engram store and Chiasm completion"
```

> Note: If `.claude` is not a git repo, skip the commit. The files are in place.

---

## Self-Review

**Spec coverage:**
- [x] Eidolon gate blocks task completion without Engram stores → Task 3 (`gate/complete`)
- [x] Engram stores tracked per session → Tasks 1 + 2
- [x] Axon auto-registration on agent spawn → Task 4
- [x] Chiasm hard 400 on blank summary → Task 6
- [x] Session-end hook for Claude Code → Task 7
- [x] Deployed to both Rocky and the production host → Task 5

**Notes for executor:**
- Find the exact variable names in `tasks.rs` before writing Task 4 code  -  run `grep -n 'agent\|session_id\|create_session' ~/eidolon/eidolon-daemon/src/routes/tasks.rs` first
- Chiasm deployment in Task 6 Step 5  -  verify actual service name and deploy path with `systemctl cat chiasm` on the production host before restarting
- The `engram-cli recall` command in the session-end hook  -  verify the exact flags with `engram-cli recall --help` before writing the hook
