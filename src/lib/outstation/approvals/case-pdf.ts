/**
 * The expense case PDF: the reviewer screen of one trip, printed as it is.
 *
 * Owner, 23 Nov 2026: "export every expense trip case as a PDF, looking 100% as it is looking in the
 * system". The server opens the real Expense Approvals page on that trip in its own Chromium, signed
 * in as the person who pressed Export with a session made for this one print and revoked when it
 * ends, waits until the case has stopped changing, and prints the reviewer on one page as tall as the
 * case. So the PDF shows what THAT person sees: a reader who is not the approver gets the claim and
 * its checks, and the same sentence about the evidence the screen gives.
 *
 * Every decision that needs no browser is in case-pdf-plan.ts (the address, the fence, the paper,
 * when the case is drawn). This file only drives the browser, through the opener the ChatGPT
 * connector's captures already use in production (one of the PDF printer's two Chromium slots, popups
 * closed, downloads denied, dialogs dismissed, beacons and non-GET fetches stopped in the page).
 *
 * 🔴 The print browser reads; it never decides. Its fence answers every write with nothing, and the
 * reviewer's buttons are never pressed.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { type CapturePage, openSignedInPage } from "@/lib/chatgpt-connector/browser/capture";
import { ToolRefusal } from "@/lib/chatgpt-connector/types";
import { withChromiumSlot } from "@/lib/pdf/chromium";

import {
  CASE_PDF_ISOLATE_SCRIPT,
  CASE_PDF_OPENING_HEIGHT,
  CASE_PDF_PASS_WRITES,
  CASE_PDF_SESSION_MARK,
  CASE_PDF_WIDTH,
  type CasePdfReading,
  casePdfOrigin,
  casePdfPagePath,
  casePdfPageSize,
  casePdfPrintOptions,
  casePdfReadingScript,
  casePdfSettled,
  classifyCasePdfRequest,
  createCasePdfTurn,
  parseCasePdfReading,
} from "./case-pdf-plan";

/** The whole export: sign in, open, wait, print. */
const DEADLINE_MS = 100_000;
/** How long the trip may take to be drawn (a cold page, the trip's one read). */
const DRAW_MS = 60_000;
/** How long photos and maps get to arrive once the window is as tall as the case. */
const SETTLE_MS = 25_000;
const SESSION_SECONDS = 180;

export type CasePdfFailure = "busy" | "session" | "signed-out" | "not-drawn" | "too-slow";

/** One case at a time in this process (case-pdf-plan.ts, createCasePdfTurn). */
const turn = createCasePdfTurn();

/** A failure the person should read as it is. `reason` is for the log, never for the screen. */
export class CasePdfError extends Error {
  // Not a parameter property: the test runner strips types only and cannot compile one.
  readonly failure: CasePdfFailure;
  readonly reason: string;

  constructor(failure: CasePdfFailure, message: string, reason = "") {
    super(message);
    this.name = "CasePdfError";
    this.failure = failure;
    this.reason = reason;
  }
}

export type CasePdfResult = { pdf: Buffer; heightPx: number; scale: number; requestsStopped: number; settled: boolean };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function read(page: CapturePage, requestId: number): Promise<CasePdfReading> {
  try {
    return parseCasePdfReading(await page.evaluate(casePdfReadingScript(requestId)));
  } catch {
    // Mid-navigation the page has no context to answer in; that is "not there yet".
    return { stage: "absent", path: "" };
  }
}

async function waitUntilDrawn(page: CapturePage, requestId: number, until: number): Promise<CasePdfReading & { stage: "ready" }> {
  let last: CasePdfReading = { stage: "absent", path: "" };
  while (Date.now() < until) {
    last = await read(page, requestId);
    if (last.stage === "ready") return last;
    if (last.path === "/login") {
      throw new CasePdfError("signed-out", "Phoenix did not accept the sign-in for the export. Try again in a minute.");
    }
    if (last.stage === "failed") {
      throw new CasePdfError("not-drawn", "This claim could not be opened for the export. Open it again and try once more.", last.message);
    }
    await sleep(300);
  }
  throw new CasePdfError("too-slow", "The claim took too long to open, so no PDF was made. Try again.", `last stage: ${last.stage} at ${last.path || "no page"}`);
}

