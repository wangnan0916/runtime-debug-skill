# Debug Mode Skill

Agent-agnostic, opt-in debug mode for reproducible runtime bugs. It includes
first-class probe helpers for browser/frontend JavaScript and Node.js, while
the local collector accepts the same structured events from other runtimes.

Agents add temporary structured probes, collect NDJSON evidence through a
local loopback collector, wait for you to reproduce manually, fix from log proof,
verify once, then clean up.

```text
hypothesize -> instrument -> reproduce -> inspect evidence -> fix -> verify -> clean up
```

## When to Use

Use this skill only when you explicitly ask for it, for example:

- `$debug-mode` or `debug mode`
- instrumented debugging
- local runtime log collection with temporary probes

For ordinary bug reports, failing tests, build errors, or issues already
explained by existing logs, agents should debug normally without this workflow.

Full opt-in rules and the agent workflow live in
[`skills/debug-mode/SKILL.md`](skills/debug-mode/SKILL.md).

## How It Works

1. The agent states ranked hypotheses and adds 3–8 targeted probes.
2. A small loopback collector receives structured events at `POST /log` and
   writes one NDJSON line per event.
3. The agent stops and asks you to reproduce the bug manually.
4. After you reply, it summarizes the log, confirms or rejects hypotheses,
   states the fix acceptance criteria, makes a minimal fix, verifies once with
   probes still active, then removes all instrumentation.

Probe templates for browser/frontend JavaScript and Node/server-side JavaScript
live under `skills/debug-mode/assets/`. Agents start collection with
`skills/debug-mode/scripts/start-collector.mjs`; the lower-level collector is
`skills/debug-mode/scripts/log-server.mjs`; the NDJSON summary script is
`skills/debug-mode/scripts/summarize-log.mjs`.

Agents run `node <skill-dir>/scripts/start-collector.mjs --session <id>`. The
wrapper fixes host to `127.0.0.1` and port to `0`, then delegates to
`log-server.mjs --ensure`. It reuses a healthy collector when available; if it
starts one, the child binds only to loopback and writes state/log files under
the OS temp directory. If command authorization is denied, agents stop and wait
for you to run the same command locally before adding probes.

## Usage

Ask your agent explicitly:

```text
Use $debug-mode to investigate this reproducible runtime bug with temporary probes, manual reproduction, log evidence, a minimal fix, and cleanup.
```

When the agent pauses for manual verification, reply with the leading letter:

```text
A - Reproduced
B - Fixed
C - Other; describe what happened
```

Checkpoint wording, evidence format, troubleshooting, and cleanup steps are in
`SKILL.md`.

## Install

Install or inspect with the open Agent Skills CLI:

```bash
npx skills add wangnan0916/debug-mode-skill
npx skills add wangnan0916/debug-mode-skill -g
npx skills add wangnan0916/debug-mode-skill -a codex
npx skills add wangnan0916/debug-mode-skill --list
npx skills update debug-mode
```

Use `-g` for global install, `-a codex` for a specific agent, `--list` to list
without installing, and `npx skills update debug-mode` to update later.

## Layout

```text
skills/debug-mode/
  SKILL.md                 # full agent workflow and protocol
  agents/openai.yaml       # Codex / OpenAI skill UI metadata
  assets/
    browser-log-helper.js  # copy into frontend code
    node-log-helper.js     # copy into Node/server code
  scripts/
    start-collector.mjs    # safe fixed-host collector entrypoint
    log-server.mjs         # loopback NDJSON collector
    summarize-log.mjs      # local NDJSON evidence summarizer

tests/                     # Node built-in tests for collector, helpers, and summarizer
```

## Safety

- Collector binds to loopback only (`127.0.0.1`, `localhost`, or `::1`).
- `start-collector.mjs` fixes host to `127.0.0.1` and port to `0`, then delegates
  to the reusable `--ensure` collector path.
- Approval denial is terminal for that collector command; agents stop until they
  have user-provided collector details or a safe file-based fallback.
- Probes must not log secrets, tokens, cookies, auth headers, or raw private
  payloads.
- Temporary instrumentation uses `DEBUG_MODE_PROBE <session_id>` region markers
  so agents can remove it mechanically.
- Debug logs are local temp evidence and should not be committed.

## Development

```bash
npm run check
npm test
```

Requires Node.js 24+. Tests use only Node.js built-ins.

## License

MIT. See [LICENSE](LICENSE).
