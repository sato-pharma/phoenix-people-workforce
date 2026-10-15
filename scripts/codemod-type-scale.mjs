#!/usr/bin/env node
// Replace arbitrary Tailwind font sizes with the --text-phx-* scale.
//
//   text-[11px]        ->  text-phx-sm
//   sm:text-[10px]     ->  sm:text-phx-xs
//   !text-[13px]       ->  !text-phx-lg
//
// WHY THIS EXISTS
// The app carries two incompatible size systems at once. Tailwind's named scale
// (text-xs .. text-7xl) is used 7,126 times and sets font-size AND a paired
// line-height. Beside it sit 4,854 arbitrary text-[Npx] classes that set
// font-size only. So text-xs and text-[12px] are the same size and render
// differently, and neither can be retuned without editing hundreds of files.
// This sweep collapses the arbitrary half onto eight named steps.
//
// WHY IT IS SAFE
// The --text-phx-* tokens are declared with no --text-*--line-height companion,
// so Tailwind emits font-size alone. text-phx-sm compiles to `font-size: 11px`
// — byte-for-byte what text-[11px] produced. This sweep is a RENAME, not a
// restyle: nothing should move on screen. That is measured in the PR, not
// assumed, and it is the whole reason the scale carries no leading.
//
// TWO THINGS THIS SCRIPT REFUSES TO DO
//  1. Touch a protected file (CLAUDE.md's owner-locked list). A mechanical edit
//     is still an edit. Hits there are REPORTED and skipped, never rewritten.
//  2. Guess. Only the eight steps below are replaced. Everything else — the
//     display sizes at 16px and up, the rem values, the clamp() expressions —
//     is left alone and counted, so what is NOT covered stays visible.
//
// Dry-run by default. Pass --apply to write.
//
//   node scripts/codemod-type-scale.mjs
//   node scripts/codemod-type-scale.mjs --apply

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "codemod-type-scale",
  entry: import.meta.url,
  known: ["--apply"],
  hints: [
    "it is a dry run by default — pass --apply to write",
  ],
});

// px -> utility suffix. Contiguous 8-15px: the whole range this admin's dense
// tables, labels and badges actually live in. The names are the ladder that was
// already in src/styles/tokens.css, not a new one invented beside it.
const MAP = {
  8: "phx-4xs",
  9: "phx-3xs",
  10: "phx-2xs",
  11: "phx-xs",
  12: "phx-sm",
  13: "phx-md",
  14: "phx-base",
  15: "phx-lg",
};

// CLAUDE.md's permanently-locked files.
const PROTECTED = [
  "src/lib/incentives/scheme-2026.ts",
  "src/lib/payroll/policy.ts",
  "src/components/employee-portal/identity-card.tsx",
  "src/lib/sales/office-allocation.ts",
];

// Resolve the WHOLE chain the browser will walk, so the report cannot drift
// from reality at either hop:
//
//   .text-phx-xs { font-size: var(--text-phx-xs) }   <- the utility
//   --text-phx-xs: var(--phx-fs-xs)                  <- app/globals.css @theme
//   --phx-fs-xs: 11px                                <- src/styles/tokens.css
//
// Checking only one file would let a correct token sit behind a missing or
// mis-pointed mapping and still report "same".
function scaleValues() {
  const tokens = readFileSync(path.join(process.cwd(), "src/styles/tokens.css"), "utf8");
  const globals = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

  const fs = {};
  for (const [, name, value] of tokens.matchAll(/^\s*--phx-fs-([a-z0-9-]+)\s*:\s*(\d+)px\s*;/gm)) {
    fs[name] = Number(value);
  }

  const out = {};
  for (const [, suffix, ref] of globals.matchAll(
    /^\s*--text-(phx-[a-z0-9-]+)\s*:\s*var\(--phx-fs-([a-z0-9-]+)\)\s*;/gm,
  )) {
    out[suffix] = fs[ref]; // undefined if the mapping points at a token that is not there
  }
  return out;
}

const apply = process.argv.includes("--apply");
const declared = scaleValues();

const files = execFileSync("git", ["ls-files", "app", "src"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(tsx|ts)$/.test(f));

// A class boundary, then any variant chain (sm:, hover:, dark:, group-hover:)
// and an optional `!`, then the literal utility. The bracket must hold ONLY
// `<digits>px`, so a clamp(), a rem, or a hex is never touched.
const PATTERN = /(^|[\s"'`{])((?:[a-z0-9-]+:)*!?)text-\[(\d+)px\]/g;

const perStep = Object.fromEntries(Object.keys(MAP).map((px) => [px, 0]));
const unmapped = new Map();
const protectedHits = [];
let filesChanged = 0;
let total = 0;

for (const file of files) {
  const isProtected = PROTECTED.includes(file.replace(/\\/g, "/"));
  const before = readFileSync(file, "utf8");
  let count = 0;

  const after = before.replace(PATTERN, (whole, lead, variants, px) => {
    const step = MAP[Number(px)];
    if (!step) {
      unmapped.set(`${px}px`, (unmapped.get(`${px}px`) ?? 0) + 1);
      return whole;
    }
    if (isProtected) {
      protectedHits.push(`${file}  ${variants}text-[${px}px]`);
      return whole;
    }
    perStep[px]++;
    count++;
    return `${lead}${variants}text-${step}`;
  });

  if (count > 0) {
    total += count;
    filesChanged++;
    if (apply) writeFileSync(file, after);
  }
}

console.log(`${apply ? "APPLIED" : "DRY RUN"} — ${files.length} tracked .ts/.tsx files scanned\n`);
console.log("FROM            ->  TOKEN            DECLARED   MATCH   REPLACED");
console.log("-".repeat(66));
let drift = 0;
for (const [px, step] of Object.entries(MAP)) {
  const d = declared[step];
  const ok = d === Number(px);
  if (!ok) drift++;
  console.log(
    `text-[${px}px]`.padEnd(15) +
      ` ->  text-${step.padEnd(10)}  ${d === undefined ? "MISSING" : `${d}px`.padEnd(7)}  ${ok ? "same " : "DRIFT"}  ${String(perStep[px]).padStart(8)}`,
  );
}
console.log("-".repeat(66));
console.log(`${total} replacements across ${filesChanged} files`);

if (drift > 0) {
  console.log(
    `\n!! ${drift} step(s) do not match globals.css. The swap is only visually inert while every` +
      `\n   declared value equals the px it replaces — fix the token before applying.`,
  );
  process.exitCode = 1;
}

if (protectedHits.length) {
  console.log(`\nPROTECTED FILES — ${protectedHits.length} size class(es) left untouched, owner approval required:`);
  for (const h of protectedHits) console.log(`  ${h}`);
}

const left = [...unmapped.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\nNOT MAPPED — ${left.reduce((s, [, n]) => s + n, 0)} occurrences over ${left.length} distinct sizes.`);
console.log("These are the display sizes; a scale for one-off hero numbers is not useful:");
for (const [px, n] of left) console.log(`  text-[${px}]  ${String(n).padStart(4)}`);
