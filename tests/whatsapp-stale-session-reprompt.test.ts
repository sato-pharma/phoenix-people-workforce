import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  areaOtherPromptText,
  backgroundMenu,
  backgroundOtherPromptText,
  classifySessionSteps,
  experienceMenu,
  jobTitleMenu,
  jobTitleOtherPromptText,
  regionMenu,
  regionOtherPromptText,
} from "../src/lib/recruitment/inbound/whatsapp-classify-menus.ts";
import {
  isSessionStale,
  planReprompt,
  STALE_SESSION_REPROMPT_MS,
} from "../src/lib/recruitment/inbound/whatsapp-classify-session.ts";

// A conversation is opened by a CV and held open until it finishes. Before 2026-09-02 "open" had no
// expiry, so a sender who never answered the first menu kept the row open for good and every later
// CV they sent was met with silence — no menu, no acknowledgement, no log. Production that morning:
// one applicant sent a second CV 27.5 hours into an unanswered conversation and heard nothing, with
// 68 open sessions in the same state behind her. These tests pin the two halves of the fix: WHEN a
// conversation counts as gone quiet, and THAT every step it can be sitting on has a question we can
// repeat. A step with no plan is silence, which is the bug itself.

const HOUR = 60 * 60 * 1000;

/** The fields planReprompt reads, with only the ones a given step actually implies filled in. */
function sessionAt(step: string, extra: { region?: string | null; questionKey?: string | null } = {}) {
  return {
    step,
    region_code: extra.region ?? null,
    extra_current_question_key: extra.questionKey ?? null,
  };
}

export function runWhatsAppStaleSessionRepromptTests() {
  // ── The threshold ────────────────────────────────────────────────────────────────────────────
  assert.equal(STALE_SESSION_REPROMPT_MS, 6 * HOUR, "the re-ask threshold is six hours");

  const now = Date.parse("2026-09-02T09:50:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  // Warm: they have a live question in front of them. Asking it twice is worse than waiting, because
  // two identical menus give the applicant no way to tell which answer counts.
  assert.equal(isSessionStale(ago(0), now), false, "a conversation touched just now is not stale");
  assert.equal(isSessionStale(ago(HOUR), now), false, "an hour of quiet is not stale");
  assert.equal(
    isSessionStale(ago(STALE_SESSION_REPROMPT_MS - 60_000), now),
    false,
    "one minute short of the threshold is still warm",
  );

  // Quiet: re-ask. The boundary is inclusive so the threshold reads as "six hours or more".
  assert.equal(isSessionStale(ago(STALE_SESSION_REPROMPT_MS), now), true, "exactly the threshold is stale");
  assert.equal(
    isSessionStale(ago(27.5 * HOUR), now),
    true,
    "the production case — a second CV 27.5 hours into an unanswered conversation — must re-ask",
  );

  // A row we cannot date is treated as stale. Staying silent on it would be the original bug.
  assert.equal(isSessionStale(null, now), true, "a missing timestamp is stale, never silently warm");
  assert.equal(isSessionStale(undefined, now), true, "an absent timestamp is stale");
  assert.equal(isSessionStale("not a date", now), true, "an unparseable timestamp is stale");

  // ── THE HEADLINE: every step a live conversation can sit on can be re-asked ───────────────────
  // classifySessionSteps is the table's own vocabulary for the fixed six; "extra" is written by the
  // admin-defined question loop, which owns its own step name. Every one of them except the terminal
  // "done" must yield a plan, or a CV arriving on that step is answered with nothing.
  const liveSteps = [...classifySessionSteps.filter((step) => step !== "done"), "extra"];
  for (const step of liveSteps) {
    const plan = planReprompt(sessionAt(step, { questionKey: "oc_age_band", region: "D1" }));
    assert.ok(
      plan,
      `step "${step}" has no re-ask plan, so a CV arriving on it gets the silence this fix removes`,
    );
  }

  // A finished conversation has nothing to repeat, and an unrecognised step must not invent one.
  assert.equal(planReprompt(sessionAt("done")), null, "a finished conversation is not re-asked");
  assert.equal(planReprompt(sessionAt("who_knows")), null, "an unknown step yields no plan");

  // ── The re-ask is the SAME question, not a new one ───────────────────────────────────────────
  // Wording drift would be its own bug: the applicant would see two questions that look different
  // and mean the same thing. Each plan is compared against the builder the first ask uses.
  assert.deepEqual(planReprompt(sessionAt("job_title")), { kind: "menu", menu: jobTitleMenu() });
  assert.deepEqual(planReprompt(sessionAt("background")), { kind: "menu", menu: backgroundMenu() });
  assert.deepEqual(planReprompt(sessionAt("region")), { kind: "menu", menu: regionMenu() });
  assert.deepEqual(planReprompt(sessionAt("experience")), { kind: "menu", menu: experienceMenu() });
  assert.deepEqual(planReprompt(sessionAt("job_title_other")), { kind: "text", text: jobTitleOtherPromptText() });
  assert.deepEqual(planReprompt(sessionAt("background_other")), { kind: "text", text: backgroundOtherPromptText() });
  assert.deepEqual(planReprompt(sessionAt("region_other")), { kind: "text", text: regionOtherPromptText() });
  assert.deepEqual(planReprompt(sessionAt("area_other")), { kind: "text", text: areaOtherPromptText() });

  // Salary is a plan KIND rather than finished text on purpose: its wording can be overridden by the
  // owner, and resolving that needs a read. Returning the code default here would silently strip his
  // wording from the re-ask only — the one place nobody would think to look.
  assert.deepEqual(planReprompt(sessionAt("salary")), { kind: "salary" });

  // ── The two steps that need a partner field ──────────────────────────────────────────────────
  assert.deepEqual(
    planReprompt(sessionAt("area", { region: "D1" })),
    { kind: "area", regionCode: "D1" },
    "an area question is re-asked for the region they already chose",
  );
  assert.equal(
    planReprompt(sessionAt("area", { region: null })),
    null,
    "an area step with no region has no menu to rebuild",
  );
  assert.equal(
    planReprompt(sessionAt("area", { region: "NOPE" })),
    null,
    "an area step whose region is not one we offer has no menu to rebuild",
  );
  assert.deepEqual(
    planReprompt(sessionAt("extra", { questionKey: "oc_sheraton_commute" })),
    { kind: "extra", questionKey: "oc_sheraton_commute" },
    "an extra question is re-asked by its own key, so the loop resumes where it stopped",
  );
  assert.equal(
    planReprompt(sessionAt("extra", { questionKey: null })),
    null,
    "an extra step with no current question has nothing to repeat",
  );

  // ── The wiring ───────────────────────────────────────────────────────────────────────────────
  // planReprompt is pure, so it cannot prove startClassification actually calls it. These two pin
  // the call site: the old unconditional bail must be gone, and the re-ask must be reached.
  const source = readFileSync(
    new URL("../src/lib/recruitment/inbound/whatsapp-classify-session.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    source.includes('if (existing) return "already_open";'),
    false,
    "startClassification bails out of every open conversation again, which restores the silent swallow",
  );
  assert.ok(
    source.includes("resendCurrentPrompt(open, input.phoneNumberId)"),
    "startClassification no longer re-asks a stale conversation",
  );
}
