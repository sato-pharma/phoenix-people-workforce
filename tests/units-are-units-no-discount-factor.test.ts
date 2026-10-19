import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// UNITS ARE UNITS — owner, 2026-09-07: "we neglect the bonus and the value in any distributor sheet,
// we take the units and multiply by factory", then "effective_units = qty x (1 - discount) delete
// this rule from every where".
//
// The rule lived in eleven places at once (ten database functions and the TypeScript importer), so
// deleting it in the file you happen to be reading is not the same as deleting it. This test is the
// sweep: no live code anywhere may multiply a quantity by one-minus-a-discount again.
//
// It is a TEXT sweep on purpose. The three surfaces that carried the factor — the closing detail
// mapper, the normalizer engine and the distributor importer — all sit behind a Supabase read or a
// workbook parse, so no unit test can reach the arithmetic itself; that is exactly how the factor
// survived a green suite for as long as it did. Comments and string literals are stripped first, so
// a line explaining that the rule was removed does not trip the guard that removed it.

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCANNED_DIRS = ["src", "app", "scripts", "tests"];
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js"]);
const SKIPPED_DIR_NAMES = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage"]);

// No live file is allow-listed any more. The last one, src/lib/direct-orders/approval-fields.ts,
// spelled out a direct order's negotiated deal percentage for the approval panel's working — a
// different rule entirely, never a distributor sheet. Since 2026-10-19 the panel prices each line
// through priceBasketLine, so the entry was dropped rather than left to cover a future file there.
// Per-LINE escape hatch, for a test that pins the factor's ABSENCE and therefore has to name it.
// Deliberately ugly and greppable: `git grep units-are-units:allow` lists every exemption.
const ALLOW_MARKER = "units-are-units:allow";

const ALLOWED_FILES = new Set([
  // This file itself: a guard has to be able to spell the thing it forbids.
  "tests/units-are-units-no-discount-factor.test.ts",
]);

// `qty * (1 - discount)`, `q * (1 - r.discountRate)`, `1 - Number(row.discount)`, and the same with
// the operands the other way round. Deliberately loose: a near-miss spelling is worth a false alarm
// a session can read and dismiss, where a miss is a rep silently credited fewer units than sold.
const FACTOR_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "1 - <discount>", re: /1\s*-\s*[A-Za-z0-9_.?![\]()"'`]*[Dd]iscount/ },
  { label: "<discount> - 1", re: /[A-Za-z0-9_.?![\]()"'`]*[Dd]iscount[A-Za-z0-9_.?![\]()"'`]*\s*\)?\s*-\s*1\b/ },
  // A REGEX LITERAL pinning the old SQL formula. Not hypothetical: the first version of this sweep
  // passed clean while tests/marketing-roi-attribution-consistency.test.ts still asserted that
  // phx_marketing_request_sales_lines MUST contain the factor — a pinning test holding the
  // anti-pattern in place. CI caught that; this pattern is so the sweep does too. A regex literal
  // is not a string literal, so it survives stripCommentsAndStrings.
  { label: "regex pinning the old formula", re: /1(?:\\s\*|\s)*-(?:\\s\*|\s)*(?:coalesce|[A-Za-z0-9_.?![\]()"'`\\*])*[Dd]iscount/ },
];

/**
 * Blank out `//` comments, block comments and string/template literals, keeping the byte length so
 * reported line numbers stay true. Not a parser — a scanner good enough that prose about the rule
 * cannot read as the rule.
 */
function stripCommentsAndStrings(source: string): string {
  const out = source.split("");
  let i = 0;
  const n = source.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      let end = source.indexOf("\n", i);
      if (end === -1) end = n;
      blank(i, end);
      i = end;
      continue;
    }
    if (two === "/*") {
      let end = source.indexOf("*/", i + 2);
      end = end === -1 ? n : end + 2;
      blank(i, end);
      i = end;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let k = i + 1;
      while (k < n) {
        if (source[k] === "\\") {
          k += 2;
          continue;
        }
        if (source[k] === ch) break;
        k += 1;
      }
      blank(i + 1, Math.min(k, n));
      i = Math.min(k + 1, n);
      continue;
    }
    i += 1;
  }
  return out.join("");
}

function walk(dir: string, found: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIPPED_DIR_NAMES.has(entry)) continue;
    const full = path.join(dir, entry);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      walk(full, found);
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry))) {
      found.push(full);
    }
  }
  return found;
}

