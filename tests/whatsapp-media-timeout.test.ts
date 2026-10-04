import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  downloadWhatsAppMedia,
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  MEDIA_LOOKUP_TIMEOUT_MS,
  WhatsAppMediaTooLargeError,
} from "../src/lib/recruitment/inbound/whatsapp-media.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Recruitment — a WhatsApp media fetch can never hang the intake worker (PERF-014).
 *
 * The two Graph API calls — the media-id lookup and the byte download — had no signal, so a socket
 * Meta never answered held the worker for ever and every CV behind it waited. Each call now carries
 * `AbortSignal.timeout(...)`: 20 s for the small JSON lookup, 120 s for the file itself.
 *
 * The one thing that must NOT change: a timeout is a RETRYABLE failure. The worker treats
 * `WhatsAppMediaTooLargeError` as terminal ("this file will never be a valid CV"), so a timeout that
 * surfaced as that type would silently drop a real applicant's CV.
 */

const ROOT = new URL("../", import.meta.url);
const SOURCE_PATH = "src/lib/recruitment/inbound/whatsapp-media.ts";

type RecordedCall = { url: string; signal: unknown };

function timeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

export async function runWhatsAppMediaTimeoutTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const originalToken = process.env.WHATSAPP_ACCESS_TOKEN;
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token-not-a-real-credential";

  try {
    // ── 1. Both calls carry an AbortSignal, with the right bound each ───────────────────────────
    {
      const calls: RecordedCall[] = [];
      const timeouts: number[] = [];
      AbortSignal.timeout = ((ms: number) => {
        timeouts.push(ms);
        return originalTimeout.call(AbortSignal, ms);
      }) as typeof AbortSignal.timeout;
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), signal: init?.signal });
        if (calls.length === 1) {
          return new Response(JSON.stringify({ url: "https://lookaside.example/media/1", mime_type: "application/pdf", file_size: 4 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
      }) as typeof fetch;

      const result = await downloadWhatsAppMedia("MEDIA-1", { maxBytes: 1_000 });
      assert.equal(result.bytes.length, 4, "the stubbed bytes come back unchanged — the signal changed nothing on the happy path");
      assert.equal(result.mimeType, "application/pdf", "the lookup's MIME type is still returned");

      assert.equal(calls.length, 2, "one lookup and one download");
      assert.ok(calls[0].url.includes("graph.facebook.com"), "the first call is the Graph API lookup");
      assert.ok(calls[0].signal instanceof AbortSignal, "🔴 the Graph API media lookup must carry an AbortSignal, or a silent socket hangs the worker");
      assert.ok(calls[1].signal instanceof AbortSignal, "🔴 the media byte download must carry an AbortSignal, or a silent socket hangs the worker");
      assert.notEqual(calls[0].signal, calls[1].signal, "each call gets its own timeout signal, so the lookup's clock does not eat the download's");
      assert.deepEqual(
        timeouts,
        [MEDIA_LOOKUP_TIMEOUT_MS, MEDIA_DOWNLOAD_TIMEOUT_MS],
        "the lookup is bounded by MEDIA_LOOKUP_TIMEOUT_MS and the download by MEDIA_DOWNLOAD_TIMEOUT_MS, in that order",
      );
      assert.equal(MEDIA_LOOKUP_TIMEOUT_MS, 20_000, "the lookup bound is 20 seconds");
      assert.equal(MEDIA_DOWNLOAD_TIMEOUT_MS, 120_000, "the download bound is 120 seconds");
      AbortSignal.timeout = originalTimeout;
    }

    // ── 2. A timeout is retryable, never the terminal too-large error ───────────────────────────
    for (const failingCall of [1, 2]) {
      let count = 0;
      globalThis.fetch = (async () => {
        count += 1;
        if (count === failingCall) throw timeoutError();
        return new Response(JSON.stringify({ url: "https://lookaside.example/media/2", mime_type: "application/pdf" }), { status: 200 });
      }) as typeof fetch;

      const step = failingCall === 1 ? "lookup" : "download";
      let caught: unknown = null;
      try {
        await downloadWhatsAppMedia("MEDIA-2", { maxBytes: 1_000 });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught !== null, `a ${step} that times out must reject, not resolve`);
      assert.equal(
        caught instanceof WhatsAppMediaTooLargeError,
        false,
        `🔴 a ${step} timeout must NOT surface as WhatsAppMediaTooLargeError — the worker treats that as terminal and would drop a real CV`,
      );
      assert.equal((caught as { name?: string }).name, "TimeoutError", `a ${step} timeout surfaces as the TimeoutError it is`);
    }

    // ── 3. Every fetch in the file carries a timeout ────────────────────────────────────────────
    {
      const source = stripComments(readFileSync(new URL(SOURCE_PATH, ROOT), "utf8"));
      const fetches = source.match(/\bfetch\(/g)?.length ?? 0;
      const bounded = source.match(/AbortSignal\.timeout\(/g)?.length ?? 0;
      assert.ok(fetches >= 2, `the file still makes its two Graph API calls (found ${fetches} fetch calls)`);
      assert.equal(bounded, fetches, `🔴 every fetch( in ${SOURCE_PATH} must carry an AbortSignal.timeout( — found ${fetches} fetch calls and ${bounded} timeouts`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    if (originalToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = originalToken;
  }

  console.log("whatsapp media timeout: OK");
}
