import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { downloadXlsxExport } from "../src/lib/export/download-xlsx-client.ts";

// The Resignations page's per-tab "Export" button (not "Export full history").
//
// On 2026-09-14 it failed 12 times in one second in production and the user saw nothing: the button
// had no busy state, so every click on a slow connection queued another upload of the rows, and its
// promise was never caught, so each failure became an unhandled rejection with no message on screen.
// The error monitor rows read only "Export failed", with no HTTP status to say why.
//
// What this pins:
//  - The shared client helper's failure names the HTTP status (checked by calling it, not by reading it).
//  - The button is disabled and relabelled while an export runs, so clicks cannot stack.
//  - A failure is caught, shown to the user, and still reported to the error monitor — a caught error
//    never reaches the global unhandledrejection net.

export async function runResignationsTabExportFailureTests() {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Too large." }), { status: 413 })) as typeof fetch;
    await assert.rejects(
      downloadXlsxExport({ columns: [{ key: "a", label: "A" }], rows: [], title: "Resignations — History" }),
      (error: unknown) => error instanceof Error && error.message === "Export failed (HTTP 413)",
      "a refused export must name its HTTP status",
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  const workspace = readFileSync("src/components/resignations/resignations-workspace.tsx", "utf8");
  const start = workspace.indexOf("async function exportCurrentTab()");
  const end = workspace.indexOf("async function exportFullHistory()");
  assert.ok(start > 0 && end > start, "exportCurrentTab must exist ahead of exportFullHistory");
  const handler = workspace.slice(start, end);

  assert.match(handler, /if \(busy === "export-tab"\) return;/, "a second click while exporting must do nothing");
  assert.match(handler, /setBusy\("export-tab"\)/, "the export must mark itself busy");
  assert.match(handler, /\}\s*catch \(caught\) \{\s*setError\(/, "a failed export must show a message");
  assert.match(
    handler,
    /reportClientError\(\{ context: `feature=resignations-tab-export/,
    "a caught failure must still reach the error monitor",
  );
  assert.match(handler, /finally \{\s*setBusy\(null\);/, "the button must come back after success or failure");

  assert.match(
    workspace,
    /<RgButton disabled=\{busy === "export-tab"\} kind="onDark" onClick=\{\(\) => void exportCurrentTab\(\)\}>\s*\{busy === "export-tab" \? "Exporting…" : "Export"\}/,
    "the Export button must be disabled and read Exporting… while it runs",
  );
}
