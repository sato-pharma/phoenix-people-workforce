#!/usr/bin/env node
// Prove the unit suite ran every test exactly once, from the records its parts left behind.
//
// WHY. ci.yml's `unit` job runs the suite as a matrix of parts (scripts/run-tests-sharded.mjs, part
// mode). Each part is green on its own slice and writes `{ part, parts, perPart, seen, ran }`; none of
// them can see the others. A leg that never ran, one that ran twice and a wrong divisor all leave every
// part green while the suite is smaller than it should be — the 2026-09-17 shape (#3950), a required
// check passing on tests that did not run. So `checks` downloads the records into one folder and runs
// this over it, and `checks` is the REQUIRED status: this script's exit code is the merge gate.
//
// The verdict itself is `coverageProblems` in scripts/run-tests-sharded-plan.mjs (pinned by
// tests/run-tests-sharded.test.ts). This file only reads the folder and prints.
//
// Usage:  node scripts/ci-unit-coverage.mjs <folder holding the unit-coverage-N.json records>

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { coverageProblems } from "./run-tests-sharded-plan.mjs";
import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

refuseUnknownFlags({
  name: "ci-unit-coverage",
  entry: import.meta.url,
  known: [],
  hints: ["usage: node scripts/ci-unit-coverage.mjs <folder holding the unit-coverage-N.json records>"],
});

/** Every record in `folder`, or a refusal naming the file that is not one. */
function readRecords(folder) {
  const files = readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .sort();
  return files.map((name) => {
    const record = JSON.parse(readFileSync(join(folder, name), "utf8"));
    for (const key of ["part", "parts", "perPart", "seen", "ran"]) {
      if (!Number.isInteger(record?.[key]) || record[key] < 0) {
        throw new Error(`${name}: \`${key}\` is not a non-negative integer (got ${JSON.stringify(record?.[key])})`);
      }
    }
    return record;
  });
}

const folder = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
if (!folder) {
  console.error("ci-unit-coverage: REFUSED — name the folder that holds the coverage records.");
  process.exit(2);
}

let records;
try {
  records = readRecords(resolve(folder));
} catch (error) {
  console.error(`ci-unit-coverage FAILED: could not read the coverage records in ${folder}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const problems = coverageProblems(records);
if (problems.length > 0) {
  console.error("ci-unit-coverage FAILED:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const ran = records.reduce((sum, record) => sum + record.ran, 0);
console.log(
  `ci-unit-coverage: ${records.length} part(s) of ${records[0].parts}, ${records[0].perPart} shard(s) each, ran ${ran} of ${records[0].seen} tests — every test exactly once.`,
);
