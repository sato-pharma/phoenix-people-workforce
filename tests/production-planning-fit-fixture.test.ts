import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The committed planner fit fixture carries NO prices — mechanically, not by a comment.
 *
 * `scripts/measure-production-planning-fit.mjs` is the browser half of the fits-the-screen golden
 * rule: it renders the real tab components in both shells at 1024px, 1280px and 375px and measures
 * `scrollWidth > clientWidth`. It cannot be a CI check, because a required check must never depend
 * on a browser being in the runner image, so it needs a fixture handed to it — and its `--capture`
 * mode reads the live workspace.
 *
 * Its header said that payload "carries raw-material PRICES, so it is written where the caller asks
 * and never committed", which left the measurement reachable only from a machine holding production
 * credentials and enough memory for chromium plus a Tailwind compile. Measured at capture on
 * 2026-10-09, the real payload holds **no price at all**: 0 of 12 materials priced, 0 of 12 plan
 * rows with a unit price, `plan.totals.costEgp` "0.00" and `unpricedMaterials` 10. So the fixture is
 * committed, and the ban it was under becomes this test rather than a sentence nobody can enforce.
 *
 * 🔴 The point is the FUTURE capture. The owner will price these materials, and the next person to
 * refresh this fixture will do it with one command and no thought about what changed underneath. A
 * comment would not stop that; a required check does. If this goes red, do NOT delete the
 * assertion — re-capture, strip the priced fields, or stop committing the fixture and pass one by
 * `--fixture` from a local capture.
 *
 * What it deliberately does NOT check: the Arabic material names and the six-figure piece counts.
 * Those are the whole point of a real fixture — a synthetic one measures a table nobody will ever
 * see — and they are already tracked in `tests/production-planning-guamusin.test.ts` and in
 * `.claude/rules/production-planning.md`, which names the aluminium film and DBK's own figures.
 */

const FIXTURE = "tests/fixtures/production-planning-fit.json";

/** Every leaf whose KEY names a price or a cost, with the path that reached it. */
function priceLeaves(node: unknown, path: string, found: Array<[string, unknown]>): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => priceLeaves(item, `${path}[${index}]`, found));
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (/price|cost/i.test(key) && (value === null || typeof value !== "object")) {
      found.push([`${path}.${key}`, value]);
    }
    priceLeaves(value, `${path}.${key}`, found);
  }
}

/**
 * A count is not a price. `unpricedMaterials` and `costDerivedMissing` both match the key pattern
 * above and neither carries a figure anyone paid — listing them by exact path keeps the check
 * strict everywhere else instead of loosening the pattern.
 */
const NOT_A_PRICE = new Set([".plan.totals.unpricedMaterials", ".plan.totals.pricedMaterials"]);

export function runProductionPlanningFitFixtureTests() {
  const raw = readFileSync(FIXTURE, "utf8");
  const workspace = JSON.parse(raw) as Record<string, unknown>;

  // The fixture has to be the real shape, or the measurement renders an empty table and reports a
  // page that fits because there is nothing in it.
  const materials = workspace.materials as Array<Record<string, unknown>>;
  const plan = workspace.plan as Record<string, unknown> | null;
  assert.ok(Array.isArray(materials) && materials.length >= 10, `${FIXTURE} should carry the real material list`);
  assert.ok(plan && Array.isArray(plan.rows) && (plan.rows as unknown[]).length >= 10, "and a computed plan");
  assert.ok(
    materials.every((material) => typeof material.nameAr === "string" && (material.nameAr as string).trim() !== ""),
    "🔴 every material needs its real Arabic name — the wrapping name is what the widest column has to hold, " +
      "and a fixture whose names fall back to the CODE measures a narrower table than anyone will ever open",
  );

  const leaves: Array<[string, unknown]> = [];
  priceLeaves(workspace, "", leaves);
  assert.ok(leaves.length > 0, "the fixture should still HAVE price fields — all empty is the point, absent is a shape change");

  const priced = leaves.filter(([path, value]) => {
    if (NOT_A_PRICE.has(path)) return false;
    if (value === null || value === false) return false;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value.trim() !== "" && Number(value) !== 0;
    return true;
  });

  assert.deepEqual(
    priced,
    [],
    `🔴 ${FIXTURE} now carries a real PRICE. It is committed only because every price in it is ` +
      "empty — 0 of 12 materials priced when it was captured on 2026-10-09. Re-capture and strip " +
      "the priced fields, or stop committing it and pass one by --fixture from a local capture. " +
      "Do not delete this assertion to make the suite green.",
  );

  console.log(`  production planning fit fixture: OK (${materials.length} materials, ${leaves.length} price fields, all empty)`);
}
