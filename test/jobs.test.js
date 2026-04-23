import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateJobId,
  getJobStatus,
  listJobs,
  killJob,
  extractContext,
  buildClaudeArgs,
} from "../lib/jobs.js";

function makeJob(overrides = {}) {
  return {
    id: "job_1",
    status: "running",
    startTime: new Date("2026-04-23T10:00:00Z").toISOString(),
    endTime: null,
    durationSeconds: null,
    exitCode: null,
    output: "",
    error: null,
    pid: 12345,
    command: "claude -p 'hello'",
    ...overrides,
  };
}

test("generateJobId returns unique ids with expected prefix", () => {
  const a = generateJobId();
  const b = generateJobId();
  assert.match(a, /^job_\d+_[a-z0-9]+$/);
  assert.notEqual(a, b);
});

test("getJobStatus returns error for unknown job", () => {
  const jobs = new Map();
  const r = getJobStatus(jobs, "missing");
  assert.equal(r.success, false);
  assert.match(r.error, /not found/);
});

test("getJobStatus returns job summary for known job", () => {
  const jobs = new Map([["job_1", makeJob()]]);
  const r = getJobStatus(jobs, "job_1");
  assert.equal(r.success, true);
  assert.equal(r.job.id, "job_1");
  assert.equal(r.job.pid, 12345);
});

test("getJobStatus caps output to 50KB", () => {
  const big = "x".repeat(60_000);
  const jobs = new Map([["j", makeJob({ id: "j", output: big })]]);
  const r = getJobStatus(jobs, "j");
  assert.equal(r.job.output.length, 50_000);
});

test("listJobs sorts by startTime desc and respects limit", () => {
  const jobs = new Map([
    ["a", makeJob({ id: "a", startTime: "2026-04-23T09:00:00Z" })],
    ["b", makeJob({ id: "b", startTime: "2026-04-23T11:00:00Z" })],
    ["c", makeJob({ id: "c", startTime: "2026-04-23T10:00:00Z" })],
  ]);
  const r = listJobs(jobs, { limit: 2 });
  assert.equal(r.total, 3);
  assert.equal(r.jobs.length, 2);
  assert.deepEqual(r.jobs.map(j => j.id), ["b", "c"]);
});

test("listJobs filters by status", () => {
  const jobs = new Map([
    ["a", makeJob({ id: "a", status: "running" })],
    ["b", makeJob({ id: "b", status: "completed" })],
  ]);
  const r = listJobs(jobs, { status: "completed" });
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].id, "b");
});

test("listJobs truncates command to 100 chars", () => {
  const long = "claude -p '" + "a".repeat(500);
  const jobs = new Map([["a", makeJob({ command: long })]]);
  const r = listJobs(jobs, {});
  assert.equal(r.jobs[0].command.length, 100);
});

test("killJob returns error for unknown job", () => {
  const r = killJob(new Map(), "nope");
  assert.equal(r.success, false);
});

test("killJob refuses to kill a non-running job", () => {
  const jobs = new Map([["a", makeJob({ status: "completed" })]]);
  const r = killJob(jobs, "a");
  assert.equal(r.success, false);
  assert.match(r.error, /not running/);
});

test("killJob kills running job and updates status", () => {
  const jobs = new Map([["a", makeJob({ status: "running" })]]);
  let killedPid = null;
  const r = killJob(jobs, "a", (pid) => { killedPid = pid; });
  assert.equal(r.success, true);
  assert.equal(killedPid, 12345);
  assert.equal(jobs.get("a").status, "killed");
  assert.ok(jobs.get("a").endTime);
});

test("killJob surfaces errors from killFn", () => {
  const jobs = new Map([["a", makeJob({ status: "running" })]]);
  const r = killJob(jobs, "a", () => { throw new Error("ESRCH"); });
  assert.equal(r.success, false);
  assert.equal(r.error, "ESRCH");
});

test("extractContext returns empty when query is absent", () => {
  assert.equal(extractContext("hello world", "missing"), "");
  assert.equal(extractContext("", "x"), "");
  assert.equal(extractContext("foo", ""), "");
});

test("extractContext returns surrounding window, case-insensitive", () => {
  const content = "a".repeat(100) + " TARGET " + "b".repeat(100);
  const r = extractContext(content, "target", 20);
  assert.ok(r.includes("TARGET"));
  assert.ok(r.length <= "TARGET".length + 40 + 2);
});

test("buildClaudeArgs throws without prompt", () => {
  assert.throws(() => buildClaudeArgs({}, "/tmp/mcp.json"), /Missing required parameter/);
});

test("buildClaudeArgs includes defaults", () => {
  const args = buildClaudeArgs({ prompt: "hi" }, "/tmp/mcp.json");
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.ok(args.includes("--mcp-config"));
  assert.ok(args.includes("/tmp/mcp.json"));
  assert.ok(args.includes("--max-turns"));
  assert.equal(args[args.length - 1], "hi");
});

test("buildClaudeArgs respects options", () => {
  const args = buildClaudeArgs({
    prompt: "go",
    model: "sonnet",
    systemPrompt: "you are helpful",
    jsonOutput: true,
    useMcpConfig: false,
    dangerouslySkipPermissions: false,
    tools: "Bash,Read",
  }, "/ignored");
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("--mcp-config"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("sonnet"));
  assert.ok(args.includes("--output-format"));
  assert.ok(args.includes("json"));
  assert.ok(args.includes("--append-system-prompt"));
  assert.ok(args.includes("you are helpful"));
  assert.ok(args.includes("--tools"));
  assert.ok(args.includes("Bash,Read"));
});
