/**
 * OPS SCRIPT — validated on one line is validated on all three (owner, 2026-11-12), for the whole country.
 *
 * The same rules and the same doors the live hooks use (src/lib/phoenix-crm/line-twins.ts and
 * src/lib/phoenix-crm/server/line-twins.ts), run once over every area to bring the rows that were validated
 * before the rule existed into line with it:
 *   1. MERGE — two validated rows of one doctor on two lines, whose places sit apart within 150 m, end on
 *      one point: the better-evidenced one (moved > shared place > trusted > photo > pin).
 *   2. SHARE — a row still waiting on one line whose twin is validated on another is validated with the
 *      twin's places (`phoenix_crm_share_line_validation`).
 * Account: docs/phoenix-crm-line-twins.md.
 *
 * DRY RUN IS THE DEFAULT: it plans both and writes nothing. --apply carries them out (a bulk production
 * change — announce the counts first, AGENTS.md §8). --test runs the test world instead of the real one.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
 *     --experimental-loader ./tests/alias-loader.mjs scripts/phoenix-crm-line-twins.ts [--apply] [--test]
 */
import { LINE_TWIN_SKIP_TEXT, lineTwinSummary, type LineTwinSkipReason } from "@/lib/phoenix-crm/line-twins";
import { selectByIds } from "@/lib/phoenix-crm/server/db";
import { runLineTwinPass } from "@/lib/phoenix-crm/server/line-twins";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";

const known = new Set(["apply", "test"]);
const flags = new Set<string>();
for (const entry of process.argv.slice(2)) {
  if (!entry.startsWith("--")) throw new Error(`Unexpected argument ${entry} — refused rather than ignored.`);
  const name = entry.slice(2);
  if (!known.has(name)) throw new Error(`Unknown flag ${entry} — refused rather than ignored.`);
  flags.add(name);
}
const apply = flags.has("apply");
const isTest = flags.has("test");
const SAMPLE = 12;

const pass = await runLineTwinPass({ isTest, apply });
const org = await loadPhoenixCrmOrg();
const nameRows = await selectByIds<Record<string, unknown>>(
  "phoenix_crm_customers",
  "id, name",
  "id",
  [...new Set([...pass.moves.flatMap((move) => [move.customerId, move.anchorCustomerId]), ...pass.plan.skipped.slice(0, SAMPLE).map((skip) => skip.customerId)])],
);
const names = new Map(nameRows.map((row) => [String(row.id), String(row.name ?? "")]));
const lineOf = (seatId: string) => org.seats.get(seatId)?.lineCode ?? "no line";
const areaOf = (seatId: string) => org.seats.get(seatId)?.areaName ?? "no area";

console.log(`${isTest ? "TEST" : "REAL"} world · ${apply ? "APPLY" : "dry run"}`);
console.log(JSON.stringify(lineTwinSummary(pass.moves, pass.plan), null, 2));

console.log(`\nMerges (${pass.moves.length}), the first ${Math.min(SAMPLE, pass.moves.length)}:`);
for (const move of pass.moves.slice(0, SAMPLE)) {
  console.log(
    `  ${names.get(move.customerId) ?? "?"} · ${lineOf(move.seatId)} · ${areaOf(move.seatId)} — ${move.distanceMeters} m onto ` +
      `${names.get(move.anchorCustomerId) ?? "?"}'s ${lineOf(move.anchorSeatId)} place (was ${move.fromPointSource})`,
  );
}

console.log(`\nValidated across the lines (${pass.plan.shares.length}), the first ${Math.min(SAMPLE, pass.plan.shares.length)}:`);
for (const share of pass.plan.shares.slice(0, SAMPLE)) {
  console.log(`  ${share.name} · ${share.lineCode ?? "no line"} · ${areaOf(share.seatId)} — ${share.sourcePlaceIds.length} place(s) from ${share.sourceCustomerIds.length} validated row(s)`);
}

console.log(`\nLeft waiting (${pass.plan.skipped.length}), the first ${Math.min(SAMPLE, pass.plan.skipped.length)}:`);
for (const skip of pass.plan.skipped.slice(0, SAMPLE)) {
  console.log(`  ${skip.name} · ${lineOf(skip.seatId)} · ${areaOf(skip.seatId)} — ${LINE_TWIN_SKIP_TEXT[skip.reason as LineTwinSkipReason]}`);
}

if (!apply) {
  console.log("\nDry run — nothing written. Add --apply to carry it out.");
} else {
  console.log(`\nAPPLIED — merges: ${pass.merged?.moved ?? 0} moved, ${pass.merged?.failed ?? 0} failed.`);
  console.log(
    `Shares: ${pass.shared?.validated ?? 0} validated, ${pass.shared?.failed ?? 0} failed, skipped at the door: ${JSON.stringify(pass.shared?.skipped ?? {})}.`,
  );
}
