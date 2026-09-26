import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripCommentsCompact } from "./support/comment-strip.ts";

import { BRICK_TINTS } from "../src/components/phoenix-crm/brick-tints.ts";
import { clusterByBrick, NO_BRICK_KEY } from "../src/lib/phoenix-crm/brick-groups.ts";
import {
  clusterByBrick as clusterByBrickOnThePhone,
  normalizeArea as normalizeAreaOnThePhone,
} from "../mobile/src/lib/crm/brick-groups.ts";
import { BRICK_TINT_COLORS } from "../mobile/src/components/crm/brick-tints.ts";
import { normalizeArea } from "../src/lib/phoenix-crm/suggestions.ts";

/**
 * Phoenix CRM — A3: the day reads as a route, not as an index.
 *
 * Owner, 2026-09-26: "I want everything to be highlighted, every brick be highlighted, the doctors in
 * the same bricks are highlighted with the same colour … I want the thing to be as easiest as it
 * could be."
 *
 * The clustering existed already — as a CLOSURE inside `AddCustomers` in plan-tab.tsx, which no other
 * screen could reach. So the candidates a rep picked from read geographically while the day he was
 * about to drive read alphabetically, and the phone had neither. This pins the shared helper, the two
 * orders, and the two hand-kept copies that would otherwise drift in silence.
 */

type Row = { name: string; brick: string | null };

const rows: Row[] = [
  { name: "first", brick: "D14" },
  { name: "second", brick: "faisal" },
  { name: "third", brick: "Faisal " },
  { name: "fourth", brick: null },
  { name: "fifth", brick: "A1" },
];

const brickOf = (row: Row) => row.brick;

function source(path: string): string {
  return stripCommentsCompact(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

export function runPhoenixCrmBrickGroupsTests(): void {
  // ── One brick, whatever the spelling ────────────────────────────────────────────────────────────
  {
    const groups = clusterByBrick(rows, brickOf, "first-appearance");
    const faisal = groups.find((group) => group.key === "faisal");
    assert.equal(faisal?.rows.length, 2, '"faisal" and "Faisal " are ONE brick — normalizeArea is the single comparison key');
    assert.equal(faisal?.label, "Brick faisal", "the label is the brick as first captured, not the normalised key");
  }

  // ── The two orders, and why they differ ─────────────────────────────────────────────────────────
  {
    // A day he is about to DRIVE is a route: the caller already sorted it, and re-sorting the
    // clusters by name would scatter his morning.
    const route = clusterByBrick(rows, brickOf, "first-appearance").map((group) => group.key);
    assert.deepEqual(route, ["d14", "faisal", "a1", NO_BRICK_KEY], "first-appearance keeps the caller's order");

    // A list he is SEARCHING is an index: "Brick A1" where he expects to find it.
    const index = clusterByBrick(rows, brickOf, "alphabetical").map((group) => group.key);
    assert.deepEqual(index, ["a1", "d14", "faisal", NO_BRICK_KEY], "alphabetical sorts by the label");
  }

  // ── Customers with no place are one group, and always last ──────────────────────────────────────
  //
  // They are the ones whose place has not been captured yet. Scattered through the geography they
  // read as though they sat somewhere, which is exactly the guess the module refuses to make.
  {
    for (const order of ["first-appearance", "alphabetical"] as const) {
      const groups = clusterByBrick(rows, brickOf, order);
      assert.equal(groups.at(-1)?.key, NO_BRICK_KEY, `no-brick is last (${order})`);
      assert.equal(groups.at(-1)?.label, "No brick");
      assert.equal(groups.filter((group) => group.key === NO_BRICK_KEY).length, 1, "and there is only ever one of it");
    }
  }

  // ── The phone answers the same as the browser ───────────────────────────────────────────────────
  //
  // Two hand-kept copies, because mobile/tsconfig.json cannot reach the web tree. Nothing but this
  // compares them, and a drift is invisible until the two screens are held side by side.
  {
    for (const order of ["first-appearance", "alphabetical"] as const) {
      const web = clusterByBrick(rows, brickOf, order).map((group) => ({ key: group.key, label: group.label, names: group.rows.map((row) => row.name) }));
      const phone = clusterByBrickOnThePhone(rows, brickOf, order).map((group) => ({ key: group.key, label: group.label, names: group.rows.map((row) => row.name) }));
      assert.deepEqual(phone, web, `the phone clusters exactly as the browser does (${order})`);
    }
    for (const value of ["D14", " d14 ", "", "   ", null, undefined]) {
      assert.equal(normalizeAreaOnThePhone(value), normalizeArea(value ?? null), `normalizeArea agrees on ${JSON.stringify(value)}`);
    }
  }

  // ── The same brick is the same colour on both ───────────────────────────────────────────────────
  {
    assert.equal(
      BRICK_TINT_COLORS.length,
      BRICK_TINTS.length,
      "the phone's palette must hold the same number of hues, or the same brick takes a different colour on each app",
    );
  }

  // ── The planned day is grouped, and carries no spread flag with it ──────────────────────────────
  {
    const plan = source("src/components/phoenix-crm/plan-tab.tsx");
    assert.ok(plan.includes("function dayBricks("), "the day's clustering is named, not inlined");
    assert.ok(plan.includes('clusterByBrick(rows, (row) => row.brick, "first-appearance")'), "the planned day reads as a route");
    assert.ok(plan.includes("{dayBricks(state.rows)"), "and the day screen actually renders the groups");
    // Every DayRow carries a brick, or a whole class of rows would silently fall into "No brick".
    assert.equal((plan.match(/\n\s+brick: /g) ?? []).length >= 4, true, "every DayRow constructor sets its brick");

    // 🔴 The heading is LAYOUT. The far-apart spread stays behind `showSpread`, which is false for a
    // rep on his own plan — grouping his day must not become a way to show him the distances.
    const start = plan.indexOf("{dayBricks(state.rows)");
    const block = plan.slice(start, start + 1200);
    for (const word of [/nearestKm/, /spanKm/, /isolated/, /farApartKm/]) {
      assert.equal(word.test(block), false, `the brick heading must not carry a spread flag: ${word}`);
    }
  }

  // ── The phone's picker groups too ───────────────────────────────────────────────────────────────
  {
    const screen = source("mobile/src/features/crm/visits-screen.tsx");
    assert.ok(screen.includes("clusterByBrick(shown"), "the phone's picker clusters what it shows");
    assert.ok(screen.includes("clusterByBrick(offered"), "but tints off the WHOLE offered list, so a brick's colour never moves as he searches");
    assert.ok(screen.includes("brickTintColorMap("), "and colours them from the shared palette");
  }

  console.log("phoenix-crm brick groups: OK");
}
