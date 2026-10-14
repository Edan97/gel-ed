// Session log, for debugging: what the page did and what the user did, with timestamps.
// Kept in memory only (nothing is sent anywhere); "Download log" saves it as text to
// share. No image data and no typed text (annotations, captions, names) go in it.

const MAX = 5000;
const start = Date.now();
const entries = [];
const last = new Map(); // event -> last data string, for logOnChange

export function log(event, data = {}) {
  entries.push({ ms: Date.now() - start, event, data });
  if (entries.length > MAX) entries.shift();
}

// Log only when the data differs from the last time this event was logged
// (e.g. analysis results while a slider is dragged).
export function logOnChange(event, data) {
  const key = JSON.stringify(data);
  if (last.get(event) === key) return;
  last.set(event, key);
  log(event, data);
}

window.addEventListener("error", (e) => log("error", { message: e.message, at: `${e.filename}:${e.lineno}:${e.colno}` }));
window.addEventListener("unhandledrejection", (e) => log("error", { message: String(e.reason && e.reason.message || e.reason) }));

export function logText() {
  const version = document.getElementById("version");
  const head = [
    "gel-ed session log",
    `page: ${location.origin}${location.pathname}`,
    `version: ${version ? `${version.textContent} (${version.title})` : "?"}`,
    `browser: ${navigator.userAgent}`,
    `started: ${new Date(start).toISOString()}`,
    `entries: ${entries.length}${entries.length >= MAX ? ` (oldest dropped; kept the last ${MAX})` : ""}`,
    "",
  ];
  const lines = entries.map((e) => `+${(e.ms / 1000).toFixed(2).padStart(8)}s  ${e.event}  ${JSON.stringify(e.data)}`);
  return head.concat(lines).join("\n") + "\n";
}
