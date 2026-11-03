// One-off, never merged: the panel's tests must pass, and must FAIL when each part of the fix is broken. No credentials reach this step.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SERVICE = "src/lib/double-visit-analytics/service.ts";
const CACHE = "src/lib/cache/shared-read.ts";
const TESTS = [
  ["private-calendar-double-visit-days", "runPrivateCalendarDoubleVisitDaysTests"],
  ["shared-read-cache", "runSharedReadCacheTests"],
  ["portal-home-card-reads", "runPortalHomeCardReadsTests"],
];

const run = () => {
  const failures = [];
  for (const [stem, exported] of TESTS) {
    const code = `const m = await import('./tests/${stem}.test.ts'); try { await m.${exported}(); } catch (e) { console.log('Error: ' + String(e && e.message).split('\\n')[0]); process.exit(1); } process.exit(0);`;
    const result = spawnSync(
      "node",
      ["--no-warnings", "--experimental-strip-types", "--experimental-specifier-resolution=node", "--experimental-loader", "./tests/alias-loader.mjs", "--input-type=module", "-e", code],
      { encoding: "utf8", timeout: 240_000 },
    );
    if (result.status !== 0) failures.push(`${stem}: ${(result.stdout + result.stderr).trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 260) ?? "no output"}`);
  }
  return failures;
};

const clean = run();
console.log(clean.length === 0 ? "PASS the unbroken code" : `FAIL the unbroken code:\n  ${clean.join("\n  ")}`);
if (clean.length > 0) process.exit(1);

const MUTANTS = [
  ["the hour becomes two", SERVICE, "ttlMs: 60 * 60 * 1000", "ttlMs: 2 * 60 * 60 * 1000"],
  ["a week's other days leak into a viewer's rows", SERVICE, ".filter((row) => listed.has(row.visit_date))", ""],
  ["the last 7 days come from the copy", SERVICE, "if (addDaysIso(week, 6) <= newestSettledDay) settledWeeks.add(week);", "if (week <= window.end) settledWeeks.add(week);"],
  ["the id sort is dropped", SERVICE, "return [...recent, ...settled.flat()].sort((left, right) => compareUuidText(left.id, right.id));", "return [...recent, ...settled.flat()];"],
  ["an empty week is kept", SERVICE, "return weekRows.length > 0 ? weekRows : null;", "return weekRows;"],
  ["the panel stops sharing", SERVICE, /^ *shareSettledWeeks: true,\r?\n/m, ""],
  ["the calendar starts sharing too", SERVICE, "includeResignedAgents: true,\n      ...(calendarDays", "includeResignedAgents: true,\n      shareSettledWeeks: true,\n      ...(calendarDays"],
  ["two read shapes share one copy", SERVICE, "`${sharedKey}|${week}`", "week"],
  ["every read gets the hour", CACHE, "(limits.ttlMs ?? SHARED_READ_TTL_MS)", "3_600_000"],
  ["the longer lifetime is ignored", CACHE, "(limits.ttlMs ?? SHARED_READ_TTL_MS)", "SHARED_READ_TTL_MS"],
];

let survived = 0;
for (const [label, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf8");
  const broken = original.replace(from, to);
  if (broken === original) {
    console.log(`NOT APPLIED ${label}`);
    survived += 1;
    continue;
  }
  writeFileSync(file, broken);
  const failures = run();
  writeFileSync(file, original);
  if (failures.length === 0) {
    console.log(`SURVIVED ${label}: no test noticed`);
    survived += 1;
  } else {
    console.log(`CAUGHT ${label}\n    ${failures[0]}`);
  }
}
console.log(`mutants: ${MUTANTS.length}, not caught: ${survived}`);
process.exit(survived === 0 ? 0 : 1);
