import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const summarizePath = path.join(repoRoot, "skills/debug-mode/scripts/summarize-log.mjs");

async function runNode(args, options) {
  const child = spawn(process.execPath, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const [code, signal] = await once(child, "exit");
  return { code, signal, stdout, stderr };
}

async function writeNdjson(file, events) {
  await writeFile(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

async function testSummarizesEventsAsJson() {
  const dir = await mkdtemp(path.join(tmpdir(), "debug-mode-summary-"));
  try {
    const logFile = path.join(dir, "debug.ndjson");
    await writeNdjson(logFile, [
      {
        ts: "2026-06-24T01:00:00.000Z",
        session: "s1",
        runId: "pre-fix",
        hypothesis: "H1",
        probe: "settings.beforePersist",
        vars: { enabled: false },
      },
      {
        ts: "2026-06-24T01:00:01.000Z",
        session: "s1",
        runId: "pre-fix",
        hypothesis: "H2",
        probe: "api.request",
        vars: { status: 200 },
      },
      {
        ts: "2026-06-24T01:00:02.000Z",
        session: "s1",
        runId: "post-fix",
        hypothesis: "H1",
        probe: "settings.beforePersist",
        vars: { enabled: true },
      },
    ]);

    const result = await runNode(
      [
        summarizePath,
        logFile,
        "--json",
        "--expect-probe",
        "settings.beforePersist",
        "--expect-probe",
        "settings.afterPersist",
      ],
      { cwd: repoRoot },
    );
    assert.equal(result.code, 0, result.stderr);

    const summary = JSON.parse(result.stdout);
    assert.equal(summary.totalEvents, 3);
    assert.deepEqual(summary.sessions, ["s1"]);
    assert.deepEqual(summary.runIds, { "post-fix": 1, "pre-fix": 2 });
    assert.deepEqual(summary.hypotheses.H1.probes, ["settings.beforePersist"]);
    assert.equal(summary.probes["settings.beforePersist"].count, 2);
    assert.deepEqual(summary.probes["settings.beforePersist"].runIds, ["post-fix", "pre-fix"]);
    assert.deepEqual(summary.probes["settings.beforePersist"].lastVars, { enabled: true });
    assert.deepEqual(summary.missingExpectedProbes, ["settings.afterPersist"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testReportsMalformedNdjsonLine() {
  const dir = await mkdtemp(path.join(tmpdir(), "debug-mode-summary-"));
  try {
    const logFile = path.join(dir, "bad.ndjson");
    await writeFile(logFile, "{\"probe\":\"ok\"}\nnot-json\n");

    const result = await runNode([summarizePath, logFile], { cwd: repoRoot });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid JSON on line 2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await testSummarizesEventsAsJson();
await testReportsMalformedNdjsonLine();

console.log("summarize-log tests passed");
