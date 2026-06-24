import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

async function loadHelper(relativePath, globals) {
  const source = await readFile(path.join(repoRoot, relativePath), "utf8");
  const context = { ...globals };
  runInNewContext(`${source}\nglobalThis.__debugModeLog = debugModeLog;`, context, {
    filename: relativePath,
  });
  return context.__debugModeLog;
}

async function testBrowserHelperUsesSendBeaconFirst() {
  let beaconRequest;
  const debugModeLog = await loadHelper("skills/debug-mode/assets/browser-log-helper.js", {
    navigator: {
      sendBeacon(url, payload) {
        beaconRequest = { url, payload };
        return true;
      },
    },
    fetch() {
      throw new Error("fetch should not be called when sendBeacon succeeds");
    },
  });

  debugModeLog({ probe: "browser.beacon", vars: { enabled: true } });

  assert.equal(beaconRequest.url, "<DEBUG_URL>/log");
  assert.deepEqual(JSON.parse(beaconRequest.payload), {
    probe: "browser.beacon",
    vars: { enabled: true },
    session: "<session_id>",
    source: "browser",
  });
}

async function testBrowserHelperFallsBackToFetch() {
  let fetchRequest;
  const debugModeLog = await loadHelper("skills/debug-mode/assets/browser-log-helper.js", {
    navigator: {
      sendBeacon() {
        return false;
      },
    },
    fetch(url, options) {
      fetchRequest = { url, options };
      return Promise.resolve({ ok: true });
    },
  });

  debugModeLog({ probe: "browser.fetch" });

  assert.equal(fetchRequest.url, "<DEBUG_URL>/log");
  assert.equal(fetchRequest.options.method, "POST");
  assert.equal(fetchRequest.options.headers["content-type"], "application/json");
  assert.equal(fetchRequest.options.keepalive, true);
  assert.deepEqual(JSON.parse(fetchRequest.options.body), {
    probe: "browser.fetch",
    session: "<session_id>",
    source: "browser",
  });
}

async function testNodeHelperPostsStructuredPayload() {
  let fetchRequest;
  const debugModeLog = await loadHelper("skills/debug-mode/assets/node-log-helper.js", {
    fetch(url, options) {
      fetchRequest = { url, options };
      return Promise.resolve({ ok: true });
    },
  });

  debugModeLog({ probe: "node.post", hypothesis: "H1" });

  assert.equal(fetchRequest.url, "<DEBUG_URL>/log");
  assert.equal(fetchRequest.options.method, "POST");
  assert.equal(fetchRequest.options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(fetchRequest.options.body), {
    probe: "node.post",
    hypothesis: "H1",
    session: "<session_id>",
    source: "node",
  });
}

async function testHelpersIgnoreInvalidEvents() {
  let fetchCalls = 0;
  const debugModeLog = await loadHelper("skills/debug-mode/assets/node-log-helper.js", {
    fetch() {
      fetchCalls += 1;
      return Promise.resolve({ ok: true });
    },
  });

  debugModeLog(null);
  debugModeLog([]);

  assert.equal(fetchCalls, 0);
}

await testBrowserHelperUsesSendBeaconFirst();
await testBrowserHelperFallsBackToFetch();
await testNodeHelperPostsStructuredPayload();
await testHelpersIgnoreInvalidEvents();

console.log("helper asset tests passed");
