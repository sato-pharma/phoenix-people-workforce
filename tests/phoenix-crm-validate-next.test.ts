import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  hasVisitsWaitingToCount,
  isValidateNextCandidate,
  rankValidateNext,
  VALIDATE_NEXT_COUNT,
  VALIDATE_NEXT_PLAIN_REASON,
  validateNextReasons,
  VALIDATE_FIRST_PER_BRICK,
  validateNextTop,
  visitsWaitingFirst,
  needsCaptureAgain,
  VALIDATE_AGAIN_REASON,
  validateFirstIn,
} from "../src/lib/phoenix-crm/validate-next.ts";
import type { ListCustomer, ListCustomerReference } from "../src/lib/phoenix-crm/server/list.ts";
import { stripComments } from "./support/comment-strip.ts";
import { listCustomer } from "./support/phoenix-crm-list-customer.ts";

/**
 * Phoenix CRM — "Validate next", the List tab's answer to "which customer is worth my next stop?"
 * (owner, 2026-09-30: "the best-appearing and easiest CRM, yet controlled").
 *
 * The ranking is pure (src/lib/phoenix-crm/validate-next.ts), so it is held here on concrete
 * customers, key by key:
 *
 *   1. visits already saved first — they start counting the moment he validates (owner, 2026-09-22);
 *   2. then grade A, B, C, then no grade;
 *   3. then the brick with the most customers still to validate — one trip, many validations;
 *   4. then the name, so the same list always reads the same way.
 *
 * and only customers still To validate, not already asked to drop, with an entry the Validate screen
 * opens on. Break any key and the strip still renders — it just sends the rep to the wrong clinic
 * first — which is why each is an assertion and not a comment.
 *
 * The strip on the screen is pinned by source: one button per card and it is the row's own, no "Add
 * visit", no rounded corner, no distance or reading of any kind (Golden rule #1), a name that reads
 * right to left when it is Arabic, and a strip only the rep is shown.
 */

const BLANK_REFERENCE: ListCustomerReference = {
  address: null,
  city: null,
  zone: null,
  lastVisitedOn: null,
  brickId: null,
  brickName: null,
  areaName: null,
};

let nextContact = 1000;

/** A carried-over customer waiting to be validated, unless the overrides say otherwise. */
function customer(overrides: Partial<ListCustomer> & { brick?: string | null } = {}): ListCustomer {
  const { brick, ...rest } = overrides;
  const name = rest.name ?? "Test Customer";
  const reference: ListCustomerReference =
    brick === undefined || brick === null ? BLANK_REFERENCE : { ...BLANK_REFERENCE, brickId: `BR-${brick}`, brickName: brick, areaName: "Area" };
  nextContact += 1;
  // The full field list lives in ONE place now (tests/support/phoenix-crm-list-customer.ts). Only the
  // fields this file actually cares about are stated here; the rest come from the shared base, so
  // widening `ListCustomer` breaks that annotated literal by name rather than this call site.
  return listCustomer({
    customerId: `id-${name}`,
    name,
    referenceContactCrmId: nextContact,
    status: "pending",
    section: "to_validate",
    reference,
    ...rest,
  });
}

const names = (picks: ReadonlyArray<{ customer: ListCustomer }>) => picks.map((pick) => pick.customer.name);

/** Words that measure or judge the rep, none of which may reach him (Golden rule #1). */
const JUDGING_WORDS = /\b(km|kilomet(?:er|re)s?|met(?:er|re)s?|distance|far|accuracy|accurate|within|gps|reading|flag(?:ged)?|check(?:ed)?|integrity|suspicious|verify|verified)\b/i;

