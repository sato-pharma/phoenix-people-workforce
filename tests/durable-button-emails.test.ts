import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDirectEmailPayload,
  resolveDirectEmailDispatch,
  sendDirectEmailMessage,
  type DurableEmailMessage,
} from "../src/lib/notifications/direct-email-payload.ts";
import {
  openDurableEmailRow,
  runDurableEmail,
  SUPERSEDED_REASON,
} from "../src/lib/notifications/durable-email.ts";
import {
  checkDurableEmailFollowUp,
  type InterviewInvitationFollowUp,
  type OfferLetterSendFollowUp,
} from "../src/lib/notifications/durable-email-follow-up.ts";
import {
  claimNotificationOutboxRow,
  deliverDirectEmailOutboxRow,
  isNeverRetriedEmailError,
  loadDueNotificationOutboxRows,
  retryDirectEmailOutboxRow,
  type NotificationOutboxRow,
} from "../src/lib/notifications/email.ts";
import { offerRetryFingerprint } from "../src/lib/offers/offer-fingerprint.ts";
import { offerExpiryRetryVerdict, offerLetterRetryVerdict } from "../src/lib/offers/outbox-retry.ts";
import { sendWhatsAppCvAcknowledgement } from "../src/lib/recruitment/inbound/whatsapp-reply.ts";
import { interviewInvitationRetryVerdict } from "../src/lib/recruitment/interview-invitation-retry.ts";
import { stripComments } from "./support/comment-strip.ts";

// THE EMAILS A PERSON SENDS WITH A BUTTON GO THROUGH THE OUTBOX (REC-048 phase 2, 19 Nov 2026).
//
// The job offer letter (send and resend), the offer expiry notice, the Interview Calendar invitation,
// the marketing "approved requests" email and the careers form's confirmation used to call the
// provider directly: a provider failure lost the email. Each now writes its notification_outbox row
// first, sends at once exactly as before (the person who pressed still reads whether it went), and a
// failure leaves the row for the drain. These cases run the REAL outbox code against an in-memory
// stand-in for the database — nothing leaves the machine.

const DIRECT_SEND = /(?<![\w$.])(sendPhoenixEmail|sendTemplatedEmail)\(/;

function code(path: string) {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

// ── A stand-in for PostgREST: notification_outbox in memory, every other table accepted and empty ──

type Row = Record<string, unknown>;

function cell(row: Row, column: string): unknown {
  const json = column.match(/^(\w+)->>(\w+)$/);
  if (json) {
    const holder = row[json[1]] as Record<string, unknown> | null | undefined;
    const value = holder?.[json[2]];
    return value == null ? null : String(value);
  }
  return row[column];
}

function compare(row: Row, column: string, op: string, raw: string): boolean {
  const value = cell(row, column);
  switch (op) {
    case "eq":
      return value != null && String(value) === raw;
    case "neq":
      return value == null || String(value) !== raw;
    case "is":
      return raw === "null" ? value == null : String(value) === raw;
    case "in":
      return raw.replace(/^\(|\)$/g, "").split(",").map((v) => v.replace(/^"|"$/g, "")).includes(String(value));
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      if (value == null) return false;
      const a = typeof value === "number" ? value : Date.parse(String(value));
      const b = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : Date.parse(raw);
      return op === "lt" ? a < b : op === "lte" ? a <= b : op === "gt" ? a > b : a >= b;
    }
    default:
      throw new Error(`the stand-in does not know the filter ${op}`);
  }
}

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, value] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(key)) continue;
    if (key === "or") {
      const parts = value.replace(/^\(|\)$/g, "").split(/,(?=\w+\.)/);
      const any = parts.some((part) => {
        const [column, op, ...rest] = part.split(".");
        return compare(row, column, op, rest.join("."));
      });
      if (!any) return false;
      continue;
    }
    const dot = value.indexOf(".");
    if (!compare(row, key, value.slice(0, dot), value.slice(dot + 1))) return false;
  }
  return true;
}

type Outbox = { other: Array<{ body: unknown; method: string; path: string }>; rows: Row[]; seq: number };

