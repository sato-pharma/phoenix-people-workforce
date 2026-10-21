import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { VISIT_COMMENT_REQUIRED } from "../src/lib/phoenix-crm/entry-rules.ts";

/**
 * Phoenix CRM — the visit form is easy to finish (owner, 2026-09-30: "the best-appearing and easiest
 * CRM, yet controlled").
 *
 * GOLDEN RULE #1, the EASY half: the rep is at a door with the phone in one hand. Four things are
 * pinned here, and each one goes wrong QUIETLY — nothing fails, the form just gets harder again:
 *
 *   (a) LOG VISIT IS UNDER HIS THUMB. One bar held at the bottom of the screen (above the portal's
 *       bottom navigation on a phone, the plan board's own pattern) carries the form's ONE save. A
 *       second save button, or the button drifting back to the end of a long form, is the regression.
 *   (b) THE BAR SAYS WHAT IS MISSING BEFORE HE TAPS — and it reads it from the save's OWN check
 *       (`draft`), never a copy of the rules. A copied list is how "Next: write the comment" goes on
 *       showing after he wrote it, or stops showing a rule the save still enforces.
 *   (c) THE REQUIRED STEPS LEAD. The comment is required since 2026-09-30, so it follows the products
 *       straight away; everything the save does not need comes after one line that says Optional.
 *   (d) THE ONE-TAP RULE STANDS (owner, 2026-09-29): no photo, no date, no time, no AM/PM picker on the
 *       form, and every control a thumb's size — square, never truncated.
 *   (e) EVERY POINT STAYS; THE PHARMACY AND WHAT HE LEFT START FOLDED (owner, 2026-10-02) AND WHAT HE
 *       TOOK AWAY IS OPEN (owner, 2026-10-06): no point removed, no step added, one tap opens a folded
 *       step in place, a required step is never folded — and the two chips that are open stay OPTIONAL,
 *       which is the half that goes wrong most quietly of all.
 *
 * The picker half: today's receiving customers come first, but only when the data carries hours —
 * a list with none keeps the server's order.
 */

const ROOT = new URL("../", import.meta.url);

const FORM = "src/components/phoenix-crm/visit-log-form.tsx";
const PICKER = "src/components/phoenix-crm/visit-customer-picker.tsx";
const START = "src/components/phoenix-crm/visit-start.tsx";

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

/** The numbered step titles of the form, in the order they render. */
function stepTitles(code: string): string[] {
  return [...code.matchAll(/<CrmBlock[^>]*title="(\d+ · [^"]+)"/g)].map((match) => match[1] ?? "");
}