function checkRanking(): void {
  // ── 1 · Visits saved outrank everything else ──────────────────────────────────────────────────
  {
    const ranked = rankValidateNext([
      customer({ name: "Adel", grade: "A", brick: "Maadi" }),
      customer({ name: "Zaki", grade: "C", visitsThisMonth: 2 }),
    ]);
    assert.deepEqual(
      names(ranked),
      ["Zaki", "Adel"],
      "a grade C customer with 2 visits saved comes before a grade A with none — his visits start counting the moment he is validated",
    );
    assert.equal(ranked[0].visitsSaved, 2);
  }
  {
    // Saved visits is a yes/no key: within it, grade decides — 1 visit on an A beats 4 on a B.
    const ranked = rankValidateNext([
      customer({ name: "Basma", grade: "B", visitsThisMonth: 4 }),
      customer({ name: "Amal", grade: "A", visitsThisMonth: 1 }),
    ]);
    assert.deepEqual(names(ranked), ["Amal", "Basma"], "among customers with visits saved, grade A still comes first");
  }

  // ── 2 · Grade A, then B, then C, then no grade ────────────────────────────────────────────────
  {
    const ranked = rankValidateNext([
      customer({ name: "No Grade", grade: null }),
      customer({ name: "Grade C", grade: "C" }),
      customer({ name: "Grade A", grade: "A" }),
      customer({ name: "Grade B", grade: "B" }),
    ]);
    assert.deepEqual(names(ranked), ["Grade A", "Grade B", "Grade C", "No Grade"], "A before B before C, and no grade last");
  }

  // ── 3 · The bigger brick first — one trip, many validations ──────────────────────────────────
  {
    const ranked = rankValidateNext([
      customer({ name: "Alone", grade: "B", brick: "Dokki" }),
      customer({ name: "Crowd 1", grade: "B", brick: "Maadi" }),
      customer({ name: "Crowd 2", grade: "B", brick: "Maadi" }),
      customer({ name: "Crowd 3", grade: "B", brick: "Maadi" }),
    ]);
    assert.deepEqual(names(ranked), ["Crowd 1", "Crowd 2", "Crowd 3", "Alone"], "the brick holding three waiting customers comes before a brick holding one");
    assert.equal(ranked[0].othersInBrick, 2, "him not included: two more wait in Maadi");
    assert.equal(ranked[0].brickName, "Maadi", "the brick by its name, never its code");
    assert.equal(ranked[3].othersInBrick, 0);
  }
  {
    // Grade outranks the brick: a lone A before a crowded B.
    const ranked = rankValidateNext([
      customer({ name: "Crowd 1", grade: "B", brick: "Maadi" }),
      customer({ name: "Crowd 2", grade: "B", brick: "Maadi" }),
      customer({ name: "Lone A", grade: "A", brick: "Dokki" }),
    ]);
    assert.equal(ranked[0].customer.name, "Lone A", "grade comes before the size of the brick");
  }

  // ── 4 · Stable by name, then id — the input order never matters ──────────────────────────────
  {
    const rows = [
      customer({ name: "Mona", grade: "B" }),
      customer({ name: "Hany", grade: "B" }),
      customer({ name: "Ola", grade: "B" }),
      customer({ name: "Hany", grade: "B", customerId: "id-Hany-2" }),
    ];
    const forward = rankValidateNext(rows);
    const backward = rankValidateNext([...rows].reverse());
    assert.deepEqual(names(forward), ["Hany", "Hany", "Mona", "Ola"], "equal on every key, the name decides");
    assert.deepEqual(
      forward.map((pick) => pick.customer.customerId),
      backward.map((pick) => pick.customer.customerId),
      "and the order is the same whatever order the list arrived in — two of the same name are settled by id",
    );
  }

  // ── Who is never ranked ───────────────────────────────────────────────────────────────────────
  {
    const validated = customer({ name: "Validated", grade: "A", status: "active", section: "your_list", visitsThisMonth: 5, brick: "Maadi" });
    const outside = customer({ name: "Outside", grade: "A", status: "outside", section: "outside", origin: "new", visitsThisMonth: 3, brick: "Maadi" });
    const archived = customer({ name: "Archived", grade: "A", status: "dropped", section: "archive", visitsThisMonth: 2, brick: "Maadi" });
    const askedToDrop = customer({ name: "Asked To Drop", grade: "A", visitsThisMonth: 4, pendingDropRequestId: "req-1", brick: "Maadi" });
    const dropWaiting = customer({
      name: "Drop Waiting",
      grade: "A",
      brick: "Maadi",
      waiting: [{ requestId: "req-2", kind: "drop", stage: "manager", stageLabel: "Waiting for the district manager" }],
    });
    const noEntry = customer({ name: "No Entry", grade: "A", referenceContactCrmId: null, origin: "new", brick: "Maadi" });
    const waiting = customer({ name: "Waiting", grade: "C", brick: "Maadi" });

    const all = [validated, outside, archived, askedToDrop, dropWaiting, noEntry, waiting];
    const ranked = rankValidateNext(all);
    assert.deepEqual(names(ranked), ["Waiting"], "only a customer still To validate, not asked to drop, with an entry to open, is ever ranked");
    for (const left of [validated, outside, archived, askedToDrop, dropWaiting, noEntry]) {
      assert.equal(isValidateNextCandidate(left), false, `${left.name} is never offered`);
    }
    assert.equal(isValidateNextCandidate(waiting), true);
    assert.equal(
      ranked[0].othersInBrick,
      0,
      "the brick is counted over the candidates only — a validated, outside, archived or asked-to-drop customer is no reason to make the trip",
    );
    assert.deepEqual(validateNextTop([validated, outside, archived]), [], "a list with nothing to validate offers nothing");
  }

  // ── A locality is not a brick ─────────────────────────────────────────────────────────────────
  {
    const tanta = { ...BLANK_REFERENCE, city: "Tanta" };
    const ranked = rankValidateNext([customer({ name: "One", reference: tanta }), customer({ name: "Two", reference: tanta })]);
    assert.equal(ranked[0].brickName, null, "an unmapped locality is not named as a brick");
    assert.equal(ranked[0].othersInBrick, 0, "and never earns \"more waiting in this brick\", which would be untrue");
  }

  // ── The top N ─────────────────────────────────────────────────────────────────────────────────
  {
    const many = ["A", "B", "C", "D", "E"].map((letter) => customer({ name: `Customer ${letter}`, grade: "B" }));
    assert.equal(VALIDATE_NEXT_COUNT, 3, "the strip shows three");
    assert.deepEqual(names(validateNextTop(many)), ["Customer A", "Customer B", "Customer C"], "the top three by default");
    assert.equal(validateNextTop(many, 1).length, 1);
    assert.equal(validateNextTop(many, 0).length, 0);
    assert.equal(validateNextTop(many, 99).length, 5, "never more than there are");
  }
}

