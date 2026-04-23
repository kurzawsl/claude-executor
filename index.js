#!/usr/bin/env node
/**
 * WORLD-CLASS CLAUDE EXECUTOR MCP SERVER
 *
 * Features:
 * - Execute claude -p commands with full options
 * - Async job management (start, status, list, kill)
 * - Conversation history inspection
 * - Session tracking and monitoring
 * - Real-time output streaming
 * - Error detection and reporting
 * - Continuous learning patterns
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { generateJobId, getJobStatus, listJobs, killJob, extractContext, buildClaudeArgs } from "./lib/jobs.js";
import { spawn, exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

const execAsync = promisify(exec);

// Surface process-level errors so they land in Claude Code logs instead of silently
// killing the stdio transport.
process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({ type: 'uncaughtException', error: err?.stack || String(err), ts: new Date().toISOString() }));
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ type: 'unhandledRejection', reason: reason instanceof Error ? reason.stack : String(reason), ts: new Date().toISOString() }));
  process.exit(1);
});

const HOME = os.homedir();
const CLAUDE_PATH = path.join(HOME, ".claude/local/claude");
const MCP_CONFIG = path.join(HOME, ".claude/.mcp.json");
const SESSIONS_DIR = path.join(HOME, ".claude/projects");
const DATA_DIR = path.join(HOME, ".claude/mcp-servers/claude-executor/data");

// In-memory job storage
const jobs = new Map();

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (e) {
    // Ignore
  }
}

// Execute claude -p command
async function executeClaudeCommand(options) {
  const {
    prompt,
    systemPrompt,
    tools,
    maxTurns = 10,
    async: isAsync = false,
    jsonOutput = false,
    workingDirectory,
    timeoutMinutes = 60,
    useMcpConfig = true,
    model,
    dangerouslySkipPermissions = false
  } = options;

  if (!prompt) {
    return { success: false, error: "Missing required parameter: prompt" };
  }

  // Validate maxTurns cap
  if (maxTurns > 500) {
    return { success: false, error: "maxTurns must be ≤ 500" };
  }

  // Validate timeoutMinutes cap
  if (timeoutMinutes > 240) {
    return { success: false, error: "timeoutMinutes must be ≤ 240" };
  }

  // Build command
  const args = ["-p"];

  if (dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  if (useMcpConfig) {
    args.push("--mcp-config", MCP_CONFIG);
  }

  if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }

  if (tools) {
    args.push("--tools", tools);
  }

  if (maxTurns) {
    args.push("--max-turns", String(maxTurns));
  }

  if (jsonOutput) {
    args.push("--output-format", "json");
  }

  if (model) {
    args.push("--model", model);
  }

  args.push(prompt);

  if (isAsync) {
    return executeAsync(args, workingDirectory, timeoutMinutes);
  } else {
    return executeSync(args, workingDirectory, timeoutMinutes);
  }
}

// Synchronous execution
async function executeSync(args, workingDirectory, timeoutMinutes) {
  const startTime = Date.now();

  return new Promise((resolve) => {
    const options = {
      cwd: workingDirectory || HOME,
      env: { ...process.env },
      timeout: timeoutMinutes * 60 * 1000,
      maxBuffer: 50 * 1024 * 1024 // 50MB
    };

    let stdout = "";
    let stderr = "";

    const child = spawn(CLAUDE_PATH, args, options);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      resolve({
        success: code === 0,
        exitCode: code,
        output: stdout.trim(),
        error: stderr.trim() || undefined,
        durationSeconds: parseFloat(duration),
        command: `claude ${args.join(" ")}`.substring(0, 500)
      });
    });

    child.on("error", (err) => {
      resolve({
        success: false,
        error: err.message,
        command: `claude ${args.join(" ")}`.substring(0, 500)
      });
    });
  });
}

// Asynchronous execution with job tracking
async function executeAsync(args, workingDirectory, timeoutMinutes) {
  const jobId = generateJobId();
  const startTime = Date.now();

  const job = {
    id: jobId,
    status: "running",
    startTime: new Date().toISOString(),
    command: `claude ${args.join(" ")}`.substring(0, 500),
    output: "",
    error: "",
    exitCode: null,
    pid: null
  };

  jobs.set(jobId, job);

  const options = {
    cwd: workingDirectory || HOME,
    env: { ...process.env }
  };

  const child = spawn(CLAUDE_PATH, args, options);
  job.pid = child.pid;

  child.stdout.on("data", (data) => {
    job.output += data.toString();
    // Trim to prevent memory issues
    if (job.output.length > 10 * 1024 * 1024) {
      job.output = job.output.slice(-5 * 1024 * 1024);
    }
  });

  child.stderr.on("data", (data) => {
    job.error += data.toString();
  });

  child.on("close", (code) => {
    job.status = code === 0 ? "completed" : "failed";
    job.exitCode = code;
    job.endTime = new Date().toISOString();
    job.durationSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
  });

  child.on("error", (err) => {
    job.status = "failed";
    job.error = err.message;
    job.endTime = new Date().toISOString();
  });

  // Auto-timeout
  setTimeout(() => {
    if (job.status === "running") {
      try {
        process.kill(child.pid, "SIGTERM");
        job.status = "timeout";
        job.error = `Timed out after ${timeoutMinutes} minutes`;
        job.endTime = new Date().toISOString();
      } catch (e) {
        // Process already dead
      }
    }
  }, timeoutMinutes * 60 * 1000);

  return {
    success: true,
    jobId,
    status: "running",
    pid: child.pid,
    message: `Job started. Use get_job_status with jobId="${jobId}" to check progress.`
  };
}

// List recent Claude sessions from filesystem
async function listSessions(options = {}) {
  const { hoursAgo = 24, limit = 20, project } = options;

  const sessions = [];
  const cutoff = Date.now() - (hoursAgo * 60 * 60 * 1000);

  try {
    const projectDirs = await fs.readdir(SESSIONS_DIR);

    for (const projectDir of projectDirs) {
      if (project && !projectDir.includes(project)) continue;

      const sessionsPath = path.join(SESSIONS_DIR, projectDir, "sessions");

      try {
        const files = await fs.readdir(sessionsPath);

        for (const file of files) {
          if (!file.endsWith(".json")) continue;

          const filePath = path.join(sessionsPath, file);
          const stat = await fs.stat(filePath);

          if (stat.mtimeMs < cutoff) continue;

          sessions.push({
            id: file.replace(".json", ""),
            project: projectDir,
            modified: new Date(stat.mtimeMs).toISOString(),
            size: stat.size
          });
        }
      } catch (e) {
        // No sessions directory
      }
    }
  } catch (e) {
    return { success: false, error: e.message };
  }

  sessions.sort((a, b) => new Date(b.modified) - new Date(a.modified));

  return {
    success: true,
    total: sessions.length,
    sessions: sessions.slice(0, limit)
  };
}

// Validate sessionId to prevent path traversal
function validateSessionId(sessionId) {
  return /^[a-zA-Z0-9_-]{1,100}$/.test(sessionId);
}

// Get session details
async function getSession(sessionId, options = {}) {
  const { project, includeMessages = false } = options;

  if (!validateSessionId(sessionId)) {
    return { success: false, error: "Invalid sessionId: must match ^[a-zA-Z0-9_-]{1,100}$" };
  }

  try {
    // Find the session file
    const projectDirs = await fs.readdir(SESSIONS_DIR);

    for (const projectDir of projectDirs) {
      if (project && projectDir !== project) continue;

      const filePath = path.join(SESSIONS_DIR, projectDir, "sessions", `${sessionId}.json`);

      try {
        const content = await fs.readFile(filePath, "utf-8");
        const data = JSON.parse(content);

        // Parse session data
        const summary = {
          id: sessionId,
          project: projectDir,
          toolsUsed: new Set(),
          messageCount: 0,
          errors: [],
          duration: null
        };

        if (Array.isArray(data)) {
          for (const item of data) {
            if (item.type === "assistant" && item.message?.content) {
              for (const block of item.message.content) {
                if (block.type === "tool_use") {
                  summary.toolsUsed.add(block.name);
                }
                if (block.type === "tool_result" && block.is_error) {
                  summary.errors.push(block.content?.substring(0, 200));
                }
              }
            }
            summary.messageCount++;
          }
        }

        return {
          success: true,
          session: {
            id: sessionId,
            project: projectDir,
            toolsUsed: Array.from(summary.toolsUsed),
            messageCount: summary.messageCount,
            errors: summary.errors.slice(0, 10),
            messages: includeMessages ? data : undefined
          }
        };
      } catch (e) {
        // File not in this project
      }
    }

    return { success: false, error: `Session not found: ${sessionId}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Search sessions
async function searchSessions(query, options = {}) {
  const { hoursAgo = 48, limit = 10 } = options;

  const results = [];
  const cutoff = Date.now() - (hoursAgo * 60 * 60 * 1000);
  const queryLower = query.toLowerCase();

  try {
    const projectDirs = await fs.readdir(SESSIONS_DIR);

    for (const projectDir of projectDirs) {
      const sessionsPath = path.join(SESSIONS_DIR, projectDir, "sessions");

      try {
        const files = await fs.readdir(sessionsPath);

        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          if (results.length >= limit) break;

          const filePath = path.join(sessionsPath, file);
          const stat = await fs.stat(filePath);

          if (stat.mtimeMs < cutoff) continue;

          const content = await fs.readFile(filePath, "utf-8");

          if (content.toLowerCase().includes(queryLower)) {
            results.push({
              id: file.replace(".json", ""),
              project: projectDir,
              modified: new Date(stat.mtimeMs).toISOString(),
              matchContext: extractContext(content, query)
            });
          }
        }
      } catch (e) {
        // No sessions directory
      }
    }
  } catch (e) {
    return { success: false, error: e.message };
  }

  return {
    success: true,
    query,
    matches: results.length,
    results
  };
}

// Analyze session for errors
async function analyzeSessionErrors(sessionId) {
  const result = await getSession(sessionId, { includeMessages: true });

  if (!result.success) return result;

  const errors = [];
  const warnings = [];

  if (Array.isArray(result.session.messages)) {
    for (const item of result.session.messages) {
      if (item.type === "assistant" && item.message?.content) {
        for (const block of item.message.content) {
          if (block.type === "tool_result") {
            const content = typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content);

            if (block.is_error || content.includes("error") || content.includes("Error")) {
              errors.push({
                tool: block.tool_use_id,
                error: content.substring(0, 500)
              });
            }

            if (content.includes("warning") || content.includes("Warning")) {
              warnings.push({
                tool: block.tool_use_id,
                warning: content.substring(0, 500)
              });
            }
          }
        }
      }
    }
  }

  return {
    success: true,
    sessionId,
    errorCount: errors.length,
    warningCount: warnings.length,
    errors: errors.slice(0, 20),
    warnings: warnings.slice(0, 10)
  };
}

// Health check
async function healthCheck() {
  let claudeAvailable = false;
  let mcpConfigExists = false;
  let sessionsAccessible = false;

  try {
    await fs.access(CLAUDE_PATH);
    claudeAvailable = true;
  } catch (e) {
    // Not available
  }

  try {
    await fs.access(MCP_CONFIG);
    mcpConfigExists = true;
  } catch (e) {
    // Not available
  }

  try {
    await fs.readdir(SESSIONS_DIR);
    sessionsAccessible = true;
  } catch (e) {
    // Not accessible
  }

  const runningJobs = Array.from(jobs.values()).filter(j => j.status === "running").length;

  return {
    success: true,
    status: "healthy",
    claudePath: CLAUDE_PATH,
    claudeAvailable,
    mcpConfigPath: MCP_CONFIG,
    mcpConfigExists,
    sessionsDir: SESSIONS_DIR,
    sessionsAccessible,
    activeJobs: runningJobs,
    totalJobs: jobs.size
  };
}

// Create MCP server
const server = new Server(
  { name: "claude-executor", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "execute_claude",
      description: `Execute a Claude CLI command (claude -p). This is the primary tool for running Claude with full MCP access.

IMPORTANT: Uses --mcp-config by default. Set dangerouslySkipPermissions=true to enable --dangerously-skip-permissions (opt-in, default false).
Claude can run for HOURS on complex tasks - use async=true for long tasks.

Examples:
- Simple query: { "prompt": "What is 2+2?" }
- With system prompt: { "prompt": "Review code", "systemPrompt": "You are a security expert" }
- Async for long tasks: { "prompt": "Analyze entire codebase", "async": true }
- Limit tools: { "prompt": "Search files", "tools": "Read,Grep,Glob" }`,
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The prompt to send to Claude" },
          systemPrompt: { type: "string", description: "Optional system prompt to append" },
          tools: { type: "string", description: "Comma-separated list of allowed tools" },
          maxTurns: { type: "number", description: "Maximum agentic turns (default: 10)" },
          async: { type: "boolean", description: "Run asynchronously (returns jobId)" },
          jsonOutput: { type: "boolean", description: "Get JSON output format" },
          workingDirectory: { type: "string", description: "Working directory" },
          timeoutMinutes: { type: "number", description: "Timeout in minutes (default: 60)" },
          useMcpConfig: { type: "boolean", description: "Use MCP config (default: true)" },
          model: { type: "string", description: "Model to use (default: claude-sonnet-4-20250514)" },
          dangerouslySkipPermissions: { type: "boolean", description: "Pass --dangerously-skip-permissions to claude (opt-in, default: false)" }
        },
        required: ["prompt"]
      }
    },
    {
      name: "get_job_status",
      description: "Get the status and output of an async job",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "The job ID returned from async execute" }
        },
        required: ["jobId"]
      }
    },
    {
      name: "list_jobs",
      description: "List all async jobs with their status",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["running", "completed", "failed", "killed", "timeout"], description: "Filter by status" },
          limit: { type: "number", description: "Maximum jobs to return (default: 20)" }
        }
      }
    },
    {
      name: "kill_job",
      description: "Kill a running async job",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "The job ID to kill" }
        },
        required: ["jobId"]
      }
    },
    {
      name: "list_sessions",
      description: "List recent Claude conversation sessions from filesystem",
      inputSchema: {
        type: "object",
        properties: {
          hoursAgo: { type: "number", description: "Only show sessions from last N hours (default: 24)" },
          limit: { type: "number", description: "Maximum sessions to return (default: 20)" },
          project: { type: "string", description: "Filter by project path pattern" }
        }
      }
    },
    {
      name: "get_session",
      description: "Get detailed information about a specific session",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID (UUID)" },
          project: { type: "string", description: "Project directory (optional)" },
          includeMessages: { type: "boolean", description: "Include full message history" }
        },
        required: ["sessionId"]
      }
    },
    {
      name: "search_sessions",
      description: "Search across all sessions for specific content",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          hoursAgo: { type: "number", description: "Only search last N hours (default: 48)" },
          limit: { type: "number", description: "Maximum results (default: 10)" }
        },
        required: ["query"]
      }
    },
    {
      name: "analyze_session_errors",
      description: "Find errors and warnings in a session",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID to analyze" }
        },
        required: ["sessionId"]
      }
    },
    {
      name: "health_check",
      description: "Check if Claude CLI and MCP config are available",
      inputSchema: {
        type: "object",
        properties: {}
      }
    }
  ]
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case "execute_claude":
        result = await executeClaudeCommand(args);
        break;
      case "get_job_status":
        result = getJobStatus(jobs, args.jobId);
        break;
      case "list_jobs":
        result = listJobs(jobs, args);
        break;
      case "kill_job":
        result = killJob(jobs, args.jobId);
        break;
      case "list_sessions":
        result = await listSessions(args);
        break;
      case "get_session":
        result = await getSession(args.sessionId, args);
        break;
      case "search_sessions":
        result = await searchSessions(args.query, args);
        break;
      case "analyze_session_errors":
        result = await analyzeSessionErrors(args.sessionId);
        break;
      case "health_check":
        result = await healthCheck();
        break;
      default:
        result = { success: false, error: `Unknown tool: ${name}` };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: error.message }, null, 2) }],
      isError: true
    };
  }
});

// Start server
async function main() {
  await ensureDataDir();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Claude Executor MCP server started");
}

main().catch(console.error);