function json(status: number, body: unknown) {
  return new Response(body === null ? null : JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function postgrestStandIn(outbox: Outbox) {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const wantsObject = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
    const wantsRows = (headers.get("prefer") ?? "").includes("return=representation") || method === "GET";
    if (!url.pathname.endsWith("/rest/v1/notification_outbox")) {
      if (url.pathname.includes("/rest/v1/")) {
        outbox.other.push({ body: init.body ? JSON.parse(String(init.body)) : null, method, path: url.pathname.replace(/^.*\/rest\/v1\//, "") });
      }
      return method === "GET" ? json(200, []) : json(201, []);
    }

    const reply = (rows: Row[]) => {
      if (!wantsRows) return new Response(null, { status: 204 });
      if (wantsObject) return rows.length === 1 ? json(200, rows[0]) : json(406, { code: "PGRST116", message: "no rows" });
      return json(200, rows);
    };

    if (method === "POST") {
      const body = JSON.parse(String(init.body)) as Row;
      if (outbox.rows.some((row) => row.dedupe_key === body.dedupe_key)) {
        return json(409, { code: "23505", message: "duplicate key value violates unique constraint" });
      }
      outbox.seq += 1;
      const now = new Date().toISOString();
      const row: Row = { created_at: now, id: `row-${outbox.seq}`, last_error: null, provider_message_id: null, sent_at: null, ...body };
      outbox.rows.push(row);
      return reply([row]);
    }
    const hit = outbox.rows.filter((row) => matches(row, url.searchParams));
    if (method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as Row;
      for (const row of hit) Object.assign(row, patch);
      return reply(hit);
    }
    return reply(hit);
  }) as typeof fetch;
}

async function withOutbox(run: (outbox: Outbox) => Promise<void>) {
  const saved = { fetch: globalThis.fetch, key: process.env.SUPABASE_SERVICE_ROLE_KEY, url: process.env.NEXT_PUBLIC_SUPABASE_URL };
  const outbox: Outbox = { other: [], rows: [], seq: 0 };
  process.env.NEXT_PUBLIC_SUPABASE_URL = `https://durable-button-emails-${Date.now()}.example.supabase.co`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-durable-button-emails";
  globalThis.fetch = postgrestStandIn(outbox);
  try {
    await run(outbox);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────

const offerFollowUp: OfferLetterSendFollowUp = {
  approvedFromPending: true,
  copies: { bcc: ["omar.anwar@satopharma.com"], cc: [] },
  design: { blocks: [], fontFamily: "Inter", fontSizePt: 11, theme: {}, variant: "premium" },
  kind: "offer_letter",
  mode: "send",
  offerFingerprint: "fingerprint-at-the-press",
  offerId: "offer-1",
  requestedBy: "HR-011",
  revision: 0,
  sentBy: "B-10",
};

function offerMessage(subject = "Offer of employment — Medical Representative"): DurableEmailMessage {
  return {
    dispatch: "job_offer_smtp",
    input: {
      attachments: [{ content: "JVBERi0xLjQ=", contentType: "application/pdf", filename: "offer.pdf" }],
      bcc: ["omar.anwar@satopharma.com"],
      externalRecipients: ["candidate@example.com", "omar.anwar@satopharma.com"],
      from: "Sato Pharma HR <hr@satopharma.com>",
      html: "<p>The letter</p>",
      idempotencyKey: "offer-letter:offer-1",
      origin: { eventType: "offer_letter", module: "offers", notificationType: "offer_letter" },
      replyTo: "hr@satopharma.com",
      subject,
      text: "The letter",
      to: ["candidate@example.com"],
    },
    sender: "phoenix",
  };
}

const turbifyMarker = (async () => ({ id: "never", provider: "turbify" })) as unknown as NonNullable<ReturnType<typeof resolveDirectEmailDispatch>>;

function senders(answer: () => Promise<{ id: string; skipped: false }>, seen: Array<Record<string, unknown>>) {
  return {
    resolveDispatch: (name: "job_offer_smtp") => (name === "job_offer_smtp" ? turbifyMarker : undefined),
    sendPhoenixEmail: async (input: Record<string, unknown>) => {
      seen.push(input);
      return answer();
    },
    sendTemplatedEmail: async () => {
      throw new Error("the templated sender must not be reached by a plain email");
    },
  } as unknown as Parameters<typeof deliverDirectEmailOutboxRow>[1];
}

const noDirectSend = async () => {
  throw new Error("the direct fallback must not run while the outbox can be written");
};

// ── 1. Every button send goes through the outbox ─────────────────────────────────────────────────

function testEveryButtonSendGoesThroughTheOutbox() {
  const offers = code("src/lib/offers/send.ts");
  assert.doesNotMatch(offers, DIRECT_SEND, "no offer email reaches the provider around the outbox");
  assert.equal((offers.match(/await sendDurableEmail\(/g) ?? []).length, 2, "the letter (send and resend share it) and the expiry notice");
  assert.equal((offers.match(/dispatch: "job_offer_smtp",/g) ?? []).length, 2, "both still leave through the hr@ mailbox when it is configured");
  assert.match(offers, /dedupeKey: `offers:offer_letter:\$\{offer\.id\}:r\$\{revision\}`/, "the letter's key names the offer and its version");
  assert.match(offers, /supersedeKey: `offer_letter:\$\{offer\.id\}:r\$\{revision\}`/, "a second press for the same version replaces a waiting first");
  assert.match(offers, /kind: "offer_letter",\s*mode: "send",/, "a late letter knows to mark the offer sent");
  assert.match(offers, /offerFingerprint: offerRetryFingerprint\(offer\),/, "and carries the offer's fingerprint at the press, so a changed offer is never sent late");
  assert.match(offers, /followUp: \{ kind: "offer_letter", mode: "resend"/, "a late resend knows it changes nothing");
  assert.match(offers, /followUp: \{ kind: "offer_expiry", offerId: offer\.id \}/, "a late expiry notice knows to withdraw the offer");

  const invitations = code("src/lib/recruitment/interview-invitations.ts");
  assert.doesNotMatch(invitations, DIRECT_SEND, "the interview invitation reaches the provider only through the outbox");
  assert.equal((invitations.match(/await sendDurableEmail\(/g) ?? []).length, 1);
  assert.match(invitations, /kind: "interview_invitation",/, "a late invitation is checked against the booking and logged");
  assert.match(invitations, /supersedeKey: `interview_invitation:\$\{bookingId\}:\$\{recipient\}:\$\{kind\}:/, "a second press replaces a waiting invitation");

  const careers = code("src/lib/recruitment/inbound/website-apply-confirmation-email.ts");
  assert.doesNotMatch(careers, DIRECT_SEND, "the careers confirmation reaches the provider only through the outbox");
  assert.equal((careers.match(/await sendDurableEmail\(/g) ?? []).length, 1);

  const approved = code("src/lib/marketing-requests/ceo-approvals-email-service.ts");
  assert.doesNotMatch(approved, DIRECT_SEND, "the approved requests email reaches the provider only through the outbox");
  assert.match(approved, /via: "durable-email",/, "its Phoenix route takes the door's durable form");
  assert.match(approved, /dedupeKey: `marketing:approved_requests:\$\{fingerprint\}`/, "keyed on the ticked rows, so a second press the same day finds the first");
  assert.match(approved, /via: "direct-email", send: \(\) => sendFromOwnMailbox\(\)/, "the sender's own mailbox stays a direct, never-retried send");

  // The outbox payload carries no function: the dispatcher is a NAME, resolved by the send itself.
  const payload = code("src/lib/notifications/direct-email-payload.ts");
  assert.match(payload, /input: Omit<SendPhoenixEmailInput, "dispatch">/, "a stored plain email cannot carry a dispatcher function");
}

// ── 2. A forced provider failure leaves a row the drain retries ──────────────────────────────────

async function testAForcedProviderFailureLeavesARowTheDrainRetries() {
  await withOutbox(async (outbox) => {
    const pressSaw: Array<Record<string, unknown>> = [];
    const message = offerMessage();
    const before = Date.now();

    // The press: the row is written, the send fails at the provider, the person is told at once.
    await assert.rejects(
      runDurableEmail(
        message,
        { dedupeKey: "offers:offer_letter:offer-1:r0", followUp: offerFollowUp, supersedeKey: "offer_letter:offer-1:r0" },
        {
          deliver: (row) => deliverDirectEmailOutboxRow(row, senders(async () => {
            throw new Error("resend: 500 Internal Server Error");
          }, pressSaw)),
          open: openDurableEmailRow,
          sendDirect: noDirectSend,
        },
      ),
      /^Error: Queued for retry: resend: 500 Internal Server Error$/,
      "the person who pressed reads at once that it did not go, and that it is waiting",
    );
    assert.equal(pressSaw.length, 1, "the press sent once");
    assert.equal(pressSaw[0].dispatch, turbifyMarker, "through the hr@ dispatcher, resolved from its stored name");

    assert.equal(outbox.rows.length, 1, "one outbox row");
    const row = outbox.rows[0];
    assert.equal(row.status, "failed", "the row is left failed — for the drain");
    assert.equal(row.attempts, 1, "one attempt spent");
    assert.equal(row.max_attempts, 5);
    assert.equal(row.last_error, "resend: 500 Internal Server Error");
    const next = Date.parse(String(row.next_attempt_at));
    assert.ok(next >= before + 4 * 60_000 && next <= Date.now() + 6 * 60_000, "the drain's own first backoff: five minutes");
    const stored = row.payload as Record<string, unknown>;
    assert.equal(stored.kind, "direct_email");
    assert.deepEqual(stored.followUp, offerFollowUp, "the late send knows what it still has to do");
    assert.equal(stored.supersedeKey, "offer_letter:offer-1:r0");
    assert.deepEqual(JSON.parse(JSON.stringify(stored)), stored, "the payload is plain data — nothing a row cannot hold");
    assert.equal((stored.message as Record<string, unknown>).dispatch, "job_offer_smtp", "the dispatcher is stored by name");
    assert.deepEqual((stored.message as { input: unknown }).input, message.input, "the exact input the press used: same To, BCC, subject, body and PDF");

    // The drain: its own due-row query finds the row once its time has come…
    assert.equal((await loadDueNotificationOutboxRows(10)).length, 0, "not before its backoff");
    row.next_attempt_at = new Date(Date.now() - 1_000).toISOString();
    const due = await loadDueNotificationOutboxRows(10);
    assert.deepEqual(due.map((r) => r.id), [row.id], "the drain's own query picks the row up");

    // …claims it, asks the follow-up, sends the stored input, and catches the record up.
    const claimed = await claimNotificationOutboxRow(String(row.id));
    assert.ok(claimed && claimed.status === "processing", "the drain claims it");
    const drainSaw: Array<Record<string, unknown>> = [];
    const checked: unknown[] = [];
    const completed: Array<[unknown, string | null]> = [];
    const delivery = await retryDirectEmailOutboxRow(claimed as NotificationOutboxRow, {
      check: async (followUp) => {
        checked.push(followUp);
        return { decision: "proceed" };
      },
      complete: async (followUp, id) => {
        completed.push([followUp, id]);
      },
      deliver: (r) => deliverDirectEmailOutboxRow(r, senders(async () => ({ id: "msg-2", skipped: false }), drainSaw)),
    });
    assert.equal(delivery.outcome, "sent", "the drain's retry went");
    assert.deepEqual(checked, [offerFollowUp], "the offer was checked before the retry");
    assert.equal(drainSaw.length, 1);
    const { dispatch: drainDispatch, ...drainInput } = drainSaw[0];
    assert.equal(drainDispatch, turbifyMarker, "the retry leaves through the same hr@ dispatcher");
    assert.deepEqual(drainInput, message.input, "the retry sends exactly what the press would have");
    assert.deepEqual(completed, [[offerFollowUp, "msg-2"]], "and then marks the offer sent, with the provider's id");
    assert.equal(row.status, "sent");
    assert.equal(row.provider_message_id, "msg-2");
    const sentPayload = row.payload as { figuresCleared?: boolean; message: { input: Record<string, unknown> } };
    assert.equal(sentPayload.figuresCleared, true, "a sent row keeps no figures");
    assert.equal(sentPayload.message.input.html, "", "the letter's body is deleted once sent");
    assert.equal(sentPayload.message.input.attachments, undefined, "and the PDF with it");
  });
}

// ── 3. A late retry that is no longer the right email is never sent ───────────────────────────────

async function testAStaleRetryClosesUnsentAndAnUnreadableRecordWaits() {
  await withOutbox(async (outbox) => {
    const failing = senders(async () => {
      throw new Error("resend: 503");
    }, []);
    const press = (key: string) =>
      runDurableEmail(offerMessage(`Offer ${key}`), { dedupeKey: key, followUp: offerFollowUp }, {
        deliver: (row) => deliverDirectEmailOutboxRow(row, failing),
        open: openDurableEmailRow,
        sendDirect: noDirectSend,
      }).catch(() => undefined);
    await press("offers:a");
    await press("offers:b");
    assert.equal(outbox.rows.length, 2);

    let delivered = 0;
    const deliver = async () => {
      delivered += 1;
      return { outcome: "sent", result: { id: "x", skipped: false } } as const;
    };
    const skipped = await retryDirectEmailOutboxRow(outbox.rows[0] as unknown as NotificationOutboxRow, {
      check: async () => ({ decision: "skip", reason: "The offer was changed after this email failed, so the older letter was not sent." }),
      complete: async () => undefined,
      deliver,
    });
    assert.equal(skipped.outcome, "skipped", "a letter whose offer changed since the press is not sent");
    assert.equal(outbox.rows[0].status, "skipped", "a stale letter's row is closed");
    assert.match(String(outbox.rows[0].last_error), /^\[follow_up_refused\] The offer was changed/, "and says why");

    const later = await retryDirectEmailOutboxRow(outbox.rows[1] as unknown as NotificationOutboxRow, {
      check: async () => ({ decision: "later", reason: "The record behind this email could not be read." }),
      complete: async () => undefined,
      deliver,
    });
    assert.equal(later.outcome, "queued");
    assert.equal(outbox.rows[1].status, "failed", "an unreadable record leaves the row queued");
    assert.equal(outbox.rows[1].attempts, 2, "spending one attempt, like any failed try");
    assert.equal(delivered, 0, "neither was sent");

    assert.deepEqual(await checkDurableEmailFollowUp(undefined), { decision: "proceed" }, "an email with no follow-up is simply retried");
    assert.deepEqual(await checkDurableEmailFollowUp({ kind: "something_else" }), { decision: "proceed" }, "an unknown shape is not a follow-up");
  });
}

// ── 4. A send through a real Turbify mailbox is never retried behind HR's back ───────────────────

async function testATurbifyFailureIsNeverRetried() {
  await withOutbox(async (outbox) => {
    const refused = new Error("The offer was not sent: Turbify refused the app password for hr@satopharma.com.");
    refused.name = "JobOfferSmtpError";
    assert.ok(isNeverRetriedEmailError(refused), "a Turbify failure on the hr@ mailbox is never retried automatically");
    const personal = new Error("Your mailbox refused the login.");
    personal.name = "PersonalMailboxError";
    assert.ok(isNeverRetriedEmailError(personal), "nor is a failure through a person's own mailbox");
    assert.equal(isNeverRetriedEmailError(new Error("resend: 500")), false, "a provider error is retried");

    let thrown: unknown;
    try {
      await runDurableEmail(offerMessage(), { dedupeKey: "offers:turbify", followUp: offerFollowUp }, {
        deliver: (row) => deliverDirectEmailOutboxRow(row, senders(async () => {
          throw refused;
        }, [])),
        open: openDurableEmailRow,
        sendDirect: noDirectSend,
      });
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown, refused, "HR reads Turbify's own sentence, word for word — the very error, not a wrapper");
    const row = outbox.rows[0];
    assert.equal(row.status, "skipped", "the row is closed, not queued");
    assert.match(String(row.last_error), /^\[not_retried\] The offer was not sent: Turbify refused/);
    row.next_attempt_at = null;
    assert.equal((await loadDueNotificationOutboxRows(10)).length, 0, "the drain never picks it up");
  });
}

// ── 5. A second press replaces the first one's waiting row ───────────────────────────────────────

async function testASecondPressReplacesAWaitingFirst() {
  await withOutbox(async (outbox) => {
    const failing = senders(async () => {
      throw new Error("resend: 500");
    }, []);
    const ok = senders(async () => ({ id: "msg-9", skipped: false }), []);
    const options = (key: string) => ({ dedupeKey: key, followUp: offerFollowUp, supersedeKey: "offer_letter:offer-1:r0" });

    // First press fails; its row waits. A "processing" row of the same email (a drain mid-send) too.
    await runDurableEmail(offerMessage("first"), options("offers:first"), {
      deliver: (row) => deliverDirectEmailOutboxRow(row, failing),
      open: openDurableEmailRow,
      sendDirect: noDirectSend,
    }).catch(() => undefined);
    outbox.rows.push({
      attempts: 1,
      dedupe_key: "durable-email:offers:inflight",
      id: "row-inflight",
      max_attempts: 5,
      payload: { kind: "direct_email", supersedeKey: "offer_letter:offer-1:r0" },
      status: "processing",
    });
    outbox.rows.push({
      attempts: 1,
      dedupe_key: "durable-email:offers:other-offer",
      id: "row-other",
      max_attempts: 5,
      payload: { kind: "direct_email", supersedeKey: "offer_letter:offer-2:r0" },
      status: "failed",
    });

    // The second press (a freshly minted PDF and link, so a different message) goes, and replaces it.
    const result = await runDurableEmail(offerMessage("second"), options("offers:second"), {
      deliver: (row) => deliverDirectEmailOutboxRow(row, ok),
      open: openDurableEmailRow,
      sendDirect: noDirectSend,
    });
    assert.deepEqual(result, { id: "msg-9", skipped: false }, "the second press is sent and answered as before");
    const byId = new Map(outbox.rows.map((row) => [row.id, row]));
    assert.equal(byId.get("row-1")?.status, "skipped", "the first press's waiting row is closed");
    assert.equal(byId.get("row-1")?.last_error, SUPERSEDED_REASON, "and says a later send replaced it");
    assert.equal(byId.get("row-inflight")?.status, "processing", "a row being sent right now is never touched");
    assert.equal(byId.get("row-other")?.status, "failed", "another email's row is never touched");
    assert.equal(outbox.rows.find((row) => row.status === "sent")?.provider_message_id, "msg-9");
  });
}

// ── 6. The rules that decide whether a late email is still the right one ────────────────────────

function testTheStaleEmailRules() {
  const offer = { candidateEmail: "c@example.com", id: "offer-1", revision: 0, status: "pending_approval", templateSnapshot: null, totalMonthly: 12000 } as const;
  const atPress = { ...offerFollowUp, offerFingerprint: offerRetryFingerprint(offer as never) };
  assert.deepEqual(offerLetterRetryVerdict(offer as never, atPress), { decision: "proceed" }, "an untouched waiting offer is sent");
  assert.equal(offerRetryFingerprint({ ...offer } as never), atPress.offerFingerprint, "the same offer read again gives the same fingerprint");
  const draftAtPress = { ...offerFollowUp, offerFingerprint: offerRetryFingerprint({ ...offer, status: "draft" } as never) };
  assert.deepEqual(offerLetterRetryVerdict({ ...offer, status: "draft" } as never, draftAtPress), { decision: "proceed" }, "so is an untouched draft");
  assert.equal(offerLetterRetryVerdict({ ...offer, totalMonthly: 13000 } as never, atPress).decision, "skip", "an offer edited since the press is not sent");
  assert.equal(offerLetterRetryVerdict({ ...offer, status: "sent" } as never, atPress).decision, "skip", "an offer HR already sent again is not sent twice");
  assert.equal(offerLetterRetryVerdict({ ...offer, status: "withdrawn" } as never, atPress).decision, "skip", "a withdrawn offer is not sent");
  assert.equal(offerLetterRetryVerdict({ ...offer, revision: 1 } as never, atPress).decision, "skip", "a newer version is a different letter");
  const resend = { kind: "offer_letter", mode: "resend", offerId: "offer-1", revision: 0 } as const;
  assert.deepEqual(offerLetterRetryVerdict({ ...offer, status: "sent", templateSnapshot: {} } as never, resend), { decision: "proceed" }, "a resend of a sent offer goes");
  assert.equal(offerLetterRetryVerdict({ ...offer, status: "accepted", templateSnapshot: {} } as never, resend).decision, "skip", "never once the candidate answered");
  assert.deepEqual(offerExpiryRetryVerdict({ candidateEmail: "c@example.com", status: "sent" }), { decision: "proceed" }, "an offer still out is expired");
  assert.equal(offerExpiryRetryVerdict({ candidateEmail: "c@example.com", status: "accepted" }).decision, "skip", "an accepted offer is never expired late");

  const invite: InterviewInvitationFollowUp = {
    bookingId: "b-1",
    destination: "c@example.com",
    interviewerHrId: "A-9",
    invitationKind: "invitation",
    kind: "interview_invitation",
    recipient: "interviewer",
    sentByHrId: "HR-011",
    startsAt: "2026-11-20T08:00:00+00:00",
  };
  const now = new Date("2026-11-19T10:00:00Z");
  const booking = { interviewer_hr_id: "a-9", starts_at: "2026-11-20T08:00:00.000Z" };
  assert.deepEqual(interviewInvitationRetryVerdict(booking, invite, now), { decision: "proceed" }, "the same interview, still ahead: invited (the same instant, written two ways)");
  assert.equal(interviewInvitationRetryVerdict(null, invite, now).decision, "skip", "a cancelled interview is never invited to");
  assert.equal(interviewInvitationRetryVerdict({ ...booking, starts_at: "2026-11-20T09:00:00Z" }, invite, now).decision, "skip", "a moved interview's old invitation is not sent");
  assert.equal(interviewInvitationRetryVerdict(booking, invite, new Date("2026-11-20T08:30:00Z")).decision, "skip", "nor once it has begun");
  assert.equal(interviewInvitationRetryVerdict({ ...booking, interviewer_hr_id: "B-155" }, invite, now).decision, "skip", "nor to an interviewer who is no longer on it");
  assert.deepEqual(interviewInvitationRetryVerdict({ ...booking, interviewer_hr_id: "B-155" }, { ...invite, recipient: "candidate" }, now), { decision: "proceed" },
    "the candidate's own invitation does not depend on who interviews");
}

// ── 7. The dispatcher name and the stored shape ─────────────────────────────────────────────────

async function testTheDispatcherIsStoredByName() {
  const stored = JSON.parse(JSON.stringify(buildDirectEmailPayload(offerMessage(), "offers:x", "test", { followUp: offerFollowUp, supersedeKey: "k" })));
  assert.equal(stored.message.dispatch, "job_offer_smtp");
  assert.equal(stored.supersedeKey, "k");
  const seen: Array<Record<string, unknown>> = [];
  await sendDirectEmailMessage(stored.message, senders(async () => ({ id: "m", skipped: false }), seen) as never);
  assert.equal(seen[0].dispatch, turbifyMarker, "the stored name is resolved by the send");
  const named = offerMessage() as Extract<DurableEmailMessage, { sender: "phoenix" }>;
  const plain: DurableEmailMessage = { input: named.input, sender: "phoenix" };
  seen.length = 0;
  await sendDirectEmailMessage(plain, senders(async () => ({ id: "m", skipped: false }), seen) as never);
  assert.equal("dispatch" in seen[0], false, "a message that names no dispatcher keeps the provider chain");
  const saved = process.env.JOB_OFFER_SMTP_APP_PASSWORD;
  delete process.env.JOB_OFFER_SMTP_APP_PASSWORD;
  try {
    assert.equal(resolveDirectEmailDispatch("job_offer_smtp"), undefined, "with no hr@ app password the offer takes the provider chain, as before");
  } finally {
    if (saved !== undefined) process.env.JOB_OFFER_SMTP_APP_PASSWORD = saved;
  }
}

// ── 8. Outbound WhatsApp: every message Phoenix sends is in the ledger ──────────────────────────

async function testEveryOutboundWhatsAppMessageIsInTheLedger() {
  // Every POST to Meta's /messages lives in whatsapp-interactive.ts (whose postToGraph records each
  // send in ats_whatsapp_outbound_messages, the approvals line in its own ledger) — or records itself.
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
    const full = `${dir}/${entry}`;
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
  // The URL is a template literal ending in "/messages" and its closing backtick (written \x60 here,
  // so this file holds no backtick inside a regex for a comment-stripper to trip on).
  const graphMessages = /graph\.facebook\.com[^\x60'"]*\/messages\x60/;
  const senders = ["src", "app"].flatMap(walk).filter((file) => graphMessages.test(code(file)));
  assert.deepEqual(
    senders.sort(),
    ["src/lib/recruitment/inbound/whatsapp-interactive.ts", "src/lib/recruitment/inbound/whatsapp-reply.ts"],
    "a new file posting to Meta's /messages must send through whatsapp-interactive.ts or record itself — add it here only once it does",
  );
  assert.match(code("src/lib/recruitment/inbound/whatsapp-interactive.ts"), /await recordOutboundMessage\(/, "the shared sender records every send");
  assert.equal((code("src/lib/recruitment/inbound/whatsapp-reply.ts").match(/await record\(/g) ?? []).length, 3, "the acknowledgement records sent, refused and thrown alike");

  const keys = ["RECRUITMENT_WHATSAPP_AUTOREPLY_ENABLED", "RECRUITMENT_WHATSAPP_AUTOREPLY_TEMPLATE", "WHATSAPP_ACCESS_TOKEN"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.RECRUITMENT_WHATSAPP_AUTOREPLY_ENABLED = "true";
    process.env.RECRUITMENT_WHATSAPP_AUTOREPLY_TEMPLATE = "cv_received";
    process.env.WHATSAPP_ACCESS_TOKEN = "token-that-must-never-reach-the-ledger";
    for (const [meta, expected] of [[{ messages: [{ id: "wamid.ACK" }] }, true], [{ error: { message: "template paused" } }, false]] as const) {
      await withOutbox(async (outbox) => {
        const standIn = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input instanceof Request ? input.url : input);
          if (url.startsWith("https://graph.facebook.com/")) return json("messages" in meta ? 200 : 400, meta);
          return standIn(input, init);
        }) as typeof fetch;
        const answered = await sendWhatsAppCvAcknowledgement({ phoneNumberId: "PN-1", toWaId: "201000000000" });
        assert.equal(answered, expected, "what the acknowledgement returns is unchanged");
        const logged = outbox.other.filter((call) => call.path === "ats_whatsapp_outbound_messages" && call.method === "POST");
        assert.equal(logged.length, 1, "exactly one ledger row per acknowledgement");
        const row = logged[0].body as Record<string, unknown>;
        assert.equal(row.event, "whatsapp_cv_acknowledgement");
        assert.equal(row.to_wa_id, "201000000000");
        assert.equal(row.phone_number_id, "PN-1");
        assert.equal(row.message_type, "template");
        assert.equal(row.ok, expected);
        assert.equal(row.provider_message_id, expected ? "wamid.ACK" : null);
        assert.equal(row.failure_reason, expected ? null : "failed");
        assert.ok(!JSON.stringify(row).includes("token-that-must-never-reach-the-ledger"), "the access token is never written");
      });
    }
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

export async function runDurableButtonEmailsTests() {
  testEveryButtonSendGoesThroughTheOutbox();
  await testAForcedProviderFailureLeavesARowTheDrainRetries();
  await testAStaleRetryClosesUnsentAndAnUnreadableRecordWaits();
  await testATurbifyFailureIsNeverRetried();
  await testASecondPressReplacesAWaitingFirst();
  testTheStaleEmailRules();
  await testTheDispatcherIsStoredByName();
  await testEveryOutboundWhatsAppMessageIsInTheLedger();
}
