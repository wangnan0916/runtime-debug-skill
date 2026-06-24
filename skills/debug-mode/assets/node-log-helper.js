// #region DEBUG_MODE_PROBE <session_id> node-log-helper
const DEBUG_MODE_SESSION = "<session_id>";
const DEBUG_MODE_URL = "<DEBUG_URL>/log";

const debugModeLog = (event) => {
  try {
    if (!event || typeof event !== "object" || Array.isArray(event)) return;

    fetch(DEBUG_MODE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...event,
        session: DEBUG_MODE_SESSION,
        source: "node",
      }),
    }).catch(() => {});
  } catch {
    // Debug-mode probes must never affect product behavior.
  }
};
// #endregion DEBUG_MODE_PROBE <session_id>
