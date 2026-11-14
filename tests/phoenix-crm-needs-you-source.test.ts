import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { buildNeedsYouBoard, NEEDS_YOU_ALL_CLEAR_SENTENCE } from "../src/lib/needs-you/classify.ts";
import { buildNeedsYouSections, needsYouHeroDescription, needsYouSectionLines } from "../src/lib/needs-you/render/sections.ts";
import { needsYouAdapters } from "../src/lib/needs-you/sources.ts";
import {
  needsYouDestinations,
  needsYouSourceIds,
  needsYouSourceLabels,
  type NeedsYouItem,
  type NeedsYouSourceId,
  type NeedsYouSourceResult,
} from "../src/lib/needs-you/types.ts";

/**
 * Phoenix CRM on the central Needs You board.
 *
 * Until 2026-10-03 the board had sixteen sources and NONE of them was Phoenix CRM, so a district
 * manager's and the SFE Manager's Phoenix CRM decisions were visible only inside the module — and the
 * one whose delay costs a rep his figures is the off-plan visit, which counts in nothing at all until
 * somebody decides it (the visit-type rule).
 *
 * WHAT EACH SECTION CATCHES, in the words of the change that would break it:
 *
 *  1. The source added to the id list and nowhere else — no label (a row reading
 *     `phoenix-crm-decisions` at him), no destination, or no adapter in the registry.
 *  2. The destination pointed at `/admin/phoenix-crm`, which is the RETIRED 2026-09-14 pilot and only
 *     forwards; or at a screen that is not where the decision is actually taken.
 *  3. A second copy of the counts. They were private to `server/overview.ts` — the module page's own
 *     "waiting for you" badge — and a board that says 0 while that badge says 3 is exactly the
 *     under-report `needs-you/types.ts` is built to make impossible. ONE producer, two readers.
 *  4. A failed read written as a zero, or a medical rep handed a row. `not-applicable` is the third
 *     state and a rep is in it: `readsTeamReports` is deliberately false for him, and a gate on "has
 *     any scope" would have reported his own list progress about him on the owner's board.
 *  5. An integrity signal — a distance, an accuracy, a location flag — reaching a central board. Those
 *     are the Super Admin's and the SFE Manager's inside the module (golden rule #1) and this is not a
 *     back door to them.
 *  6. The board acting rather than linking.
 */

const ROOT = new URL("../", import.meta.url);
const SOURCE_ID: NeedsYouSourceId = "phoenix-crm-decisions";

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

const NOW = new Date("2026-10-03T09:00:00.000Z");

/** Every source answered and empty, except the ones this test replaces. */
function allOk(): NeedsYouSourceResult[] {
  return needsYouSourceIds.map((id) => ({ id, state: { status: "ok" as const, items: [] } }));
}

function withPhoenixCrm(items: readonly NeedsYouItem[]): NeedsYouSourceResult[] {
  const results = allOk();
  const index = results.findIndex((result) => result.id === SOURCE_ID);
  results[index] = { id: SOURCE_ID, state: { status: "ok", items } };
  return results;
}

function item(overrides: Partial<NeedsYouItem> & Pick<NeedsYouItem, "key">): NeedsYouItem {
  return {
    sourceId: SOURCE_ID,
    kind: "approval",
    lane: "yours",
    label: "2 off-plan visits are waiting for your approval",
    count: 2,
    people: [],
    href: needsYouDestinations[SOURCE_ID].href,
    externalUrl: null,
    oldestAt: null,
    ageDays: null,
    overdue: false,
    note: null,
    ...overrides,
  };
}

