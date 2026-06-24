#!/usr/bin/env node

import http from "node:http";
import { spawn } from "node:child_process";
import { appendFile, mkdir, open, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_ROOT = path.join(os.tmpdir(), "debug-mode-skill");
const DEFAULT_LOG_DIR = path.join(DEFAULT_ROOT, "logs");
const DEFAULT_STATE_FILE = path.join(DEFAULT_ROOT, "collector.json");
const SERVICE_VERSION = 1;
const ENSURE_TIMEOUT_MS = 5000;
const HEALTH_TIMEOUT_MS = 500;
const HEALTH_POLL_INTERVAL_MS = 100;
const STARTUP_ERROR_OUTPUT_LIMIT = 4000;
const SESSION_PATTERN = /^[A-Za-z0-9._-]+$/;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function usage() {
  console.log(`Usage: node scripts/log-server.mjs [--ensure] [--dir <path>] [--session <id>] [--port 0] [--host 127.0.0.1] [--state <path>]

Options:
  --ensure    Reuse a healthy shared collector or start one in the background
  --dir       Directory for NDJSON logs. Default: ${DEFAULT_LOG_DIR}
  --session   Session id and log filename stem. Default: dbg-<timestamp>-<random>
  --port      Port to bind. Use 0 for an available port. Default: 0
  --host      Loopback host to bind. Default: 127.0.0.1
  --state     Service discovery state file. Default: ${DEFAULT_STATE_FILE}
  --help      Show this help text
`);
}

function parseArgs(argv) {
  const args = {
    dir: DEFAULT_LOG_DIR,
    session: `dbg-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    port: 0,
    host: "127.0.0.1",
    state: DEFAULT_STATE_FILE,
    ensure: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2);
    if (key === "ensure") {
      args.ensure = true;
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    i += 1;

    if (key === "dir") args.dir = value;
    else if (key === "session") args.session = value;
    else if (key === "host") args.host = value;
    else if (key === "state") args.state = value;
    else if (key === "port") {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid port: ${value}`);
      }
      args.port = port;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  validateSession(args.session);

  if (!LOOPBACK_HOSTS.has(args.host)) {
    throw new Error(
      `Host must be loopback-only (127.0.0.1, localhost, or ::1). Refusing to bind ${args.host}.`,
    );
  }

  return args;
}

function validateSession(session) {
  if (typeof session !== "string" || !SESSION_PATTERN.test(session)) {
    const error = new Error("Session may only contain letters, digits, dot, underscore, and hyphen.");
    error.statusCode = 400;
    throw error;
  }
}

function resolvePath(value) {
  return path.resolve(process.cwd(), value);
}

function sessionLogFile(logDir, session) {
  validateSession(session);
  return path.join(logDir, `${session}.ndjson`);
}

function resolveEventSession(body, defaultSession) {
  if (!Object.hasOwn(body, "session")) return defaultSession;
  validateSession(body.session);
  return body.session;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      const error = new Error("Request body too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function writeJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...CORS_HEADERS,
  });
  res.end(payload);
}

function writeNoContent(res) {
  res.writeHead(204, CORS_HEADERS);
  res.end();
}

function formatHostForUrl(host) {
  return host.includes(":") ? `[${host}]` : host;
}

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startupError(message, stderr) {
  const details = stderr.trim();
  if (!details) return new Error(message);
  return new Error(`${message}\nChild stderr:\n${details}`);
}

async function readStartupOutput(file) {
  try {
    const output = await readFile(file, "utf8");
    return output.slice(-STARTUP_ERROR_OUTPUT_LIMIT);
  } catch {
    return "";
  }
}

const writeQueues = new Map();

async function drainWriteQueue() {
  await Promise.all([...writeQueues.values()].map((queue) => queue.catch(() => {})));
}

