import assert from "node:assert/strict";

import {
  enforceCandidateAssignedEmailBlock,
  isCandidateAssignedEvent,
} from "../src/lib/notifications/recruitment-candidate-assigned-channel-guard.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";
import { defaultTelegramPolicyFor } from "../src/lib/notifications/telegram-governance.ts";

// Owner rule (2026-08-24): a candidate pushed to a hiring manager reaches them IN-APP, by TELEGRAM
// and by PUSH. Never email. Asked for while sending a 14-person shortlist to the anti-infective
// National Sales Manager, when it turned out the button emailed unconditionally and nothing could
// stop it; Telegram was added the same day on the follow-up "add telegram too".
//
// Three independent things have to hold, and the rule is only as loud or as quiet as the weakest:
//   1. the policy row must not ASK for email, and must ask for the three that are wanted
//   2. the guard must strip email even when something else asks for it anyway
//   3. Telegram must be explicitly allowed and non-generic for the module, or the fail-safe leaves
//      a channel that is configured but silently never delivers anything readable
//
// Plus the thing that makes a guard dangerous rather than useful: it must not widen. Every other
// recruitment notification — offers, interviews, everything under recruitment.* — keeps its email.

export function runCandidateAssignedEmailBlockTests() {
  // ── 1. The policy row states the intent ─────────────────────────────────────────
  {
    const policy = resolveNotificationPolicy({ module: "recruitment", eventType: "candidate_assigned" });
    assert.equal(
      policy.channels.includes("email"),
      false,
      "the recruitment.candidate_assigned policy row must not request the email channel",
    );
    assert.equal(policy.channels.includes("in_app"), true, "in-app is how the manager actually sees it");
    assert.equal(policy.channels.includes("telegram"), true, "Telegram is what reaches a sales manager in the field");
    assert.equal(policy.channels.includes("push"), true, "push is the third delivery channel");

    // The row has to EXIST, not merely resolve. recruitment.* carries email, so a missing specific
    // row falls through to it and emails the exact notice this rule forbids — the same trap the
    // daily CV digest hit, which is why that one needed its own row too.
    const fallthrough = resolveNotificationPolicy({ module: "recruitment", eventType: "offer_approved" });
    assert.equal(
      fallthrough.channels.includes("email"),
      true,
      "recruitment.* still carries email, so candidate_assigned needs its OWN row — this assert is what proves the row is not merely inheriting",
    );
  }

  // ── 2. The guard is the enforcement, not the policy row ─────────────────────────
  {
    // The policy table is not the last word. An explicit call-site `channels`, the code defaults in
    // resolveBasePolicyChannels, and the Telegram-failure fallback all re-introduce email
    // downstream — the fallback re-enters with exactly ["email","in_app","push"].
    assert.deepEqual(
      enforceCandidateAssignedEmailBlock(["email", "in_app", "push"], "recruitment", "candidate_assigned"),
      ["in_app", "push"],
      "a candidate push must never be emailed — this is the Telegram-failure fallback shape, the one that re-adds email behind everyone's back",
    );
    assert.deepEqual(
      enforceCandidateAssignedEmailBlock(["in_app", "email", "push"], "recruitment", "candidate_assigned"),
      ["in_app", "push"],
      "this is the shape the call site used to pass; email is stripped and both authorized channels survive",
    );
    // The live shape since Telegram was added. This is a block on ONE channel, not an allow-list of
    // the others — so a channel the owner adds later must pass through untouched, and this assert
    // is what proves the guard was not quietly rewritten into a whitelist.
    assert.deepEqual(
      enforceCandidateAssignedEmailBlock(["in_app", "telegram", "email", "push"], "recruitment", "candidate_assigned"),
      ["in_app", "telegram", "push"],
      "email is stripped and all THREE authorized channels survive, Telegram among them",
    );
    assert.deepEqual(
      enforceCandidateAssignedEmailBlock(["email"], "recruitment", "candidate_assigned"),
      [],
      "email-only resolves to NOTHING, never to a send",
    );

    assert.deepEqual(
      enforceCandidateAssignedEmailBlock(["in_app", "email"], "  Recruitment  ", "  CANDIDATE_ASSIGNED  "),
      ["in_app"],
      "module and event are trimmed and lower-cased before matching",
    );
    assert.deepEqual(
      enforceCandidateAssignedEmailBlock(["in_app", "in_app", "push"], "recruitment", "candidate_assigned"),
      ["in_app", "push"],
      "duplicates collapse, matching every sibling guard",
    );
  }

  // ── 3. The guard must not widen ─────────────────────────────────────────────────
  {
    // Both call sites in hiring-manager-notify.ts write this one event type, so one key covers the
    // direct push AND the requisition-level assignment. Nothing else in recruitment may be caught.
    for (const eventType of ["offer_approved", "interview_scheduled", "recruitment_inbound_cv", "candidate_assigned_notify_failed", null, undefined]) {
      assert.deepEqual(
        enforceCandidateAssignedEmailBlock(["in_app", "email"], "recruitment", eventType),
        ["in_app", "email"],
        `recruitment/${String(eventType)} must keep its email channel`,
      );
    }
    for (const other of ["payroll", "vacation", "marketing_requests", "attendance", null, undefined]) {
      assert.deepEqual(
        enforceCandidateAssignedEmailBlock(["in_app", "email"], other, "candidate_assigned"),
        ["in_app", "email"],
        `${String(other)}/candidate_assigned must keep its email channel — the event name alone is not the key`,
      );
    }
  }

  // ── 4. Telegram must be allowed AND non-generic, or it delivers nothing useful ───
  {
    // Configuring a channel is not the same as it working. The unknown-module fail-safe disables
    // Telegram, and genericOnly collapses the message to "you have a notification" — which for this
    // event would strip out the one thing it exists to carry, the candidates' names. The sibling
    // `offers` module is deliberately disabled for exactly this sensitivity, so recruitment being
    // enabled is a real decision and not an accident to be tidied away.
    const policy = defaultTelegramPolicyFor("recruitment");
    assert.equal(
      policy.enabled,
      true,
      "recruitment needs Telegram enabled — the unknown-module fail-safe disables it, and the channel would then be configured but silently never send",
    );
    assert.equal(
      policy.genericOnly,
      false,
      "a generic 'you have a notification' ping cannot tell a manager WHO was sent to them, which is the entire content of this alert",
    );
  }

  // ── Predicate ───────────────────────────────────────────────────────────────────
  assert.equal(isCandidateAssignedEvent("recruitment", "candidate_assigned"), true);
  assert.equal(isCandidateAssignedEvent("RECRUITMENT", "CANDIDATE_ASSIGNED"), true);
  assert.equal(isCandidateAssignedEvent("recruitment", "candidate_assigned_notify_failed"), false,
    "the failure log event is a different string and must not match");
  assert.equal(isCandidateAssignedEvent("recruitment", null), false);
  assert.equal(isCandidateAssignedEvent(null, "candidate_assigned"), false);
}
