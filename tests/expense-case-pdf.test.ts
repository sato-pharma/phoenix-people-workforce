/**
 * The expense case PDF (owner, 23 Nov 2026: "export every expense trip case as a PDF, looking 100% as it
 * is looking in the system").
 *
 * The PDF is the reviewer screen itself: the server opens the live Expense Approvals page on one trip,
 * signed in as the person who pressed Export, and prints it. Nothing here opens a browser; every
 * decision that keeps that print safe and true to the screen is pure and is tested directly:
 *
 *   1. Where the page is opened: the deployment's own public address (the map's key is tied to it),
 *      a laptop's loopback port, never a request header.
 *   2. The fence is an allow-list: the page, its scripts, the case's three reads, pictures and maps
 *      from other sites, and the map's one call to Google. Every write, every Server Action, every
 *      other trip, every other page and the export itself are refused.
 *   3. What the page says about itself, run against a stand-in page: drawn, still reading, failed;
 *      the case's own height, never the window's; and when it has stopped changing.
 *   4. The paper: one page as tall as the case, scaled and never split past a page's limit.
 *   5. The list behind the reviewer (other people's claims) is taken out of the print.
 *   6. The route's order, its own registry entry, and that the ChatGPT connector's captures refuse it.
 *   7. The shared opener: without the new settings the connector's page stub stops every non-GET.
 *   8. The button: a press with a state on the reviewer's bar, a GET, no rounded corner.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

import { pageStubs } from "@/lib/chatgpt-connector/browser/capture";
import { classifyCaptureRequest, NEVER_TOUCH_API_SHAPES, parseSideEffectRoutes, SIDE_EFFECT_ROUTES_FILE } from "@/lib/chatgpt-connector/browser/fence";
import {
  CASE_PDF_ISOLATE_SCRIPT,
  CASE_PDF_MAX_PAGE_PX,
  CASE_PDF_PAGE,
  CASE_PDF_PASS_WRITES,
  CASE_PDF_SESSION_MARK,
  CASE_PDF_WIDTH,
  casePdfFilename,
  casePdfFilenameFromHeader,
  casePdfOrigin,
  casePdfPagePath,
  casePdfPageSize,
  casePdfPrintOptions,
  casePdfReadingScript,
  casePdfReads,
  casePdfSettled,
  caseExportNoteOnScreen,
  classifyCasePdfRequest,
  parseCasePdfReading,
} from "@/lib/outstation/approvals/case-pdf-plan";
import { findAccessRegistryEntry } from "@/lib/security/access-registry";

const code = (path: string) => fs.readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

/** Each step must appear, and in this order. */
function assertOrder(block: string, steps: string[], what: string) {
  let from = 0;
  for (const step of steps) {
    const at = block.indexOf(step, from);
    assert.ok(at >= 0, `${what}: "${step}" must come after the step before it`);
    from = at + step.length;
  }
}

const ORIGIN = "https://phoenix-hr.satopharma.com";
const TRIP = 341;
const MAP_CALL = "https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetViewportInfo";

const decide = (method: string, url: string, headers: Record<string, string> = {}) =>
  classifyCasePdfRequest({ headers, method, url }, { origin: ORIGIN, requestId: TRIP });
const allowed = (method: string, url: string, headers?: Record<string, string>) => decide(method, url, headers).allow;
const reason = (method: string, url: string, headers?: Record<string, string>) => {
  const decision = decide(method, url, headers);
  return decision.allow ? "allowed" : decision.reason;
};

/** A stand-in for the reviewer in the page, enough for the reading script to run against. */
function standInPage(input: { busy?: boolean; mark: string | null; text?: string; reviewer?: boolean }) {
  const busyNodes = input.busy ? [{}] : [];
  const file =
    input.mark === null
      ? null
      : {
          firstElementChild: { offsetHeight: 2034 },
          getAttribute: (name: string) => (name === "data-trip-file" ? input.mark : null),
          querySelector: (selector: string) => (selector === '[aria-busy="true"]' ? (busyNodes[0] ?? null) : null),
          // The scroller is as tall as the window, however short the case in it is.
          scrollHeight: 797,
          textContent: input.text ?? "",
        };
  const box = {
    children: [{ offsetHeight: 62 }, ...(file ? [file] : []), { offsetHeight: 41 }],
    querySelector: (selector: string) => (selector === "[data-trip-file]" ? file : null),
    querySelectorAll: (selector: string) =>
      selector === "img" ? [{ complete: true }, { complete: false }, { complete: true }] : selector === ".gm-style" ? [{}] : selector === '[aria-busy="true"]' ? busyNodes : [],
  };
  return {
    document: { querySelector: (selector: string) => (selector === "[data-desk-reviewer]" && input.reviewer !== false ? box : null) },
    location: { pathname: CASE_PDF_PAGE },
  };
}

