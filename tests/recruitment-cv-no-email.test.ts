import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  enforceRecruitmentCvEmailBlock,
  isRecruitmentCvReceivedEvent,
} from "@/lib/notifications/recruitment-cv-channel-guard";

const systemSource = readFileSync(
  new URL("../src/lib/notifications/system.ts", import.meta.url),
  "utf8",
);
const policySource = readFileSync(
  new URL("../src/lib/notifications/policy.ts", import.meta.url),
  "utf8",
);

/**
 * OWNER RULE (2026-08-15): the "new CV received" notice must never be delivered by email —
 * in-app and Telegram only. A Telegram-failure fallback re-enters the notification pipeline
 * with an explicit `channels: ["email","in_app","push"]` (see
 * triggerTelegramRetryExhaustionFallback in system.ts) whenever Telegram delivery fails —
 * which is the expected case while a recipient hasn't linked Telegram yet — so this asserts
 * the hard post-filter, not just the policy row, survives that path.
 */
export function runRecruitmentCvNoEmailTests() {
  const ALL = ["in_app", "email", "push", "telegram"] as const;

  // ── The rule, behaviourally ────────────────────────────────────────────────
  const blocked = enforceRecruitmentCvEmailBlock(ALL, "recruitment", "recruitment_inbound_cv");
  assert.ok(!blocked.includes("email"), "the CV-received notice must never keep an email channel");
  assert.ok(blocked.includes("in_app"), "in_app must survive the block");
  assert.ok(blocked.includes("telegram"), "telegram must survive the block");
  assert.ok(blocked.includes("push"), "push must survive the block");

  // Even the Telegram-failure fallback's explicit channels must lose email for this event.
  assert.deepEqual(
    enforceRecruitmentCvEmailBlock(["email", "in_app", "push"], "recruitment", "recruitment_inbound_cv"),
    ["in_app", "push"],
    "the Telegram-failure fallback's explicit channels must still resolve to no email",
  );

  // ── It must not over-reach ────────────────────────────────────────────────
  assert.ok(
    enforceRecruitmentCvEmailBlock(ALL, "recruitment", "offer_extended").includes("email"),
    "other recruitment notifications must keep email — the block is keyed on recruitment_inbound_cv only",
  );
  assert.ok(
    enforceRecruitmentCvEmailBlock(ALL, "attendance", "recruitment_inbound_cv").includes("email"),
    "the block must be scoped to the recruitment module, not the event name alone",
  );

  assert.equal(isRecruitmentCvReceivedEvent("recruitment", "recruitment_inbound_cv"), true);
  assert.equal(isRecruitmentCvReceivedEvent("Recruitment", "RECRUITMENT_INBOUND_CV"), true, "matching must be case-insensitive");
  assert.equal(isRecruitmentCvReceivedEvent("recruitment", "offer_extended"), false);
  assert.equal(isRecruitmentCvReceivedEvent(null, null), false);

  // ── The guard must actually be wired into the resolved channel list ────────
  assert.match(
    systemSource,
    /enforceRecruitmentCvEmailBlock\([\s\S]{0,80}input\.module, input\.eventType\)/,
    "basePolicyChannels must apply the recruitment CV email block to the RESOLVED channels, or the guard is decorative",
  );

  // The policy entry must still say in_app + telegram + push, so config and guard agree.
  assert.match(
    policySource,
    /"recruitment\.recruitment_inbound_cv": \{ channels: \["in_app", "telegram", "push"\]/,
    "the policy entry for the CV-received notice must stay in_app + telegram + push",
  );
}
