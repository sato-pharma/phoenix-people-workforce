import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  buildDeckSlides,
  DECK_TABS,
  deckArrowStep,
  deckSeatItem,
  deckSlideKey,
  deckStartOfBoardView,
  deckTabNeedsCases,
  parseDeckTab,
  slideIsSettled,
  summarizeDeckOutcomes,
  venueLiveItems,
  type DeckSources,
} from "../src/lib/place-review-deck/slides.ts";
import type { VenueGroup } from "../src/lib/phoenix-crm/shared-place-groups.ts";

/**
 * Place checks — the one-by-one review (owner, 2026-10-18: "I want to have the picture in a very wide
 * space in the screen and a column on the right having all the data I need … validate from this screen
 * or reject or approve. Then press next … like sliding instead of opening").
 *
 * What is pinned, and why each half matters:
 *   1. what each tab holds, the Places / Polyclinics / Both switch, and "All" with every slide once;
 *   2. when a slide may slide on by itself — a polyclinic only once its building AND every waiting
 *      customer are answered;
 *   3. the arrows never move while he types, holds a modifier or has the zoom open, and no key decides;
 *   4. the review is not a second decision path: every decision control reports through
 *      `usePlaceCheckDone`, and nothing the review adds posts anything;
 *   5. it is the Super Admin's alone, and none of it reaches a district manager's portal bundle;
 *   6. the dialog is a real dialog, the house rules hold on every new file, and the cases route reads
 *      the board's own loader.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

const NEW_FILES = [
  "src/components/place-review-deck/review-deck.tsx",
  "src/components/place-review-deck/review-deck-button.tsx",
  "src/components/place-review-deck/place-checks-with-deck.tsx",
  "src/components/place-review-deck/deck-parts.tsx",
  "src/components/place-review-deck/deck-cases.ts",
  "src/components/crm-integrity/integrity-review-slide.tsx",
  "src/components/phoenix-crm/place-check-done.tsx",
] as const;

/** The body of one top-level function, up to the next top-level declaration. */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`\\n(?:export )?function ${name}\\(`));
  assert.ok(start >= 0, `function ${name} must still exist — this check has lost its anchor`);
  const rest = source.slice(start + 1);
  const end = rest.slice(1).search(/\n(?:export )?(?:async )?(?:function|const|type|export \{)/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

function sources(): DeckSources {
  return {
    waitingReviews: ["r1", "r2"],
    waitingVenues: ["v-held"],
    unconfirmedPlaces: ["p1"],
    unconfirmedVenues: ["v-held", "v-active"],
    historyReviews: ["r3"],
    historyVenues: ["v-retired"],
    cases: [
      { id: "c1", polyclinic: false },
      { id: "c2", polyclinic: true },
    ],
  };
}

function venue(status: "active" | "held" | "retired", customers: Array<{ key: string; state: string }>): Pick<VenueGroup, "venue" | "customers"> {
  return {
    venue: { sharedPlaceId: "v1", status } as unknown as VenueGroup["venue"],
    customers: customers as unknown as VenueGroup["customers"],
  };
}

export function runPlaceReviewDeckTests(): void {
  // ── 1 · What each tab holds ────────────────────────────────────────────────────────────────────
  const keys = (tab: Parameters<typeof buildDeckSlides>[0], kind: Parameters<typeof buildDeckSlides>[1] = "both", from = sources()) =>
    buildDeckSlides(tab, kind, from).map((slide) => slide.key);

  assert.deepEqual(DECK_TABS, ["waiting", "unconfirmed", "integrity", "history", "all"], "the tabs, in the order the work is done");
  assert.deepEqual(keys("waiting"), ["review:r1", "review:r2", "venue:v-held"], "Waiting is the held places, then the buildings that need a decision");
  assert.deepEqual(keys("unconfirmed"), ["place:p1", "venue:v-held", "venue:v-active"], "Not confirmed is the places in use, then the buildings");
  assert.deepEqual(keys("history"), ["review:r3", "venue:v-retired"], "History is the decided places, then the rejected buildings");
  assert.deepEqual(keys("integrity"), ["case:c1", "case:c2"], "Integrity cases is the open cases, in the board's order");
  assert.deepEqual(
    keys("all"),
    ["review:r1", "review:r2", "venue:v-held", "place:p1", "venue:v-active", "case:c1", "case:c2", "review:r3", "venue:v-retired"],
    "All walks every tab in order and keeps each slide ONCE — the held building is in Waiting and among the buildings in use",
  );
  assert.equal(new Set(keys("all")).size, keys("all").length, "All holds no slide twice");

  // The switch (owner, 2026-10-18: "view polyclinics only, or places only, or both").
  assert.deepEqual(keys("waiting", "places"), ["review:r1", "review:r2"], "Places keeps the places alone");
  assert.deepEqual(keys("waiting", "polyclinics"), ["venue:v-held"], "Polyclinics keeps the buildings alone");
  assert.deepEqual(keys("integrity", "polyclinics"), ["case:c2"], "a case filed on a polyclinic counts as a polyclinic");
  assert.deepEqual(keys("integrity", "places"), ["case:c1"], "and every other case as a place");
  assert.equal(keys("all", "places").length + keys("all", "polyclinics").length, keys("all", "both").length, "Places and Polyclinics together are Both, nothing lost and nothing twice");

  // The cases are read only when a tab needs them; before that the tab holds none of them.
  assert.deepEqual(keys("integrity", "both", { ...sources(), cases: null }), [], "no cases until they have been read");
  assert.equal(deckTabNeedsCases("integrity"), true);
  assert.equal(deckTabNeedsCases("all"), true, "All waits for the cases rather than shifting every History slide when they arrive");
  assert.equal(deckTabNeedsCases("waiting"), false, "the place tabs never pay for a read of the cases");

  // Where it opens.
  assert.equal(parseDeckTab("integrity"), "integrity", "?review=integrity is the Location integrity page's link");
  assert.equal(parseDeckTab("approve"), null, "anything else opens nothing");
  assert.equal(parseDeckTab(null), null);
  assert.deepEqual(deckStartOfBoardView("needs"), { tab: "waiting", kind: "both" }, "from Needs you, the waiting ones");
  assert.deepEqual(deckStartOfBoardView("unconfirmed"), { tab: "unconfirmed", kind: "places" }, "from Not confirmed, the single places in use");
  assert.deepEqual(deckStartOfBoardView("polyclinics"), { tab: "all", kind: "polyclinics" }, "from the polyclinic tab, every building");
  assert.deepEqual(deckStartOfBoardView("history"), { tab: "history", kind: "both" });
  assert.deepEqual(deckStartOfBoardView("samePlace"), { tab: "waiting", kind: "both" }, "the comparison tab has no photo of its own to review, so the review opens on Waiting");

  // ── 2 · When a slide slides on by itself ─────────────────────────────────────────────────────────
  assert.equal(slideIsSettled({ live: ["review:r1"], decided: [] }), false, "nothing decided here — it never moves on by itself");
  assert.equal(slideIsSettled({ live: [], decided: [] }), false, "a slide answered elsewhere does not slide past him unasked");
  assert.equal(slideIsSettled({ live: ["review:r1"], decided: ["review:r1"] }), true, "the one thing on it decided — on to the next");
  assert.equal(slideIsSettled({ live: [], decided: ["place:p1"] }), true, "a refused place has left the list and is answered");

  const held = venue("held", [
    { key: "a", state: "waiting" },
    { key: "b", state: "waiting" },
    { key: "c", state: "in_use" },
  ]);
  const live = venueLiveItems(held);
  assert.deepEqual(live, [deckSlideKey("venue", "v1"), deckSeatItem("a"), deckSeatItem("b")], "a held building waits on itself and on every customer the system is still checking");
  assert.equal(slideIsSettled({ live, decided: [deckSlideKey("venue", "v1")] }), false, "the building approved with two customers still waiting stays put");
  assert.equal(slideIsSettled({ live, decided: [deckSlideKey("venue", "v1"), deckSeatItem("a")] }), false, "and with one still waiting");
  assert.equal(slideIsSettled({ live, decided: [deckSlideKey("venue", "v1"), deckSeatItem("a"), deckSeatItem("b")] }), true, "only once every waiting customer is answered");
  assert.ok(!live.includes(deckSeatItem("c")), "a customer already in use is his to reject or not — nothing waits on him");
  assert.deepEqual(
    venueLiveItems(venue("retired", [{ key: "a", state: "waiting" }])),
    [deckSeatItem("a")],
    "a rejected building is not itself waiting; a customer still being checked in it is",
  );

  // ── 3 · The arrows, and no key that decides ─────────────────────────────────────────────────────
  const arrow = (key: string, overrides: Partial<Parameters<typeof deckArrowStep>[0]> = {}) =>
    deckArrowStep({ key, typing: false, modifier: false, otherDialogOpen: false, ...overrides });
  assert.equal(arrow("ArrowRight"), 1);
  assert.equal(arrow("ArrowLeft"), -1);
  assert.equal(arrow("ArrowRight", { typing: true }), 0, "never while he types a note — the arrows move the caret there");
  assert.equal(arrow("ArrowRight", { modifier: true }), 0, "never with a modifier held");
  assert.equal(arrow("ArrowRight", { otherDialogOpen: true }), 0, "never while the zoomed photo is open over the review");
  for (const key of ["Enter", " ", "a", "r", "Delete"]) assert.equal(arrow(key), 0, `${JSON.stringify(key)} does nothing: these are live places`);

  assert.deepEqual(
    summarizeDeckOutcomes(["Approved", "Rejected", "Approved"]),
    [
      { outcome: "Approved", count: 2 },
      { outcome: "Rejected", count: 1 },
    ],
    "the panel that closes a tab counts what was decided, most first",
  );

  // ── 4 · One decision path: the board's own controls, reporting through one hook ─────────────────
  const CONTROLS: ReadonlyArray<[string, ReadonlyArray<string>]> = [
    ["src/components/phoenix-crm/validation-review-queue.tsx", ["Decision", "Restore", "RejectAfterApproval"]],
    ["src/components/phoenix-crm/validated-place-list.tsx", ["Approve", "Refuse"]],
    ["src/components/phoenix-crm/shared-place-list.tsx", ["Decision", "RestoreVenue"]],
    ["src/components/phoenix-crm/shared-place-customers.tsx", ["RejectNotOnTimetable", "WaitingDecision", "RestoreSeated"]],
    ["src/components/crm-integrity/integrity-settle.tsx", ["IntegritySettleControl"]],
  ];
  for (const [path, names] of CONTROLS) {
    const code = stripComments(read(path));
    for (const name of names) {
      const body = functionBody(code, name);
      assert.match(body, /const done = usePlaceCheckDone\(\);/, `${path} ${name} must report a saved decision through usePlaceCheckDone, or the review never slides on`);
      // A literal or a choice between literals: `done(decision === "approve" ? "approved" : "rejected")`.
      assert.match(body, /done\([^;\n]*"[a-z]+"[^;\n]*\);/, `${path} ${name} must say what it decided`);
      assert.doesNotMatch(body, /router\.refresh\(\)/, `${path} ${name} refreshes through the hook, never beside it`);
    }
  }
  {
    const hook = stripComments(read("src/components/phoenix-crm/place-check-done.tsx"));
    assert.match(functionBody(hook, "usePlaceCheckDone"), /scope\?\.done\(scope\.item, outcome\);\s*router\.refresh\(\);/, "outside the review the hook is exactly the old router.refresh()");
  }
  for (const path of NEW_FILES) {
    const code = stripComments(read(path));
    if (path.endsWith("deck-cases.ts")) {
      assert.doesNotMatch(code, /crmPost|method:\s*"(?:POST|PATCH|DELETE)"/, `${path} only reads`);
      continue;
    }
    assert.doesNotMatch(code, /crmPost|crmPatch|fetch\(|method:\s*"/, `${path} must post nothing of its own — every decision is a control the board already had`);
  }
  {
    const deck = stripComments(read("src/components/place-review-deck/review-deck.tsx"));
    assert.match(deck, /<PlaceCheckDoneProvider item=\{current\.key\} key=\{current\.key\} onDone=\{record\}>/, "every control on the slide reports to the review");
    assert.match(deck, /<PlaceCheckDoneItem item=\{deckSlideKey\("venue", venue\.sharedPlaceId\)\}>/, "a polyclinic's building is answered on its own");
    assert.match(deck, /<PlaceCheckDoneItem item=\{deckSeatItem\(customer\.key\)\}>/, "and each customer seated in it on his own");
    assert.match(deck, /const step = deckArrowStep\(/, "the keys go through the one rule pinned above");
    assert.match(deck, /lastDecision\.slideKey !== current\.key \|\| !settled/, "it slides on only after a decision on THIS slide, never on one he came Back to");
  }

  // ── 5 · The Super Admin's alone, and in none of the portal's bundles ────────────────────────────
  {
    const board = stripComments(read("src/components/phoenix-crm/validation-reviews-board.tsx"));
    assert.match(board, /const withDeck = !team && reviewDeck !== undefined;/, "a district manager's board is never handed the review");
    const imports = board.match(/import[^;]*from "@\/(?:lib|components)\/place-review-deck\/[^"]+";/g) ?? [];
    assert.ok(imports.length > 0, "the board names the review's input type");
    for (const line of imports) assert.match(line, /^import type /, `the board imports types only from the review: ${line}`);
    const page = stripComments(read("app/(admin)/admin/field-crm/validation-reviews/page.tsx"));
    assert.match(page, /<PlaceChecksWithDeck/, "the Super Admin's page is the one that hands the review in");
    assert.match(page, /canDecideValidationReviews\(viewer\)\) redirect\("\/admin"\)/, "and that page is his alone");
    const wrapper = stripComments(read("src/components/place-review-deck/place-checks-with-deck.tsx"));
    assert.match(wrapper, /mode="company"/, "the wrapper draws the company board only");
    const integrity = stripComments(read("app/(admin)/admin/phoenix-crm/integrity/page.tsx"));
    assert.match(integrity, /canSettle && board\.cases\.length > 0 \?/, "the link from Location integrity is behind the Super Admin's own flag — the SFE Manager would be turned away");
    assert.match(integrity, /href="\/admin\/field-crm\/validation-reviews\?review=integrity"/);
  }

  // ── 6 · A real dialog, the house rules, and the cases read through the board ─────────────────────
  {
    const deck = stripComments(read("src/components/place-review-deck/review-deck.tsx"));
    assert.match(deck, /useDialogA11y<HTMLDivElement>\(\{ open: hydrated, onClose: close \}\)/, "focus held inside, the page behind locked, Escape closes");
    assert.match(deck, /aria-modal="true"/);
    assert.match(deck, /role="dialog"/);
    assert.match(deck, /createPortal\(/, "over the page, not inside its layout");
    assert.match(deck, /if \(!hydrated\) return null;/, "and only after hydration, as the zoomed photo does");
    assert.match(deck, /if \(otherDialogOpen\(\)\) return;/, "Escape closes the zoomed photo first, never the review under it");
    assert.match(deck, /motion-safe:animate-in/, "the slide moves only when the device allows motion");
    assert.doesNotMatch(deck, /(?<!motion-safe:)animate-in/, "every transition is behind motion-safe");
    assert.match(deck, /const \[frozen\] = useState\(\(\) => input\);/, "the tabs are taken when the review opens, so '12 of 87' never shifts under his finger");
  }
  for (const path of NEW_FILES) {
    const code = stripComments(read(path));
    const classes = (code.match(/className=(?:"[^"]*"|\{[^}]*\})/g) ?? []).join(" ") + " " + (code.match(/cn\([^)]*\)/g) ?? []).join(" ");
    assert.doesNotMatch(classes, /\brounded-(?!none\b)[a-z0-9]+/, `${path}: square corners only`);
    assert.doesNotMatch(code, /\b(?:truncate|line-clamp-\d|text-ellipsis)\b/, `${path}: no ellipsis — wrap instead`);
    assert.doesNotMatch(code, /overflow-x-|overflow-auto\b|overflow-scroll\b/, `${path}: never a sideways scroll`);
    assert.doesNotMatch(code, /…/, `${path}: no ellipsis character`);
    const words = [...(code.match(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g) ?? []), ...[...code.matchAll(/>([^<>{}]+)</g)].map((match) => match[1] ?? "")];
    for (const text of words) {
      assert.doesNotMatch(text, /\b(?:doctors?|accounts?)\b/i, `${path} says ${text.trim().slice(0, 60)} — the field CRM says customer`);
    }
  }
  {
    const route = stripComments(read("app/api/admin/phoenix-crm/integrity/cases/route.ts"));
    assert.match(route, /export async function GET\(/, "the cases route reads");
    assert.doesNotMatch(route, /export async function (?:POST|PATCH|PUT|DELETE)\(/, "and only reads — settling is the settle route's");
    assert.match(route, /await assertPermission\(access, "phoenix_crm", "read"\);/, "the permission is asserted on the server");
    assert.match(route, /const board = await loadIntegrityBoard\(viewer\);/, "through the board's own loader, so every narrowing the board applies applies here");
    assert.doesNotMatch(route, /\.from\(/, "and never the table itself");
    assert.match(route, /canSettle: canSettleIntegrityCases\(viewer\)/, "the review never offers a button the settle route would refuse");
    const cases = stripComments(read("src/components/place-review-deck/deck-cases.ts"));
    assert.match(cases, /first: current\.first \?\? board\.cases/, "the tab keeps the cases as first read, so a settled case keeps its slide");
  }
}
