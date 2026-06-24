---
name: debug-mode
description: Opt-in, hypothesis-driven debugging workflow for reproducible runtime bugs using temporary instrumentation, structured NDJSON logs, manual reproduction, evidence-based fixes, post-fix verification, and cleanup. Use only when the user explicitly invokes debug-mode, $debug-mode, "debug mode", "instrumented debugging", or local runtime log collection. Do not auto-trigger for ordinary bug reports, failing tests, frontend/UI bugs, requests to investigate, runtime logs, or requests to add probes unless the user explicitly asks for this workflow.
---

# Debug Mode

Use this skill only after the user explicitly invokes `debug-mode`,
`$debug-mode`, `debug mode`, or instrumented debugging.

If the user did not explicitly opt in, debug normally. Mention this skill only
when temporary runtime instrumentation would materially help.

## Core Loop

Run a hypothesis-driven debugging loop:

1. Capture the Bug Intake below, then read the relevant code, repro details,
   existing logs, and recent changes.
2. List 2-5 ranked hypotheses with IDs such as `H1`, `H2`, and `H3` using the
   Hypothesis Matrix. Each hypothesis must predict what a runtime probe will
   show and what evidence would confirm or reject it.
3. Start or reuse the loopback collector (Collector Contract).
4. Add 3-8 targeted probes that distinguish the hypotheses. Use structured
   events sent to `DEBUG_URL + "/log"`, never stdout/stderr. Follow Event
   Shape, Region Markers, and Helpers below.
5. Stop at the manual checkpoint. Send a Checkpoint Template. Do not analyze,
   fix, or remove probes until the user replies with `A`, `B`, or `C`.
6. After `A`, summarize the printed `LOG_FILE`, inspect the raw events as
   needed, classify each hypothesis as `CONFIRMED`, `REJECTED`, or
   `INCONCLUSIVE`, and make the smallest fix only when the logs explain the
   root cause. Follow Evidence Summary below.
7. Keep probes active for one post-fix run tagged with `runId: "post-fix"`.
8. After the user replies `B` to the post-fix checkpoint, remove all
   instrumentation and run relevant checks. Follow Cleanup Checklist below.

## Bug Intake

Before adding probes, capture missing context without over-interviewing. Use
the user's text where possible and ask only for fields that block useful probes:

- Symptom: what happened?
- Expected behavior: what should have happened?
- Repro steps: exact action, input, route, command, or fixture.
- Environment: browser, OS, runtime, branch, feature flag, account, or dataset.
- Frequency: always, intermittent, or unknown.
- Recent changes or existing logs that may matter.
- Acceptance criteria: the original symptom is gone and expected behavior still
  works.

## Hypothesis Matrix

Write hypotheses in this shape before instrumenting:

```text
H1 <short cause>
Prediction: <what runtime state/path/timing will show>
Probe: <event names or code locations>
Confirm if: <specific log condition>
Reject if: <specific log condition>
```

Prefer probes that distinguish two hypotheses at once. If no hypothesis predicts
a concrete probe result, read more code before instrumenting.

## Hard Rules

- Never skip the manual reproduction checkpoint after adding probes.
- Never fix from guesswork while this skill is active.
- Never remove probes before the user confirms the post-fix check.
- Never commit debug logs or temporary instrumentation.
- Never retry the same collector command after an approval denial or approval
  service disconnect. Stop and send the Collector Setup Blocked Template.
- Never add HTTP probes until `DEBUG_URL`, `SESSION_ID`, and `LOG_FILE` are
  known from a successful collector start or user-provided collector details.
- Never log secrets, tokens, cookies, authorization headers, API keys, raw
  request bodies, raw responses that may contain private data, or unnecessary
  personal data.

## Collector Contract

The bundled collector is intentionally small:

- `GET /health` checks whether an existing collector is reusable.
- `POST /log` accepts one JSON object and appends one NDJSON line before
  returning `200`, so write failures are visible to the caller.
- `scripts/summarize-log.mjs <LOG_FILE>` summarizes sessions, run IDs,
  hypotheses, probes, last variables, and missing expected probes.
- Different sessions write to separate files with independent queues, so writes
  can proceed in parallel across sessions.
- Logs live under the OS temp directory by default, outside the workspace.
- `--ensure` prints `DEBUG_URL`, `SESSION_ID`, `LOG_DIR`, `LOG_FILE`, and
  `HEALTH_URL`.
