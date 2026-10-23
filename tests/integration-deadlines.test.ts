import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resetHeadwindTokenCache } from "../src/lib/devices/headwind/auth.ts";
import {
  HEADWIND_REQUEST_TIMEOUT_MS,
  HEADWIND_UPLOAD_TIMEOUT_MS,
  HeadwindRequestError,
  callHeadwind,
  headwindTimeoutFor,
} from "../src/lib/devices/headwind/client.ts";
import { OCR_DEADLINE_MS, withOcrDeadline } from "../src/lib/recruitment/cv-ocr.ts";
import {
  RECRUITMENT_IMAP_SOCKET_TIMEOUT_MS,
  createRecruitmentImapClient,
} from "../src/lib/recruitment/inbound/email-poller.ts";

/**
 * EVERY OUTSIDE CALL IN THE BACKGROUND JOBS HAS A DEADLINE (23 Oct 2026 audit, P5-01 and the OCR half
 * of P5-04).
 *
 *  - The careers-mailbox IMAP clients ran on imapflow's defaults (five minutes of socket silence) with
 *    no 'error' listener: a silent mail host held the poll past its route's lifetime.
 *  - Headwind calls had no deadline at all, and a request that timed out was reported as one that
 *    "never reached a server" — the opposite of the truth for a remote lock that did arrive.
 *  - Free OCR bounded its pages but not its time.
 */

const ENV = {
  HEADWIND_MDM_BASE_URL: "https://mdm.test.local",
  HEADWIND_MDM_LOGIN: "phoenix",
  HEADWIND_MDM_PASSWORD: "a-real-password",
} as unknown as NodeJS.ProcessEnv;

function headwindFetch(apiFailure: () => never) {
  const calls: Array<{ init: RequestInit; url: string }> = [];
  const impl = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ init, url });
    if (url.includes("/rest/public/jwt/login")) {
      return { json: async () => ({ data: { authToken: "jwt-1" }, status: "OK" }), ok: true, status: 200 } as unknown as Response;
    }
    apiFailure();
  }) as unknown as typeof fetch;
  return { calls, fetch: impl };
}

export async function runIntegrationDeadlinesTests() {
  // ── IMAP ────────────────────────────────────────────────────────────────────────────────────────
  const client = createRecruitmentImapClient({
    host: "imap.test.local",
    label: "careers",
    password: "x",
    port: 993,
    secure: true,
    user: "careers@test.local",
  } as never);
  const options = (client as unknown as { options: Record<string, unknown> }).options;
  assert.equal(options.socketTimeout, RECRUITMENT_IMAP_SOCKET_TIMEOUT_MS, "a silent mail host is cut after 30 seconds, not five minutes");
  assert.ok(Number(options.connectionTimeout) <= 15_000, "connecting has its own short deadline");
  assert.ok(Number(options.greetingTimeout) <= 10_000);
  assert.ok(client.listenerCount("error") >= 1, "an 'error' listener exists before connect(), so a socket drop is never an uncaught exception");
  const poller = readFileSync("src/lib/recruitment/inbound/email-poller.ts", "utf8");
  assert.equal((poller.match(/new ImapFlow\(/g) ?? []).length, 1, "the one ImapFlow constructor is the helper's");
  assert.equal((poller.match(/createRecruitmentImapClient\(config\)/g) ?? []).length, 2, "both the poll and the worker's re-fetch use it");

  // ── Headwind ────────────────────────────────────────────────────────────────────────────────────
  assert.equal(headwindTimeoutFor({ method: "POST" }), HEADWIND_REQUEST_TIMEOUT_MS);
  assert.equal(headwindTimeoutFor({ body: new FormData(), method: "POST" }), HEADWIND_UPLOAD_TIMEOUT_MS, "an upload gets the longer deadline");

  resetHeadwindTokenCache();
  const timedOut = headwindFetch(() => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  await assert.rejects(
    () => callHeadwind("/rest/private/devices/lock", { body: "{}", method: "POST" }, timedOut.fetch, ENV),
    (error: unknown) => {
      assert.ok(error instanceof HeadwindRequestError);
      assert.equal(error.status, 504, "a deadline answers 504, not the transport 502");
      assert.doesNotMatch(error.message, /never reached a server/i, "a timed-out request is NOT one that never arrived");
      assert.match(error.message, /may have reached Headwind and taken effect/, "it says the action may have happened");
      return true;
    },
  );
  const apiCall = timedOut.calls.find((call) => !call.url.includes("/jwt/login"))!;
  assert.ok(apiCall.init.signal instanceof AbortSignal, "every Headwind call carries a deadline signal");
  const loginCall = timedOut.calls.find((call) => call.url.includes("/jwt/login"))!;
  assert.ok(loginCall.init.signal instanceof AbortSignal, "and so does the sign-in");

  resetHeadwindTokenCache();
  const unreachable = headwindFetch(() => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(
    () => callHeadwind("/rest/private/devices", { method: "GET" }, unreachable.fetch, ENV),
    (error: unknown) => error instanceof HeadwindRequestError && error.status === 502 && /never reached a server/.test(error.message),
    "a real transport failure keeps its own sentence",
  );
  resetHeadwindTokenCache();

  // ── OCR ─────────────────────────────────────────────────────────────────────────────────────────
  assert.ok(OCR_DEADLINE_MS <= 120_000, "OCR has a whole-read deadline");
  let fired = false;
  const never = new Promise<string>(() => undefined);
  assert.equal(await withOcrDeadline(never, 20, () => (fired = true)), null, "a read past its deadline answers null — the caller goes to the model");
  assert.equal(fired, true, "the deadline reports itself, so the stopped read is logged");
  assert.equal(await withOcrDeadline(Promise.resolve("text"), 1_000, () => assert.fail("no timeout")), "text");
  const ocr = readFileSync("src/lib/recruitment/cv-ocr.ts", "utf8");
  const entry = ocr.slice(ocr.indexOf("export async function extractTextByOcr("));
  assert.match(entry.slice(0, 1_500), /withOcrDeadline\(readByOcr\(input, run\)/, "the whole OCR read runs under the deadline");
  assert.match(entry.slice(0, 1_800), /finally \{[\s\S]*run\.worker\.terminate\(\)/, "and the Tesseract worker is terminated when it passes");
  assert.match(ocr, /if \(run\.timedOut\) \{\s*\/\/[^\n]*\n\s*await active\.terminate\(\)/, "a worker that finishes starting after the deadline is terminated at once");
}
