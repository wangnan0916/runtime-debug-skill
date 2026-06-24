// #region DEBUG_MODE_PROBE <session_id> browser-log-helper
const DEBUG_MODE_SESSION = "<session_id>";
const DEBUG_MODE_URL = "<DEBUG_URL>/log";

const debugModeLog = (event) => {
  try {
    if (!event || typeof event !== "object" || Array.isArray(event)) return;

    const payload = JSON.stringify({
      ...event,
      session: DEBUG_MODE_SESSION,
      source: "browser",
    });

    if (navigator.sendBeacon?.(DEBUG_MODE_URL, payload)) return;

    fetch(DEBUG_MODE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Debug-mode probes must never affect product behavior.
  }
};
// #endregion DEBUG_MODE_PROBE <session_id>
