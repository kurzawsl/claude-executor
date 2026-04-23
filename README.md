# claude-executor

[![CI](https://github.com/kurzawsl/claude-executor/actions/workflows/ci.yml/badge.svg)](https://github.com/kurzawsl/claude-executor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An MCP server that wraps the Claude CLI (`claude -p`) with async job management, session inspection, and error analysis. Register it in Claude Code to programmatically launch and monitor Claude sub-processes from within an agent session.

## Prerequisites

- Node.js 20+
- Claude CLI installed at `~/.claude/local/claude` (default) or any path — set `CLAUDE_CLI_PATH` to override

## Installation

```bash
git clone https://github.com/kurzawsl/claude-executor.git
cd claude-executor
npm install
```

## Usage

Register the server in your Claude Code MCP config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "claude-executor": {
      "command": "node",
      "args": ["/path/to/claude-executor/index.js"],
      "env": {
        "CLAUDE_CLI_PATH": "/path/to/claude",
        "CLAUDE_CODE_OAUTH_TOKEN": "<your-oauth-token>"
      }
    }
  }
}
```

**Environment variables:**

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_CLI_PATH` | No | Override Claude CLI path (default: `~/.claude/local/claude`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes | OAuth token passed to Claude sub-processes for authentication |

Claude Code will start the server automatically when needed.

## Tools

| Tool | Description |
|------|-------------|
| `execute_claude` | Execute a `claude -p` command (sync or async). Supports system prompts, tool restrictions, model selection, and working directory. |
| `get_job_status` | Poll the status and captured output of an async job by `jobId`. |
| `list_jobs` | List all tracked async jobs; filter by status, cap with limit. |
| `kill_job` | Send SIGTERM to a running async job. |
| `list_sessions` | List recent Claude conversation sessions from `~/.claude/projects`. |
| `get_session` | Retrieve details (tools used, message count, errors) for a specific session UUID. |
| `search_sessions` | Full-text search across session JSON files within a time window. |
| `analyze_session_errors` | Extract tool errors and warnings from a session file. |
| `health_check` | Verify that the Claude CLI binary, MCP config, and sessions directory are accessible. |

### Example: run a task asynchronously

Request:
```json
{
  "tool": "execute_claude",
  "arguments": {
    "prompt": "Summarise the git log for the last 7 days",
    "async": true,
    "workingDirectory": "/path/to/repo"
  }
}
```

Response:
```json
{
  "jobId": "job_1714000000000_abc12",
  "status": "running",
  "message": "Job started. Poll with get_job_status using the jobId."
}
```

Then poll with `get_job_status`:
```json
{
  "tool": "get_job_status",
  "arguments": { "jobId": "job_1714000000000_abc12" }
}
```

Response when complete:
```json
{
  "jobId": "job_1714000000000_abc12",
  "status": "completed",
  "exitCode": 0,
  "output": "Here is a summary of the last 7 days of commits:\n- feat: add async job queue\n- fix: handle SIGTERM gracefully\n..."
}
```

## Development

```bash
# Run unit tests (Node built-in test runner, no extra deps)
npm test

# Start the MCP server directly (stdio transport)
npm start
```

Tests live in `test/jobs.test.js` and cover the pure job-management helpers in `lib/jobs.js`.

## License

[MIT](LICENSE)
