#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";

function usage() {
  console.log(`Usage: node scripts/summarize-log.mjs <LOG_FILE> [--json] [--expect-probe <name>]

Options:
  --json              Print machine-readable JSON
  --expect-probe      Mark a probe as expected; repeat for multiple probes
  --help              Show this help text
`);
}

function parseArgs(argv) {
  const args = {
    file: null,
    json: false,
    expectedProbes: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }

    if (arg === "--json") {
      args.json = true;
      continue;
    }

    if (arg === "--expect-probe") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value for --expect-probe");
      args.expectedProbes.push(value);
      i += 1;
      continue;
    }

    if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    if (args.file) throw new Error(`Unexpected argument: ${arg}`);
    args.file = arg;
  }

  if (!args.file) throw new Error("Missing LOG_FILE argument.");
  return args;
}

function sortedValues(values) {
  return [...values].sort();
}

function incrementCount(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function parseNdjson(raw) {
  const events = [];
  const lines = raw.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      const event = JSON.parse(line);
      if (!event || Array.isArray(event) || typeof event !== "object") {
        throw new Error("line is not a JSON object");
      }
      events.push(event);
    } catch (error) {
      throw new Error(`Invalid JSON on line ${index + 1}: ${error.message}`);
    }
  }

  return events;
}

function summarizeEvents(events, expectedProbes) {
  const sessions = new Set();
  const runIds = {};
  const hypotheses = {};
  const probes = {};

  for (const event of events) {
    if (typeof event.session === "string") sessions.add(event.session);
    if (typeof event.runId === "string") incrementCount(runIds, event.runId);

    const hypothesis = typeof event.hypothesis === "string" ? event.hypothesis : "unlabeled";
    const probe = typeof event.probe === "string" ? event.probe : "unlabeled";

    hypotheses[hypothesis] ??= {
      count: 0,
      probes: new Set(),
      runIds: new Set(),
    };
    hypotheses[hypothesis].count += 1;
    hypotheses[hypothesis].probes.add(probe);
    if (typeof event.runId === "string") hypotheses[hypothesis].runIds.add(event.runId);

    probes[probe] ??= {
      count: 0,
      hypotheses: new Set(),
      runIds: new Set(),
      firstTs: event.ts,
      lastTs: event.ts,
      lastVars: undefined,
    };
    probes[probe].count += 1;
    probes[probe].hypotheses.add(hypothesis);
    if (typeof event.runId === "string") probes[probe].runIds.add(event.runId);
    if (typeof event.ts === "string") probes[probe].lastTs = event.ts;
    if (Object.hasOwn(event, "vars")) probes[probe].lastVars = event.vars;
  }

  return {
    totalEvents: events.length,
    sessions: sortedValues(sessions),
    runIds: Object.fromEntries(Object.entries(runIds).sort(([a], [b]) => a.localeCompare(b))),
    hypotheses: Object.fromEntries(
      Object.entries(hypotheses)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => [
          name,
          {
            count: value.count,
            probes: sortedValues(value.probes),
            runIds: sortedValues(value.runIds),
          },
        ]),
    ),
    probes: Object.fromEntries(
      Object.entries(probes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => [
          name,
          {
            count: value.count,
            hypotheses: sortedValues(value.hypotheses),
            runIds: sortedValues(value.runIds),
            firstTs: value.firstTs,
            lastTs: value.lastTs,
            lastVars: value.lastVars,
          },
        ]),
    ),
    missingExpectedProbes: expectedProbes.filter((probe) => !Object.hasOwn(probes, probe)).sort(),
  };
}

function formatTextSummary(summary) {
  const lines = [
    `Events: ${summary.totalEvents}`,
    `Sessions: ${summary.sessions.length ? summary.sessions.join(", ") : "(none)"}`,
    `Run IDs: ${Object.keys(summary.runIds).length ? JSON.stringify(summary.runIds) : "(none)"}`,
    "",
    "Hypotheses:",
  ];

  for (const [name, value] of Object.entries(summary.hypotheses)) {
    lines.push(`- ${name}: ${value.count} event(s); probes=${value.probes.join(", ") || "(none)"}`);
  }

  lines.push("", "Probes:");
  for (const [name, value] of Object.entries(summary.probes)) {
    const runIds = value.runIds.length ? value.runIds.join(", ") : "(none)";
    lines.push(`- ${name}: ${value.count} event(s); runIds=${runIds}; lastTs=${value.lastTs ?? "(none)"}`);
  }

  if (summary.missingExpectedProbes.length > 0) {
    lines.push("", `Missing expected probes: ${summary.missingExpectedProbes.join(", ")}`);
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const events = parseNdjson(await readFile(args.file, "utf8"));
  const summary = summarizeEvents(events, args.expectedProbes);

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  process.stdout.write(formatTextSummary(summary));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