export async function renderExpenseCasePdf(ctx: AccessContext, requestId: number): Promise<CasePdfResult> {
  if (!turn.take()) {
    throw new CasePdfError("busy", "Another claim is being printed right now. Try again when it finishes, in about a minute.");
  }
  try {
    return await printCase(ctx, requestId);
  } finally {
    turn.release();
  }
}

async function printCase(ctx: AccessContext, requestId: number): Promise<CasePdfResult> {
  const origin = casePdfOrigin();
  const deadline = Date.now() + DEADLINE_MS;

  return withChromiumSlot(async () => {
    let opened: Awaited<ReturnType<typeof openSignedInPage>>;
    try {
      opened = await openSignedInPage(
        ctx,
        { deviceScaleFactor: 1, hasTouch: false, height: CASE_PDF_OPENING_HEIGHT, isMobile: false, width: CASE_PDF_WIDTH },
        // This export brings its own fence, so the connector's list is never read; were it ever
        // read, an unreadable list refuses everything.
        { api: [], ok: false, pages: [] },
        {
          decide: (request) => classifyCasePdfRequest(request, { origin, requestId }),
          origin,
          passWrites: CASE_PDF_PASS_WRITES,
          sessionMark: CASE_PDF_SESSION_MARK,
          sessionSeconds: SESSION_SECONDS,
        },
      );
    } catch (error) {
      if (error instanceof ToolRefusal) {
        throw new CasePdfError("session", "The export needs your own Phoenix sign-in. Sign in again, then export.", error.message);
      }
      throw error;
    }

    try {
      const page = opened.page;
      // A slow first paint is waited for below, by what the page shows, not by this call's clock.
      await page.goto(`${origin}${casePdfPagePath(requestId)}`, { timeout: 45_000, waitUntil: "domcontentloaded" }).catch(() => undefined);
      let reading = await waitUntilDrawn(page, requestId, Math.min(deadline - 20_000, Date.now() + DRAW_MS));
      await page.evaluate(CASE_PDF_ISOLATE_SCRIPT);

      // Grow the window to the whole case, so every photo and map is on screen and loads; then wait
      // until two readings in a row agree and nothing is still arriving.
      let size = casePdfPageSize(reading);
      let windowHeight = CASE_PDF_OPENING_HEIGHT;
      let settled = false;
      const settleUntil = Math.min(deadline - 15_000, Date.now() + SETTLE_MS);
      while (Date.now() < settleUntil) {
        if (size.viewportHeight !== windowHeight) {
          windowHeight = size.viewportHeight;
          await page.setViewport({ deviceScaleFactor: 1, height: windowHeight, width: CASE_PDF_WIDTH });
        }
        await page.waitForNetworkIdle({ idleTime: 700, timeout: Math.max(1_000, Math.min(8_000, settleUntil - Date.now())) }).catch(() => undefined);
        const next = await read(page, requestId);
        if (next.stage !== "ready") {
          await sleep(300);
          continue;
        }
        const nextSize = casePdfPageSize(next);
        settled = casePdfSettled(reading, next) && nextSize.viewportHeight === windowHeight;
        reading = next;
        size = nextSize;
        if (settled) break;
      }
      if (!settled) {
        // Time ran out while something was still arriving. Read once more: a case that is no longer
        // drawn (a loader, a failed read) is never printed as if it were the claim.
        const last = await read(page, requestId);
        if (last.stage !== "ready") {
          throw new CasePdfError("not-drawn", "The claim changed while it was being printed, so no PDF was made. Try again.", `last stage: ${last.stage}`);
        }
        reading = last;
        size = casePdfPageSize(last);
      }
      if (size.viewportHeight !== windowHeight) {
        await page.setViewport({ deviceScaleFactor: 1, height: size.viewportHeight, width: CASE_PDF_WIDTH });
      }
      // Again, right before the print: anything the page added to its body since the first pass.
      await page.evaluate(CASE_PDF_ISOLATE_SCRIPT);

      // The SCREEN's styles: this is the screen on paper, not a print layout.
      await page.emulateMediaType("screen");
      const bytes = await page.pdf({ ...casePdfPrintOptions(size), timeout: Math.max(10_000, deadline - Date.now()) });
      return { heightPx: size.viewportHeight, pdf: Buffer.from(bytes), requestsStopped: opened.stopped(), scale: size.scale, settled };
    } finally {
      await opened.finish();
    }
  });
}
