import assert from "node:assert/strict";

import { buildNeedsYouBoard, NEEDS_YOU_ALL_CLEAR_SENTENCE } from "../src/lib/needs-you/classify.ts";
import { needsYouAdapters } from "../src/lib/needs-you/sources.ts";
import {
  buildNeedsYouSections,
  needsYouHeroDescription,
  needsYouSectionLines,
} from "../src/lib/needs-you/render/sections.ts";
import {
  needsYouSourceIds,
  type NeedsYouItem,
  type NeedsYouSourceId,
  type NeedsYouSourceResult,
} from "../src/lib/needs-you/types.ts";

/**
 * 🔴 THE ONE RULE THIS WHOLE MODULE EXISTS FOR: A BOARD THAT UNDER-REPORTS IS WORSE THAN NO BOARD.
 *
 * `/admin/needs-you` exists so the owner stops walking a dozen admin screens himself. That is the
 * hazard: he has DELEGATED the looking, so a board printing "nothing needs you" over a dead read
 * costs him the decision more surely than no board would have. Nothing on the page is allowed to
 * reach that sentence except a board that can prove it.
 *
 * This file drives the PURE core — `buildNeedsYouBoard` and the render model it feeds — because the
 * rule whose wrong answer costs something has to be checkable without a database, a browser or a
 * session. Same split as `scripts/needs-you.mjs` and `scripts/branch-pr-state.mjs`.
 *
 * WHAT EACH ASSERTION CATCHES, in the words of the change that would break it:
 *
 *  1. A source that died renders as calm — the `.catch(() => [])` that `getAwaitingMyActionItems`
 *     carried until 2026-09-28, moved one layer up.
 *  2. `not-applicable` collapsed into `unavailable` — nine permission refusals become nine permanent
 *     amber rows, which teaches the reader to ignore amber. The same failure, one step removed.
 *  3. A source dropped by a lost `await`, an early `return`, or a deleted registry line. `classify.ts`
 *     walks the REGISTRY rather than the results it was handed, so a dropped source arrives as amber
 *     instead of vanishing — and this is what pins that.
 *  4. A row he is told is his with nowhere to go.
 *  5. An ellipsis anywhere in what the page prints (AGENTS.md §4 — never truncate with one).
 *
 * Over-reporting is deliberately NOT tested. A row he glances at and dismisses costs two seconds; a
 * row that never appeared costs a deploy.
 */

function item(overrides: Partial<NeedsYouItem> & Pick<NeedsYouItem, "key" | "sourceId">): NeedsYouItem {
  return {
    kind: "approval",
    lane: "yours",
    label: `${overrides.key} is waiting`,
    count: 1,
    people: ["Ahmed Samir"],
    href: "/admin/action-center",
    externalUrl: null,
    oldestAt: "2026-09-06T08:00:00.000Z",
    ageDays: 12,
    overdue: false,
    note: null,
    ...overrides,
  };
}

/** Every source answered, and every one of them empty. The only state that may print the all-clear. */
function allOk(): NeedsYouSourceResult[] {
  return needsYouSourceIds.map((id) => ({ id, state: { status: "ok" as const, items: [] } }));
}

const NOW = new Date("2026-09-18T09:00:00.000Z");

/** Everything the page prints, hero line included — the hero is gated on the same flag as the band. */
function renderedLines(results: readonly NeedsYouSourceResult[]): string[] {
  const board = buildNeedsYouBoard(results, NOW);
  return [needsYouHeroDescription(board), ...needsYouSectionLines(buildNeedsYouSections(board))];
}