- `scripts/start-collector.mjs` is the preferred safe entrypoint. It starts or
  reuses one shared loopback collector with fixed host `127.0.0.1` and port `0`.
  Leave it running across debug-mode sessions unless the user explicitly asks to
  stop it.
- The collector creates `LOG_FILE` on the first event. Do not `touch`,
  pre-create, truncate, or clear it after a repro.
- The collector is loopback-only. Do not bind it to `0.0.0.0` or any public
  interface.

Start or reuse the shared collector in the agent's default sandbox:

```bash
node <skill-dir>/scripts/start-collector.mjs --session <session_id>
```

Do not pass `--host`, `--port`, or `--ensure`; `start-collector.mjs` fixes those
values and delegates to `log-server.mjs --ensure --host 127.0.0.1 --port 0`.
The delegated `--ensure` path:

- reuses only healthy loopback collector state with a matching `pid`;
- ignores stale or non-loopback state;
- clears stale startup locks after the startup timeout;
- starts one detached child serving only `GET /health`, `POST /log`, and CORS
  `OPTIONS` when needed.

The start command does not write to the repository, bind to LAN/public
interfaces, or make external network calls. Its normal files are temp-directory
state, startup log, and NDJSON evidence files. `LOG_FILE` is printed immediately
but is not created until the first accepted `POST /log` event.

Do not request elevated approval preemptively. Retry the same wrapper command
only after a default-sandbox attempt fails with a clear sandbox, permission,
local listener, or detached-process error. Scope the justification to starting
or reusing this loopback-only debug collector.
Use this approval justification shape:

```text
Start or reuse the debug-mode loopback collector. It binds only to 127.0.0.1,
writes state/log files under the OS temp directory, does not write to the
repository, and does not make external network calls.
```

If approval is denied or the approval service disconnects, do not retry, request
broader permissions, or add HTTP probes. Send the Collector Setup Blocked
Template below and wait.

If the user pastes `DEBUG_URL`, `SESSION_ID`, `LOG_DIR`, `LOG_FILE`, and
`HEALTH_URL`, use those values and do not start another collector. Otherwise
continue only when the runtime has a safe file-based probe path that needs no
more approval; browser/frontend bugs usually do not.

## Collector Setup Blocked Template

If collector setup is denied before probes are added, stop and send only this
shape with the real command. Do not include hypotheses, edited files, or extra
commentary.

```text
debug-mode local collection is blocked by command authorization.

Please run this command in your terminal:

node <skill-dir>/scripts/start-collector.mjs --session <session_id>

Then paste the printed DEBUG_URL, SESSION_ID, LOG_DIR, LOG_FILE, and HEALTH_URL.

I will wait before adding probes.
```

If the user cannot run the command, local collection is blocked. Continue only
when a safe file-based probe path exists for the runtime; otherwise ask for a
different repro path that does not require runtime collection.

## Checkpoint Templates

Checkpoint replies are protocol messages, not progress summaries. After adding
probes or after a post-fix change, send only the appropriate checkpoint
template. Do not add a list of edited files, probes, validation commands,
analysis, next-action commentary, or a narrowed instruction such as "reply A".
The checkpoint must always offer all three state-machine options: `A`, `B`, and
`C`.

Use the templates below verbatim unless the user explicitly asked for another
language. If translating, preserve the same fields, the same order, and all
three `A`/`B`/`C` options, with no extra content.

After adding probes, stop and send this shape with real session details:

```text
I added debug-mode probes and the collector is writing:

- Session: <session_id>
- Log file: <LOG_FILE>
- Debug endpoint: <DEBUG_URL>/log

Please reproduce the bug manually, then reply:

A - Reproduced
B - Fixed
C - Other; describe what happened
```

For post-fix verification, change only the opening sentence:

```text
I kept debug-mode probes active for post-fix verification and the collector is writing:

- Session: <session_id>
- Log file: <LOG_FILE>
- Debug endpoint: <DEBUG_URL>/log

Please verify the original bug manually, then reply:

A - Reproduced
B - Fixed
C - Other; describe what happened
```

Interpret checkpoint replies as a small state machine:

- `A` before a fix: read the NDJSON log, classify hypothesis evidence, then fix
  only a confirmed cause or add narrower probes.
- `A` after a fix: the bug still reproduced. Read the post-fix log and continue
  with narrower hypotheses or probes.
