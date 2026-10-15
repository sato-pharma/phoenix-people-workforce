#!/usr/bin/env node
// Replace arbitrary hex Tailwind classes with --phx- token utilities.
//
//   text-[#64748b]  ->  text-phx-ink-soft
//   border-[#E2E8F0] -> border-phx-line
//   hover:bg-[#f97316]/10 -> hover:bg-phx-accent/10
//
// WHY THIS EXISTS
// 335 files carry 7,816 hardcoded hex colours. The 14 values below are 5,694 of
// them. An arbitrary hex says nothing about what the colour is FOR, nothing
// connects the 923 copies of #64748b to each other, and changing the palette
// means editing 335 files by hand. A token utility says what it is, and one edit
// in src/styles/tokens.css moves every use of it.
//
// TWO THINGS THIS SCRIPT REFUSES TO DO
//  1. Touch a protected file (CLAUDE.md's owner-locked list). Those need the
//     owner's approval for ANY change, including a mechanical one. If a hex is
//     found in one, it is REPORTED and skipped, never rewritten.
//  2. Guess. Only the explicit map below is replaced; every other hex is left
//     alone and counted, so what is NOT covered stays visible.
//
// Dry-run by default. Pass --apply to write.
//
//   node scripts/codemod-hex-to-tokens.mjs
//   node scripts/codemod-hex-to-tokens.mjs --apply

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "codemod-hex-to-tokens",
  entry: import.meta.url,
  known: ["--apply"],
  hints: [
    "it is a dry run by default — pass --apply to write",
  ],
});

// hex (lowercase) -> --phx- token suffix. The comment on each line is the
// Tailwind palette name it came from, so the intent behind the old value is
// recoverable rather than lost in the rewrite.
const MAP = {
  "64748b": "phx-ink-soft", // slate-500  — secondary/meta text
  "0f172a": "phx-ink", // slate-900  — body ink
  f97316: "phx-accent", // orange-500 — the brand; identical value
  e2e8f0: "phx-line", // slate-200  — hairline border
  "94a3b8": "phx-ink-faint", // slate-400  — disabled/placeholder
  f8fafc: "phx-paper", // slate-50   — page ground
  fdba74: "phx-accent-line", // orange-300 — accent border
  d8e0ea: "phx-line", // custom     — border/ring only
  fff7ed: "phx-accent-soft", // orange-50  — accent tint ground
  "475569": "phx-ink-2", // slate-600  — secondary ink
  cbd5e1: "phx-line-strong", // slate-300  — emphasised rule
  "334155": "phx-ink-2", // slate-700  — secondary ink
  e4e9ec: "phx-line", // custom     — border only
  f1f5f9: "phx-paper-2", // slate-100  — muted ground
  ea580c: "phx-accent-hover", // orange-600 — identical value
  c2410c: "phx-accent-press", // orange-700 — identical value
};

// Some hexes mean different things depending on the property they colour, and a
// single mapping would be wrong for the minority case.
//
// #fdba74 is the only one so far: 210 of its 228 uses are borders (hover:border
// 99, focus:border 90, border 16, ...), where the soft --phx-accent-line tint is
// exactly right. But 10 are text-[#fdba74], and orange-300 as text is already
// only ~1.8:1 on white — routing those to a LIGHTER tint would take unreadable
// to invisible. They go to the full-strength accent instead, which is the same
// hue family and strictly more legible.
const PREFIX_OVERRIDES = {
  fdba74: { text: "phx-accent" },
};

/** The base utility, with any variant chain and `!` stripped: "focus:!border-l" -> "border-l". */
const baseUtility = (prefix) => prefix.split(":").pop().replace(/^!/, "");