function checkReasons(): void {
  const base = customer({ name: "Reasoned" });
  assert.deepEqual(
    validateNextReasons({ customer: customer({ grade: "A", target: 3 }), visitsSaved: 2, othersInBrick: 3 }),
    ["2 visits saved — they count once you validate", "Grade A — 3 visits a month", "3 more waiting in this brick"],
    "every reason that applies, in the ranking's own order",
  );
  assert.deepEqual(validateNextReasons({ customer: base, visitsSaved: 1, othersInBrick: 0 }), ["1 visit saved — it counts once you validate"], "one visit reads in the singular");
  assert.deepEqual(validateNextReasons({ customer: customer({ grade: "A", target: 1 }), visitsSaved: 0, othersInBrick: 0 }), ["Grade A — 1 visit a month"]);
  assert.deepEqual(validateNextReasons({ customer: customer({ grade: "A", target: null }), visitsSaved: 0, othersInBrick: 0 }), ["Grade A"], "no target, no number claimed");
  assert.deepEqual(validateNextReasons({ customer: customer({ grade: "B" }), visitsSaved: 0, othersInBrick: 1 }), ["1 more waiting in this brick"], "B and C are on the card already; only A is a reason");
  assert.deepEqual(validateNextReasons({ customer: customer({ grade: "C" }), visitsSaved: 0, othersInBrick: 0 }), [VALIDATE_NEXT_PLAIN_REASON], "a pick is never shown with no reason at all");

  // What reaches the rep is about his own work — never a distance, a reading or a check.
  const everyReason = rankValidateNext([
    customer({ name: "R1", grade: "A", target: 3, visitsThisMonth: 2, brick: "Maadi" }),
    customer({ name: "R2", grade: "B", visitsThisMonth: 1, brick: "Maadi" }),
    customer({ name: "R3", grade: "C" }),
  ]).flatMap((pick) => pick.reasons);
  assert.ok(everyReason.length >= 5, "the sweep reads real reasons");
  for (const reason of everyReason) {
    assert.doesNotMatch(reason, JUDGING_WORDS, `"${reason}" measures or judges the rep — Golden rule #1`);
    assert.doesNotMatch(reason, /\b(doctor|account)s?\b/i, `"${reason}" — the module says AM and PM, customer, never doctor or account`);
  }
}