- `B` before a fix: not a terminal state. Treat it as evidence that the bug did
  not reproduce under instrumentation and ask for clarification or a narrower
  repro.
- `B` after a fix: remove probes and run final checks.
- `C` at any time: treat the user's text as evidence. Adjust the repro,
  hypotheses, or probes.

## Event Shape

Use structured, low-volume events. A typical event looks like:

```json
{
  "session": "<session_id>",
  "runId": "pre-fix",
  "probe": "settings.beforePersist",
  "hypothesis": "H1",
  "file": "src/settings/save.ts",
  "fn": "saveSettings",
  "vars": {
    "enabled": true,
    "userId": "redacted"
  }
}
```

Use `runId: "pre-fix"` before the fix and `runId: "post-fix"` for verification.
For high-frequency paths, log only on state changes or sample aggressively.

## Region Markers

Wrap all temporary instrumentation so cleanup can be mechanical:

```ts
// #region DEBUG_MODE_PROBE <session_id> settings-before-persist
debugModeLog({
  probe: "settings.beforePersist",
  hypothesis: "H1",
  file: "src/settings/save.ts",
  fn: "saveSettings",
  vars: { enabled, userId: "redacted" },
});
// #endregion DEBUG_MODE_PROBE <session_id>
```

For non-JavaScript files, use the file's native comment syntax around the
same `DEBUG_MODE_PROBE <session_id>` marker. The exact marker text matters for
cleanup; the comment style does not.

## Helpers

JavaScript has first-class helper templates:

- Browser or frontend JavaScript: copy `assets/browser-log-helper.js`.
- Node.js or server-side JavaScript: copy `assets/node-log-helper.js`.

After copying either helper, replace `<session_id>` and `<DEBUG_URL>`, and keep
the function name `debugModeLog`.

Do not invent reusable helpers for other runtimes while this skill is active. If
the bug requires non-JavaScript instrumentation, use the same Event Shape and
Collector Contract, but write only the smallest local probe needed there.

## Evidence Summary

After an `A` reply, summarize evidence before editing code:

```bash
node <skill-dir>/scripts/summarize-log.mjs <LOG_FILE> --expect-probe <probe_name>
```

```text
H1 settings state is lost before API call
Status: CONFIRMED
Evidence: settings.beforePersist logged enabled=false while the UI event logged enabled=true.

H2 API rejects the value
Status: REJECTED
Evidence: no API call happened in this repro.

Acceptance: original toggle state persists after Save without regressing the API call path.
Next action: fix the local state handoff between onToggle and saveSettings.
```

If every hypothesis is `REJECTED` or `INCONCLUSIVE`, generate new hypotheses
from a different subsystem and add narrower probes. Do not patch from vibes.

Before editing, state the acceptance criteria for the fix in one sentence. The
post-fix checkpoint verifies that criterion, not just that the code changed.

## Troubleshooting

- Empty log: confirm the app executed the instrumented path, the session id
  matches, and the endpoint includes `/log`.
- Browser blocked request: check mixed content, CSP `connect-src`, extension
  isolation, or content-script context.
- CORS/preflight issue: the collector handles `OPTIONS`; if it still fails, try
  `navigator.sendBeacon`, a same-origin dev-server proxy, or server-side
  instrumentation.
- Host rejected: use `127.0.0.1`, `localhost`, or `::1`; never bind to LAN or
  public interfaces.
- Sandbox blocks listener: try the safe `start-collector.mjs` command in the
  default sandbox first. Retry once with the approval justification above only
  after a clear sandbox/listener/process failure. If denied, send the Collector
  Setup Blocked Template.
- Too many logs: replace noisy probes with narrower state-change probes.
- Cannot reproduce: ask for exact steps, environment, input data, or a screen
  recording; do not invent a fix.

## Cleanup Checklist

Before declaring the task done:

- Re-run the original repro or the closest available automated check.
- Remove every paired region marked `DEBUG_MODE_PROBE <session_id>`.
- Search for the session id, `DEBUG_MODE_PROBE`,
  `#region DEBUG_MODE_PROBE`, and `#endregion DEBUG_MODE_PROBE`.
- Remove the session NDJSON log at the printed `LOG_FILE`, or confirm it should
  be kept as local evidence.
- Leave the reusable loopback collector running unless the user asked to stop it.
- Keep only the product fix and any useful regression test.
