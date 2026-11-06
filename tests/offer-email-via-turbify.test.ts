import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { ADMIN_STANDING_EMAIL } from "../src/lib/email/admin-telegram-mirror.ts";
import { JOB_OFFER_SENDER_ADDRESS } from "../src/lib/email/job-offer-sender.ts";
import {
  JOB_OFFER_SMTP_PROVIDER,
  JobOfferSmtpError,
  jobOfferSmtpAppPassword,
  jobOfferSmtpDispatch,
  jobOfferSmtpFrom,
  type JobOfferDeliveryEvent,
  type JobOfferSmtpTransport,
} from "../src/lib/email/job-offer-smtp.ts";
import { sendPhoenixEmail } from "../src/lib/email/send-phoenix-email.ts";
import { shouldMirrorEmailToAdminTelegram } from "../src/lib/email/transactional-types.ts";
import { resolveOfferSender } from "../src/lib/offers/identity.ts";
import { composeRawMessage } from "../src/lib/personal-mailbox/smtp.ts";

/**
 * TWO OWNER DECISIONS OF 2026-11-06, PINNED BY EXECUTING THE SEND PATH.
 *
 * 1. "Send job offers through the real hr@ mailbox." With `JOB_OFFER_SMTP_APP_PASSWORD` set, an offer is
 *    handed to Turbify's own server as `hr@satopharma.com` and never to Resend (112 apex-From Resend
 *    sends in 35 days, 0 opens: Yahoo junks the company's own address arriving from Amazon SES). A
 *    Turbify failure is the offer's failure — never a quiet fall back to Resend. Unset, nothing changes.
 * 2. "Stop the BCC copies." No automated email is blind-copied to the owner's mailbox any more (about
 *    8,000 a month were, and taught Yahoo that satopharma.com mail is junk). His copy is the Telegram
 *    mirror, which stays on every path, the Turbify one included.
 *
 * The real `sendPhoenixEmail` runs here. Nothing leaves the machine: `fetch` is replaced for the whole
 * run, the Turbify transport is a fake, the Confidence Gate and the Recipient Assurance Guard are
 * bypassed (both are database-bound), and every send is stamped as a credential email ONLY so that the
 * Telegram mirror — a real outbound message if this suite ever runs with live keys — stays quiet. The
 * mirror's presence is pinned by its decision function and its place in the source instead.
 */

const CANDIDATE = "candidate.person@example.com";
const RESEND_ENDPOINT = "https://api.resend.com/emails";

type FetchCall = { body: string; url: string };

function stubFetch(calls: FetchCall[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ body: typeof init?.body === "string" ? init.body : "", url });
    if (url.startsWith(RESEND_ENDPOINT)) {
      return new Response(JSON.stringify({ id: "re_test_1" }), { headers: { "content-type": "application/json" }, status: 200 });
    }
    if (url.includes("/rest/v1/")) {
      return new Response("[]", { headers: { "content-type": "application/json" }, status: 200 });
    }
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" }, status: 200 });
  }) as typeof fetch;
}

type FakeTransport = JobOfferSmtpTransport & {
  filed: number;
  recorded: JobOfferDeliveryEvent[];
  sent: Array<{ envelope: { from: string; to: string[] }; raw: string; user: string }>;
};

function fakeTransport(options: { fileError?: unknown; rejected?: string[]; sendError?: unknown } = {}): FakeTransport {
  const transport: FakeTransport = {
    async compose(composeOptions) {
      return composeRawMessage(composeOptions);
    },
    filed: 0,
    async fileInSent() {
      transport.filed += 1;
      if (options.fileError) throw options.fileError;
      return "appended";
    },
    async record(row) {
      transport.recorded.push(row);
    },
    recorded: [],
    async send(credential, envelope, raw) {
      transport.sent.push({ envelope, raw: raw.toString("utf8"), user: credential.user });
      if (options.sendError) throw options.sendError;
      return { rejected: options.rejected ?? [] };
    },
    sent: [],
  };
  return transport;
}

