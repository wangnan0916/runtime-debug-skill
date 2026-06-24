import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const serverPath = path.join(repoRoot, "skills/debug-mode/scripts/log-server.mjs");
const startCollectorPath = path.join(repoRoot, "skills/debug-mode/scripts/start-collector.mjs");

function trackExit(child) {
  let exited = false;
  const promise = once(child, "exit").then(([code, signal]) => {
    exited = true;
    return { code, signal };
  });
  return { promise, hasExited: () => exited };
}

async function stopChild(child, tracker) {
  if (!tracker.hasExited()) {
    child.kill("SIGTERM");
  }
  await tracker.promise.catch(() => {});
}

async function waitForDebugUrl(child, exit) {
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const debugUrlPromise = new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for DEBUG_URL"));
    }, 5000);

    const onData = (chunk) => {
      output += chunk.toString("utf8");
      const match = output.match(/^DEBUG_URL=(http:\/\/[^\s]+)$/m);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    };

    const onClose = () => {
      cleanup();
      reject(new Error(`Stream closed before DEBUG_URL appeared. Output: ${output}`));
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stdout.off("close", onClose);
      child.stdout.off("error", onError);
    };

    child.stdout.on("data", onData);
    child.stdout.on("close", onClose);
    child.stdout.on("error", onError);
  });

  return Promise.race([
    debugUrlPromise,
    exit.promise.then(({ code, signal }) => {
      throw new Error(`Server exited before ready: code=${code} signal=${signal} stderr=${stderr}`);
    }),
  ]);
}

async function expectedLogDir(dir) {
  return path.join(await realpath(dir), "logs");
}

function sessionLogPath(dir, session) {
  return path.join(dir, "logs", `${session}.ndjson`);
}

async function readNdjsonEvents(logFile) {
  const lines = (await readFile(logFile, "utf8")).trim().split("\n");
  return lines.map((line) => JSON.parse(line));
}

