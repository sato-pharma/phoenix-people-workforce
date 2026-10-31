import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { NEIGHBOUR_TINTS, neighbourTint } from "../src/components/phoenix-crm/brick-tints.ts";
import { gatherNeighbours, gatherWithinGroups } from "../src/lib/phoenix-crm/plan-neighbours.ts";

/**
 * Phoenix CRM — on the rep's plan day, the customers at the same address sit together and wear ONE
 * colour per group.
 *
 * 🔴 THE OWNER, 2026-10-31: "make the same color rule when making their weekly plans" — the rule he
 * set on the Reps List the same night: "color all drs near to each other by a group color and if
 * another group near each other then another color". Within 20 m of each other is one group, a chain
 * of such pairs is one group, and the whole row takes the group's colour.
 *
 * What has to hold on a PLAN, where it did not on the list: the day's order is the rep's, so a group
 * moves up to where its first member already stood and nothing else moves.
 */

type Row = { id: string; lat: number | null; lon: number | null };

// 111,320 m to a degree of latitude, the constant the scorer uses — so these distances are exact.
const north = (metres: number) => 30 + metres / 111_320;
const row = (id: string, metresNorth: number | null, lon = 31): Row => ({ id, lat: metresNorth === null ? null : north(metresNorth), lon: metresNorth === null ? null : lon });
const pointOf = (entry: Row) => ({ lat: entry.lat, lon: entry.lon, name: entry.id });
const ids = (gathered: ReadonlyArray<{ row: Row; group: number | null }>) => gathered.map((entry) => `${entry.row.id}:${entry.group ?? "-"}`);

export function runPhoenixCrmPlanNeighboursTests() {
  // ── Nobody shares an address: the day is exactly as he ordered it ───────────────────────────────
  {
    const day = [row("A", 0), row("B", 5_000), row("C", 10_000)];
    assert.deepEqual(ids(gatherNeighbours(day, pointOf)), ["A:-", "B:-", "C:-"], "with no neighbours nothing moves and nothing is coloured");
  }

  // ── A group sits under its FIRST member; a chain is one group; the rest keep their places ────────
  {
    // A and C are 10 m apart, C and E 15 m (A to E is 25 m — past 20 m, but the chain holds them).
    // F and G stand 5 m apart, 50 km away. B is alone; D has no place yet.
    const far = 50_000;
    const day = [row("A", 0), row("B", 5_000), row("C", 10), row("D", null), row("F", far), row("E", 25), row("G", far + 5)];
    assert.deepEqual(
      ids(gatherNeighbours(day, pointOf)),
      ["A:0", "C:0", "E:0", "B:-", "D:-", "F:1", "G:1"],
      "A's group gathers under A, in its own order; B and D follow; F's group is the second colour",
    );
  }

  // ── A lone row ahead of a group stays ahead of it — the planner never re-sorts ──────────────────
  {
    const day = [row("Z", 9_000), row("M", 0), row("A", 3)];
    assert.deepEqual(ids(gatherNeighbours(day, pointOf)), ["Z:-", "M:0", "A:0"], "never sorted by name: Z stays first, M before A as he had them");
  }

  // ── A customer not validated yet has no place, so he is never anyone's neighbour ────────────────
  {
    const day = [row("P", null), row("Q", null), row("R", 0)];
    assert.deepEqual(ids(gatherNeighbours(day, pointOf)), ["P:-", "Q:-", "R:-"], "two missing points are not 'the same address'");
  }

  // ── Per brick, with the numbering running on across the bricks ──────────────────────────────────
  {
    const bricks = [
      { key: "b1", label: "Brick 1", rows: [row("A", 0), row("B", 9_000), row("C", 4)] },
      { key: "b2", label: "Brick 2", rows: [row("D", 20_000)] },
      { key: "b3", label: "Brick 3", rows: [row("E", 30_000), row("F", 30_002)] },
    ];
    const { groups, groupOf } = gatherWithinGroups(bricks, pointOf, (entry) => entry.id);
    assert.deepEqual(
      groups.map((group) => ({ key: group.key, label: group.label, rows: group.rows.map((entry) => entry.id) })),
      [
        { key: "b1", label: "Brick 1", rows: ["A", "C", "B"] },
        { key: "b2", label: "Brick 2", rows: ["D"] },
        { key: "b3", label: "Brick 3", rows: ["E", "F"] },
      ],
      "each brick keeps its key and label, and gathers inside itself only",
    );
    assert.deepEqual(
      [...groupOf.entries()],
      [
        ["A", 0],
        ["C", 0],
        ["E", 1],
        ["F", 1],
      ],
      "the second brick's group is the SECOND colour, so two groups on one list never share one",
    );
    // Two bricks a few metres apart are still two headings: a group never reaches across one.
    const split = gatherWithinGroups(
      [
        { key: "x", rows: [row("X", 0)] },
        { key: "y", rows: [row("Y", 3)] },
      ],
      pointOf,
      (entry) => entry.id,
    );
    assert.equal(split.groupOf.size, 0, "a group never reaches across a brick heading");
  }

  // ── The colours are the Reps List's five, and they wrap ─────────────────────────────────────────
  {
    assert.equal(neighbourTint(null), null, "a row standing alone has no colour");
    assert.equal(neighbourTint(undefined), null);
    assert.equal(neighbourTint(0), NEIGHBOUR_TINTS[0]);
    assert.equal(neighbourTint(NEIGHBOUR_TINTS.length), NEIGHBOUR_TINTS[0], "the sixth group wraps to the first colour");
  }

  // ── The plan day wears it: the tick list AND the day read back ──────────────────────────────────
  {
    const panel = stripComments(readFileSync("src/components/phoenix-crm/plan-day-panel.tsx", "utf8"));
    assert.equal((panel.match(/gatherWithinGroups\(/g) ?? []).length, 2, "both the day he is building and the day read back gather by address");
    assert.ok(/import \{[^}]*\bneighbourTint\b[^}]*\} from "@\/components\/phoenix-crm\/brick-tints";/.test(panel), "from the one shared palette");
    assert.ok(!panel.includes("NEIGHBOUR_TINTS"), "never a copy of its own");
    assert.ok(panel.includes("lat: fit.place?.lat ?? null"), "a row stands where the place it is planned at stands");
    assert.match(
      panel,
      /if \(tint\) return tint\.fill;\s*return row\.placed \? "bg-orange-50\/40" : undefined;/,
      "the WHOLE row takes the group's colour, ahead of the placed row's orange wash; a lone placed row keeps orange",
    );
    assert.match(panel, /<tr className=\{tickRowFill\(row, tint\)\}>/, "on the desktop row");
    assert.match(panel, /tickRowFill\(row, tint\) \?\? "bg-white"/, "and on the phone card");
    assert.match(panel, /<tr className=\{neighbourTint\(groupOf\.get\(item\.customerId\)\)\?\.fill\}/, "and on a day read back");
    assert.ok(panel.includes("Customers in one colour receive at the same address."), "one plain line says what the colour means");
    // It is layout, never a measure of him: no distance reaches his own plan.
    assert.ok(!/\.metres\b|NEIGHBOUR_M/.test(panel), "no metres figure is written on the rep's plan");
  }

  console.log("phoenix-crm plan neighbours: OK");
}
