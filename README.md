# claude-executor

An MCP server that wraps the Claude CLI (`claude -p`) with async job management, session inspection, and error analysis. Register it in Claude Code to programmatically launch and monitor Claude sub-processes from within an agent session.

## Installation

```bash
# Clone and install dependencies
git clone https://github.com/kurzawsl/claude-executor.git
cd claude-executor
npm install
```

Or install globally via npm (once published):

```bash
npm install -g mcp-claude-executor
```

## Usage

Register the server in your Claude Code MCP config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "claude-executor": {
      "command": "node",
      "args": ["/path/to/claude-executor/index.js"],
      "env": {}
    }
  }
}
```

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

Then poll with `get_job_status` using the returned `jobId`.

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