async function waitForNdjsonEvents(logFile, expectedCount, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const events = await readNdjsonEvents(logFile);
      if (events.length >= expectedCount) return events;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expectedCount} NDJSON lines in ${logFile}`);
}

async function assertLogFileMissing(logFile) {
  await assert.rejects(() => readFile(logFile, "utf8"), { code: "ENOENT" });
}

async function postLog(debugUrl, body) {
  return fetch(`${debugUrl}/log`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function parseKeyOutput(output) {
  const entries = output
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    });
  return Object.fromEntries(entries);
}

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
  if (code !== 0) {
    throw new Error(`Command failed: code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`);
  }
  return { stdout, stderr };
}

async function runNodeExpectFailure(args, options) {
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
  assert.notEqual(code, 0);
  return { stdout, stderr, code, signal };
}

async function listenOnLoopback(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function stopPid(pid, healthUrl) {
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (!response.ok) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function withRunningCollector(session, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "debug-mode-log-server-"));
  const child = spawn(
    process.execPath,
    [serverPath, "--dir", "logs", "--session", session, "--state", "collector.json", "--port", "0"],
    {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exit = trackExit(child);

  try {
    const debugUrl = await waitForDebugUrl(child, exit);
    return await run({ dir, session, child, exit, debugUrl });
  } finally {
    await stopChild(child, exit);
    await rm(dir, { recursive: true, force: true });
  }
}

async function testRejectsNonLoopbackHost() {
  const child = spawn(process.execPath, [serverPath, "--host", "0.0.0.0", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = trackExit(child);

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const { code } = await exit.promise;
  assert.notEqual(code, 0);
  assert.match(stderr, /loopback-only/);
}

async function testWritesValidNdjson() {
  await withRunningCollector("test-session", async ({ dir, session, debugUrl }) => {
    const writes = Array.from({ length: 8 }, (_, index) =>
      postLog(debugUrl, {
        probe: `parallel.${index + 1}`,
        vars: { index: index + 1 },
      }),
    );

    const responses = await Promise.all(writes);
    assert.equal(responses.every((response) => response.ok), true);

    const events = await waitForNdjsonEvents(sessionLogPath(dir, session), 8);
    assert.deepEqual(
      events.map((event) => event.probe).sort(),
      Array.from({ length: 8 }, (_, index) => `parallel.${index + 1}`),
    );
    assert.equal(events.every((event) => event.session === session), true);
    assert.equal(events.every((event) => typeof event.ts === "string" && event.ts.length > 0), true);
  });
}

async function testDoesNotCreateLogFileBeforeFirstEvent() {
  await withRunningCollector("no-empty-log-session", async ({ dir, session }) => {
    await assertLogFileMissing(sessionLogPath(dir, session));
  });
}

async function testRecreatesDeletedLogFile() {
  await withRunningCollector("deleted-log-session", async ({ dir, session, debugUrl }) => {
    const logFile = sessionLogPath(dir, session);
    await rm(logFile, { force: true });

    const response = await postLog(debugUrl, { probe: "after-delete" });
    assert.equal(response.ok, true);

    const events = await waitForNdjsonEvents(logFile, 1);
    assert.equal(events[0].probe, "after-delete");
  });
}

async function testReportsWriteFailureBeforeReturningSuccess() {
  await withRunningCollector("write-failure-session", async ({ dir, debugUrl }) => {
    await rm(path.join(dir, "logs"), { recursive: true, force: true });

    const response = await postLog(debugUrl, { probe: "write-failure" });

    assert.equal(response.status, 500);
    assert.equal((await response.json()).ok, false);
  });
}

async function testHealthEndpoint() {
  await withRunningCollector("health-session", async ({ dir, session, child, debugUrl }) => {
    const response = await fetch(`${debugUrl}/health`);
    assert.equal(response.ok, true);

    const health = await response.json();
    assert.equal(health.ok, true);
    assert.equal(health.pid, child.pid);
    assert.equal(health.debugUrl, debugUrl);
    assert.equal(health.healthUrl, `${debugUrl}/health`);
    assert.equal(health.logDir, await expectedLogDir(dir));
    assert.equal(typeof health.startedAt, "string");
    assert.equal(typeof health.uptimeMs, "number");

    const state = JSON.parse(await readFile(path.join(dir, "collector.json"), "utf8"));
    assert.equal(state.pid, child.pid);
    assert.equal(state.debugUrl, debugUrl);

    await assertLogFileMissing(sessionLogPath(dir, session));
  });
}

async function testRoutesBodySessionToLogFile() {
  await withRunningCollector("default-session", async ({ dir, debugUrl }) => {
    const requestSession = "request-session";
    const response = await postLog(debugUrl, { session: requestSession, probe: "session-route" });
    assert.equal(response.ok, true);
    assert.equal((await response.json()).session, requestSession);

    const events = await waitForNdjsonEvents(sessionLogPath(dir, requestSession), 1);
    assert.equal(events[0].session, requestSession);

    await assertLogFileMissing(sessionLogPath(dir, "default-session"));

    const invalid = await postLog(debugUrl, { session: "../bad", probe: "invalid-session" });
    assert.equal(invalid.status, 400);
  });
}

async function testEnsureStartsAndReusesHealthyCollector() {
  const dir = await mkdtemp(path.join(tmpdir(), "debug-mode-log-server-"));
  let pid;
  let healthUrl;

  try {
    const first = await runNode(
      [serverPath, "--ensure", "--dir", "logs", "--session", "ensure-one", "--state", "collector.json"],
      { cwd: dir },
    );
    const firstInfo = parseKeyOutput(first.stdout);
    assert.equal(firstInfo.SESSION_ID, "ensure-one");
    assert.equal(firstInfo.LOG_DIR, await expectedLogDir(dir));
    assert.match(firstInfo.DEBUG_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(firstInfo.HEALTH_URL, `${firstInfo.DEBUG_URL}/health`);

    const firstHealth = await (await fetch(firstInfo.HEALTH_URL)).json();
    assert.equal(firstHealth.ok, true);
    pid = firstHealth.pid;
    healthUrl = firstInfo.HEALTH_URL;

    const write = await postLog(firstInfo.DEBUG_URL, { session: "ensure-one", probe: "ensure.write" });
    assert.equal(write.ok, true);

    const second = await runNode(
      [serverPath, "--ensure", "--dir", "logs", "--session", "ensure-two", "--state", "collector.json"],
      { cwd: dir },
    );
    const secondInfo = parseKeyOutput(second.stdout);
    assert.equal(secondInfo.SESSION_ID, "ensure-two");
    assert.equal(secondInfo.DEBUG_URL, firstInfo.DEBUG_URL);

    const secondHealth = await (await fetch(secondInfo.HEALTH_URL)).json();
    assert.equal(secondHealth.pid, pid);

    const events = await waitForNdjsonEvents(sessionLogPath(dir, "ensure-one"), 1);
    assert.equal(events[0].probe, "ensure.write");
  } finally {
    await stopPid(pid, healthUrl);
    await rm(dir, { recursive: true, force: true });
  }
}

async function testStartCollectorWrapperUsesSafeDefaults() {
  const dir = await mkdtemp(path.join(tmpdir(), "debug-mode-log-server-"));
  let pid;
  let healthUrl;

  try {
    const result = await runNode(
      [startCollectorPath, "--dir", "logs", "--session", "safe-start", "--state", "collector.json"],
      { cwd: dir },
    );
    const info = parseKeyOutput(result.stdout);
    assert.equal(info.SESSION_ID, "safe-start");
    assert.match(info.DEBUG_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(info.HEALTH_URL, `${info.DEBUG_URL}/health`);

    const health = await (await fetch(info.HEALTH_URL)).json();
    pid = health.pid;
    healthUrl = info.HEALTH_URL;
    assert.equal(health.ok, true);
    assert.equal(health.debugUrl, info.DEBUG_URL);
  } finally {
    await stopPid(pid, healthUrl);
    await rm(dir, { recursive: true, force: true });
  }
}

async function testStartCollectorWrapperRejectsUnsafeOrIncompleteArgs() {
  const dir = await mkdtemp(path.join(tmpdir(), "debug-mode-log-server-"));
  const cases = [
    { args: [], message: /Missing required --session/ },
    { args: ["--session", "safe-start", "--host", "0.0.0.0"], message: /--host is fixed/ },
    { args: ["--session", "safe-start", "--port", "3000"], message: /--port is fixed/ },
    { args: ["--session", "safe-start", "--ensure"], message: /--ensure is implied/ },
  ];

  try {
    for (const { args, message } of cases) {
      const result = await runNodeExpectFailure([startCollectorPath, ...args], { cwd: dir });
      assert.match(result.stderr, message);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testParallelSessionsWriteIndependently() {
  await withRunningCollector("parallel-default", async ({ dir, debugUrl }) => {
    const sessionA = "parallel-session-a";
    const sessionB = "parallel-session-b";

    const writes = [
      ...Array.from({ length: 4 }, (_, index) =>
        postLog(debugUrl, { session: sessionA, probe: `a.${index + 1}` }),
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        postLog(debugUrl, { session: sessionB, probe: `b.${index + 1}` }),
      ),
    ];

    const responses = await Promise.all(writes);
    assert.equal(responses.every((response) => response.ok), true);

    const eventsA = await waitForNdjsonEvents(sessionLogPath(dir, sessionA), 4);
    const eventsB = await waitForNdjsonEvents(sessionLogPath(dir, sessionB), 4);

    assert.deepEqual(
      eventsA.map((event) => event.probe).sort(),
      ["a.1", "a.2", "a.3", "a.4"],
    );
    assert.deepEqual(
      eventsB.map((event) => event.probe).sort(),
      ["b.1", "b.2", "b.3", "b.4"],
    );
  });
}

async function testEnsureIgnoresStaleStateFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "debug-mode-log-server-"));
  let pid;
  let healthUrl;

  try {
    await writeFile(
      path.join(dir, "collector.json"),
      JSON.stringify({
        pid: 999999,
        healthUrl: "http://127.0.0.1:9/health",
        debugUrl: "http://127.0.0.1:9",
        logDir: path.join(dir, "logs"),
      }),
    );

    const result = await runNode(
      [serverPath, "--ensure", "--dir", "logs", "--session", "stale-state", "--state", "collector.json"],
      { cwd: dir },
    );
    const info = parseKeyOutput(result.stdout);
    const health = await (await fetch(info.HEALTH_URL)).json();
    assert.equal(health.ok, true);
    assert.notEqual(health.pid, 999999);
    pid = health.pid;
    healthUrl = info.HEALTH_URL;
  } finally {
    await stopPid(pid, healthUrl);
    await rm(dir, { recursive: true, force: true });
  }
}

async function testEnsureRejectsNonLoopbackStateUrls() {
  const dir = await mkdtemp(path.join(tmpdir(), "debug-mode-log-server-"));
  const fakeCollector = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        pid: process.pid,
        debugUrl: "http://0.0.0.0:12345",
        healthUrl: "http://0.0.0.0:12345/health",
        logDir: path.join(dir, "fake-logs"),
      }),
    );
  });
  let pid;
  let healthUrl;

  try {
    const port = await listenOnLoopback(fakeCollector);
    await writeFile(
      path.join(dir, "collector.json"),
      JSON.stringify({
        pid: process.pid,
        healthUrl: `http://127.0.0.1:${port}/health`,
        debugUrl: `http://127.0.0.1:${port}`,
        logDir: path.join(dir, "fake-logs"),
      }),
    );

    const result = await runNode(
      [serverPath, "--ensure", "--dir", "logs", "--session", "non-loopback-state", "--state", "collector.json"],
      { cwd: dir },
    );
    const info = parseKeyOutput(result.stdout);

    assert.match(info.DEBUG_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(info.HEALTH_URL, /^http:\/\/127\.0\.0\.1:\d+\/health$/);

    const health = await (await fetch(info.HEALTH_URL)).json();
    pid = health.pid;
    healthUrl = info.HEALTH_URL;
    assert.equal(health.ok, true);
    assert.notEqual(health.pid, process.pid);
  } finally {
    await closeServer(fakeCollector);
    await stopPid(pid, healthUrl);
    await rm(dir, { recursive: true, force: true });
  }
}

