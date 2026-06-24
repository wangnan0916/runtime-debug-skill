#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG_SERVER_PATH = path.join(SCRIPT_DIR, "log-server.mjs");
const FIXED_HOST = "127.0.0.1";
const FIXED_PORT = "0";
const FIXED_ARGS = ["--ensure", "--host", FIXED_HOST, "--port", FIXED_PORT];
const PASSTHROUGH_OPTIONS = new Set(["--session", "--dir", "--state"]);

function usage() {
  console.log(`Usage: node scripts/start-collector.mjs --session <id> [--dir <path>] [--state <path>]

Starts or reuses the debug-mode collector with safe fixed network settings:
  --host ${FIXED_HOST}
  --port ${FIXED_PORT}

Options:
  --session   Session id and log filename stem
  --dir       Optional directory for NDJSON logs
  --state     Optional service discovery state file
  --help      Show this help text
`);
}

function readValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
  return value;
}

function parseArgs(argv) {
  const passthrough = [];
  let hasSession = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }

    if (arg === "--host" || arg === "--port") {
      const fixedValue = arg === "--host" ? FIXED_HOST : FIXED_PORT;
      throw new Error(`${arg} is fixed to ${fixedValue}; do not pass it to start-collector.mjs.`);
    }

    if (arg === "--ensure") {
      throw new Error("--ensure is implied by start-collector.mjs; do not pass it explicitly.");
    }

    if (PASSTHROUGH_OPTIONS.has(arg)) {
      const value = readValue(argv, i, arg);
      passthrough.push(arg, value);
      if (arg === "--session") hasSession = true;
      i += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (!hasSession) throw new Error("Missing required --session <id>.");
  return passthrough;
}

function main() {
  const passthrough = parseArgs(process.argv.slice(2));
  const child = spawn(process.execPath, [LOG_SERVER_PATH, ...FIXED_ARGS, ...passthrough], {
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

try {
  main();
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