function enqueueWrite(logFile, line) {
  const previous = writeQueues.get(logFile) ?? Promise.resolve();
  const write = previous.then(() => appendFile(logFile, line));
  writeQueues.set(logFile, write.catch(() => {}));
  return write;
}

function printCollectorDetails({ debugUrl, healthUrl, logDir, session }) {
  console.log(`DEBUG_URL=${debugUrl}`);
  console.log(`SESSION_ID=${session}`);
  console.log(`LOG_DIR=${logDir}`);
  console.log(`LOG_FILE=${sessionLogFile(logDir, session)}`);
  console.log(`HEALTH_URL=${healthUrl}`);
}

async function writeStateFile(stateFile, state) {
  await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function readStateFile(stateFile) {
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    return null;
  }
}

async function removeStateFileIfOwned(stateFile) {
  const state = await readStateFile(stateFile);
  if (!state || state.pid !== process.pid) return;
  await unlink(stateFile).catch(() => {});
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function healthyStateFromResponse(state, body) {
  if (!state || !body || body.ok !== true) return null;
  if (typeof body.pid !== "number" || body.pid !== state.pid) return null;
  if (typeof body.debugUrl !== "string" || typeof body.logDir !== "string") return null;

  const healthUrl = body.healthUrl || `${body.debugUrl}/health`;
  if (!isLoopbackUrl(body.debugUrl) || !isLoopbackUrl(healthUrl)) return null;

  return {
    ...state,
    debugUrl: body.debugUrl,
    healthUrl,
    logDir: body.logDir,
    pid: body.pid,
    startedAt: body.startedAt,
  };
}

async function checkStateHealth(stateFile) {
  const state = await readStateFile(stateFile);
  if (!state || typeof state.healthUrl !== "string") return null;
  if (!isLoopbackUrl(state.healthUrl)) return null;
  const body = await fetchJson(state.healthUrl, HEALTH_TIMEOUT_MS);
  return healthyStateFromResponse(state, body);
}

async function waitForHealthyState(stateFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const healthy = await checkStateHealth(stateFile);
    if (healthy) return healthy;
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  return null;
}

async function removeStaleLock(lockDir, staleMs) {
  try {
    const stats = await stat(lockDir);
    if (Date.now() - stats.mtimeMs <= staleMs) return false;
    await rm(lockDir, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function acquireEnsureLock(stateFile, lockDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      return {
        existing: null,
        release: async () => {
          await rm(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      const existing = await checkStateHealth(stateFile);
      if (existing) {
        return {
          existing,
          release: async () => {},
        };
      }

      if (await removeStaleLock(lockDir, timeoutMs)) continue;
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
  }

  throw new Error(`Timed out waiting for the debug-mode collector startup lock: ${lockDir}`);
}

async function startDetachedCollector(args, logDir, stateFile) {
  const startupLogFile = `${stateFile}.startup-${process.pid}-${Date.now()}.log`;
  const startupLog = await open(startupLogFile, "w", 0o600);
  let child;
  try {
    child = spawn(
      process.execPath,
      [
        SCRIPT_PATH,
        "--dir",
        logDir,
        "--session",
        args.session,
        "--host",
        args.host,
        "--port",
        String(args.port),
        "--state",
        stateFile,
      ],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", "ignore", startupLog.fd],
      },
    );
  } finally {
    await startupLog.close().catch(() => {});
  }

  const closePromise = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });

  const result = await Promise.race([
    waitForHealthyState(stateFile, ENSURE_TIMEOUT_MS).then((healthy) => ({
      type: "healthy",
      healthy,
    })),
    closePromise.then((exit) => ({
      type: "exit",
      exit,
    })),
  ]);

  if (result.type === "healthy" && result.healthy) {
    await rm(startupLogFile, { force: true });
    child.unref();
    return result.healthy;
  }

  if (result.type === "exit") {
    const stderr = await readStartupOutput(startupLogFile);
    await rm(startupLogFile, { force: true });
    child.unref();
    const { code, signal } = result.exit;
    throw startupError(
      `Failed to start the debug-mode collector: code=${code ?? "null"} signal=${signal ?? "null"}.`,
      stderr,
    );
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // Best effort cleanup for a collector that never became discoverable.
  }
  const stderr = await readStartupOutput(startupLogFile);
  await rm(startupLogFile, { force: true });
  child.unref();
  throw startupError("Timed out waiting for the debug-mode collector to become healthy.", stderr);
}

async function ensureCollector(args) {
  const logDir = resolvePath(args.dir);
  const stateFile = resolvePath(args.state);
  const existing = await checkStateHealth(stateFile);
  if (existing) {
    printCollectorDetails({ ...existing, session: args.session });
    return;
  }

  await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const lock = await acquireEnsureLock(stateFile, `${stateFile}.lock`, ENSURE_TIMEOUT_MS);
  try {
    const lockedExisting = lock.existing ?? (await checkStateHealth(stateFile));
    if (lockedExisting) {
      printCollectorDetails({ ...lockedExisting, session: args.session });
      return;
    }

    await mkdir(logDir, { recursive: true });
    const healthy = await startDetachedCollector(args, logDir, stateFile);
    printCollectorDetails({ ...healthy, session: args.session });
  } finally {
    await lock.release();
  }
}

async function startCollector(args) {
  const logDir = resolvePath(args.dir);
  const stateFile = resolvePath(args.state);
  const startedAt = new Date().toISOString();
  let serviceInfo = null;

  await mkdir(logDir, { recursive: true });

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        writeNoContent(res);
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        writeJson(res, 200, {
          ok: true,
          version: SERVICE_VERSION,
          pid: process.pid,
          debugUrl: serviceInfo?.debugUrl,
          healthUrl: serviceInfo?.healthUrl,
          logDir,
          startedAt,
          uptimeMs: Date.now() - Date.parse(startedAt),
        });
        return;
      }

      if (req.method !== "POST" || req.url !== "/log") {
        writeJson(res, 404, { ok: false, error: "Use POST /log with a JSON object." });
        return;
      }

      const body = await readJsonBody(req);
      if (!body || Array.isArray(body) || typeof body !== "object") {
        writeJson(res, 400, { ok: false, error: "Body must be a JSON object." });
        return;
      }

      const session = resolveEventSession(body, args.session);
      const logFile = sessionLogFile(logDir, session);
      const event = {
        ...body,
        ts: new Date().toISOString(),
        session,
      };

      await enqueueWrite(logFile, `${JSON.stringify(event)}\n`);
      writeJson(res, 200, { ok: true, session, logFile });
    } catch (error) {
      writeJson(res, error.statusCode || 500, { ok: false, error: error.message || String(error) });
    }
  });

  const shutdown = async (code) => {
    server.close(async () => {
      await drainWriteQueue();
      await removeStateFileIfOwned(stateFile);
      process.exit(code);
    });
  };

  server.on("error", async (error) => {
    await drainWriteQueue();
    console.error(`Failed to start debug log server: ${error.message}`);
    process.exit(1);
  });

  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.on(signal, () => {
      shutdown(code);
    });
  }

  server.listen(args.port, args.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : args.port;
    const debugUrl = `http://${formatHostForUrl(args.host)}:${port}`;
    const healthUrl = `${debugUrl}/health`;
    serviceInfo = {
      version: SERVICE_VERSION,
      pid: process.pid,
      host: args.host,
      port,
      debugUrl,
      healthUrl,
      logDir,
      stateFile,
      startedAt,
    };

    writeStateFile(stateFile, serviceInfo)
      .catch((error) => {
        console.error(`Failed to write debug log server state: ${error.message || String(error)}`);
      })
      .finally(() => {
        printCollectorDetails({ debugUrl, healthUrl, logDir, session: args.session });
      });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.ensure) {
    await ensureCollector(args);
    return;
  }
  await startCollector(args);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