function offerEmail(idempotencyKey: string, extra: Partial<Parameters<typeof sendPhoenixEmail>[0]> = {}) {
  const sender = resolveOfferSender();
  return {
    attachments: [
      { content: Buffer.from("%PDF-1.4 test").toString("base64"), contentType: "application/pdf", filename: "Offer.pdf" },
    ],
    bcc: ["typed.copy@satopharma.com"],
    // Database-bound gates off; see the header. The credential stamp only silences the mirror.
    bypassConfidenceGate: true,
    credentialEmail: "password_setup_link" as const,
    externalRecipients: [CANDIDATE],
    from: sender.from,
    html: "<p>Offer of employment</p>",
    idempotencyKey,
    origin: { eventType: "offer_letter", module: "offers", notificationType: "offer_letter" },
    replyTo: sender.replyTo,
    subject: "Offer of Employment — Medical Representative",
    text: "Offer of employment",
    to: [CANDIDATE],
    ...extra,
  };
}

const ENV_KEYS = [
  "EMAIL_FAILOVER_ENABLED",
  "EMAIL_NOTIFICATIONS_ENABLED",
  "JOB_OFFER_EMAIL_FROM",
  "JOB_OFFER_SMTP_APP_PASSWORD",
  "PHOENIX_EMAIL_DELIVERY_MODE",
  "PHOENIX_EMAIL_FORCE_TESTING",
  "RESEND_API_KEY",
] as const;