export function runExpenseCasePdfTests() {
  // 1. Where the page is opened.
  assert.equal(
    casePdfOrigin({ APP_URL: "https://phoenix-people-workforce-staging.up.railway.app/", NODE_ENV: "production" }),
    "https://phoenix-people-workforce-staging.up.railway.app",
    "a deployed server opens its OWN public address, so staging never opens production",
  );
  assert.equal(casePdfOrigin({ NODE_ENV: "production" }), ORIGIN, "production with no address set falls back to its known domain");
  assert.equal(
    casePdfOrigin({ APP_URL: ORIGIN, NODE_ENV: "development", PORT: "3001" }),
    "http://127.0.0.1:3001",
    "a laptop opens its own port even when its env file names production: its session means nothing there",
  );
  assert.equal(casePdfOrigin({}), "http://127.0.0.1:3000", "no port named is the dev server's 3000");
  assert.equal(casePdfOrigin({ NODE_ENV: "production", PHOENIX_CASE_PDF_ORIGIN: "http://127.0.0.1:8080/x" }), "http://127.0.0.1:8080", "the override wins");
  assert.equal(casePdfOrigin({ NODE_ENV: "production", PHOENIX_CASE_PDF_ORIGIN: "not an address" }), ORIGIN, "an unreadable override is ignored, never thrown");
  assert.equal(casePdfOrigin({ APP_URL: "javascript:alert(1)", NODE_ENV: "production" }), ORIGIN, "an address that is not http or https is ignored");
  assert.equal(casePdfPagePath(TRIP), "/admin/outstation/expense-approvals?trip=341", "the page is the desk itself, opened on the one trip");

  // 2. The fence.
  for (const url of [
    `${ORIGIN}/admin/outstation/expense-approvals?trip=341`,
    `${ORIGIN}/admin/outstation/expense-approvals?trip=341&_rsc=abc`,
    `${ORIGIN}/_next/static/chunks/app/page-1a2b.js`,
    `${ORIGIN}/favicon.ico`,
    `${ORIGIN}/api/admin/outstation/approvals`,
    `${ORIGIN}/api/admin/outstation/approvals/341`,
    `${ORIGIN}/api/admin/outstation/approvals/341/`,
    `${ORIGIN}/api/outstation/visit-workload?hrId=x&from=2026-09-02`,
    `${ORIGIN}/login?next=%2Fadmin`,
    "https://ozucdzovmcqvepbozvqf.supabase.co/storage/v1/object/sign/outstation/a.jpg?token=t",
    "https://maps.googleapis.com/maps/api/js?key=k",
    "https://maps.gstatic.com/mapfiles/transparent.png",
    "data:image/png;base64,AAAA",
    "blob:https://phoenix-hr.satopharma.com/1b2c",
  ]) {
    assert.equal(allowed("GET", url), true, `the case needs ${url.slice(0, 80)}`);
  }
  assert.deepEqual(
    casePdfReads(TRIP),
    ["/api/admin/outstation/approvals", "/api/admin/outstation/approvals/341", "/api/outstation/visit-workload"],
    "an open case makes three reads (measured on three cases, 23 Nov 2026), and the list holds no fourth",
  );
  assert.equal(allowed("HEAD", `${ORIGIN}/api/admin/outstation/approvals/341`), true, "HEAD is a read");
  assert.equal(allowed("POST", MAP_CALL), true, "the map's own viewport call reaches Google");

  assert.equal(reason("POST", `${ORIGIN}/api/admin/outstation/approvals`), "write-method", "a decision can never leave the print browser");
  for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.equal(reason(method, `${ORIGIN}/api/admin/outstation/approvals/341`), "write-method", `${method} is refused`);
  }
  assert.equal(reason("GET", `${ORIGIN}/admin/outstation/expense-approvals?trip=341`, { "Next-Action": "abc" }), "server-action", "a Server Action is refused whatever its method and header case");
  assert.equal(reason("POST", `${ORIGIN}/admin/outstation/expense-approvals`, { "next-action": "abc" }), "server-action");
  for (const path of [
    "/api/admin/outstation/approvals/342",
    "/api/admin/outstation/approvals/history",
    "/api/admin/outstation/approvals/341/pdf",
    "/api/admin/outstation/approvals/341%2Fpdf",
    "/api/admin/outstation/341/attachments",
    "/api/admin/outstation/341/journey-stop",
    "/api/admin/outstation/expenses/export",
    "/api/admin/outstation/expenses/export.png",
    "/api/admin/outstation/expenses/note-assist",
    "/api/notifications",
    "/api",
  ]) {
    assert.equal(reason("GET", `${ORIGIN}${path}`), "outside-the-case", `${path} is not one of the case's reads`);
  }
  for (const path of ["/admin", "/admin/outstation/expense-command", "/employee-portals", "/admin/outstation/expense-approvals/other", "/"]) {
    assert.equal(reason("GET", `${ORIGIN}${path}`), "another-page", `${path} is another page`);
  }
  assert.equal(reason("GET", "http://example.com/a.png"), "insecure-off-origin", "never plain http off the box");
  assert.equal(reason("GET", "ftp://example.com/a"), "scheme");
  assert.equal(reason("GET", "not a url"), "unparseable-url");
  for (const url of [
    "https://maps.googleapis.com/maps/api/place/textsearch",
    "https://maps.googleapis.com.evil.example/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetViewportInfo",
    "https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/../../maps/api/place/textsearch",
    "https://example.com/collect",
    "http://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetViewportInfo",
  ]) {
    assert.equal(reason("POST", url), "write-method", `no other POST passes: ${url.slice(0, 70)}`);
  }
  assert.equal(reason("PUT", MAP_CALL), "write-method", "only a POST passes to the map, never another write");
  assert.equal(CASE_PDF_PASS_WRITES.length, 1, "one address prefix is let through, and it is Google's map service");

  // 3. What the page says about itself.
  const read = (page: ReturnType<typeof standInPage>) => parseCasePdfReading(vm.runInNewContext(casePdfReadingScript(TRIP), page));
  const drawn = read(standInPage({ mark: "341" }));
  assert.deepEqual(
    drawn,
    { busy: 0, chrome: 103, content: 2034, images: 3, maps: 1, path: CASE_PDF_PAGE, pendingImages: 1, stage: "ready" },
    "the case's OWN height (2,034), never the scroller's (797, the window), plus the bar and the foot around it",
  );
  assert.equal(read(standInPage({ mark: null, reviewer: false })).stage, "absent", "no reviewer yet");
  assert.equal(read(standInPage({ mark: null })).stage, "loading", "the reviewer before its trip box");
  assert.equal(read(standInPage({ busy: true, mark: "loading" })).stage, "loading", "the loader is still reading");
  assert.deepEqual(
    read(standInPage({ mark: "loading", text: "  This claim is not on\n your list any more. " })),
    { message: "This claim is not on your list any more.", path: CASE_PDF_PAGE, stage: "failed" },
    "the loading box without its loader is the failure, in its own words",
  );
  assert.equal(read(standInPage({ mark: "342", text: "Another employee" })).stage, "loading", "another trip on screen is never read as this one, and its text is never taken");
  assert.equal(casePdfReadingScript(TRIP).includes('"341"'), true, "the script looks for this trip's own number");

  assert.equal(parseCasePdfReading(null).stage, "absent");
  assert.equal(parseCasePdfReading("ready").stage, "absent");
  assert.equal(parseCasePdfReading({ chrome: 103, content: 0, images: 0, pendingImages: 0, busy: 0, maps: 0, stage: "ready" }).stage, "absent", "a case with no height is not drawn");
  assert.equal(parseCasePdfReading({ chrome: 103, content: "2034", images: 0, pendingImages: 0, busy: 0, maps: 0, stage: "ready" }).stage, "absent", "a number that is not a number is not trusted");
  assert.equal(parseCasePdfReading({ chrome: -1, content: 2034, images: 0, pendingImages: 0, busy: 0, maps: 0, stage: "ready" }).stage, "absent");

  if (drawn.stage !== "ready") throw new Error("the stand-in case was not read as drawn");
  const still = { ...drawn, pendingImages: 0 };
  assert.equal(casePdfSettled(still, still), true, "two readings agree and nothing is arriving");
  assert.equal(casePdfSettled(still, drawn), false, "a photo still decoding is not settled");
  assert.equal(casePdfSettled(still, { ...still, busy: 1 }), false, "a loader on screen is not settled");
  assert.equal(casePdfSettled(still, { ...still, content: 2400 }), false, "the case grew (a map opened)");
  assert.equal(casePdfSettled(still, { ...still, images: 9 }), false, "more pictures arrived");
  assert.equal(casePdfSettled(still, { ...still, maps: 2 }), false, "another map arrived");
  assert.equal(casePdfSettled({ path: "", stage: "loading" }, still), false, "one reading alone is never settled");

  // 4. The paper.
  assert.deepEqual(casePdfPageSize({ chrome: 103, content: 2034 }), { paperHeight: 2137, paperWidth: 1440, scale: 1, viewportHeight: 2137 }, "one page, as wide as the screen and as tall as the case");
  assert.deepEqual(casePdfPageSize({ chrome: 103, content: 300 }), { paperHeight: 403, paperWidth: 1440, scale: 1, viewportHeight: 403 }, "a short case is a short page, with no empty window under it");
  assert.equal(casePdfPageSize({ chrome: 0, content: CASE_PDF_MAX_PAGE_PX }).scale, 1, "exactly a page's limit is not scaled");
  for (const content of [19_001, 24_000, 30_000, 57_123, 189_999, 400_000]) {
    const size = casePdfPageSize({ chrome: 103, content });
    assert.ok(size.scale < 1 && size.scale >= 0.1, `${content} px is scaled down, never below a tenth`);
    assert.ok(size.paperHeight <= CASE_PDF_MAX_PAGE_PX, `${content} px still fits a page (${size.paperHeight})`);
    assert.ok(size.viewportHeight * size.scale <= size.paperHeight, `${content} px: the scaled case is never taller than its page, so nothing spills onto a second`);
    assert.ok(CASE_PDF_WIDTH * size.scale <= size.paperWidth, `${content} px: nor wider`);
  }
  assert.deepEqual(casePdfPageSize({ chrome: 0, content: 38_000 }), { paperHeight: 19_000, paperWidth: 720, scale: 0.5, viewportHeight: 38_000 });
  assert.deepEqual(
    casePdfPrintOptions(casePdfPageSize({ chrome: 103, content: 2034 })),
    { height: "2137px", margin: { bottom: "0", left: "0", right: "0", top: "0" }, pageRanges: "1", printBackground: true, scale: 1, width: "1440px" },
    "backgrounds printed, no margin, one page",
  );

  // 5. The list behind the reviewer is taken out of the print.
  const hiddenWith: string[][] = [];
  const el = (tagName: string, reviewer = false) => {
    const set: string[] = [];
    hiddenWith.push(set);
    return {
      hasAttribute: (name: string) => reviewer && name === "data-desk-reviewer",
      style: { setProperty: (...args: string[]) => set.push(args.join(":")) },
      tagName,
    };
  };
  const body = [el("DIV"), el("SCRIPT"), el("STYLE"), el("SECTION"), el("NEXT-ROUTE-ANNOUNCER"), el("DIV", true)];
  assert.equal(vm.runInNewContext(CASE_PDF_ISOLATE_SCRIPT, { document: { body: { children: body } } }), 3, "the shell, the toasts and the announcer are hidden");
  assert.deepEqual(hiddenWith.map((set) => set.join()), ["display:none:important", "", "", "display:none:important", "display:none:important", ""], "and the reviewer is left as it is");
  assert.equal(/createElement|<style|innerHTML/.test(CASE_PDF_ISOLATE_SCRIPT), false, "no style tag, which the page's own security policy would refuse");

  // The file's name.
  assert.equal(
    casePdfFilename({ employeeName: "Ghada Mohamed", requestId: 341, tripEnd: "2026-09-04", tripStart: "2026-09-02" }),
    "Expense-trip-Ghada-Mohamed-2026-09-02-to-2026-09-04-341.pdf",
  );
  assert.equal(casePdfFilename({ employeeName: "Salim Gomaa", requestId: 334, tripEnd: "2026-11-01", tripStart: "2026-11-01" }), "Expense-trip-Salim-Gomaa-2026-11-01-334.pdf", "a one-day trip names its day once");
  assert.equal(casePdfFilename({ employeeName: "غادة محمد", requestId: 7, tripEnd: null, tripStart: null }), "Expense-trip-Employee-7.pdf", "a name with no Latin letter still makes a plain file name");
  assert.equal(/^[A-Za-z0-9._-]+$/.test(casePdfFilename({ employeeName: 'A "quoted"; name\r\n', requestId: 9, tripEnd: "x", tripStart: "2026-01-02T00:00:00Z" })), true, "nothing a header could be broken with");
  assert.equal(casePdfFilenameFromHeader('attachment; filename="Expense-trip-Salim-Gomaa-2026-11-01-334.pdf"', 334), "Expense-trip-Salim-Gomaa-2026-11-01-334.pdf");
  assert.equal(casePdfFilenameFromHeader('attachment; filename="../../x.pdf"', 334), "Expense-trip-334.pdf", "a name with a path in it is not used");
  assert.equal(casePdfFilenameFromHeader(null, 334), "Expense-trip-334.pdf");

  // 6. The route.
  const route = code("app/api/admin/outstation/approvals/[requestId]/pdf/route.ts");
  assertOrder(
    route,
    [
      "resolveAccessContext(request)",
      "unauthenticatedSessionResponse(access)",
      'assertOutstationExpenseApprovalReviewAccess(access, "expense approvals")',
      "parseOutstationRequestId(",
      "isPreviewSession(access)",
      "loadDeskTripFile(access, requestId, { includeEvidence: false })",
      "status: 404",
      "renderExpenseCasePdf(access, requestId)",
      "writeAuditLog(",
      '"Content-Type": "application/pdf"',
    ],
    "the export: signed in, the desk's own read gate, a real session, the claim on this person's list, and only then the browser",
  );
  assert.equal(/export async function (POST|PUT|PATCH|DELETE)/.test(route), false, "the export is a read");
  assert.equal(route.includes("getSupabaseAdmin"), false, "the route reads nothing itself; the page it prints is read as the person");
  const entry = findAccessRegistryEntry("/api/admin/outstation/approvals/341/pdf", "GET");
  assert.equal(entry?.pattern, "/api/admin/outstation/approvals/:requestId/pdf", "its own registry entry, never the outstation blanket");
  assert.equal(entry?.audit.classification, "export", "audited as an export");
  assert.equal(entry?.audit.required, true, "and the audit line is required");
  assert.equal(findAccessRegistryEntry("/api/admin/outstation/approvals/341/pdf", "POST")?.pattern === "/api/admin/outstation/approvals/:requestId/pdf", false, "and it is registered for GET alone");

  const connectorList = parseSideEffectRoutes(fs.readFileSync(SIDE_EFFECT_ROUTES_FILE, "utf8"));
  assert.equal(connectorList.ok, true);
  assert.deepEqual(
    classifyCaptureRequest({ method: "GET", url: "http://127.0.0.1:8080/api/admin/outstation/approvals/341/pdf" }, { origin: "http://127.0.0.1:8080", routes: connectorList }),
    { allow: false, reason: "side-effect-route" },
    "a ChatGPT connector capture never sets an export going: the source-built list holds the new route",
  );
  assert.ok(
    NEVER_TOUCH_API_SHAPES.some((shape) => shape.test("/api/admin/outstation/approvals/341/pdf")),
    "and were the list ever behind, the address's own shape (it ends in /pdf) refuses it too",
  );

  const renderer = code("src/lib/outstation/approvals/case-pdf.ts");
  assertOrder(
    renderer,
    ["withChromiumSlot(", "openSignedInPage(", "decide: (request) => classifyCasePdfRequest(request, { origin, requestId })", "sessionMark: CASE_PDF_SESSION_MARK", "CASE_PDF_ISOLATE_SCRIPT", 'emulateMediaType("screen")', "page.pdf(", "finally", "opened.finish()"],
    "the print: one Chromium slot, this export's own fence, a named session, the list hidden, the screen's styles, and the session always revoked",
  );
  assert.equal(/\.click\(|\.type\(|keyboard|setBypassCSP|x-forwarded|headers\.get\(/.test(renderer), false, "the print browser presses nothing, bypasses no policy and takes no address from a request");
  assert.equal(CASE_PDF_SESSION_MARK.userAgent.includes("ChatGPT"), false, "the session says what it was: an expense case export");

  // 7. The shared opener, with and without the new settings.
  const runStub = (passWrites?: readonly string[]) => {
    const reached: string[] = [];
    const window = { fetch: (input: unknown) => (reached.push(String(input)), Promise.resolve("real")) };
    class Response {
      status: number;
      constructor(_body: unknown, init: { status: number }) {
        this.status = init.status;
      }
    }
    vm.runInNewContext(pageStubs(passWrites), { navigator: {}, Response, window });
    return { fetch: window.fetch as unknown as (input: unknown, init?: { method?: string }) => Promise<unknown>, reached };
  };
  const connector = runStub();
  void connector.fetch("/api/x", { method: "POST" });
  void connector.fetch(MAP_CALL, { method: "POST" });
  void connector.fetch("/api/y");
  assert.deepEqual(connector.reached, ["/api/y"], "for the connector nothing changed: every non-GET fetch is stopped in the page, the map's included");
  const exporter = runStub(CASE_PDF_PASS_WRITES);
  void exporter.fetch("/api/admin/outstation/approvals", { method: "POST" });
  void exporter.fetch(MAP_CALL, { method: "POST" });
  void exporter.fetch({ method: "POST", url: MAP_CALL });
  void exporter.fetch("https://example.com/collect", { method: "POST" });
  assert.deepEqual(exporter.reached, [MAP_CALL, "[object Object]"], "the export lets the map's call through the page stub, and nothing else");

  const opener = code("src/lib/chatgpt-connector/browser/capture.ts");
  assert.ok(opener.includes("options.origin ?? captureOrigin()"), "the connector still opens the loopback address");
  assert.ok(opener.includes("classifyCaptureRequest(request, policy)"), "and still decides with its own fence when no other is given");
  const session = code("src/lib/chatgpt-connector/browser/session.ts");
  assert.ok(session.includes("mark?.userAgent ?? CAPTURE_SESSION_USER_AGENT"), "a connector session keeps its own name");
  assert.ok(session.includes("session.revokeReason ?? CAPTURE_SESSION_REVOKE_REASON"), "and its own revoke reason");

  // 8. The button.
  const reviewer = code("src/components/outstation/approvals-desk/desk-reviewer.tsx");
  assertOrder(reviewer, ["<header", "<DeskExportPdfButton", 'aria-label="Previous claim"', "</header>", "<DeskExportPdfNote", "<DeskTripFile"], "Export PDF sits on the reviewer's bar, its note under the bar");
  assert.ok(reviewer.includes("exporting.start(requestId)"), "it exports the claim that is open");
  const button = code("src/components/outstation/approvals-desk/desk-export-pdf.tsx");
  assert.ok(button.includes("fetch(`${ROUTE}/${requestId}/pdf`, { cache: \"no-store\" })"), "one GET, with nothing in it but the trip");
  assert.equal(/method:\s*"/.test(button), false, "never a write");
  assert.ok(button.includes("if (running.current) return;"), "one export at a time: a second press while it prepares does nothing");
  assert.ok(button.includes("Export PDF") && button.includes("Preparing"), "the button says what it does and that it is working");
  assert.ok(button.includes('type="button"') && button.includes("aria-label="), "a real button with a name");
  assert.ok(button.includes("aria-disabled={busy}") && button.includes("if (!busy) onExport();"), "while it prepares the button refuses the press");
  assert.equal(/\sdisabled=\{/.test(button), false, "and is never `disabled`, which would drop the keyboard out of the reviewer");

  // The note knows which claim it is about: he can walk to the next claim while the PDF is prepared.
  const waiting = { message: "Preparing the PDF of this claim.", requestId: 341, tone: "info" } as const;
  const failed = { message: "The claim took too long to open, so no PDF was made. Try again.", requestId: 341, tone: "bad" } as const;
  assert.equal(caseExportNoteOnScreen(null, 341), null);
  assert.deepEqual(caseExportNoteOnScreen(waiting, 341), { message: "Preparing the PDF of this claim.", tone: "info" }, "on its own claim the note reads as it was written");
  assert.deepEqual(
    caseExportNoteOnScreen(waiting, 342),
    { message: "Still preparing the PDF of the claim you exported. This claim can be exported when it finishes.", tone: "info" },
    "on another claim it never says \"this claim\"",
  );
  assert.deepEqual(
    caseExportNoteOnScreen(failed, 342),
    { message: "The PDF of the claim you exported was not made. The claim took too long to open, so no PDF was made. Try again.", tone: "bad" },
    "a failure follows him to the next claim and says whose it was",
  );
  assert.ok(reviewer.includes("<DeskExportPdfNote note={exporting.note} onDismiss={exporting.dismiss} requestId={requestId} />"), "the note is given the claim on screen and a way to close it");
  assert.ok(button.includes("caseExportNoteOnScreen(note, requestId)"), "and reads through the one rule");
  assert.equal(/rounded-(?!none)|truncate|line-clamp|overflow-x-auto/.test(button), false, "no rounded corner, no cut text, no sideways scroll");
  assert.ok(fs.readFileSync("src/components/outstation/approvals-desk/desk-export-pdf.tsx", "utf8").split("\n").length <= 400, "no desk screen file is over 400 lines");
}