export function runUnitsAreUnitsNoDiscountFactorTests() {
  const files: string[] = [];
  for (const dir of SCANNED_DIRS) walk(path.join(REPO_ROOT, dir), files);

  // POSITIVE CONTROL — an empty sweep and a broken sweep look identical, and this one walks the
  // filesystem, so prove it actually reached the code before trusting a clean result.
  assert.ok(files.length > 500, `sweep found only ${files.length} files — it did not reach the source tree`);
  const importerPath = path.join(REPO_ROOT, "src/lib/sales/monthly-distributor-import.ts");
  assert.ok(files.includes(importerPath), "sweep must include the distributor importer");

  // POSITIVE CONTROL — and prove the matcher itself still fires, so a clean sweep means "no factor"
  // rather than "no working regex".
  const probe = stripCommentsAndStrings("const v = qty * (1 - discount) * price;");
  assert.ok(
    FACTOR_PATTERNS.some((pattern) => pattern.re.test(probe)),
    "the factor patterns must match the rule they exist to forbid",
  );
  // The regex-literal spelling too, written exactly as a pinning test would write it.
  const escapedProbe = String.raw`const RE = /r\.qty\s*\*\s*\(1\s*-\s*coalesce\(r\.discount,\s*0\)\)/i;`;
  assert.ok(
    FACTOR_PATTERNS.some((pattern) => pattern.re.test(stripCommentsAndStrings(escapedProbe))),
    "the sweep must also catch a regex literal that pins the old formula",
  );
  // NEGATIVE CONTROL — the same text as prose must NOT fire, or every explanatory comment in the
  // repo becomes a failure and the guard gets deleted rather than obeyed.
  const prose = stripCommentsAndStrings("// this was qty * (1 - discount) until 2026-09-07\nconst v = qty * price;");
  assert.ok(
    !FACTOR_PATTERNS.some((pattern) => pattern.re.test(prose)),
    "a comment describing the removed rule must not trip the sweep",
  );

  const offenders: string[] = [];
  for (const file of files) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    if (ALLOWED_FILES.has(relative)) continue;
    const raw = readFileSync(file, "utf8");
    const rawLines = raw.split("\n");
    const code = stripCommentsAndStrings(raw);
    const lines = code.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      // A test that pins the factor's ABSENCE has to spell it out, and reads to this sweep exactly
      // like a test that pins its presence. One explicit, greppable marker on that line is the
      // escape hatch — visible in review, and never reachable from a comment the sweep has already
      // stripped, because it is read off the ORIGINAL line.
      if (rawLines[index]?.includes(ALLOW_MARKER)) continue;
      for (const pattern of FACTOR_PATTERNS) {
        if (pattern.re.test(lines[index])) {
          offenders.push(`${relative}:${index + 1}  [${pattern.label}]  ${lines[index].trim()}`);
          break;
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "UNITS ARE UNITS: a discount factor is back in live code. A distributor row is worth qty x factory " +
      "price — the discount column is carried and displayed, never applied. Offenders:\n" +
      offenders.join("\n"),
  );

  // Only this file may sit on the list. A live file added back would silently permit the factor at
  // that path for ever, which is exactly the dead weight the old approval-fields.ts entry became.
  assert.deepEqual(
    [...ALLOWED_FILES],
    ["tests/units-are-units-no-discount-factor.test.ts"],
    "no live file is exempt from UNITS ARE UNITS — a deal discount belongs in priceBasketLine, not a new allow-list entry",
  );

  console.log("units-are-units-no-discount-factor: ok");
}
