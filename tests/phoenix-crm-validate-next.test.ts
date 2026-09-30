import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isValidateNextCandidate,
  rankValidateNext,
  VALIDATE_NEXT_COUNT,
  VALIDATE_NEXT_PLAIN_REASON,
  validateNextReasons,
  validateNextTop,
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

/** The body of one top-level function in a source, comments blanked. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is still in the file`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} ends`);
  return source.slice(start, end);
}

function checkScreens(): void {
  const tab = stripComments(readFileSync("src/components/phoenix-crm/list-tab.tsx", "utf8").replace(/\r\n/g, "\n"));
  const strip = functionBody(tab, "ValidateNextStrip");

  // ── The strip reads the ranking, and nothing else decides the order ───────────────────────────
  assert.match(strip, /validateNextTop\(customers\)/, "the strip shows the pure ranking's top three");
  assert.doesNotMatch(strip, /\.sort\(/, "and never re-sorts them by a rule of its own");

  // ── One button per card, the row's own ────────────────────────────────────────────────────────
  assert.equal((strip.match(/<CustomerRowAction\b/g) ?? []).length, 1, "each card carries exactly one button: the row's own CustomerRowAction");
  assert.doesNotMatch(strip, /<CrmButton\b|<button\b/, "and no other button beside it");
  assert.match(strip, /<CustomerRowAction canValidate=\{canValidate\} customer=\{pick\.customer\} onAction=\{onRowAction\} \/>/, "wired to the list's own row action");
  assert.doesNotMatch(strip, /\bAdd (?:a |today(?:'|&apos;)s )?visit\b/i, "no Add visit — a visit starts from Visits, Today or the portal's \"+\"");
  assert.doesNotMatch(strip, /onStartVisit|onVisitCustomer/, "and nothing that starts one");

  // ── Only the rep, only where he chooses what to do next ───────────────────────────────────────
  assert.match(strip, /const picks = canValidate \? validateNextTop\(customers\) : \[\];/, "the strip draws nothing for anyone who does not validate");
  assert.match(
    tab,
    /\{current === "to_validate" \|\| current === "board" \? \(\s*<ValidateNextStrip canValidate=\{view\.canEdit\}/,
    "it sits on To validate and The list, for the territory's rep",
  );

  // ── The house look, and Golden rule #1 ────────────────────────────────────────────────────────
  assert.doesNotMatch(strip, /\brounded-(?!none\b)/, "square corners only");
  assert.doesNotMatch(strip, /\b(?:truncate|line-clamp-\d|overflow-x-auto|overflow-auto)\b/, "no ellipsis, no sideways scroll");
  const stripText = [...(strip.match(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g) ?? []), ...[...strip.matchAll(/>([^<>{}]+)</g)].map((match) => match[1] ?? "")];
  assert.ok(stripText.some((text) => text.includes("Validate next")), "the sweep reads the strip's own words");
  for (const text of stripText) {
    assert.doesNotMatch(text, JUDGING_WORDS, `the strip says "${text.trim()}" — no distance, reading or check reaches the rep`);
    assert.doesNotMatch(text, /\b(doctor|account)s?\b/i, `the strip says "${text.trim()}"`);
  }
  assert.doesNotMatch(strip, /brickDistanceKm|accuracyMeters|\.lat\b|\.lon\b/, "no measurement is even read into it");
  assert.match(strip, /<h4 className="[^"]*" dir="auto">\s*\{pick\.customer\.name\}/, "an Arabic name reads right to left");
  assert.match(strip, /<bdi>\{pick\.brickName\}<\/bdi>/, "and an Arabic brick name is isolated inside the English line");
  assert.match(strip, /listText\(pick\.customer\.listType\)/, "AM or PM, in the module's one wording");

  // ── The four figures: ONE tile family, and the progress outside them ──────────────────────────
  // 🔴 The owner called this row awful on 2026-09-30 while it was a tall lead box beside three short
  //    ones: the lead carried the bar, the percentage and a three-line sentence, so it stood about
  //    three times their height and — a grid row being as tall as its tallest cell — left each of the
  //    other three ending in ~120px of white nothing, with its AM · PM beside the figure where theirs
  //    sat underneath. Four identical tiles now, and everything that measures the WHOLE list moved
  //    out below them. Re-introducing a bespoke lead box is what this pins against.
  const readiness = functionBody(tab, "ReadinessBlock");
  const lead = readiness.indexOf('label="To validate"');
  assert.ok(lead > 0, "the block leads with To validate");
  for (const figure of ['label="Reference list"', 'label="Validated"', 'label="Drops waiting"']) {
    const at = readiness.indexOf(figure);
    assert.ok(at > lead, `${figure} is context beside the lead figure, after it`);
  }
  assert.equal(
    (readiness.match(/<ListFigure\b/g) ?? []).length,
    4,
    "all four figures are the SAME tile — To validate is not a bespoke box beside the other three",
  );
  assert.ok(
    readiness.includes('<div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4">'),
    "and they sit in one equal four-up grid, two-up on a narrow screen — never a 5fr lead track beside a 7fr one",
  );
  assert.ok(
    !readiness.includes("md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"),
    "the split that made the lead three times its neighbours' height must not come back",
  );
  // The bar measures the whole list, so it belongs to the block, not to one tile.
  assert.ok(
    readiness.indexOf('role="progressbar"') > readiness.indexOf('label="Drops waiting"'),
    "the progress bar sits BELOW the four tiles, not inside the first one",
  );
  assert.match(readiness, /tone=\{allDone \? "good" : "act"\}/, "the figure he acts on is marked by its rail, never by a larger number");
  assert.match(readiness, /pairText\(countByType\(pending\)\)/, "the lead's AM and PM are said apart");
  assert.doesNotMatch(tab, /\.AM \+ [^;]*\.PM|\.PM \+ [^;]*\.AM/, "AM and PM are never added into one figure");
  assert.doesNotMatch(readiness, /\brounded-(?!none\b)/, "square corners");

  // ── The board's filter row on a phone: the search stays, the selects fold ─────────────────────
  const board = stripComments(readFileSync("src/components/phoenix-crm/customer-list-board.tsx", "utf8").replace(/\r\n/g, "\n"));
  const fold = board.indexOf('<div className={filtersOpen ? "contents" : "hidden md:contents"} id={filtersId}>');
  assert.ok(fold > 0, "the selects fold behind the Filters toggle on a phone and are always open from md");
  const search = board.indexOf("<TableSearchInput");
  assert.ok(search > 0 && search < fold, "the search sits OUTSIDE the fold, so it is always in sight on a phone");
  const foldEnd = board.indexOf("</div>", fold);
  const folded = board.slice(fold, foldEnd);
  assert.equal((folded.match(/<select\b/g) ?? []).length, 5, "the five selects — brick, list, this month, grade, specialty — are what fold");
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

export function runPhoenixCrmValidateNextTests(): void {
  checkRanking();
  checkReasons();
  checkScreens();
  console.log("phoenix-crm validate next: OK");
}