export async function runOfferEmailViaTurbifyTests() {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = stubFetch(calls);
  try {
    process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
    process.env.EMAIL_FAILOVER_ENABLED = "false";
    // Real recipients, not the testing redirect — the redirect skips the BCC question altogether.
    process.env.PHOENIX_EMAIL_FORCE_TESTING = "false";
    process.env.PHOENIX_EMAIL_DELIVERY_MODE = "";
    process.env.RESEND_API_KEY = "re_test_key";
    delete process.env.JOB_OFFER_EMAIL_FROM;

    // ── 1. the switch ─────────────────────────────────────────────────────────────────────────────
    delete process.env.JOB_OFFER_SMTP_APP_PASSWORD;
    assert.equal(jobOfferSmtpDispatch(fakeTransport()), undefined, "unset: no Turbify dispatcher, the provider chain stays");
    process.env.JOB_OFFER_SMTP_APP_PASSWORD = "   ";
    assert.equal(jobOfferSmtpDispatch(fakeTransport()), undefined, "blank after normalisation counts as unset");
    process.env.JOB_OFFER_SMTP_APP_PASSWORD = "abcd efgh ijkl mnop";
    assert.equal(jobOfferSmtpAppPassword(), "abcdefghijklmnop", "pasted as Turbify shows it — the spaces are stripped like the mailbox monitor strips them");
    assert.deepEqual(
      jobOfferSmtpFrom("Sato Pharma <hr@send.satopharma.com>"),
      { address: JOB_OFFER_SENDER_ADDRESS, name: "Sato Pharma" },
      "the display name stays the offer's own, and the address is the mailbox that logs in — hr@ on the apex",
    );

    // ── 2. with the password set, the offer goes to Turbify as hr@ — and never to Resend ───────────
    {
      const transport = fakeTransport();
      calls.length = 0;
      const result = await sendPhoenixEmail(offerEmail("offer-letter:turbify-1", { dispatch: jobOfferSmtpDispatch(transport) }));
      assert.equal(result.skipped, false, "the offer went out");
      assert.equal(transport.sent.length, 1, "handed to Turbify exactly once");
      const [sent] = transport.sent;
      assert.equal(sent.user, JOB_OFFER_SENDER_ADDRESS, "logged in as the real hr@ mailbox");
      assert.equal(sent.envelope.from, JOB_OFFER_SENDER_ADDRESS, "the envelope sender is hr@satopharma.com");
      assert.match(sent.raw, /^From: .*<hr@satopharma\.com>\r?$/m, "the From header is hr@satopharma.com");
      assert.match(sent.raw, /^Subject: /m);
      assert.match(sent.raw, /^Reply-To: /m, "the offer's Reply-To travels with it");
      assert.doesNotMatch(sent.raw, /^Bcc:/im, "a blind copy never appears in the message itself");
      assert.ok(sent.envelope.to.includes(CANDIDATE), "the candidate is in the envelope");
      assert.ok(sent.envelope.to.includes("typed.copy@satopharma.com"), "a BCC HR typed still reaches its addressee, through the envelope");
      assert.ok(
        !sent.envelope.to.includes(ADMIN_STANDING_EMAIL),
        "no standing admin BCC on the Turbify path (owner, 2026-11-06: \"Stop the BCC copies\")",
      );
      assert.equal(calls.filter((call) => call.url.startsWith(RESEND_ENDPOINT)).length, 0, "Resend is never called");
      assert.equal(transport.filed, 1, "the same bytes are filed in the hr@ Sent folder");
      assert.equal(transport.recorded.length, 1);
      assert.equal(transport.recorded[0].provider, JOB_OFFER_SMTP_PROVIDER, "recorded under the provider turbify");
      assert.equal(transport.recorded[0].status, "sent");
      assert.deepEqual(transport.recorded[0].recipients, [CANDIDATE]);

      // A double press of the same send sends once.
      const again = await sendPhoenixEmail(offerEmail("offer-letter:turbify-1", { dispatch: jobOfferSmtpDispatch(transport) }));
      assert.equal(again.skipped, false);
      assert.equal(transport.sent.length, 1, "the same idempotency key is not sent a second time");
    }

    // ── 3. a Turbify failure is the offer's failure — no Resend, a sentence HR can read ────────────
    {
      const transport = fakeTransport({
        sendError: Object.assign(new Error("535 5.7.0 (#AUTH005) Too many bad auth attempts for someone@example.com"), {
          code: "EAUTH",
          responseCode: 535,
        }),
      });
      calls.length = 0;
      await assert.rejects(
        sendPhoenixEmail(offerEmail("offer-letter:turbify-2", { dispatch: jobOfferSmtpDispatch(transport) })),
        (error: unknown) => {
          assert.ok(error instanceof JobOfferSmtpError, "the failure surfaces as the offer's own error");
          assert.match(error.message, /refused the app password for hr@satopharma\.com/);
          assert.match(error.message, /JOB_OFFER_SMTP_APP_PASSWORD/, "it names the variable that needs a new value");
          assert.doesNotMatch(error.message, /someone@example\.com|AUTH005/, "never the server's own text, which quotes addresses");
          return true;
        },
      );
      assert.equal(calls.filter((call) => call.url.startsWith(RESEND_ENDPOINT)).length, 0, "a Turbify failure never falls back to Resend");
      assert.equal(transport.filed, 0, "nothing is filed in Sent for an offer that did not leave");
      assert.equal(transport.recorded[0]?.status, "failed", "the failure is recorded under turbify");
      assert.equal(transport.recorded[0]?.provider, JOB_OFFER_SMTP_PROVIDER);

      // Retrying after a failure really tries again.
      await assert.rejects(sendPhoenixEmail(offerEmail("offer-letter:turbify-2", { dispatch: jobOfferSmtpDispatch(transport) })));
      assert.equal(transport.sent.length, 2, "a failed key is forgotten, so Send tries again");

      // The candidate's own address refused: not sent to him, so not reported as sent.
      const refused = fakeTransport({ rejected: [CANDIDATE] });
      await assert.rejects(
        sendPhoenixEmail(offerEmail("offer-letter:turbify-3", { dispatch: jobOfferSmtpDispatch(refused) })),
        /refused the candidate's address/,
      );
    }

    // ── 4. a failed Sent copy never fails, or resends, the offer ───────────────────────────────────
    {
      const transport = fakeTransport({ fileError: new Error("IMAP down") });
      const result = await sendPhoenixEmail(offerEmail("offer-letter:turbify-4", { dispatch: jobOfferSmtpDispatch(transport) }));
      assert.equal(result.skipped, false, "the offer still counts as sent");
      assert.equal(transport.sent.length, 1, "and was sent exactly once");
      assert.equal(transport.recorded[0]?.status, "sent");
      assert.equal(transport.recorded[0]?.raw_event.filedInSent, false, "the missing Sent copy is recorded, not hidden");
    }

    // ── 5. without the password the ordinary Resend path is used — and it carries no admin BCC ─────
    {
      delete process.env.JOB_OFFER_SMTP_APP_PASSWORD;
      calls.length = 0;
      const result = await sendPhoenixEmail(offerEmail("offer-letter:resend-1", { dispatch: jobOfferSmtpDispatch(fakeTransport()) }));
      assert.equal(result.skipped, false);
      const resendCalls = calls.filter((call) => call.url.startsWith(RESEND_ENDPOINT));
      assert.equal(resendCalls.length, 1, "unset: the offer goes through Resend exactly as before");
      const body = JSON.parse(resendCalls[0].body) as { bcc?: string[]; from: string };
      assert.equal(body.from, resolveOfferSender().from, "with the same From as before");
      assert.deepEqual(body.bcc, ["typed.copy@satopharma.com"], "only the BCC the caller asked for");
      assert.ok(!(body.bcc ?? []).includes(ADMIN_STANDING_EMAIL), "no standing admin BCC on the Resend path");

      // An ordinary notification with no BCC of its own goes out with none at all.
      calls.length = 0;
      await sendPhoenixEmail({
        ...offerEmail("notification:no-bcc-1"),
        bcc: undefined,
        externalRecipients: ["someone@example.com"],
        origin: { eventType: "leave_request", module: "leave", notificationType: "leave_request" },
        to: ["someone@example.com"],
      });
      const plain = calls.find((call) => call.url.startsWith(RESEND_ENDPOINT));
      assert.ok(plain, "the notification reached the provider");
      assert.equal((JSON.parse(plain.body) as { bcc?: string[] }).bcc, undefined, "an automated email carries no BCC unless its sender asked for one");
    }

    // ── 6. the Telegram mirror stays, on every path ────────────────────────────────────────────────
    assert.equal(
      shouldMirrorEmailToAdminTelegram({ credentialEmail: null, testingRedirectActive: false }),
      true,
      "an offer — like every non-credential email — is still mirrored to the admin's Telegram",
    );
    const send = stripComments(readFileSync("src/lib/email/send-phoenix-email.ts", "utf8"));
    assert.doesNotMatch(send, /ADMIN_STANDING_EMAIL|withStandingAdminBcc/, "the send path adds no standing admin BCC");
    const dispatchAt = send.indexOf("const delivered = input.dispatch ? await input.dispatch(prepared) : await sendPreparedEmailWithFailover(prepared);");
    const mirrorAt = send.indexOf("void mirrorEmailToAdminTelegram(");
    assert.ok(dispatchAt > 0, "the Turbify dispatch replaces only the provider hand-off");
    assert.ok(mirrorAt > dispatchAt, "and the mirror runs after it, whichever way the email left");

    // ── 7. every offer email is wired to the dispatcher ───────────────────────────────────────────
    const offers = stripComments(readFileSync("src/lib/offers/send.ts", "utf8"));
    assert.equal(
      (offers.match(/dispatch: jobOfferSmtpDispatch\(\),/g) ?? []).length,
      (offers.match(/await sendPhoenixEmail\(\{/g) ?? []).length,
      "the letter (send and resend) and the expiry notice all go through the hr@ mailbox when it is configured",
    );
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
