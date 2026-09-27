import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { reportClientError } from "../src/lib/error-monitor/report-client-error.ts";
import {
  buildCvPreviewFailureReport,
  CvPreviewNotice,
  shouldReportCvPreviewFailure,
} from "../src/lib/recruitment/cv-preview-failure-report.ts";

/**
 * On 2026-09-14 managers across the field got "Promise.withResolvers is not a function" on every
 * PDF CV (#3833), and production `app_error_events` held ZERO rows for it. The CV viewer caught the
 * failure, put it on the screen, and told nobody else — a caught error never reaches the global
 * window.onerror net. These pin that a CV load failure now reaches the error monitor, carrying the
 * CV kind but never the file name or the candidate, and that the designed notices (a photograph a
 * manager may not see, a legacy .doc) stay out of it.
 */
export function runCvPreviewFailureReportTests() {
  const fileName = "Ahmed Mohamed Hassan CV.pdf";
  const candidateId = "3f2c4a1e-9b7d-4c2e-8a11-0d5e6f7a8b9c";
  const route = `/employee-portals/hiring/candidates/${candidateId}/cv`;

  // ── The headline: the exact failure that went unrecorded ─────────────────────────────────────
  const thrown = new TypeError("Promise.withResolvers is not a function");
  const report = buildCvPreviewFailureReport({ caught: thrown, fileName, httpStatus: 200, kind: "pdf", route, stage: "render" });

  assert.ok(report, "a pdf.js render failure must produce a report — returning null is the silence this exists to end");
  assert.equal(
    (report.error as Error).message,
    "Promise.withResolvers is not a function",
    "the thrown message travels verbatim, so every manager's failure groups into one row family",
  );
  assert.equal((report.error as Error).name, "TypeError", "the error class survives, it narrows the failure");
  assert.match(report.context ?? "", /\bcvKind=pdf\b/, "the row must say which kind of CV failed");
  assert.match(report.context ?? "", /\bstage=render\b/, "and where in the load it failed");
  assert.match(report.context ?? "", /\bhttpStatus=200\b/, "and that the bytes did arrive");
  assert.match(report.context ?? "", /\bfeature=cv-preview\b/, "and that it came from the CV viewer, not the page around it");

  // ── Personal data never travels ───────────────────────────────────────────────────────────────
  assert.equal(report.route, "/employee-portals/hiring/candidates/[id]/cv", "the route names the screen, never which candidate was on it");
  assert.ok(!JSON.stringify(report).includes(candidateId), "the candidate id must appear nowhere in the report");

  const echoed = new Error(`Invalid PDF structure in ${fileName}`);
  const echoedReport = buildCvPreviewFailureReport({ caught: echoed, fileName, kind: "pdf", route, stage: "render" });
  assert.ok(echoedReport, "a renderer echoing the name is still a real failure");
  const echoedText = `${(echoedReport.error as Error).message}\n${(echoedReport.error as Error).stack ?? ""}`;
  assert.ok(!echoedText.includes(fileName), "a file name a renderer echoes into its message or stack must be scrubbed before it is reported");
  assert.match((echoedReport.error as Error).message, /Invalid PDF structure in \[cv file\]/, "the rest of the message survives the scrub");

  const queried = buildCvPreviewFailureReport({ caught: thrown, kind: "docx", route: `/recruitment/12345678?file=${fileName}`, stage: "fetch" });
  assert.equal(queried?.route, "/recruitment/[id]", "a numeric id and a query string naming the file are both dropped");

  // ── A designed notice is NOT a failure ────────────────────────────────────────────────────────
  const photoNotice = new CvPreviewNotice("This CV is a photograph, so the phone number printed on it cannot be covered.");
  const docNotice = new CvPreviewNotice("This older Word (.doc) file holds no text that can be shown on screen.");
  for (const notice of [photoNotice, docNotice]) {
    assert.equal(shouldReportCvPreviewFailure(notice), false, `a designed notice is not reported: ${notice.message}`);
    assert.equal(buildCvPreviewFailureReport({ caught: notice, kind: "image", route, stage: "render" }), null);
  }
  assert.ok(photoNotice instanceof Error, "a notice stays an Error, so the screen shows its message exactly as before");

  // A thrown non-Error (a rejected body, a plain object) is still a failure, and still legible.
  const plain = buildCvPreviewFailureReport({ caught: "Failed to fetch", httpStatus: null, kind: "image", route, stage: "fetch" });
  assert.equal((plain?.error as Error).message, "Failed to fetch");
  assert.ok(!(plain?.context ?? "").includes("httpStatus"), "no status is claimed when the fetch never answered");
  assert.equal((plain?.error as Error).stack, undefined, "a thrown string has no stack, and must not borrow this helper's");

  // ── The EMITTED payload, not the builder's intent ─────────────────────────────────────────────
  // reportClientError is what writes to /api/errors/client. Capture the body it really sends.
  const originalFetch = globalThis.fetch;
  const sent: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    sent.push({ body: String(init?.body ?? ""), url: String(url) });
    return new Response("{}");
  }) as unknown as typeof fetch;
  try {
    reportClientError(report);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(sent.length, 1, "reporting a CV failure must POST exactly once");
  assert.equal(sent[0].url, "/api/errors/client", "through the app's one client-error pipeline");
  const payload = JSON.parse(sent[0].body) as Record<string, unknown>;
  assert.equal(payload.message, "Promise.withResolvers is not a function");
  assert.equal(payload.route, "/employee-portals/hiring/candidates/[id]/cv");
  assert.match(String(payload.clientContext), /\bcvKind=pdf\b/, "the CV kind must reach the posted clientContext, which the service stores with the row");
  assert.ok(!sent[0].body.includes(candidateId) && !sent[0].body.includes(fileName), "the posted body carries neither the candidate nor the file name");

  // The user agent is stored by the ingest route from the request's own header — pin that it still is.
  const ingestRoute = readFileSync(join(process.cwd(), "app", "api", "errors", "client", "route.ts"), "utf8");
  assert.match(ingestRoute, /userAgent: request\.headers\.get\("user-agent"\)/, "the browser user agent reaches app_error_events.user_agent through the ingest route");

  // ── The viewer actually routes its catch through it ───────────────────────────────────────────
  // A correct builder nothing calls fixes nothing — which is precisely the state that hid #3833.
  const viewer = readFileSync(join(process.cwd(), "src", "components", "recruitment", "cv-preview-modal.tsx"), "utf8");
  const catchStart = viewer.indexOf("} catch (caught) {");
  const catchEnd = viewer.indexOf("} finally {", catchStart);
  assert.ok(catchStart > 0 && catchEnd > catchStart, "the CV viewer's load catch must still exist");
  const catchBlock = viewer.slice(catchStart, catchEnd);
  assert.match(catchBlock, /buildCvPreviewFailureReport\(\{/, "the viewer's catch must build the failure report");
  assert.match(catchBlock, /if \(report\) reportClientError\(report\);/, "the viewer's catch must send it to the error monitor");
  assert.match(
    catchBlock,
    /setError\(caught instanceof Error \? caught\.message : "This document couldn't be previewed\."\);/,
    "what the manager sees must not change",
  );
  assert.match(viewer, /throw new CvPreviewNotice\(\s*"This CV is a photograph/, "the photograph notice is thrown as a notice, so it is not reported");
  // Until 2026-09-27 the notice here read "This is an older Word (.doc) format that can't be
  // previewed here", and EVERY legacy .doc raised it. That format is now READ as text
  // (legacy-doc-text.ts), so the notice is left for the one case with genuinely nothing to show: an
  // OLE2 file holding no text at all. Still a notice and still never reported, for the same reason
  // as the photograph above — it fires by design, and a monitor full of decisions buries the next
  // real failure.
  assert.match(
    viewer,
    /throw new CvPreviewNotice\("This older Word \(\.doc\) file holds no text/,
    "an empty legacy .doc is thrown as a notice, so it is not reported",
  );

  console.log("  CV viewer: a load failure reaches /api/errors/client with cvKind, stage and status");
  console.log("  CV viewer: no file name, no candidate id, no query string in the report; notices stay out");
}
