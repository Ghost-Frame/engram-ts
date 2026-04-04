// ============================================================================
// SHELL BACKEND - Execute shell commands as grounding tools
// ============================================================================

import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { log } from "../../config/logger.ts";
import type {
  GroundingProvider, ToolSchema, ToolResult, SessionConfig, SessionInfo, BackendType,
} from "../types.ts";

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_SIZE = 100000; // 100KB max output

// --- Built-in shell tools ---

const SHELL_TOOLS: ToolSchema[] = [
  {
    name: "shell_exec",
    description: "Execute a shell command and return stdout/stderr",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: { type: "string", description: "Working directory (optional)" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
      },
      required: ["command"],
    },
    backend_type: "shell",
  },
  {
    name: "file_read",
    description: "Read a file and return its contents",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read" },
        max_lines: { type: "number", description: "Maximum lines to read (default: all)" },
      },
      required: ["path"],
    },
    backend_type: "shell",
  },
  {
    name: "file_list",
    description: "List files in a directory",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path" },
        recursive: { type: "boolean", description: "List recursively (default: false)" },
        pattern: { type: "string", description: "Glob pattern filter (optional)" },
      },
      required: ["path"],
    },
    backend_type: "shell",
  },
  {
    name: "git_status",
    description: "Get git status for a repository",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path" },
      },
      required: ["path"],
    },
    backend_type: "shell",
  },
  {
    name: "system_info",
    description: "Get system information (OS, memory, CPU)",
    parameters: { type: "object", properties: {} },
    backend_type: "shell",
  },
];

// --- Shell provider implementation ---

export class ShellProvider implements GroundingProvider {
  readonly type: BackendType = "shell";
  readonly name: string;
  private sessions: Map<string, SessionInfo> = new Map();

  constructor(name: string = "default") {
    this.name = name;
  }

  async initialize(): Promise<void> {
    // No-op for shell provider
  }

  async getTools(): Promise<ToolSchema[]> {
    return SHELL_TOOLS;
  }

  async executeTool(
    toolName: string,
    args: Record<string, any>,
    timeoutMs?: number,
  ): Promise<ToolResult> {
    const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;

    try {
      switch (toolName) {
        case "shell_exec":
          return await this.execShell(args, timeout);
        case "file_read":
          return await this.readFile(args);
        case "file_list":
          return await this.listFiles(args, timeout);
        case "git_status":
          return await this.gitStatus(args, timeout);
        case "system_info":
          return await this.systemInfo(timeout);
        default:
          return { status: "error", content: null, error: `Unknown tool: ${toolName}` };
      }
    } catch (e: any) {
      return { status: "error", content: null, error: e.message };
    }
  }

  async createSession(config: SessionConfig): Promise<SessionInfo> {
    const session: SessionInfo = {
      id: randomUUID(),
      name: config.name,
      backend: "shell",
      status: "connected",
      tools: SHELL_TOOLS.map(t => t.name),
      created_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      metadata: config.metadata,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async destroySession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await execAsync("echo ok", { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  // --- Tool implementations ---

  private async execShell(args: Record<string, any>, timeout: number): Promise<ToolResult> {
    const command = String(args.command || "");
    if (!command) return { status: "error", content: null, error: "command is required" };

    const opts: any = { timeout, maxBuffer: MAX_OUTPUT_SIZE };
    if (args.cwd) opts.cwd = args.cwd;

    try {
      const { stdout, stderr } = await execAsync(command, opts);
      const output = (stdout || "").slice(0, MAX_OUTPUT_SIZE);
      const errors = (stderr || "").slice(0, MAX_OUTPUT_SIZE);
      return {
        status: "success",
        content: { stdout: output, stderr: errors },
      };
    } catch (e: any) {
      return {
        status: "error",
        content: { stdout: e.stdout?.slice(0, MAX_OUTPUT_SIZE) || "", stderr: e.stderr?.slice(0, MAX_OUTPUT_SIZE) || "" },
        error: e.message,
      };
    }
  }

  private async readFile(args: Record<string, any>): Promise<ToolResult> {
    const { readFileSync } = await import("fs");
    const path = String(args.path || "");
    if (!path) return { status: "error", content: null, error: "path is required" };

    try {
      let content = readFileSync(path, "utf-8");
      if (args.max_lines) {
        const lines = content.split("\n");
        content = lines.slice(0, Number(args.max_lines)).join("\n");
      }
      return { status: "success", content: content.slice(0, MAX_OUTPUT_SIZE) };
    } catch (e: any) {
      return { status: "error", content: null, error: e.message };
    }
  }

  private async listFiles(args: Record<string, any>, timeout: number): Promise<ToolResult> {
    const path = String(args.path || ".");
    const recursive = !!args.recursive;
    const cmd = process.platform === "win32"
      ? (recursive ? `dir /s /b "${path}"` : `dir /b "${path}"`)
      : (recursive ? `find "${path}" -type f` : `ls -la "${path}"`);

    return this.execShell({ command: cmd }, timeout);
  }

  private async gitStatus(args: Record<string, any>, timeout: number): Promise<ToolResult> {
    const path = String(args.path || ".");
    return this.execShell({ command: "git status --porcelain && git log --oneline -5", cwd: path }, timeout);
  }

  private async systemInfo(timeout: number): Promise<ToolResult> {
    const cmd = process.platform === "win32"
      ? "systeminfo | findstr /C:\"OS\" /C:\"Memory\" /C:\"Processor\""
      : "uname -a && free -h 2>/dev/null || true && nproc 2>/dev/null || true";
    return this.execShell({ command: cmd }, timeout);
  }
}
