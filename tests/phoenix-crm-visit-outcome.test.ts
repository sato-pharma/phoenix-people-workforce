import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import {
  EMPTY_VISIT_OUTCOME,
  OBJECTION_NOTE_MAX,
  VISIT_NEXT_STEPS,
  VISIT_OBJECTIONS,
  isFollowUp,
  parseVisitOutcome,
  pickLastNextStep,
  visitNextStepLabel,
  visitObjectionLabel,
} from "../src/lib/phoenix-crm/visit-outcome.ts";
import {
  OBJECTION_NOTE_MAX as MOBILE_OBJECTION_NOTE_MAX,
  VISIT_NEXT_STEPS as MOBILE_NEXT_STEPS,
  VISIT_OBJECTIONS as MOBILE_OBJECTIONS,
  isFollowUp as mobileIsFollowUp,
} from "../mobile/src/lib/crm/visit-outcome.ts";

/**
 * Phoenix CRM — E3: the objection the doctor raised, and what the rep will do next.
 *
 * Owner, 2026-09-26, under Golden Rule #1. A call report that records only who was seen and what was
 * discussed is an attendance sheet; these are the two questions a pharmaceutical manager coaches on.
 *
 * ## The rule this file exists to pin
 *
 * 🔴 **AN UNKNOWN VALUE IS DROPPED, NEVER REFUSED** — deliberately the OPPOSITE of a day activity,
 * where the kind IS the record and an unknown kind is refused outright. These four are extras on a
 * visit that is otherwise complete, and the rep sending them is standing at a door holding a photo he
 * cannot retake: a phone one release behind must cost him the field, never the visit. It is a silent
 * rule — a `raise exception` added to the outcome block would compile, deploy, and only surface as a
 * rep in a clinic who cannot save — so the SQL is read here and asserted to drop rather than raise.
 *
 * And the second: **`none` is STORED, not collapsed to null.** "He tapped No objection" and "he left
 * the row alone" are different facts, and only the first is an answer. A parser that folded them
 * together would leave every board unable to tell a rep reporting honestly that a call went smoothly
 * from a rep who never fills the row in — which is the entire reason the column exists.
 */

const MIGRATION = "supabase/migrations/20260926210000_phoenix_crm_visit_outcome.sql";

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