function checkScreens(): void {
  const tab = stripComments(readFileSync("src/components/phoenix-crm/list-tab.tsx", "utf8").replace(/\r\n/g, "\n"));
  // ── 🔴 THE LIST PAGE HOLDS THE LIST, AND NOTHING ELSE ─────────────────────────────────────────
  // Owner, 2026-09-30: "I want the page of the list to contain the list only." Two blocks used to
  // stand between a rep and his own list — a four-figure readiness summary and a three-card
  // "Validate next" strip — together about half the first screen, and the figures repeated three of
  // the chooser's own parts besides ("the list is the full list, To validate is who are not
  // validated, Your list is which are validated"). He asked for them gone twice; moving them lower
  // was not what he asked for. Both components are deleted, not merely unrendered, so neither can be
  // brought back by restoring one line.
  //
  // The ranking itself is NOT deleted: `validate-next.ts` is still pinned above, and what it decides
  // belongs on the To validate rows rather than in a strip over them.
  assert.ok(!tab.includes("function ValidateNextStrip("), "the Validate next strip is gone from the List page");
  assert.ok(!tab.includes("function ReadinessBlock("), "and so is the readiness figures block");
  assert.ok(!tab.includes("function ListFigure("), "and the tile it drew with");
  assert.ok(!tab.includes("<ValidateNextStrip") && !tab.includes("<ReadinessBlock"), "neither is rendered anywhere");
  assert.ok(
    !tab.includes('from "@/lib/phoenix-crm/validate-next"'),
    "the List page no longer reads the ranking itself — nothing above the chooser ranks anything",
  );
  // Nothing may sit between the screen's own head and the chooser again.
  const chooser = tab.indexOf('<CrmChoice columns={7} label="Which part of the list"');
  assert.ok(chooser > 0, "the chooser is still what opens the list");
  const head = tab.indexOf("{error ? <CrmLoadError");
  assert.ok(head > 0 && head < chooser, "the load error is the only thing before it");
  const between = tab.slice(head, chooser);
  assert.ok(
    !between.includes("<CrmBlock title=") && !between.includes("<ListFigure"),
    "no summary, strip or banner stands between the rep and the chooser",
  );

  // ── The board's filter row on a phone: the search stays, the selects fold ─────────────────────
  const board = stripComments(readFileSync("src/components/phoenix-crm/customer-list-board.tsx", "utf8").replace(/\r\n/g, "\n"));
  const fold = board.indexOf('<div className={filtersOpen ? "contents" : "hidden md:contents"} id={filtersId}>');
  assert.ok(fold > 0, "the selects fold behind the Filters toggle on a phone and are always open from md");
  const search = board.indexOf("<TableSearchInput");
  assert.ok(search > 0 && search < fold, "the search sits OUTSIDE the fold, so it is always in sight on a phone");
  const foldEnd = board.indexOf("</div>", fold);
  const folded = board.slice(fold, foldEnd);
  // 🔴 `CrmBareSelect` since 2026-10-03, not a raw `<select`: it keeps the caller's own look and
  // renders a searchable combo box on an ADMIN account, a native dropdown in the portal (Brick is the
  // filter that needed it). What this line pins is unchanged — that five of them, and only five, sit
  // behind the Filters toggle while the search stays outside it.
  assert.equal(
    (folded.match(/<CrmBareSelect\b/g) ?? []).length,
    5,
    "the five dropdowns — brick, list, this month, grade, specialty — are what fold",
  );
  assert.equal(
    (folded.match(/<select\b/g) ?? []).length,
    0,
    "and not one of them is a raw select any more, or an admin would never get a combo box there",
  );
  assert.equal((folded.match(/md:order-first/g) ?? []).length, 5, "and each comes first again from md, ahead of the search, as the row always read");
  assert.match(board, /aria-controls=\{filtersId\}\s+aria-expanded=\{filtersOpen\}/, "the toggle says what it opens and whether it is open");
  assert.match(board, /className="[^"]*\bmd:hidden"\s+onClick=\{\(\) => setFiltersOpen/, "the toggle is a phone's alone");
  assert.match(board, /const filtersOn = \[brick, listType, activity, grade, speciality\]\.filter\(Boolean\)\.length;/, "it counts only what it hides");

  // ── Nothing on the List is rounded or scrolls sideways ────────────────────────────────────────
  for (const path of ["src/components/phoenix-crm/list-tab.tsx", "src/components/phoenix-crm/customer-list-board.tsx", "src/components/phoenix-crm/list-customer.tsx"]) {
    const body = stripComments(readFileSync(path, "utf8"));
    for (const banned of [/\brounded-(?!none\b)/, /\btruncate\b/, /\bline-clamp-/, /\boverflow-x-auto\b/, /\boverflow-auto\b/, /\boverflow-x-scroll\b/]) {
      assert.doesNotMatch(body, banned, `${path} breaks the module's look (${banned})`);
    }
  }
}