export function runNeedsYouNeverUnderReportsTests() {
  // ── 1. ONE dead source among fifteen live ones ⇒ the all-clear is unprovable and unprinted ─────
  {
    const results = allOk();
    const casualty: NeedsYouSourceId = "monthly-closings";
    const index = results.findIndex((result) => result.id === casualty);
    results[index] = {
      id: casualty,
      state: { status: "unavailable", because: "the closing read threw" },
    };

    const board = buildNeedsYouBoard(results, NOW);
    assert.equal(
      board.allClearProvable,
      false,
      "One source that did not answer must make the clean board UNPROVABLE. If this reads true, a " +
        "failure has been collapsed into a zero somewhere in classify.ts and the page will print " +
        "\"nothing needs you\" over an unread closing queue.",
    );
    assert.equal(board.notProven.length, 1, "The dead source must produce exactly one amber row.");
    assert.equal(board.notProven[0]?.id, casualty);
    assert.equal(board.yours.length, 0, "No source had any items, so nothing may be in the yours lane.");

    // The reason has to reach the screen in WORDS. An amber row with no sentence is a row he cannot act on.
    const lines = renderedLines(results);
    assert.ok(
      lines.some((line) => line.includes("the closing read threw")),
      "The failure's own reason must be printed, not swallowed into a generic notice.",
    );
    assert.ok(
      !lines.some((line) => line.includes(NEEDS_YOU_ALL_CLEAR_SENTENCE)),
      `The all-clear sentence reached the render with a dead source present. That sentence is the ` +
        `whole hazard: it is gated on allClearProvable and on NOTHING else — never on yours.length, ` +
        `which is also zero when every source is dead.`,
    );

    // A failure must write NO number. `itemCount: 0` would render identically to a read, empty queue.
    const report = board.sources.find((source) => source.id === casualty);
    assert.equal(report?.status, "unavailable");
    assert.equal(
      report?.itemCount,
      null,
      "A source that did not answer must report itemCount NULL, never 0 — a zero is what makes an " +
        "unread queue look like an empty one on the every-source band.",
    );
  }

  // ── 2. A PERMISSION REFUSAL is a true zero. It must not spend the all-clear ────────────────────
  {
    const results = allOk();
    results[0] = { id: results[0]!.id, state: { status: "not-applicable", because: "you hold no rung on this queue" } };
    results[1] = { id: results[1]!.id, state: { status: "not-applicable", because: "you hold no rung on this queue" } };

    const board = buildNeedsYouBoard(results, NOW);
    assert.equal(
      board.allClearProvable,
      true,
      "A viewer who holds no rung on a queue has NOTHING waiting there — a true zero. If this reads " +
        "false, `not-applicable` has been collapsed into `unavailable`, and every permission refusal " +
        "becomes a permanent amber warning. That trains the reader to ignore amber, which is this " +
        "same failure one step removed.",
    );
    assert.equal(board.notProven.length, 0, "A refusal is never an amber row.");
    assert.ok(
      renderedLines(results).some((line) => line.includes(NEEDS_YOU_ALL_CLEAR_SENTENCE)),
      "With every source answered and nothing waiting, the all-clear sentence MUST be printed — " +
        "withholding it when it is provable is the opposite defect and just as useless.",
    );

    // ...and it is still listed, with its reason, so "why is this queue empty" is answerable on screen.
    const report = board.sources.find((source) => source.id === results[0]!.id);
    assert.equal(report?.status, "not-applicable");
    assert.equal(report?.because, "you hold no rung on this queue");
  }

  // ── 3. ONE ENTRY PER SOURCE, ALWAYS — all-ok, all-failed, mixed, and nothing reported at all ───
  {
    const expected = [...needsYouSourceIds].sort();

    const cases: Array<{ name: string; results: NeedsYouSourceResult[] }> = [
      { name: "every source ok", results: allOk() },
      {
        name: "every source failed",
        results: needsYouSourceIds.map((id) => ({
          id,
          state: { status: "unavailable" as const, because: "nothing answered" },
        })),
      },
      {
        name: "mixed",
        results: needsYouSourceIds.map((id, index) => ({
          id,
          state:
            index % 3 === 0
              ? { status: "unavailable" as const, because: "it did not answer within 8 seconds" }
              : index % 3 === 1
                ? { status: "not-applicable" as const, because: "no rung" }
                : { status: "ok" as const, items: [] },
        })),
      },
      // The failure this guarantee was WRITTEN for: the fan-out reports on nothing at all, because an
      // `await` was lost or a registry line was deleted. Every source must still be listed, amber.
      { name: "nothing reported at all", results: [] },
    ];

    for (const testCase of cases) {
      const board = buildNeedsYouBoard(testCase.results, NOW);
      assert.deepEqual(
        board.sources.map((source) => source.id).sort(),
        expected,
        `${testCase.name}: the every-source band must carry one row per NeedsYouSourceId. A shorter ` +
          `list means a source can disappear from the screen entirely, which is the silent half of ` +
          `the under-report — classify.ts must iterate needsYouSourceIds, never the results it was given.`,
      );
    }

    // And an unreported source is AMBER, not absent and not calm.
    const empty = buildNeedsYouBoard([], NOW);
    assert.equal(empty.allClearProvable, false, "A board that received no answers cannot prove anything.");
    assert.equal(empty.notProven.length, needsYouSourceIds.length);
  }

  // ── 4. EVERY `yours` ROW HAS SOMEWHERE TO GO ───────────────────────────────────────────────────
  {
    const results = allOk();
    results[0] = {
      id: results[0]!.id,
      state: {
        status: "ok",
        items: [
          item({ key: "a", sourceId: results[0]!.id }),
          item({ key: "b", sourceId: results[0]!.id, lane: "worth-knowing", href: null }),
          item({ key: "c", sourceId: results[0]!.id, href: null, externalUrl: "https://github.com/x/y/pull/1" }),
        ],
      },
    };
    const board = buildNeedsYouBoard(results, NOW);
    assert.ok(board.yours.length > 0, "The fixture must actually put something in the yours lane.");
    for (const row of board.yours) {
      assert.ok(
        row.href !== null || row.externalUrl !== null,
        `The yours row "${row.key}" has neither an href nor an externalUrl. Telling him a decision is ` +
          `his and then not saying where to make it is worse than not listing it — this board's only ` +
          `job is to hand him the screen that already owns the click.`,
      );
    }

    // ...AND ON THE RENDER, not only on the model. Proving this guard by breaking it is what showed
    // the model-level check alone was not enough: nulling the href inside `toRow` left every board
    // item intact and this test green, while the screen grew a row he is told is his with no link on
    // it. The render is what he reads, so the render is what has to be asserted.
    const yoursSection = buildNeedsYouSections(board).find((section) => section.id === "yours");
    assert.ok(yoursSection?.band === "table" && yoursSection.rows.length > 0, "The yours band must have rendered rows.");
    for (const row of yoursSection.rows) {
      assert.ok(
        row.href !== null || row.externalUrl !== null,
        `The RENDERED yours row "${row.key}" carries no destination, so the page prints "No screen owns ` +
          `this yet" against work he is told is his. The board item has one — it was lost on the way to ` +
          `the screen.`,
      );
      assert.ok(row.whereLabel.trim().length > 0, `The rendered yours row "${row.key}" has an empty link label.`);
    }
  }

  // ── 5. NO ELLIPSIS ANYWHERE IN WHAT THE PAGE PRINTS ────────────────────────────────────────────
  {
    // A board with something in every lane and an amber row, so the scan covers all five bands.
    const results = allOk();
    results[0] = {
      id: results[0]!.id,
      state: {
        status: "ok",
        items: [
          item({ key: "mine", sourceId: results[0]!.id, overdue: true }),
          item({ key: "theirs", sourceId: results[0]!.id, lane: "someone-else" }),
          item({
            key: "noted",
            sourceId: results[0]!.id,
            lane: "worth-knowing",
            note: "Across August 2026 and September 2026.",
          }),
          // Nine names — past the six the cell prints — so the "and N more" wording is scanned too.
          item({
            key: "crowded",
            sourceId: results[0]!.id,
            people: ["Ali", "Mona", "Sara", "Hany", "Nour", "Omar", "Rana", "Tarek", "Yasmin"],
          }),
          item({ key: "uncounted", sourceId: results[0]!.id, count: null, people: [], oldestAt: null, ageDays: null }),
        ],
      },
    };
    results[1] = { id: results[1]!.id, state: { status: "unavailable", because: "it did not answer within 8 seconds" } };
    results[2] = { id: results[2]!.id, state: { status: "not-applicable", because: "you hold no rung on this queue" } };

    for (const line of renderedLines(results)) {
      assert.ok(
        !line.includes("…") && !line.includes("..."),
        `"${line}" carries an ellipsis. The owner's standing rule is that text is NEVER truncated ` +
          `with one; where that collides with the no-horizontal-scroll rule, wrapping wins. The "and ` +
          `N more" wording exists so a long roster needs no ellipsis at all.`,
      );
    }

    // The crowded cell says how many more there are, in words, rather than trailing off.
    const lines = renderedLines(results);
    assert.ok(
      lines.some((line) => line.includes("and 3 more")),
      "A roster longer than the cell prints must name the remainder in words.",
    );

    // An item that is not a count prints an em dash, never a fabricated 0.
    assert.ok(lines.includes("—"), "An item with `count: null` must print an em dash, not a zero.");
  }

  // ── 6. THE HEADLINE COUNTS ONLY WHAT IS HIS ────────────────────────────────────────────────────
  {
    const results = allOk();
    results[0] = {
      id: results[0]!.id,
      state: {
        status: "ok",
        items: [
          item({ key: "mine", sourceId: results[0]!.id }),
          item({ key: "theirs", sourceId: results[0]!.id, lane: "someone-else" }),
          item({ key: "noted", sourceId: results[0]!.id, lane: "worth-knowing" }),
        ],
      },
    };
    const board = buildNeedsYouBoard(results, NOW);
    assert.equal(
      board.yours.length,
      1,
      "The headline is the `yours` lane alone. A figure that counted someone else's work would send " +
        "him looking for decisions that are not his.",
    );
    assert.ok(needsYouHeroDescription(board).includes("1 thing is waiting"));
  }

  // ── 7. OLDEST FIRST, and an undated row never jumps the queue ──────────────────────────────────
  {
    const results = allOk();
    results[0] = {
      id: results[0]!.id,
      state: {
        status: "ok",
        items: [
          item({ key: "newer", sourceId: results[0]!.id, oldestAt: "2026-09-15T00:00:00.000Z" }),
          item({ key: "undated", sourceId: results[0]!.id, oldestAt: null }),
          item({ key: "oldest", sourceId: results[0]!.id, oldestAt: "2026-08-01T00:00:00.000Z" }),
        ],
      },
    };
    assert.deepEqual(
      buildNeedsYouBoard(results, NOW).yours.map((row) => row.key),
      ["oldest", "newer", "undated"],
      "Oldest first, undated last. A count-only source has no timestamp, and inventing today's date " +
        "for it would sort it above a request that has genuinely waited a month.",
    );
  }

  // ── 8. THE BAND ORDER: what could not be read comes FIRST ──────────────────────────────────────
  {
    assert.deepEqual(
      buildNeedsYouSections(buildNeedsYouBoard(allOk(), NOW)).map((section) => section.id),
      ["not-proven", "yours", "someone-else", "worth-knowing", "every-source"],
      "\"Could not be read\" is band ONE, above the work. This is a page the reader leaves after the " +
        "first fold, so an amber notice below the table is an amber notice nobody sees.",
    );
  }

  // ── 9. THE REGISTRY AND THE ADAPTERS ARE THE SAME SET ──────────────────────────────────────────
  //
  // Driven against the REAL exported array, not a restatement of it — `sources.ts` imports cleanly
  // under the test runner, so nothing here has to be taken on trust.
  //
  // Both directions matter, and they fail differently. A source id with no adapter renders as a
  // permanent amber row nobody can clear (harmless-looking, and it teaches the reader to ignore
  // amber). An adapter with no source id is the dangerous half: `classify.ts` walks the registry, so
  // its answer would be read and then silently dropped on the floor.
  {
    assert.deepEqual(
      needsYouAdapters.map((adapter) => adapter.id).sort(),
      [...needsYouSourceIds].sort(),
      "Every NeedsYouSourceId needs exactly one adapter, and every adapter needs a source id. An " +
        "adapter whose id is not in the registry is READ AND DISCARDED, because classify.ts iterates " +
        "the registry — so its queue silently stops being on the board.",
    );
    assert.equal(
      new Set(needsYouAdapters.map((adapter) => adapter.id)).size,
      needsYouAdapters.length,
      "Two adapters claiming one source id means one of them is thrown away by the last-answer-wins " +
        "rule in classify.ts, with nothing on screen to say so.",
    );
  }
}
