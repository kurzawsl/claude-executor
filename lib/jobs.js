// Pure job-management helpers extracted from index.js for testability.
// The Map<jobId, job> is passed in — no module-level state.

// ─── Input validation helpers ─────────────────────────────────────────────────

/** Return true if sessionId is safe to embed in a path (no traversal). */
export function validateSessionId(sessionId) {
  return /^[a-zA-Z0-9_-]{1,100}$/.test(sessionId);
}

/**
 * Validate execution limits. Returns an error string on failure, null on success.
 * maxTurns ≤ 500, timeoutMinutes ≤ 240.
 */
export function validateExecutionLimits({ maxTurns, timeoutMinutes }) {
  if (maxTurns !== undefined && maxTurns > 500) {
    return "maxTurns must be ≤ 500";
  }
  if (timeoutMinutes !== undefined && timeoutMinutes > 240) {
    return "timeoutMinutes must be ≤ 240";
  }
  return null;
}

export function generateJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function getJobStatus(jobs, jobId) {
  const job = jobs.get(jobId);
  if (!job) return { success: false, error: `Job not found: ${jobId}` };

  return {
    success: true,
    job: {
      id: job.id,
      status: job.status,
      startTime: job.startTime,
      endTime: job.endTime,
      durationSeconds: job.durationSeconds,
      exitCode: job.exitCode,
      output: (job.output || "").slice(-50000),
      error: job.error,
      pid: job.pid,
    },
  };
}

export function listJobs(jobs, options = {}) {
  const { status, limit = 20 } = options;
  let jobList = Array.from(jobs.values());

  if (status) jobList = jobList.filter(j => j.status === status);

  jobList.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  jobList = jobList.slice(0, limit);

  return {
    success: true,
    total: jobs.size,
    jobs: jobList.map(j => ({
      id: j.id,
      status: j.status,
      startTime: j.startTime,
      endTime: j.endTime,
      durationSeconds: j.durationSeconds,
      command: (j.command || "").substring(0, 100),
    })),
  };
}

export function killJob(jobs, jobId, killFn = (pid, sig) => process.kill(pid, sig)) {
  const job = jobs.get(jobId);
  if (!job) return { success: false, error: `Job not found: ${jobId}` };
  if (job.status !== "running") {
    return { success: false, error: `Job is not running (status: ${job.status})` };
  }

  try {
    killFn(job.pid, "SIGTERM");
    job.status = "killed";
    job.endTime = new Date().toISOString();
    return { success: true, message: `Job ${jobId} killed` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Extract a snippet around the first occurrence of `query` in `content`.
// Returns up to `radius` chars on each side.
export function extractContext(content, query, radius = 200) {
  if (!content || !query) return "";
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return "";
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + query.length + radius);
  return content.slice(start, end);
}

// Build argv for `claude -p` from an options object. Pure.
export function buildClaudeArgs(options, mcpConfigPath) {
  const {
    prompt,
    systemPrompt,
    tools,
    maxTurns = 10,
    jsonOutput = false,
    useMcpConfig = true,
    model,
    dangerouslySkipPermissions = false,
  } = options;

  if (!prompt) throw new Error("Missing required parameter: prompt");

  const args = ["-p"];
  if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (useMcpConfig && mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  if (tools) args.push("--tools", tools);
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  if (jsonOutput) args.push("--output-format", "json");
  if (model) args.push("--model", model);
  args.push(prompt);
  return args;
}