/**
 * 🔴 ONLY THE FEW WITH THE MOST VISITS WAITING ARE MARKED (owner, 2026-09-30: "mark only the ones
 * with the most visits waiting, not all 88").
 *
 * Behaviour, not source text. The first build marked every customer with ANY saved visit, which on
 * the territory it was measured against was 88 of 88 — the whole list amber, the mark saying nothing.
 * These cases pin the narrowing AND the guard that stops it coming back.
 */
function checkVisitsWaitingFirst(): void {
  const ready = (id: string, visits: number): ListCustomer =>
    listCustomer({ customerId: id, name: id, referenceHistory: { visits, lastVisitedOn: "2026-09-29" } });
  const plain = (id: string): ListCustomer => listCustomer({ customerId: id, name: id });
  const ids = (rows: readonly ListCustomer[]): string[] => rows.map((customer) => customer.customerId);

  assert.equal(hasVisitsWaitingToCount(ready("a", 1)), true, "one saved visit counts as waiting");
  assert.equal(hasVisitsWaitingToCount(ready("a", 0)), false, "a history that counted nothing does not");
  assert.equal(hasVisitsWaitingToCount(plain("a")), false, "and neither does no history at all");

  // The brick's best three lead, most first, and ONLY those three are marked.
  const brick = [plain("p1"), ready("r3", 3), ready("r20", 20), plain("p2"), ready("r9", 9), ready("r1", 1), plain("p3")];
  const out = visitsWaitingFirst(brick);
  assert.deepEqual(ids(out.rows), ["r20", "r9", "r3", "p1", "p2", "r1", "p3"], "the best three lead, most first");
  assert.deepEqual([...out.marked].sort(), ["r20", "r3", "r9"], "and exactly those three are marked");
  assert.equal(out.marked.size, VALIDATE_FIRST_PER_BRICK, "never more than a brick's share");
  assert.equal(out.marked.has("r1"), false, "a fourth customer with visits waiting is NOT marked — that is the whole point");
  // Everyone unmarked keeps the order the neighbourhood pass gave them, r1 included.
  assert.deepEqual(ids(out.rows).slice(3), ["p1", "p2", "r1", "p3"], "the rest keep their neighbourhood order");

  // 🔴 THE GUARD: no "most" means no mark. This is the 88-of-88 failure, and it must stay closed.
  const allSame = [ready("a", 4), ready("b", 4), ready("c", 4), ready("d", 4)];
  const flat = visitsWaitingFirst(allSame);
  assert.equal(flat.marked.size, 0, "when every candidate carries the SAME count there is no most, so the brick marks none");
  assert.deepEqual(ids(flat.rows), ["a", "b", "c", "d"], "and nothing is re-ordered either");

  const none = visitsWaitingFirst([plain("p1"), plain("p2")]);
  assert.equal(none.marked.size, 0, "nothing waiting, nothing marked");
  assert.deepEqual(ids(none.rows), ["p1", "p2"], "and nothing moves");
  assert.deepEqual(ids(visitsWaitingFirst([]).rows), [], "an empty brick is left alone");

  // Stable across reads: running it on its own output changes nothing.
  assert.deepEqual(ids(visitsWaitingFirst(out.rows).rows), ids(out.rows), "a re-read never churns the list");
}

/**
 * 🔴 A CUSTOMER WAITING TO BE CAPTURED AGAIN COMES FIRST, OLDEST WAIT FIRST, ALL OF THEM MARKED
 * (owner, 2026-10-08). Measured that day: 0 of 22 reopened customers had been validated again, the
 * oldest 76.7 hours later, because To validate listed them in name order with everyone else.
 */