// Resolved live from tokens.css so the delta report cannot drift from reality.
function tokenValues() {
  const css = readFileSync(path.join(process.cwd(), "src/styles/tokens.css"), "utf8");
  const root = css.slice(css.indexOf(":root {"), css.indexOf(".dark {"));
  const out = {};
  for (const [, name, value] of root.matchAll(/^\s*--(phx-[a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gim)) {
    out[name] = value.toLowerCase();
  }
  return out;
}

// CLAUDE.md's permanently-locked files. A mechanical edit is still an edit.
const PROTECTED = [
  "src/lib/incentives/scheme-2026.ts",
  "src/lib/payroll/policy.ts",
  "src/components/employee-portal/identity-card.tsx",
  "src/lib/sales/office-allocation.ts",
];

const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
const distance = (a, b) => {
  const [x, y, z] = rgb(a.replace("#", ""));
  const [p, q, r] = rgb(b.replace("#", ""));
  return Math.round(Math.sqrt((x - p) ** 2 + (y - q) ** 2 + (z - r) ** 2));
};

const apply = process.argv.includes("--apply");
const values = tokenValues();

const files = execFileSync("git", ["ls-files", "app", "src"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(tsx|ts)$/.test(f));

// prefix-[#hex]  — prefix may carry a variant (hover:, dark:, md:) and a dash
// (border-l). The bracket must contain ONLY the hex, so a gradient or a shadow
// with a hex buried inside a longer arbitrary value is never touched.
const PATTERN = /(^|[\s"'`{:!])((?:[a-z0-9-]+:)*!?[a-z][a-z0-9-]*)-\[#([0-9a-fA-F]{6})\]/g;

const perRule = Object.fromEntries(Object.keys(MAP).map((h) => [h, 0]));
const unmapped = new Map();
const protectedHits = [];
const overrideHits = [];
let filesChanged = 0;
let total = 0;

for (const file of files) {
  const isProtected = PROTECTED.includes(file.replace(/\\/g, "/"));
  const before = readFileSync(file, "utf8");
  let count = 0;

  const after = before.replace(PATTERN, (whole, lead, prefix, hex) => {
    const key = hex.toLowerCase();
    if (!MAP[key]) {
      unmapped.set(key, (unmapped.get(key) ?? 0) + 1);
      return whole;
    }
    if (isProtected) {
      protectedHits.push(`${file}  ${prefix}-[#${hex}]`);
      return whole;
    }
    const token = PREFIX_OVERRIDES[key]?.[baseUtility(prefix)] ?? MAP[key];
    if (token !== MAP[key]) overrideHits.push(`${prefix}-[#${hex}] -> ${prefix}-${token}`);
    perRule[key]++;
    count++;
    return `${lead}${prefix}-${token}`;
  });

  if (count > 0) {
    total += count;
    filesChanged++;
    if (apply) writeFileSync(file, after);
  }
}

console.log(`${apply ? "APPLIED" : "DRY RUN"} — ${files.length} tracked .ts/.tsx files scanned\n`);
console.log("HEX        ->  TOKEN               VALUE      NEW        SHIFT  REPLACED");
console.log("-".repeat(74));
for (const [hex, token] of Object.entries(MAP)) {
  const to = values[token] ?? "?";
  const d = to === "?" ? "?" : distance(hex, to);
  const flag = d !== "?" && d > 40 ? "  <-- large" : "";
  console.log(
    `#${hex.padEnd(9)} ->  ${token.padEnd(18)} #${hex}   ${to}    ${String(d).padStart(4)}  ${String(perRule[hex]).padStart(6)}${flag}`,
  );
}
console.log("-".repeat(74));
console.log(`${total} replacements across ${filesChanged} files`);

if (overrideHits.length) {
  const grouped = overrideHits.reduce((m, h) => m.set(h, (m.get(h) ?? 0) + 1), new Map());
  console.log(`\nPREFIX OVERRIDES APPLIED — ${overrideHits.length}, so a colour is not used in a role it cannot fill:`);
  for (const [h, n] of grouped) console.log(`  ${String(n).padStart(4)}x  ${h}`);
}

if (protectedHits.length) {
  console.log(`\nPROTECTED FILES — ${protectedHits.length} hex class(es) left untouched, owner approval required:`);
  for (const h of protectedHits) console.log(`  ${h}`);
}

const left = [...unmapped.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\nNOT MAPPED — ${left.reduce((s, [, n]) => s + n, 0)} occurrences over ${left.length} distinct values.`);
console.log("Top 10 remaining:");
for (const [hex, n] of left.slice(0, 10)) console.log(`  #${hex}  ${String(n).padStart(5)}`);
