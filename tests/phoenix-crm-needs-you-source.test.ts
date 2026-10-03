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
    ]) {
      assert.ok(queues.includes(producer), `decision-queues.ts owns ${producer}`);
    }

    // 🔴 AND THE MODULE PAGE READS IT RATHER THAN KEEPING ITS OWN COPY. If `overview.ts` grows its own
    // `countWaiting`/`countUnplannedVisits` again, the badge and the board drift — and the direction
    // they drift in is the board reading a smaller number than the module, which is the under-report.
    assert.ok(overview.includes("phoenixCrmDecisionSeats("), "overview.ts reads the shared seat split");
    assert.ok(overview.includes("countPhoenixCrmListRequestsWaitingForYou("), "and the shared list-request count");
    assert.ok(overview.includes("countPhoenixCrmOffPlanVisitsWaitingForYou("), "and the shared off-plan count");
    assert.ok(!/async function countUnplannedVisits/.test(overview), "overview.ts holds no private copy of the off-plan count");
    assert.ok(!/async function countWaiting\b/.test(overview), "nor of the waiting count");
    assert.ok(
      !overview.includes("canReviewTerritory("),
      "the reviewer test travels with the counts; a second reading of it here is how the two came apart",
    );

    // The board's own side reads the same two functions and counts nothing itself.
    assert.ok(crmNeedsYou.includes("countPhoenixCrmListRequestsWaitingForYou("), "the board's loader reads the producer");
    assert.ok(crmNeedsYou.includes("countPhoenixCrmOffPlanVisitsWaitingForYou("));
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
    const block = adapterSource.slice(
      adapterSource.indexOf("const phoenixCrmDecisions:"),
      adapterSource.indexOf("export const needsYouAdapters"),
    );
    assert.ok(block.length > 0, "the Phoenix CRM adapter could not be located");

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
    // And no item is produced at zero: the three pushes are each behind a `> 0`.
    assert.equal((block.match(/> 0\) \{/g) ?? []).length, 3, "each of the three counts produces an item only when it is non-zero");
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

  console.log("phoenix-crm on the needs-you board: OK");
}