async function testEnsureClearsStaleStartupLock() {
  const dir = await mkdtemp(path.join(tmpdir(), "debug-mode-log-server-"));
  let pid;
  let healthUrl;

  try {
    const lockDir = path.join(dir, "collector.json.lock");
    await mkdir(lockDir);
    const staleTime = new Date(Date.now() - 10_000);
    await utimes(lockDir, staleTime, staleTime);

    const result = await runNode(
      [serverPath, "--ensure", "--dir", "logs", "--session", "stale-lock", "--state", "collector.json"],
      { cwd: dir },
    );
    const info = parseKeyOutput(result.stdout);
    assert.equal(info.SESSION_ID, "stale-lock");

    const health = await (await fetch(info.HEALTH_URL)).json();
    pid = health.pid;
    healthUrl = info.HEALTH_URL;
    assert.equal(health.ok, true);
  } finally {
    await stopPid(pid, healthUrl);
    await rm(dir, { recursive: true, force: true });
  }
}

async function testEnsureReportsCollectorStartupFailure() {
  const dir = await mkdtemp(path.join(tmpdir(), "debug-mode-log-server-"));
  const blocker = net.createServer();

  try {
    const port = await listenOnLoopback(blocker);
    const result = await runNodeExpectFailure(
      [
        serverPath,
        "--ensure",
        "--dir",
        "logs",
        "--session",
        "startup-failure",
        "--state",
        "collector.json",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      { cwd: dir },
    );

    assert.match(result.stderr, /Failed to start the debug-mode collector/);
    assert.match(result.stderr, /Child stderr/);
    assert.match(result.stderr, /EADDRINUSE/);
  } finally {
    await closeServer(blocker);
    await rm(dir, { recursive: true, force: true });
  }
}

async function testConcurrentEnsureUsesSingleCollector() {
  const dir = await mkdtemp(path.join(tmpdir(), "debug-mode-log-server-"));

  try {
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        runNode(
          [
            serverPath,
            "--ensure",
            "--dir",
            "logs",
            "--session",
            `concurrent-${index + 1}`,
            "--state",
            "collector.json",
          ],
          { cwd: dir },
        ),
      ),
    );
    const infos = results.map((result) => parseKeyOutput(result.stdout));
    const debugUrls = new Set(infos.map((info) => info.DEBUG_URL));
    const healthUrls = new Set(infos.map((info) => info.HEALTH_URL));

    assert.equal(debugUrls.size, 1);
    assert.equal(healthUrls.size, 1);
    assert.deepEqual(
      infos.map((info) => info.SESSION_ID).sort(),
      ["concurrent-1", "concurrent-2", "concurrent-3", "concurrent-4"],
    );

    const healthUrl = [...healthUrls][0];
    const health = await (await fetch(healthUrl)).json();
    assert.equal(health.ok, true);
    await stopPid(health.pid, healthUrl);
  } finally {
    try {
      const state = JSON.parse(await readFile(path.join(dir, "collector.json"), "utf8"));
      await stopPid(state.pid, state.healthUrl);
    } catch {
      // Collector may already be stopped or may never have started.
    }
    await rm(dir, { recursive: true, force: true });
  }
}

await testRejectsNonLoopbackHost();
await testWritesValidNdjson();
await testDoesNotCreateLogFileBeforeFirstEvent();
await testRecreatesDeletedLogFile();
await testReportsWriteFailureBeforeReturningSuccess();
await testHealthEndpoint();
await testRoutesBodySessionToLogFile();
await testParallelSessionsWriteIndependently();
await testEnsureStartsAndReusesHealthyCollector();
await testStartCollectorWrapperUsesSafeDefaults();
await testStartCollectorWrapperRejectsUnsafeOrIncompleteArgs();
await testEnsureIgnoresStaleStateFile();
await testEnsureRejectsNonLoopbackStateUrls();
await testEnsureClearsStaleStartupLock();
await testEnsureReportsCollectorStartupFailure();
await testConcurrentEnsureUsesSingleCollector();
console.log("log-server tests passed");