function sql(): string {
  return stripSqlComments(readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

/** The body of the one function the migration re-creates. */
function saveVisitBody(): string {
  const text = sql();
  const start = text.indexOf("create or replace function public.phoenix_crm_save_visit(");
  assert.ok(start >= 0, "the migration re-creates phoenix_crm_save_visit");
  return text.slice(start);
}

export function runPhoenixCrmVisitOutcomeTests(): void {
  const nextStepKeys = VISIT_NEXT_STEPS.map((entry) => entry.key);
  const objectionKeys = VISIT_OBJECTIONS.map((entry) => entry.key);

  // ── The two vocabularies, and the phone's copy of them ────────────────────────────────────────
  //
  // `mobile/tsconfig.json` maps `@/*` to `mobile/src/*` only, so the phone cannot import the web's
  // module and carries a hand transcription. A drift is silent: the phone would write a value into
  // the column that the web's own screens cannot name, and the database would take it.
  {
    assert.deepEqual(nextStepKeys, ["follow_up", "send_data", "arrange_double", "invite_event", "pharmacy_stock", "none"]);
    assert.deepEqual(objectionKeys, ["price", "efficacy", "safety", "competitor", "formulary", "no_time", "none"]);
    assert.deepEqual(MOBILE_NEXT_STEPS.map((entry) => ({ ...entry })), VISIT_NEXT_STEPS.map((entry) => ({ ...entry })), "the phone's next steps are the same list, label for label");
    assert.deepEqual(MOBILE_OBJECTIONS.map((entry) => ({ ...entry })), VISIT_OBJECTIONS.map((entry) => ({ ...entry })), "and so are its objections");
    assert.equal(MOBILE_OBJECTION_NOTE_MAX, OBJECTION_NOTE_MAX);
    for (const key of [...nextStepKeys, "none"] as const) assert.equal(mobileIsFollowUp(key as never), isFollowUp(key as never));

    assert.equal(visitNextStepLabel("send_data"), "Send the data");
    assert.equal(visitObjectionLabel("none"), "No objection");
    // No pronoun in any label: a customer's own pronouns are nowhere in this system, and a label is
    // the one place a wrong guess would be printed back at the rep on every visit.
    for (const label of [...VISIT_NEXT_STEPS, ...VISIT_OBJECTIONS].map((entry) => entry.label)) {
      assert.doesNotMatch(label, /\b(he|him|his|she|her|hers)\b/i, `the label "${label}" names a gender`);
    }
  }

  // ── Dropped, never refused ────────────────────────────────────────────────────────────────────
  {
    // It has no failure shape at all — there is no `{ ok: false }` to return.
    assert.deepEqual(parseVisitOutcome({ nextStep: "sample_left", objection: "cost" }), EMPTY_VISIT_OUTCOME, "an unknown value is dropped");
    assert.deepEqual(parseVisitOutcome(null), EMPTY_VISIT_OUTCOME);
    assert.deepEqual(parseVisitOutcome("nonsense"), EMPTY_VISIT_OUTCOME);
    assert.deepEqual(parseVisitOutcome({ nextStep: 7, objection: [] }), EMPTY_VISIT_OUTCOME);

    // `none` is an answer and is kept.
    assert.equal(parseVisitOutcome({ objection: "none" }).objection, "none");
    assert.equal(parseVisitOutcome({ nextStep: "none" }).nextStep, "none");
    assert.equal(parseVisitOutcome({}).objection, null, "and a row left alone is not an answer");

    // The dependants go with their parent, so no row can read "by 30 Sept" under "Nothing to follow".
    assert.equal(parseVisitOutcome({ nextStep: "none", nextStepOn: "2026-09-30" }).nextStepOn, null);
    assert.equal(parseVisitOutcome({ nextStepOn: "2026-09-30" }).nextStepOn, null);
    assert.equal(parseVisitOutcome({ nextStep: "send_data", nextStepOn: "2026-09-30" }).nextStepOn, "2026-09-30");
    assert.equal(parseVisitOutcome({ nextStep: "send_data", nextStepOn: "30/09/2026" }).nextStepOn, null, "a date that is not an ISO day is dropped");
    assert.equal(parseVisitOutcome({ nextStep: "send_data", nextStepOn: "2026-02-31" }).nextStepOn, null, "and neither is a calendar-shaped non-day");

    assert.equal(parseVisitOutcome({ objection: "none", objectionNote: "he was fine" }).objectionNote, null);
    assert.equal(parseVisitOutcome({ objectionNote: "he was fine" }).objectionNote, null);
    assert.equal(parseVisitOutcome({ objection: "price", objectionNote: "  the  pack  is too big " }).objectionNote, "the pack is too big");

    // Sliced, never refused: the cap is a column width, not a rule the rep broke.
    const long = parseVisitOutcome({ objection: "price", objectionNote: "x".repeat(OBJECTION_NOTE_MAX + 40) });
    assert.equal(long.objectionNote?.length, OBJECTION_NOTE_MAX);
  }

  // ── And the DATABASE drops rather than raises, on the same two lists ──────────────────────────
  //
  // The parser is only the caller in front of it today. The rule has to be true of the function.
  {
    const body = saveVisitBody();
    for (const [column, keys] of [["next_step", nextStepKeys], ["objection", objectionKeys]] as const) {
      const guard = new RegExp(
        String.raw`if v_${column} is not null and v_${column} not in \(([^)]*)\) then\s+v_${column} := null;\s+end if;`,
      );
      const found = guard.exec(body);
      assert.ok(found, `${column}: an unrecognised value is set to null, never raised`);
      for (const key of keys) assert.ok(found[1].includes(`'${key}'`), `${column}: the function allows '${key}'`);
      assert.equal(
        (found[1].match(/'/g) ?? []).length / 2,
        keys.length,
        `${column}: the function's list is exactly the module's list, no more`,
      );
    }
    // The dependants, in the function too.
    assert.match(body, /if v_next_step is null or v_next_step = 'none' then\s+v_next_step_on := null;/);
    assert.match(body, /if v_objection is null or v_objection = 'none' then\s+v_objection_note := null;\s+else\s+v_objection_note := left\(v_objection_note, 300\);/);

    // 🔴 The headline. Every `raise exception` in the function is one that was already there; not one
    // of them mentions the outcome. A refusal added here costs a rep a visit he actually made.
    for (const raise of body.match(/raise exception '[^']+'/g) ?? []) {
      assert.doesNotMatch(raise, /next_step|objection|outcome/, `${raise} refuses a visit over an optional extra`);
    }
    assert.equal(/phoenix_crm:(bad_)?outcome/.test(body), false, "no refusal code exists for an outcome");
  }

  // ── The column agrees with the function, and holds no note without an objection ───────────────
  {
    const text = sql();
    const nextStepCheck = /constraint phoenix_crm_visits_next_step\s+check \(next_step is null or next_step in \(([^)]+)\)\)/.exec(text);
    assert.ok(nextStepCheck, "the column constrains its own values");
    for (const key of nextStepKeys) assert.ok(nextStepCheck[1].includes(`'${key}'`));

    const objectionCheck = /constraint phoenix_crm_visits_objection\s+check \(objection is null or objection in \(([^)]+)\)\)/.exec(text);
    assert.ok(objectionCheck, "and so does the objection");
    for (const key of objectionKeys) assert.ok(objectionCheck[1].includes(`'${key}'`));

    assert.match(
      text,
      /constraint phoenix_crm_visits_objection_note\s+check \(\s+objection_note is null\s+or \(objection is not null and objection <> 'none' and char_length\(objection_note\) <= 300\)\s+\)/,
      "a note with no objection beside it is a sentence contradicting the chip above it",
    );

    // All four are nullable with no default, so every visit already on file is correct with no
    // backfill: nobody was asked these questions, so nobody answered them.
    assert.match(
      text,
      /alter table public\.phoenix_crm_visits\s+add column if not exists next_step text,\s+add column if not exists next_step_on date,\s+add column if not exists objection text,\s+add column if not exists objection_note text;/,
    );
    assert.equal(/add column if not exists (next_step|objection)[^,;]*\bnot null\b/.test(text), false, "no new column is NOT NULL — that would need a backfill");
  }

  // ── What he said last time comes back to him ──────────────────────────────────────────────────
  //
  // The whole reason a next step is worth writing down. Kept apart from pickLastVisitProducts, which
  // shares the read: that one drops a customer whose products have all been retired from the line, and
  // a commitment the rep made to that same doctor is still a commitment.
  {
    const rows = [
      { customerId: "a", visitDate: "2026-09-01", capturedAt: "2026-09-01T08:00:00Z", nextStep: "send_data", nextStepOn: null },
      { customerId: "a", visitDate: "2026-09-20", capturedAt: "2026-09-20T08:00:00Z", nextStep: "arrange_double", nextStepOn: "2026-10-02" },
      { customerId: "b", visitDate: "2026-09-10", capturedAt: "2026-09-10T08:00:00Z", nextStep: "none", nextStepOn: null },
      { customerId: "c", visitDate: "2026-09-10", capturedAt: "2026-09-10T08:00:00Z", nextStep: null, nextStepOn: null },
      { customerId: "d", visitDate: "2026-09-10", capturedAt: "2026-09-10T08:00:00Z", nextStep: "sample_left", nextStepOn: null },
      // One day, two visits: the later capture is the answer.
      { customerId: "e", visitDate: "2026-09-10", capturedAt: "2026-09-10T09:00:00Z", nextStep: "follow_up", nextStepOn: null },
      { customerId: "e", visitDate: "2026-09-10", capturedAt: "2026-09-10T14:00:00Z", nextStep: "invite_event", nextStepOn: null },
    ];
    const picked = pickLastNextStep(rows);

    assert.deepEqual(picked.get("a"), { date: "2026-09-20", nextStep: "arrange_double", label: "Arrange a double visit", dueOn: "2026-10-02" });
    assert.equal(picked.has("b"), false, "'Nothing to follow' is not something to do, so it is absent");
    assert.equal(picked.has("c"), false, "and so is a visit that answered nothing");
    assert.equal(picked.has("d"), false, "an unrecognised value reads as unanswered here too");
    assert.equal(picked.get("e")?.nextStep, "invite_event", "the later capture of one day wins");

    // 🔴 The NEWEST visit's answer, never the newest visit that happens to carry one. A rep who
    // followed up last week and closed it out must not be told again, from the visit before that.
    const closed = pickLastNextStep([
      { customerId: "f", visitDate: "2026-09-01", capturedAt: "2026-09-01T08:00:00Z", nextStep: "send_data", nextStepOn: null },
      { customerId: "f", visitDate: "2026-09-20", capturedAt: "2026-09-20T08:00:00Z", nextStep: "none", nextStepOn: null },
    ]);
    assert.equal(closed.has("f"), false, "a commitment answered 'nothing to follow' later is closed, not resurrected");

    assert.equal(pickLastNextStep([{ customerId: "", visitDate: "2026-09-01", capturedAt: "x", nextStep: "send_data", nextStepOn: null }]).size, 0);
  }

  // ── Wired end to end, both apps ───────────────────────────────────────────────────────────────
  {
    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    assert.ok(visits.includes("next_step, next_step_on, objection, objection_note"), "the four columns are selected back");
    for (const line of [
      "next_step: visit.outcome.nextStep",
      "next_step_on: visit.outcome.nextStepOn",
      "objection: visit.outcome.objection",
      "objection_note: visit.outcome.objectionNote",
    ]) {
      assert.ok(visits.includes(line), `the save passes ${line}`);
    }
    assert.ok(visits.includes("pickLastNextStep("), "and the form carries last time's commitment");

    const entry = source("src/lib/phoenix-crm/entry-rules.ts");
    assert.ok(entry.includes("outcome: parseVisitOutcome(body)"), "the draft parses it");

    // The web visit form has been its own file since the one-tap rebuild (2026-09-29).
    const web = source("src/components/phoenix-crm/visit-log-form.tsx");
    const phone = source("mobile/src/features/crm/visits-screen.tsx");
    for (const [name, code] of [["web", web], ["phone", phone]] as const) {
      assert.ok(code.includes("VISIT_OBJECTIONS.map"), `${name}: the objections are offered`);
      assert.ok(code.includes("VISIT_NEXT_STEPS.map"), `${name}: and the next steps`);
      assert.ok(code.includes("lastNextStep"), `${name}: and last time's commitment is shown back at the door`);
      // GOLDEN RULE #1, the BLIND half: the objection belongs to the customer, never a verdict on
      // the rep, and the word "flagged" is how a verdict creeps back onto his screen.
      assert.doesNotMatch(code, /\bflagg?ed\b/i, `${name}: the word "flagged" is not in a rep's app`);
      // AM and PM, never "doctor" or "account" (owner, 2026-09-23). The module-wide sweep in
      // tests/phoenix-crm-am-pm-words.ts reads `src/**` only, so the phone is outside it — and the
      // first draft of this very block said "Did the doctor push back on anything?" in BOTH apps.
      // Here the two copies are held to the rule together.
      assert.doesNotMatch(code, /(push back on|pushed back on)[^\n]*\b(doctor|account)/i, `${name}: it says doctor or account where it must say customer`);
      assert.ok(code.includes("push back on anything?"), `${name}: it asks the question in the same words as the other app`);
    }

    // The phone sends no date, deliberately — and says so where the next person will look.
    assert.ok(phone.includes("nextStepOn: null"), "the phone sends no date");
    const mobilePure = readFileSync(new URL("../mobile/src/lib/crm/visit-outcome.ts", import.meta.url), "utf8");
    assert.match(mobilePure, /ONE DELIBERATE DIFFERENCE/, "and the reason is written down beside the copy, not only here");
  }

  console.log("phoenix-crm visit outcome: OK");
}