export function runPhoenixCrmNeedsYouSourceTests(): void {
  // ── 1. The source is wired in all four places, not one ───────────────────────────────────────
  {
    assert.ok(needsYouSourceIds.includes(SOURCE_ID), "the id is in the closed registry");
    assert.equal(needsYouSourceLabels[SOURCE_ID], "Phoenix CRM decisions", "it has the name a person would say");
    assert.ok(
      !needsYouSourceLabels[SOURCE_ID].includes("-"),
      "the amber row prints this label, so it must never read like a code (names, never codes)",
    );
    const adapter = needsYouAdapters.find((entry) => entry.id === SOURCE_ID);
    assert.ok(adapter, "an adapter is registered for it — without one the fan-out reports it as amber for ever");
    assert.equal(typeof adapter?.load, "function");
  }

  // ── 2. It links to where the decision is actually taken ──────────────────────────────────────
  {
    const destination = needsYouDestinations[SOURCE_ID];
    assert.equal(destination.href, "/admin/field-crm?tab=team");
    assert.ok(
      !destination.href.startsWith("/admin/phoenix-crm"),
      "/admin/phoenix-crm is the RETIRED 2026-09-14 pilot and only forwards. The live app is /admin/field-crm.",
    );
    assert.ok(destination.href.startsWith("/"), "an app screen, never an off-app address");
    assert.ok(destination.screen.length > 0 && !destination.screen.includes("/"), "the screen is NAMED, not a path");
    // The Team tab is the one that owns all three: the list requests, the off-plan visits and each
    // territory's readiness. A link anywhere else is a row he clicks and cannot act on.
    assert.ok(destination.href.includes("tab=team"));
  }

  // ── 3. ONE producer for the counts, read by the module AND by the board ──────────────────────
  {
    const overview = source("src/lib/phoenix-crm/server/overview.ts");
    const queues = source("src/lib/phoenix-crm/server/decision-queues.ts");
    const crmNeedsYou = source("src/lib/phoenix-crm/server/needs-you.ts");

    // The rule lives in exactly one file.
    for (const producer of [
      "export function phoenixCrmDecisionSeats",
      "export async function countPhoenixCrmListRequestsWaitingForYou",
      "export async function countPhoenixCrmOffPlanVisitsWaitingForYou",
      "export async function countPhoenixCrmWeeklyPlansWaitingForYou",
    ]) {
      assert.ok(queues.includes(producer), `decision-queues.ts owns ${producer}`);
    }

    // 🔴 AND THE MODULE PAGE READS IT RATHER THAN KEEPING ITS OWN COPY. If `overview.ts` grows its own
    // `countWaiting`/`countUnplannedVisits` again, the badge and the board drift — and the direction
    // they drift in is the board reading a smaller number than the module, which is the under-report.
    assert.ok(overview.includes("phoenixCrmDecisionSeats("), "overview.ts reads the shared seat split");
    assert.ok(overview.includes("countPhoenixCrmListRequestsWaitingForYou("), "and the shared list-request count");
    assert.ok(overview.includes("countPhoenixCrmOffPlanVisitsWaitingForYou("), "and the shared off-plan count");
    // 🔴 THE WEEKLY-PLAN COUNT MOVED INTO THE PRODUCER ON 2026-10-08, and this is the pair of lines
    // that keeps it there: `overview.ts` had the only copy, inlined, which is exactly why the board
    // read 0 for a manager with weeks sitting on his desk.
    assert.ok(overview.includes("countPhoenixCrmWeeklyPlansWaitingForYou("), "and the shared weekly-plan count");
    assert.ok(!overview.includes('countPhoenixCrmWaiting("phoenix_crm_plans"'), "overview.ts no longer counts the sent weeks itself");
    assert.ok(!/async function countUnplannedVisits/.test(overview), "overview.ts holds no private copy of the off-plan count");
    assert.ok(!/async function countWaiting\b/.test(overview), "nor of the waiting count");
    assert.ok(
      !overview.includes("canReviewTerritory("),
      "the reviewer test travels with the counts; a second reading of it here is how the two came apart",
    );

    // The board's own side reads the same two functions and counts nothing itself.
    assert.ok(crmNeedsYou.includes("countPhoenixCrmListRequestsWaitingForYou("), "the board's loader reads the producer");
    assert.ok(crmNeedsYou.includes("countPhoenixCrmOffPlanVisitsWaitingForYou("));
    assert.ok(crmNeedsYou.includes("countPhoenixCrmWeeklyPlansWaitingForYou("), "and the weekly plans, which it did not count at all before 2026-10-08");
    assert.ok(!crmNeedsYou.includes(".from("), "it writes no query of its own");
    assert.ok(crmNeedsYou.includes("loadReadiness("), "and the validation figure is the Team tab's own readiness read");
    assert.ok(
      !/loadReadiness\([^)]*,\s*true/.test(crmNeedsYou),
      "`loadReadiness` can STAMP a territory ready; the board reads and never writes, so it is called with the default",
    );
  }

  // ── 4. A failure is never a zero, and a rep is `not-applicable` rather than a row ────────────
  {
    const adapterSource = source("src/lib/needs-you/sources.ts");
    // 🔴 THE WINDOW ENDS AT THE NEXT ADAPTER, NOT AT THE REGISTRY. It used to run to
    // `export const needsYouAdapters`, which swept in every adapter declared after this one — so the
    // `> 0) {` count below was measuring the whole tail of the file, and it read 7 the moment an
    // unrelated source was added (2026-10-09, `closing-publication-drift`, whose own `cells > 0`
    // guard matched). The count is meant to be THIS adapter's, so the slice is now this adapter's.
    const crmStart = adapterSource.indexOf("const phoenixCrmDecisions:");
    const nextAdapterOffset = adapterSource
      .slice(crmStart + 1)
      .search(/\nconst [A-Za-z0-9_]+: NeedsYouAdapter = \{/);
    assert.ok(crmStart >= 0, "the Phoenix CRM adapter could not be located");
    assert.ok(nextAdapterOffset > 0, "the Phoenix CRM adapter could not be bounded by its neighbour");
    const block = adapterSource.slice(crmStart, crmStart + 1 + nextAdapterOffset);
    assert.ok(block.length > 0, "the Phoenix CRM adapter could not be located");
    assert.ok(
      !/\nconst [A-Za-z0-9_]+: NeedsYouAdapter = \{/.test(block),
      "and the window holds exactly ONE adapter, or every assertion below is reading its neighbours",
    );

    // Its own permission call, as every adapter has — a `Forbidden:` rejection is a TRUE zero upstream.
    assert.ok(block.includes('assertPermission(access, "phoenix_crm", "read")'), "the adapter asserts the module's own gate");

    // 🔴 A 403 FROM THE MODULE IS MAPPED EXPLICITLY. `resolvePhoenixCrmViewer` refuses a login with no
    // HR record through `forbiddenError`, whose message does NOT begin "Forbidden:" — so without this
    // the board would carry a permanent amber row for an account that simply holds no seat.
    assert.ok(block.includes("ApiError") && block.includes("403"), "a 403 from the module becomes not-applicable, never amber");
    assert.ok(block.includes('status: "not-applicable"'), "and `not-applicable` is produced, not inferred");

    // A rep is gated out by the module's own team-report predicate.
    assert.ok(block.includes("phoenixCrmReadsDecisions(viewer)"), "the reader test is the module's, not a copy");
    const crmNeedsYou = source("src/lib/phoenix-crm/server/needs-you.ts");
    assert.ok(crmNeedsYou.includes("return readsTeamReports(viewer)"), "and that predicate IS readsTeamReports");

    // Nothing in the adapter or the loader turns a failure into a number.
    for (const swallow of ["catch", "?? 0", "|| 0"]) {
      assert.ok(!crmNeedsYou.includes(swallow), `a failed read must travel, never become a figure (${swallow})`);
    }
    // And no item is produced at zero: the four pushes are each behind a `> 0`.
    // Six since 2026-10-08: a refused place not yet captured again is the sixth.
    // Seven since 2026-10-16: a recorded visit waiting for the Administrator.
    assert.equal((block.match(/> 0\) \{/g) ?? []).length, 7, "each of the seven counts produces an item only when it is non-zero");

    // 🔴 THE WEEKLY PLANS ARE ON THE BOARD (2026-10-08). The module's own badge always counted them;
    // this board did not, so a district manager read 0 here while weeks sat on his desk — the
    // under-report `src/lib/needs-you/types.ts` exists to make impossible.
    assert.ok(block.includes('key: "phoenix-crm-decisions:weekly-plans"'), "the weekly plans have their own row");
    assert.ok(block.includes("counts.weeklyPlans > 0"), "and it is produced only when something is waiting");
    assert.ok(
      block.includes('`${counts.weeklyPlans} weekly ${plural(counts.weeklyPlans, "plan is", "plans are")} waiting for your approval`'),
      "named in words, singular and plural",
    );
  }

  // ── 5. No measurement, no money, no id ───────────────────────────────────────────────────────
  {
    const adapterSource = source("src/lib/needs-you/sources.ts");
    const block = adapterSource.slice(
      adapterSource.indexOf("const phoenixCrmDecisions:"),
      adapterSource.indexOf("export const needsYouAdapters"),
    );
    for (const measured of ["distance", "locationFlag", "accuracy", "device_mocked", "integrity", "photo"]) {
      assert.ok(!block.includes(measured), `Phoenix CRM's integrity signals never reach a central board (${measured})`);
    }
    // `people` is names-only by the item's own shape (there is no hrId field), and this source carries
    // no people at all: the counts are head counts, which return a number and no rows.
    assert.ok(block.includes("people: []"), "a head count has no names to carry, and an id is not a substitute");
    // No SLA upstream, so no verdict invented here.
    assert.ok(!block.includes("overdue: true"), "the module publishes no SLA, so no overdue verdict is invented");
  }

  // ── 6. The board classifies it correctly and prints it without an ellipsis ───────────────────
  {
    const board = buildNeedsYouBoard(
      withPhoenixCrm([
        item({ key: "phoenix-crm-decisions:off-plan-visits" }),
        item({ key: "phoenix-crm-decisions:list-requests", label: "3 Phoenix CRM list requests are at your step", count: 3 }),
        item({
          key: "phoenix-crm-decisions:awaiting-validation",
          kind: "flag",
          lane: "worth-knowing",
          label: "1551 carried-over customers are still waiting to be validated",
          count: 1551,
        }),
      ]),
      NOW,
    );
    assert.equal(board.notProven.length, 0, "every source answered");
    assert.equal(board.allClearProvable, false, "two decisions are his, so the all-clear cannot print");
    assert.equal(board.yours.filter((row) => row.sourceId === SOURCE_ID).length, 2, "the two decisions are in his own lane");
    assert.equal(board.worthKnowing.filter((row) => row.sourceId === SOURCE_ID).length, 1, "the validation figure is worth knowing, never his");

    const lines = [needsYouHeroDescription(board), ...needsYouSectionLines(buildNeedsYouSections(board))];
    const printed = lines.join("\n");
    assert.ok(printed.includes("off-plan"), "the off-plan row is printed");
    assert.ok(!printed.includes(NEEDS_YOU_ALL_CLEAR_SENTENCE), "the all-clear sentence is nowhere near a full lane");
    assert.ok(!printed.includes("…") && !printed.includes("..."), "nothing is truncated with an ellipsis (AGENTS.md §4)");
    assert.ok(!printed.includes(SOURCE_ID), "the id never reaches the screen — only the label does");

    // The source answering EMPTY is a true zero and may sit under the all-clear.
    const clear = buildNeedsYouBoard(withPhoenixCrm([]), NOW);
    assert.equal(clear.allClearProvable, true, "an empty Phoenix CRM source is a true zero");

    // And a FAILED Phoenix CRM read makes the all-clear unprovable rather than reading as calm.
    const dead = allOk();
    const index = dead.findIndex((result) => result.id === SOURCE_ID);
    dead[index] = { id: SOURCE_ID, state: { status: "unavailable", because: "the readiness read answered no row for 4 of 92 territories" } };
    const deadBoard = buildNeedsYouBoard(dead, NOW);
    assert.equal(deadBoard.allClearProvable, false, "a dead Phoenix CRM read can never print the all-clear");
    assert.deepEqual(
      deadBoard.notProven.map((entry) => entry.label),
      ["Phoenix CRM decisions"],
      "and it is named the way a person would say it",
    );
  }

  // ── 7. The held places: his queue alone, counted once, linked to the screen that decides it ──
  //
  // Added 2026-10-05, the day the owner put that queue on email, in-app and Telegram by name. The
  // board is the fourth way the same hold reaches him and the only one that still shows it tomorrow,
  // so a notice read late and left is not a decision lost. What this section refuses:
  //
  //  · the count read with its own query here, or in `needs-you.ts`, instead of from the file that
  //    owns the table and the gate — the drift section 3 already paid for once;
  //  · the row linking to the source's Team tab, which cannot decide one of these;
  //  · the gate widened past the Super Admin, putting the queue on the screens of people who cannot
  //    act on it, or a role test spelled out again here instead of the module's own predicate;
  //  · the count narrowed to one world, which would read 0 while the page shows a row — and the
  //    decider's own entries are TEST entries, so a real-only count is permanently calm;
  //  · an `overdue` verdict invented for a queue the module publishes no SLA for.
  {
    const reviews = source("src/lib/phoenix-crm/server/validation-reviews.ts");
    const crmNeedsYou = source("src/lib/phoenix-crm/server/needs-you.ts");

    assert.ok(
      reviews.includes("export async function countValidationReviewsWaiting"),
      "the file that owns the table and the gate owns the count too",
    );
    assert.ok(crmNeedsYou.includes("countValidationReviewsWaiting("), "and the board's loader reads it rather than querying");
    assert.ok(
      crmNeedsYou.includes("canDecideValidationReviews(viewer)"),
      "gated by the module's own predicate — the Super Admin alone decides a held place",
    );
    assert.ok(
      !crmNeedsYou.includes("isSuperAdmin"),
      "the role test travels with the gate; reading it again here is how two copies come apart",
    );

    // Both worlds, exactly as the page lists them. A filter either way is the under-report.
    const countBlock = reviews.slice(
      reviews.indexOf("export async function countValidationReviewsWaiting"),
      reviews.indexOf("function reviewNoticeKey"),
    );
    assert.ok(countBlock.length > 0, "the count could not be located");
    assert.ok(!countBlock.includes("is_test"), "the page shows both worlds and marks each row, so the count filters neither");
    // 14 Nov 2026: it was a head count of every pending review. A review left pending on a retired place
    // is nobody's to decide and the page no longer lists it, so the count reads the waiting rows whole,
    // paged, and asks the page's own test of each. A read it could not finish throws, never a short figure.
    assert.ok(countBlock.includes("readEveryPage<Row>("), "read whole and paged, so the 1,000-row ceiling cannot shorten it");
    assert.ok(!countBlock.includes(".limit("), "and never a bounded read");
    assert.match(countBlock, /if \(capped\) throw new Error\(/, "a read that met its ceiling is refused, never counted short");
    assert.ok(countBlock.includes("rows.filter((row) => reviewStillToDecide(row, placeById))"), "counted by the same test the page lists by");
    assert.ok(
      reviews.includes("reviews.filter((row) => reviewStillToDecide(row, placeById)).map((row): ValidationReviewRow =>"),
      "and the page lists by it, so the two can never disagree",
    );
    assert.match(
      countBlock,
      /if \(review\.status !== "pending"\) return true;\s+const place = placeById\.get\(String\(review\.place_id\)\);\s+return !place \|\| place\.status === "active";/,
      "a decided row is always shown, and a place that could not be read hides nothing",
    );
    for (const swallow of ["catch", "|| 0"]) {
      assert.ok(!countBlock.includes(swallow), `a failed read must travel, never become a figure (${swallow})`);
    }

    // The row carries its OWN href, because the Team tab has no decision on it.
    const adapterSource = source("src/lib/needs-you/sources.ts");
    const block = adapterSource.slice(
      adapterSource.indexOf("const phoenixCrmDecisions:"),
      adapterSource.indexOf("export const needsYouAdapters"),
    );
    assert.ok(block.includes("href: VALIDATION_REVIEWS_PATH"), "it links to the page that decides these, by the module's own constant");
    assert.ok(!block.includes('href: "/admin'), "and never to a path written out again here");

    // And it renders in HIS lane, with an age and no invented verdict.
    const held = item({
      key: "phoenix-crm-decisions:place-checks",
      label: "2 places are held for your approval",
      href: "/admin/field-crm/validation-reviews",
      oldestAt: "2026-09-30T06:00:00.000Z",
      ageDays: 3,
    });
    const board = buildNeedsYouBoard(withPhoenixCrm([held]), NOW);
    const row = board.yours.find((entry) => entry.key === "phoenix-crm-decisions:place-checks");
    assert.ok(row, "a held place is in his own lane — nobody else can clear it");
    assert.equal(row?.href, "/admin/field-crm/validation-reviews", "and it opens the page that decides it");
    assert.equal(row?.ageDays, 3, "the age is carried, because the customer stays unvalidated meanwhile");
    assert.equal(row?.overdue, false, "no SLA upstream, so no verdict");
    assert.equal(board.allClearProvable, false, "a held place can never sit under the all-clear");
    const printed = [needsYouHeroDescription(board), ...needsYouSectionLines(buildNeedsYouSections(board))].join("\n");
    assert.ok(printed.includes("held for your approval"), "the row is printed in his own words");
  }

  // ── 🔴 A REFUSED PLACE NOT YET CAPTURED AGAIN — his alone, worth knowing, with an age ────────────
  // Added 2026-10-08: 0 of 22 refused customers had been validated again, the oldest 76.7 hours
  // later, and nothing outside the page said so. The rep redoes the photo, so it is never his lane.
  {
    const reviews = source("src/lib/phoenix-crm/server/validation-reviews.ts");
    const crmNeedsYou = source("src/lib/phoenix-crm/server/needs-you.ts");
    assert.ok(reviews.includes("export async function countReopenedCustomersWaiting"), "the module owns the count");
    assert.match(
      crmNeedsYou,
      /decidesPlaces \? countReopenedCustomersWaiting\(\) : Promise\.resolve\(\{ count: 0, oldestAt: null \}\)/,
      "asked only for the Super Admin, a true zero with no query for everyone else",
    );
    const countBlock = reviews.slice(reviews.indexOf("export async function countReopenedCustomersWaiting"));
    const countBody = countBlock.slice(0, countBlock.indexOf("\n}\n"));
    assert.ok(countBody.includes('{ count: "exact", head: true }'), "a head count, so no row ceiling can shorten it");
    assert.ok(!countBody.includes("catch"), "a failed read travels");

    const adapterSource = source("src/lib/needs-you/sources.ts");
    const block = adapterSource.slice(adapterSource.indexOf('key: "phoenix-crm-decisions:reopened-waiting"'));
    const rowSource = block.slice(0, block.indexOf("});"));
    assert.ok(rowSource.includes('lane: "worth-knowing"'), "worth knowing — nothing waits on his decision");
    assert.ok(rowSource.includes("overdue: false"), "no SLA upstream, so no verdict");
    assert.ok(rowSource.includes("ageDays: ageDaysSince(counts.oldestReopenedAt, now)"), "but the wait is stated");
    assert.ok(rowSource.includes("href: VALIDATION_REVIEWS_PATH"), "and it opens the page that lists each one");

    const waiting = item({
      key: "phoenix-crm-decisions:reopened-waiting",
      kind: "flag",
      lane: "worth-knowing",
      label: "3 refused places are still waiting to be captured again",
      href: "/admin/field-crm/validation-reviews",
      oldestAt: "2026-10-05T06:00:00.000Z",
      ageDays: 3,
    });
    const board = buildNeedsYouBoard(withPhoenixCrm([waiting]), NOW);
    assert.equal(board.yours.some((entry) => entry.key === "phoenix-crm-decisions:reopened-waiting"), false, "never in his own lane");
  }

  // ── 🔴 A RECORDED VISIT WAITING FOR THE ADMINISTRATOR — his alone, his own lane, its own page ──
  // Added 2026-10-16: a recorded visit of any type counts in nothing until he approves it, so a rep's
  // figures wait on him by name. Asked only when `canAdminister` is true.
  {
    const crmNeedsYou = source("src/lib/phoenix-crm/server/needs-you.ts");
    assert.match(
      crmNeedsYou,
      /canAdminister\(viewer\) \? countRecordedVisitsWaiting\(\) : Promise\.resolve\(\{ count: 0, oldestAt: null \}\)/,
      "asked only for the Administrator, a true zero with no query for everyone else",
    );
    const adapterSource = source("src/lib/needs-you/sources.ts");
    const block = adapterSource.slice(adapterSource.indexOf('key: "phoenix-crm-decisions:recorded-visits"'));
    const rowSource = block.slice(0, block.indexOf("});"));
    assert.ok(rowSource.length > 0, "the recorded-visit row could not be located");
    assert.ok(rowSource.includes('lane: "yours"'), "his own lane — nobody else can clear it");
    assert.ok(rowSource.includes("href: VISIT_RECORDING_ADMIN_PATH"), "it opens the page that decides it, by the module's own constant");
    assert.ok(rowSource.includes("overdue: false"), "no SLA upstream, so no verdict");

    const waiting = item({
      key: "phoenix-crm-decisions:recorded-visits",
      label: "2 recorded visits are waiting for your approval",
      href: "/admin/field-crm/visit-recording",
      oldestAt: "2026-10-02T06:00:00.000Z",
      ageDays: 1,
    });
    const board = buildNeedsYouBoard(withPhoenixCrm([waiting]), NOW);
    assert.ok(board.yours.some((entry) => entry.key === "phoenix-crm-decisions:recorded-visits"), "in his own lane");
    assert.equal(board.allClearProvable, false, "a waiting recorded visit can never sit under the all-clear");
  }

  console.log("phoenix-crm on the needs-you board: OK");
}
