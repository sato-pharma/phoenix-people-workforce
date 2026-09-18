import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  enforceOutstationRejectionEmailBlock,
  isOutstationRejectionEvent,
} from "../src/lib/notifications/outstation-rejection-channel-guard.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Slice one function body so an assertion is scoped to it, not to the whole file. */
function functionSlice(src: string, declaration: string) {
  const start = src.indexOf(declaration);
  assert.notEqual(start, -1, `expected to find ${declaration}`);
  const rest = src.slice(start + declaration.length);
  const nextExport = rest.indexOf("\nexport ");
  const nextFn = rest.indexOf("\nasync function ");
  const nextPlainFn = rest.indexOf("\nfunction ");
  const ends = [nextExport, nextFn, nextPlainFn].filter((index) => index !== -1);
  return rest.slice(0, ends.length > 0 ? Math.min(...ends) : rest.length);
}

/** Executable code only — the comments explain the rule and must not satisfy or trip a match. */
function code(slice: string) {
  return slice.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// Owner rule (2026-09-19): an employee whose expense is REJECTED is told in-app — never by email.
// "I don't want him to receive an email that his expense is rejected."
//
// Three things have to hold, and the rule is only as quiet as the weakest:
//   1. the call site must not ASK for email
//   2. the guard must strip email even when something else asks for it anyway — the Telegram-failure
//      fallback re-enters with ["email","in_app","push"], and before this change it never fired for
//      a rejection only because email was already in the original send
//   3. the guard must actually sit in the pipeline every send and every fallback passes through
//
// Plus the thing that makes a guard dangerous rather than useful: it must not widen. The submit
// notice is an owner-ruled email (2026-09-04) and keeps it, as does every other module.
export function runOutstationRejectionEmailBlockTests() {
  // ── 1. The call site no longer asks for email ──────────────────────────────────
  {
    const service = source("src/lib/outstation/service.ts");
    const decision = code(functionSlice(service, "async function notifyOutstationDecision"));
    const channels = decision.match(/channels:\s*\[([^\]]*)\]/);
    assert.ok(channels, "notifyOutstationDecision must pass an explicit channels list");
    assert.equal(/"email"/.test(channels[1]), false, "the rejection notice must not request the email channel");
    assert.match(channels[1], /"in_app"/, "in-app is how the employee is told his expense was rejected");
    assert.match(decision, /eventType: "request_rejected"/, "the guard keys on this exact event type");
    assert.match(decision, /module: "outstation"/, "the guard keys on this exact module");
  }

  // ── 2. The guard is the enforcement ────────────────────────────────────────────
  {
    assert.deepEqual(
      enforceOutstationRejectionEmailBlock(["email", "in_app", "push"], "outstation", "request_rejected"),
      ["in_app", "push"],
      "the Telegram-failure fallback shape must lose its email — this is the path that re-adds it behind the call site's back",
    );
    assert.deepEqual(
      enforceOutstationRejectionEmailBlock(["in_app", "email", "telegram", "push"], "outstation", "request_rejected"),
      ["in_app", "telegram", "push"],
      "the old call-site shape: email is stripped and every other channel survives",
    );
    assert.deepEqual(
      enforceOutstationRejectionEmailBlock(["email"], "outstation", "request_rejected"),
      [],
      "email-only resolves to NOTHING, never to a send",
    );
    assert.deepEqual(
      enforceOutstationRejectionEmailBlock(["in_app", "email"], "  Outstation  ", "  REQUEST_REJECTED  "),
      ["in_app"],
      "module and event are trimmed and lower-cased before matching",
    );
    assert.deepEqual(
      enforceOutstationRejectionEmailBlock(["in_app", "in_app", "push"], "outstation", "request_rejected"),
      ["in_app", "push"],
      "duplicates collapse, matching every sibling guard",
    );
  }

  // ── 3. The guard sits in the pipeline every send passes through ────────────────
  {
    // basePolicyChannels is what createSystemNotificationForRecipient resolves channels through —
    // including the in-line Telegram-failure fallback and triggerTelegramRetryExhaustionFallback,
    // both of which call createSystemNotification again. A guard defined but never chained guards
    // nothing, and every unit assert above would still pass.
    const system = source("src/lib/notifications/system.ts");
    const base = code(functionSlice(system, "function basePolicyChannels("));
    assert.match(
      base,
      /enforceOutstationRejectionEmailBlock\(\s*\w+,\s*input\.module,\s*input\.eventType\s*\)/,
      "basePolicyChannels must run the outstation rejection email block",
    );
    const resolver = code(functionSlice(system, "async function createSystemNotificationForRecipient("));
    assert.match(
      resolver,
      /const channels = basePolicyChannels\(/,
      "every per-recipient send must resolve its channels through basePolicyChannels",
    );
  }

  // ── 4. The guard must not widen ────────────────────────────────────────────────
  {
    for (const eventType of ["request_submitted", "outstation_sla_reminder", "departure_photo_reminder", "added_to_payroll", null, undefined]) {
      assert.deepEqual(
        enforceOutstationRejectionEmailBlock(["in_app", "email"], "outstation", eventType),
        ["in_app", "email"],
        `outstation/${String(eventType)} must keep its email channel — the submit notice is an owner-ruled email`,
      );
    }
    for (const other of ["marketing_requests", "vacation", "payroll", "recruitment", null, undefined]) {
      assert.deepEqual(
        enforceOutstationRejectionEmailBlock(["in_app", "email"], other, "request_rejected"),
        ["in_app", "email"],
        `${String(other)}/request_rejected must keep its email channel — the event name alone is not the key`,
      );
    }
  }

  // ── Predicate ──────────────────────────────────────────────────────────────────
  assert.equal(isOutstationRejectionEvent("outstation", "request_rejected"), true);
  assert.equal(isOutstationRejectionEvent("OUTSTATION", "REQUEST_REJECTED"), true);
  assert.equal(isOutstationRejectionEvent("outstation", "request_submitted"), false);
  assert.equal(isOutstationRejectionEvent("outstation", null), false);
  assert.equal(isOutstationRejectionEvent(null, "request_rejected"), false);
}