export function runPhoenixCrmVisitFormEaseTests(): void {
  const form = source(FORM);

  // ── (a) One Log visit, in a bar held at the bottom ─────────────────────────────────────────────
  {
    const barAt = form.indexOf('className="sticky bottom-[var(--crm-sticky-bottom,0px)]');
    assert.notEqual(barAt, -1, "the form has a bar held at the bottom, above the phone's bottom navigation");
    assert.ok(form.slice(barAt, barAt + 400).includes("lg:bottom-0"), "and at the very bottom on a desktop, where there is no bottom navigation");

    const saves = [...form.matchAll(/void save\(Date\.now\(\)\)/g)];
    assert.equal(saves.length, 1, "the form has ONE way to save — a second Log visit is a second path that can drift");
    assert.ok((saves[0]?.index ?? -1) > barAt, "and that one Log visit lives in the bottom bar, under his thumb");
    assert.match(
      form.slice(barAt),
      /<CrmButton busy=\{saving\}[^>]*onClick=\{\(\) => void save\(Date\.now\(\)\)\} variant="primary">\s*\{saving \? "Saving…" : "Log visit"\}/,
      "it is the primary button, busy while it saves, so a second tap cannot send the visit twice",
    );
    assert.equal((form.match(/: "Log visit"\}/g) ?? []).length, 1, "exactly one button says Log visit");

    const lastStep = form.indexOf('title="7 · What you took away"');
    assert.ok(lastStep !== -1 && barAt > lastStep, "the bar comes after every step, so it closes the form rather than splitting it");

    // Leaving with a recording is said IN the bar, where it is in view from either exit. Since
    // 2026-10-02 the sentence is CHOSEN (`voiceNoteLeaveWarning`) — a microphone still running, or a
    // note recorded and not saved — so the bar renders the chosen one rather than naming a constant.
    const warnAt = form.indexOf("{leaveWarning.message}");
    assert.ok(warnAt > barAt, "the unsaved-recording sentence is in the bottom bar, in view whichever exit he used");
    assert.equal((form.match(/\{leaveWarning\.message\}/g) ?? []).length, 1, "and said once, not at the top as well");
  }

  // ── (b) The next missing thing, in the save's own words ─────────────────────────────────────────
  {
    assert.equal(VISIT_COMMENT_REQUIRED, "Write what happened on the visit — type it or speak it.", "the comment's words are the server's own");
    assert.ok(form.includes('const check = draft("", null);'), "the bar reads the save's own check, never a copy of the rules");
    const barAt = form.indexOf('className="sticky bottom-[var(--crm-sticky-bottom,0px)]');
    const bar = form.slice(barAt);
    assert.ok(bar.includes("{check.problem}"), "the bar names what the save would refuse, before he taps");
    assert.ok(bar.includes('{tried ? "Still needed" : "Next"}'), "as the next thing — and as still needed once he has tried");
    assert.ok(bar.includes("Ready to log"), "and says so when nothing required is missing");
    assert.ok(bar.includes("onClick={() => showStep(openStep)}"), "one tap on that line takes him to the step it means");

    // The draft names the two required answers in the order the form shows them.
    const draftAt = form.indexOf("function draft(visitId: string, formOpenSeconds: number | null): Draft {");
    assert.notEqual(draftAt, -1, "the form still builds one draft");
    const productsCheck = form.indexOf('if (products.length === 0) return { ok: false, problem: "Choose the products you discussed." };', draftAt);
    const commentCheck = form.indexOf("if (!comment.trim()) return { ok: false, problem: VISIT_COMMENT_REQUIRED };", draftAt);
    assert.ok(productsCheck > draftAt, "no products: \"Choose the products you discussed.\"");
    assert.ok(commentCheck > productsCheck, "then no comment — the same order the steps are drawn in, so the bar walks him down the form");

    // A refused press turns the line into a refusal and scrolls to it — it copies no sentence of its own.
    const saveAt = form.indexOf("async function save(savedAt: number) {");
    const refused = form.slice(saveAt, form.indexOf("visitIdRef.current = visitId;", saveAt));
    assert.ok(refused.includes("setTried(true);") && refused.includes("showStep(openStep);"), "a refused Log visit marks the line and takes him to the step");
    assert.equal(/setProblem\(next\.problem\)/.test(refused), false, "and never freezes a copy of the sentence that goes stale as he fills it in");

    // The jump order is the draft's order: a customer already visited first (no step answers that),
    // then the reason, who, the products and the comment.
    const jump = /const openStep = ([\s\S]*?);\n/.exec(form)?.[1]?.replace(/\s+/g, " ") ?? "";
    assert.equal(
      jump,
      "customer.visitedToday ? null : !reasonDone ? STEP_REASON : !whoDone ? STEP_WHO : !productsDone ? STEP_PRODUCTS : !commentDone ? STEP_COMMENT : !doubleVisitDone ? STEP_DOUBLE : null",
      "the step the bar points at follows the draft's own order, and the double visit question is the LAST stop",
    );
    for (const [step, anchor] of [
      ["the reason", "id={STEP_REASON}"],
      ["who was on the visit", "id={STEP_WHO}"],
      ["the products", "id={STEP_PRODUCTS}"],
      ["the comment", "id={STEP_COMMENT}"],
    ] as const) {
      assert.ok(form.includes(anchor), `${step} can be scrolled to`);
    }
  }

  // ── (c) Comment right after Products; the optional steps after one Optional line ────────────────
  {
    assert.deepEqual(
      stepTitles(form),
      [
        "1 · Customer",
        "2 · Who was on the visit",
        "3 · Products discussed",
        "4 · Comment",
        "5 · Pharmacy you took feedback from",
        "6 · What you left",
        "7 · What you took away",
      ],
      "the comment follows the products, and every step is numbered in order",
    );
    const optionalLine = form.indexOf(">Optional</p>");
    assert.ok(optionalLine > form.indexOf('title="4 · Comment"'), "one Optional line comes after the comment");
    assert.ok(optionalLine < form.indexOf('title="5 · Pharmacy you took feedback from"'), "and before the first optional step");
    for (const title of ["5 · Pharmacy you took feedback from", "6 · What you left", "7 · What you took away"]) {
      assert.match(form, new RegExp(`<CrmBlock actions=\\{stepMark\\("optional"\\)\\}[^>]*title="${title}"`), `${title} is marked Optional in its header`);
    }
    for (const [title, done] of [
      ["2 · Who was on the visit", "whoDone"],
      ["3 · Products discussed", "productsDone"],
      ["4 · Comment", "commentDone"],
    ] as const) {
      assert.match(
        form,
        new RegExp(`<CrmBlock actions=\\{stepMark\\(${done} \\? "done" : "required"\\)\\}[^>]*title="${title}"`),
        `${title} is marked Required, and Done once answered`,
      );
    }
    assert.ok(form.includes("hint={`Required — type it or speak it"), "the comment says it is required, and how");

    // The prefill from last time is said out loud, with one tap either way.
    assert.ok(form.includes("Filled in from your last visit on"), "the products say where they came from");
    assert.ok(form.includes("onClick={productsDone ? clearProducts : refillProducts}"), "one tap clears them, one tap puts them back");
    assert.ok(form.includes('{productsDone ? "Clear all" : "Fill in again"}'), "in plain words");
    const reminder = form.indexOf("Last time you said you would");
    assert.ok(reminder !== -1 && reminder < form.indexOf('title="2 · Who was on the visit"'), "last time's commitment is the first thing under the customer's name");
  }

  // ── (d) One tap: no photo, no date, no time, no AM/PM; thumb-sized, square, never truncated ─────
  {
    for (const banned of [
      /type="date"/,
      /type="time"/,
      /datetime-local/,
      /accept="image/,
      /\bcapture=/,
      /LivePhotoCapture|CapturedPhoto|\bphotoPath\b/,
      /value: "AM"|value: "PM"/,
      /setListType|\blistType\b/,
      /\bvisitDate\b|\bcapturedAt:/,
    ]) {
      assert.equal(banned.test(form), false, `the visit form carries no ${banned} — Log visit is one tap, and the server stamps the rest`);
    }

    for (const path of [FORM, PICKER, START]) {
      const code = source(path);
      // Square corners: `rounded-none` is the only rounded class a CRM screen may carry.
      const rounded = [...code.matchAll(/(?<![\w-])rounded(?:-[\w./[\]-]+)?(?![\w-])/g)].map((match) => match[0]).filter((token) => token !== "rounded-none");
      assert.deepEqual(rounded, [], `${path} rounds a corner`);
      // Never an ellipsis: a long name wraps.
      assert.equal(/\b(truncate|text-ellipsis|line-clamp-\d)\b/.test(code), false, `${path} cuts text short with an ellipsis`);
      // A small CrmButton is 40px on a phone; every target on these screens is at least 44px.
      assert.equal(/size="sm"/.test(code), false, `${path} has a button smaller than a thumb`);
      // Customer, never doctor or account (owner, 2026-09-23) — in anything a rep reads.
      for (const text of code.match(/"[^"\n]*"|`[^`\n]*`|>[^<>{}\n]+</g) ?? []) {
        assert.equal(/\b(doctor|doctors|account|accounts)\b/i.test(text), false, `${path} says doctor or account to a rep: ${text}`);
      }
    }
  }

  // ── (e) Every point stays; two optional steps start folded, and step 7 is OPEN ────────────────
  // Folded, 2026-10-02: "I need all the points in the current form of entering the visit … I don't need
  // too many steps and too many clicks by the reps." So no point is removed and no step is added: each
  // folded step keeps its header (the seven titles above still hold) and opens IN PLACE with one tap.
  //
  // 🔴 UNFOLDED, 2026-10-06, for step 7 ONLY: "unfold objection and next step in Phoenix CRM". The
  // field had answered the fold — a next step on 1 visit of 332 and an objection on 2, across the
  // module's first three live days — so the two questions a manager actually coaches on sat behind a
  // tap nobody took. Only the owner's own word can fold it again.
  {
    assert.ok(
      form.includes("const [openExtras, setOpenExtras] = useState<ReadonlySet<VisitExtra>>(() => new Set());"),
      "every visit starts with the foldable optional steps folded",
    );
    for (const [title, extra] of [
      ["5 · Pharmacy you took feedback from", "pharmacy"],
      ["6 · What you left", "left"],
    ] as const) {
      const at = form.indexOf(`title="${title}">`);
      assert.notEqual(at, -1, `${title} is still on the form`);
      const block = form.slice(at, form.indexOf("</CrmBlock>", at));
      assert.ok(block.includes(`{openExtras.has("${extra}") ? (`), `${title} shows its boxes once opened`);
      assert.ok(block.includes(`onOpen={() => openExtra("${extra}")}`), `${title}, folded, is one tap on its own row`);
    }

    // Step 7 renders its chips with nothing in front of them, and carries no fold at all: a key that
    // nothing folds would leave an "Add what the customer said" row on screen that can never be shown.
    const outcomeAt = form.indexOf('title="7 · What you took away">');
    assert.notEqual(outcomeAt, -1, "What you took away is still on the form");
    const outcome = form.slice(outcomeAt, form.indexOf("</CrmBlock>", outcomeAt));
    assert.equal(outcome.includes("openExtras"), false, "the objection and the next step wait on no tap to open (owner, 2026-10-06)");
    assert.equal(outcome.includes("<FoldedStep"), false, "and step 7 carries no folded row to fall back to");
    assert.match(outcome, /options=\{VISIT_OBJECTIONS\.map/, "the objection chips are in view");
    assert.match(outcome, /options=\{VISIT_NEXT_STEPS\.map/, "and so are the next-step chips");
    assert.doesNotMatch(form, /type VisitExtra = [^;]*"outcome"/, "and `outcome` is no longer one of the foldable steps");

    // 🔴 UNFOLDED IS NOT REQUIRED. Chips in view are one step away from reading as a question the save
    // asks, and the rule written above them is that the visit logs without them — a rep at a door must
    // never be refused for an objection he was not given. The save's own check is the authority.
    const draftAt = form.indexOf("function draft(visitId: string");
    assert.notEqual(draftAt, -1, "the save's own check must still be `draft`, or this assertion reads nothing");
    const refusals = form.slice(draftAt, form.indexOf("ok: true", draftAt));
    assert.ok(refusals.length > 200, "the refusal half of `draft` must be the slice that was read, not an empty one");
    assert.doesNotMatch(refusals, /objection/i, "no refusal may mention the objection — it stays optional");
    assert.doesNotMatch(refusals, /nextStep/i, "and none may mention the next step");
    assert.match(
      form,
      /<CrmBlock actions=\{stepMark\("optional"\)\}[^>]*title="7 · What you took away"/,
      "its header still reads Optional, so he can see the visit logs without it",
    );

    // A required step is never folded: the bar's jump must land on an open box.
    const required = form.slice(form.indexOf('<CrmBlock title="1 · Customer">'), form.indexOf('title="5 · Pharmacy you took feedback from"'));
    assert.equal(required.includes("<FoldedStep"), false, "nothing the save needs is ever folded");
    assert.equal(required.includes("openExtras"), false, "and nothing the save needs waits on a tap to open");
  }

  // ── The picker: the door he can walk through now is at the top ─────────────────────────────────
  {
    const picker = source(PICKER);
    assert.ok(
      picker.includes("Number(left.visitedToday) - Number(right.visitedToday) || receivingRank(left) - receivingRank(right)"),
      "not-yet-visited first, then the customers who receive today",
    );
    const rank = picker.slice(picker.indexOf("export function receivingRank("), picker.indexOf("export function customersFor("));
    assert.ok(rank.includes("if (customer.places.length === 0) return 1;"), "a customer with no hours to read sits in the middle, never last");
    assert.ok(rank.includes("place.todayWindows !== NOT_RECEIVING) ? 0 : 2"), "one place receiving today puts him first");
    assert.ok(picker.includes("const byHours = offered.some((customer) => customer.places.length > 0);"), "the order is only claimed when there are hours to order by");
    assert.ok(picker.includes('{byHours ? " Customers who receive today come first." : ""}'), "and the page says so only then");
  }

  // ── The first screen: visits first, the day's record second ────────────────────────────────────
  {
    const start = source(START);
    const visits = start.indexOf('<CrmBlock title="A customer visit">');
    const day = start.indexOf('title="Or record the day as"');
    assert.ok(visits !== -1 && day > visits, "the two visit targets lead, and the nine day activities follow under their own heading");
    assert.ok(start.indexOf('label="Planned visit"') > visits && start.indexOf('label="Planned visit"') < day, "Planned is in the visit group");
    assert.ok(start.indexOf("PHOENIX_CRM_DAY_ACTIVITIES.map") > day, "and the activities in theirs");
  }

  console.log("phoenix-crm visit form ease: OK");
}
