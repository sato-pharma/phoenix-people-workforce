import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The Synthetic Journeys page's Run History fits a phone.
 *
 * Owner, 14 November 2026: "Fix it". Measured at 375px that morning: Run History was one table at every
 * width, its last column 12% of a 317px card (38px) and the "Viewing" button in it about 60px, so the card
 * scrolled sideways by 34px (351px of content in 317px) and the button sat past its edge. Journey Results,
 * directly above it, already gave a phone cards. The fits-the-screen rule: never a horizontal scroll, and
 * the admin shell shows desktop a full table and a phone cards.
 */

const source = readFileSync(new URL("../src/components/admin/synthetic-journeys-dashboard.tsx", import.meta.url), "utf8");

function section(title: string): string {
  const start = source.indexOf(`title="${title}"`);
  assert.ok(start >= 0, `the ${title} section is still on the page`);
  const end = source.indexOf("</AdminTableShell>", start);
  assert.ok(end > start, `the ${title} section closes`);
  return source.slice(start, end);
}

export function runSyntheticJourneysRunHistoryFitTests() {
  const history = section("Run History");

  // ── The table is the desktop's alone.
  const desktopAt = history.indexOf('<div className="hidden md:block">');
  const tableAt = history.indexOf("<table");
  assert.ok(desktopAt >= 0 && desktopAt < tableAt, "the Run History table is wrapped so only a desktop shows it — at 375px its last column cannot hold the View button");

  // ── A phone gets cards, and every run is on them with the same facts and the same button.
  const cardsAt = history.indexOf('className="divide-y divide-slate-100 md:hidden"');
  assert.ok(cardsAt > tableAt, "a phone gets Run History as cards, as it gets Journey Results");
  const cards = history.slice(cardsAt);
  assert.ok(cards.includes("runs.map((run)"), "the cards list every saved run");
  for (const fact of ["formatDateTime(run.createdAt)", "OVERALL_TONE[run.overallStatus].label", "run.passedCount", "run.failedCount", "run.skippedCount", "formatDuration(run.durationMs)"]) {
    assert.ok(cards.includes(fact), `a card shows ${fact}, as the table row does`);
  }
  assert.ok(cards.includes("onClick={() => viewRun(run.id)}"), "a card's button opens that run, as the table's does");
  assert.ok(cards.includes('"Viewing"'), "and says Viewing on the run being shown");

  // ── Nothing fits the card by scrolling it.
  assert.ok(!history.includes("overflow-x-auto"), "Run History never fits by scrolling sideways");
  assert.ok(!/min-w-\[\d+px\]/.test(history), "and never by a minimum width wider than a phone");
}