function checkValidateFirstIn(): void {
  const ids = (rows: readonly ListCustomer[]): string[] => rows.map((row) => row.customerId);
  const ready = (id: string, visits: number): ListCustomer =>
    listCustomer({ customerId: id, name: id, referenceHistory: { visits, lastVisitedOn: "2026-09-29" } });
  const plain = (id: string): ListCustomer => listCustomer({ customerId: id, name: id });
  const reopened = (id: string, at: string): ListCustomer =>
    listCustomer({ customerId: id, name: id, reopenedAt: at, locationCheck: "not_confirmed" });
  const held = (id: string): ListCustomer => listCustomer({ customerId: id, name: id, locationCheck: "not_confirmed" });

  assert.equal(needsCaptureAgain(plain("p")), false, "an ordinary customer is not waiting to be captured again");
  assert.equal(needsCaptureAgain(reopened("o", "2026-10-06T08:00:00Z")), true, "a refused one is");
  assert.equal(needsCaptureAgain(held("h")), true, "and so is one the review still reads as not confirmed");

  const brick = [plain("p1"), ready("r9", 9), reopened("new", "2026-10-07T08:00:00Z"), ready("r2", 2), held("held"), reopened("old", "2026-10-05T08:00:00Z")];
  const out = validateFirstIn(brick);
  assert.deepEqual(ids(out.rows).slice(0, 3), ["old", "new", "held"], "every capture-again customer leads, the oldest wait first");
  assert.deepEqual([...out.again].sort(), ["held", "new", "old"], "and ALL of them carry the rose mark — no only-the-most here");
  assert.deepEqual(ids(out.rows).slice(3), ids(visitsWaitingFirst([plain("p1"), ready("r9", 9), ready("r2", 2)]).rows), "everyone else keeps the visits order, unchanged");
  assert.ok(out.marked.has("r9") && out.marked.has("old"), "the visits mark and the capture-again mark both survive");
  assert.deepEqual(ids(validateFirstIn(out.rows).rows), ids(out.rows), "a re-read never churns the list");

  // The ranking agrees with the board: a capture-again customer outranks visits saved, and says why.
  const noEntry = { ...reopened("again", "2026-10-06T08:00:00Z"), referenceContactCrmId: null, section: "to_validate" as const };
  assert.equal(isValidateNextCandidate(noEntry), true, "a refused customer is a candidate even without an iReports360 entry");
  const ranked = rankValidateNext([{ ...plain("busy"), visitsThisMonth: 30, referenceContactCrmId: 77, section: "to_validate" as const }, noEntry]);
  assert.equal(ranked[0]?.customer.customerId, "again", "and he ranks above visits saved");
  assert.equal(ranked[0]?.reasons[0], VALIDATE_AGAIN_REASON, "with the photo reason first");
  assert.doesNotMatch(VALIDATE_AGAIN_REASON, JUDGING_WORDS, "worded about the photo, never judging the rep");

  // The board draws through it, and paints the capture-again rows rose.
  const board = stripComments(readFileSync("src/components/phoenix-crm/customer-list-board.tsx", "utf8"));
  assert.match(board, /variant === "pending" \? validateFirstIn\(neighbourhoods\.rows\)/, "To validate orders each brick through validateFirstIn");
  assert.match(board, /border-l-rose-500/, "and a capture-again row carries the rose rail");
  // 2026-10-16 performance audit: the grouping and ordering is worked out once per list and filter,
  // never again on a redraw that changes neither (folding a brick, opening the phone's filters).
  const arrangedAt = board.indexOf("const arranged = useMemo(");
  assert.ok(arrangedAt > 0, "the board keeps each group's order and marks between redraws");
  const arrangedBody = board.slice(arrangedAt, board.indexOf("[variant, visible],", arrangedAt) + "[variant, visible],".length);
  assert.ok(
    arrangedBody.includes("const neighbourhoods = neighbourhoodsIn(rawEntry.rows);") && arrangedBody.includes("validateFirstIn(neighbourhoods.rows)"),
    "the neighbours and the validate-first order are what it keeps",
  );
  assert.ok(arrangedBody.endsWith("[variant, visible],"), "and they are worked out again whenever the shown rows or the section change");
  assert.match(board, /\{arranged\.map\(\(\{ entry, neighbourhoods, markedForValidating, captureAgain \}\) => \{/, "the groups are drawn from what it kept");
}

export function runPhoenixCrmValidateNextTests(): void {
  checkRanking();
  checkReasons();
  checkScreens();
  checkVisitsWaitingFirst();
  checkValidateFirstIn();
  console.log("phoenix-crm validate next: OK");
}
