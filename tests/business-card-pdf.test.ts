import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export function runBusinessCardPdfTests() {
  const route = source("app/api/business-cards/mine/route.ts");
  const component = source("src/components/business-cards/employee-business-card.tsx");
  const registry = source("src/lib/security/access-registry.ts");

  // ── The employee's own card is rendered as the REAL print-ready PDF (front and back) ───────────
  // The same renderBusinessCardsPdf the HR generator uses — so the employee sees exactly the admin
  // card, Sato logo and all.
  assert.match(route, /renderBusinessCardsPdf\(\[fields\]/, "the route renders the real print-ready card PDF");
  assert.match(route, /getOwnBusinessCard\(access\)/, "the card is the caller's OWN, resolved from their record");
  assert.match(route, /"Content-Type": "application\/pdf"/, "the route returns a PDF");

  // ── Scoped to the signed-in employee, and only name + mobile are theirs ────────────────────────
  assert.match(route, /assertPermission\(access, "employee_profile", "read"\)/, "gated to the signed-in employee");
  assert.match(route, /assertSameOriginMutation\(request\)/, "the render is CSRF-guarded");
  assert.doesNotMatch(route, /body\.hrId/, "the route must never read an hrId from the body — it can only render the caller's own card");
  assert.match(
    route,
    /\{ \.\.\.own, mobile: clean\(body\.cardMobile\), name \}/,
    "only the name and mobile overlay the record; the title, line·area, email and company details stay the record's",
  );

  // ── The card is fetched as BASE64 TEXT, so a PDF download-manager can't intercept it ────────────
  // A fetch of an application/pdf response is grabbed and force-downloaded by a browser PDF
  // download-manager (the page's JS then sees only "Failed to fetch"); base64-as-text dodges it.
  assert.match(route, /searchParams\.get\("format"\) === "base64"/, "the route can return the card as base64 text");
  assert.match(route, /pdfBytes\.toString\("base64"\)/, "base64 mode encodes the PDF as text");
  assert.match(route, /"Content-Type": "text\/plain; charset=utf-8"/, "base64 mode is served as text/plain, not application/pdf");
  assert.match(component, /\/api\/business-cards\/mine\?format=base64/, "the page fetches the card as base64 text");
  assert.match(component, /base64ToBytes\(await response\.text\(\)\)/, "the base64 text is decoded to bytes in the browser");
  assert.doesNotMatch(component, /response\.blob\(\)/, "the page must never read the card as an application/pdf blob a download-manager can grab");

  // ── The page SHOWS the card (front and back) and offers a printable-PDF download ────────────────
  assert.match(component, /\/api\/business-cards\/mine/, "the component renders via the own-card PDF endpoint");
  // The card is drawn onto <canvas> via pdf.js, NEVER an <iframe>/<embed> PDF — those obey the
  // browser's "download PDFs instead of opening them" setting and force a download instead of showing
  // the card (and mobile browsers cannot render a PDF iframe inline at all).
  assert.doesNotMatch(component, /<iframe/, "the card must not be shown through a PDF <iframe> the browser can force-download");
  assert.match(component, /\/pdfjs\/pdf\.min\.mjs/, "pdf.js is loaded from the same-origin static assets");
  assert.match(component, /getDocument\(\{ data: bytes/, "the fetched PDF bytes are decoded by pdf.js");
  assert.match(component, /document\.createElement\("canvas"\)/, "each page is drawn onto a canvas");
  assert.match(component, /page\.render\(\{ canvas, viewport \}\)/, "the page is rendered onto the canvas");
  assert.match(component, /front and back/i, "the preview is labelled front and back");
  assert.match(component, /Download printable PDF/, "there is a high-quality printable-PDF download");
  assert.match(
    component,
    /cardName: name\.trim\(\), cardMobile: mobile\.trim\(\)/,
    "only the name and mobile are sent to render — never an email",
  );

  // ── Registered, and BEFORE the HR export so the exact /mine path never falls to the HR gate ─────
  assert.match(
    registry,
    /pattern: "\/api\/business-cards\/mine", permission: \{ resource: "employee_profile", action: "read" \}/,
    "the own-card route is registered for every employee",
  );
  const mineIdx = registry.indexOf('pattern: "/api/business-cards/mine"');
  const hrExportIdx = registry.indexOf('pattern: "/api/business-cards",');
  assert.ok(
    mineIdx > -1 && hrExportIdx > -1 && mineIdx < hrExportIdx,
    "/api/business-cards/mine must be registered before the HR /api/business-cards export",
  );

  // ── The ~2.7 MB preview is single-flight and abort-safe ─────────────────────────────────────────
  // A superseded preview (re-mount, rapid edit, or a reload mid-transfer) must be aborted rather
  // than left to tear its own connection down — which the browser reports as "NetworkError when
  // attempting to fetch resource" and the server logs as "the destination stream closed early".
  assert.match(component, /new AbortController\(\)/, "the preview render is abortable");
  assert.match(component, /previewAbortRef\.current\?\.abort\(\)/, "a new preview aborts the one still in flight");
  assert.match(component, /signal\?: AbortSignal/, "the fetch takes an abort signal");
  assert.match(component, /"AbortError"/, "an aborted (superseded) preview is never shown as an error");
  // A fixed Content-Length makes the large card a single, known-length body rather than a chunked
  // stream a browser or proxy can cut short.
  assert.match(route, /"Content-Length": String\(pdfBytes\.byteLength\)/, "the PDF is returned with an explicit Content-Length");
}
