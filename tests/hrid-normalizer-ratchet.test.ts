import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// One canonical HR_ID normaliser, src/lib/hr-id.ts. Everything else should call
// it. This ratchet pins how many functions still DON'T — so the number can only
// fall, never rise.
//
// THE ANTI-PATTERN
// An HR_ID has one true shape (trim -> fold the legacy `aaa`->`aa` alias ->
// uppercase), and canonicalHrIdForDisplay is the one place that shape lives. A
// function that instead writes `String(value).trim().toUpperCase()` inline is a
// second, subtly-different copy of that rule: it does NOT fold the alias, so it
// files a new-hire's `AAA` order under a row a canonical reader will look up as
// `AA`. Every such copy is a place the rule can drift. A4 (this PR) folded the
// two normalisers that were safe to fold; the rest are pinned here to be folded
// over time, and — the point of the ratchet — so no NEW copy is ever added.
//
// WHAT COUNTS (a member of the baseline set)
// A function whose NAME pairs a normalise/clean/canonical verb with "HrId", whose
// own body performs an inline case/space normalisation (`.trim()`,
// `.toUpperCase()`, or `.toLowerCase()`), and which does NOT reference any symbol
// exported by src/lib/hr-id.ts. Those three facts together mean: it is an HR_ID
// normaliser, it reimplements the shape by hand, and it does not delegate.
//
// WHAT IS NOT A VIOLATION
//   - A DELEGATOR. `return canonicalHrIdForDisplay(value) ?? ""` references the
//     canonical source; it is the fix, not the defect.
//   - A TRANSITIVE delegator. `return normalizeAttendanceHrId(value)` has no
//     inline op of its own — it forwards to a function that (after A4) delegates
//     to canon. It is already correct and there is nothing to fold. The first
//     census counted these as violations and read 24 where the truth was 21;
//     `device-user-mapping.ts` and `fingerprint-report.ts` are exactly this
//     shape, and `contracts/service.ts`'s canonicalContractHrId forwards to a
//     local cleanHrId that delegates. The self-checks below pin this so it cannot
//     come back.
//   - A function outside the name pattern. `normalizeEmail`, `cleanText` and the
//     like are not HR_ID normalisers and are out of scope.
//
// ONE MEMBER OF THE BASELINE IS DELIBERATELY UNFOLDABLE
// src/lib/imports/employee-normalizers.ts `normalizeHrId` MUST stay inline. It
// uppercases WITHOUT folding the alias on purpose: the employee-import upsert has
// onConflict:"hr_id", so folding `AAA`->`AA` at import time would collapse a
// genuinely new employee onto an existing `AA` row. tests/
// employee-import-hrid-alias-resolution.test.ts pins that. It is counted here
// (it IS an inline normaliser) but it is not expected to ever leave the set — so
// the baseline floor for folding is 20, not 0.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counted 2026-08-29 in the worktree that landed A4 (the two folds in
 * attendance/metrics.ts and notifications/recipients.ts). Before A4 it was 23:
 * these 21 plus those two, which now delegate to canonicalHrIdForDisplay.
 *
 * The plan's estimate was 12. That audit used a narrower name pattern
 * (`normalize*HrId` only) and so never saw the nine `cleanHrId` copies, nor
 * canonicalContractHrId / normalizeIdentityHrId / normalizeMetricHrId /
 * normalizedPushHrId. This detector counts the `clean` and `canonical` verbs too,
 * which is the same anti-pattern under other names. 21 is the measured truth; the
 * estimate was an undercount, not a target.
 *
 * Lower this when a copy is genuinely folded onto canon; never raise it to turn a
 * red run green — a rise means a new hand-rolled HR_ID normaliser was added.
 */
const BASELINE = 21;

const ROOTS = ["app", "src"];

/** Symbols exported by src/lib/hr-id.ts. A body naming any of these delegates. */
const CANON = [
  "canonicalHrIdKey",
  "canonicalHrIdForDisplay",
  "normalizeHrIdForAccess",
  "hrIdsMatch",
  "hrIdLookupKeys",
  "resolveStoredHrId",
  "formatHrIdForDisplay",
];

/** A normalise/clean/canonical verb bound to "HrId" — the name of an HR_ID normaliser. */
const NAME = "(?:normali[sz]e|normalized|clean|canonical|toCanonical)[A-Za-z0-9_]*[Hh]r[Ii]d[A-Za-z0-9_]*";

/** A definition of such a function: `function NAME(` or `const NAME = (`/`= async (`. */
const DEF_RE = new RegExp(
  `(?:export\\s+)?(?:async\\s+)?function\\s+(${NAME})\\s*\\(` +
    `|(?:export\\s+)?const\\s+(${NAME})\\s*=\\s*(?:async\\s*)?\\(`,
  "g",
);

/** An inline case/space normalisation performed in the function's own body. */
const INLINE_NORM = /\.trim\(\)|\.toUpperCase\(\)|\.toLowerCase\(\)/;

/**
 * Blank comments before measuring, so a sentence describing the anti-pattern is
 * never counted as one. Newlines survive, so every file:line stays accurate. The
 * `[^:]` guard stops `https://…` reading as a line comment.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Extract a function's body given the index just past the `(` that opens its
 * parameter list. Balances the params first (so a nested `)` in a default value
 * cannot fool it), then takes the brace-balanced block, or — for an
 * expression-bodied arrow — a bounded window of the expression. Quote-aware so a
 * brace or paren inside a string literal never mis-counts depth. A bounded window
 * matters: an unbalanced read that bled into the NEXT function would let a
 * neighbour's `canonicalHrIdForDisplay` mask an inline copy, or vice-versa.
 */
function bodyAfterParamsOpen(source: string, paramsOpenIndex: number): string {
  let i = paramsOpenIndex;
  let depth = 1; // we start just inside the params "("
  let quote: string | null = null;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  const rest = source.slice(i, i + 2000);
  const brace = rest.indexOf("{");
  const arrow = rest.indexOf("=>");
  if (arrow !== -1 && (brace === -1 || arrow < brace)) {
    // Expression-bodied arrow: a bounded window of the expression is enough to
    // test for token presence.
    return rest.slice(arrow + 2, arrow + 2 + 400);
  }
  if (brace === -1) return rest.slice(0, 400);
  let d = 0;
  let q: string | null = null;
  for (let j = brace; j < rest.length; j += 1) {
    const ch = rest[j];
    if (q) {
      if (ch === "\\") {
        j += 1;
        continue;
      }
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      q = ch;
      continue;
    }
    if (ch === "{") d += 1;
    else if (ch === "}") {
      d -= 1;
      if (d === 0) return rest.slice(brace, j + 1);
    }
  }
  return rest.slice(brace);
}

type Member = { site: string; name: string; delegates: boolean; inline: boolean };

/**
 * Every HR_ID-normaliser definition in one file, classified. `isCanonSource`
 * excludes src/lib/hr-id.ts itself — those functions ARE the canonical shape,
 * not a copy of it.
 */
function scan(label: string, rawSource: string, isCanonSource = false): Member[] {
  if (isCanonSource) return [];
  const source = stripComments(rawSource);
  const members: Member[] = [];
  DEF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DEF_RE.exec(source))) {
    const name = match[1] ?? match[2];
    const body = bodyAfterParamsOpen(source, match.index + match[0].length);
    members.push({
      site: `${label}:${source.slice(0, match.index).split("\n").length}`,
      name,
      delegates: CANON.some((c) => body.includes(c)),
      inline: INLINE_NORM.test(body),
    });
  }
  return members;
}

/** A member of the baseline set: an inline normaliser that does not delegate. */
function isBaselineViolation(m: Member): boolean {
  return m.inline && !m.delegates;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

export function runHrIdNormalizerRatchetTests() {
  // ───────────────────────────────────────────────────────────────────────────
  // Prove the classifier discriminates BEFORE trusting it across ~2,900 files. A
  // ratchet whose detector is wrong reports a number, and a wrong number looks
  // exactly as authoritative as a right one. Two of these cases (the transitive
  // delegator, the helper-wrapped uppercase) are here because the first census
  // got them wrong and read 24 where the truth is 21.
  // ───────────────────────────────────────────────────────────────────────────
  const one = (snippet: string): Member => {
    const m = scan("probe.ts", snippet);
    assert.equal(m.length, 1, `probe should define exactly one normaliser, got ${m.length}: ${snippet}`);
    return m[0]!;
  };

  // Inline, no delegation — the violation this whole file counts.
  assert.equal(
    isBaselineViolation(one('function normalizeHrId(value: string | null) { return String(value ?? "").trim().toUpperCase(); }')),
    true,
    "a hand-rolled trim().toUpperCase() is the anti-pattern",
  );
  // The same rule via a local helper still uppercases inline — still counted.
  assert.equal(
    isBaselineViolation(one("function cleanHrId(value: string | null) { return cleanText(value).toUpperCase(); }")),
    true,
    "a helper-wrapped .toUpperCase() is still an inline copy of the shape",
  );
  // The lowercase-key variant is the same defect wearing a different case.
  assert.equal(
    isBaselineViolation(one("function normalizeHrIdKey(value: string) { return value.trim().toLowerCase(); }")),
    true,
    "a lowercase key is still an inline HR_ID normalisation",
  );
  // A DIRECT delegator is the fix, not the defect.
  assert.equal(
    isBaselineViolation(one('function normalizeHrId(value: string | null) { return canonicalHrIdForDisplay(value) ?? ""; }')),
    false,
    "referencing the canonical source is delegation, not a violation",
  );
  // A delegator that ALSO keeps an inline fallback still delegates — excluded.
  assert.equal(
    isBaselineViolation(one('function normalizeHrId(value: string | null) { return canonicalHrIdForDisplay(value) ?? value?.toUpperCase() ?? ""; }')),
    false,
    "a canon reference wins even when an inline fallback is present — belt-and-suspenders is not the anti-pattern",
  );
  // A TRANSITIVE delegator forwards to a domain normaliser and has no inline op.
  // This is the exact shape (device-user-mapping, fingerprint-report) that the
  // 24-count wrongly flagged.
  assert.equal(
    isBaselineViolation(one("function normalizeHrId(value: string | null) { return normalizeAttendanceHrId(value); }")),
    false,
    "a forward to a delegating domain normaliser has no inline op — it is already correct and unfoldable",
  );
  // An expression-bodied arrow delegator must also read as delegating.
  assert.equal(
    isBaselineViolation(one('const normalizeHrId = (value: string | null) => canonicalHrIdForDisplay(value) ?? "";')),
    false,
    "an arrow delegator is a delegator — body extraction must handle the expression form",
  );
  // A comment naming the anti-pattern is documentation, not code.
  assert.equal(
    scan("probe.ts", "// normalizeHrId should never String(value).trim().toUpperCase() by hand\nconst x = 1;").length,
    0,
    "a comment describing the rule is not a definition of a normaliser",
  );
  // The name pattern is the scope boundary: a non-HrId normaliser is out of scope.
  assert.equal(
    scan("probe.ts", 'function normalizeEmail(value: string) { return value.trim().toLowerCase(); }').length,
    0,
    "normalizeEmail is not an HR_ID normaliser and must not enter the population",
  );
  // Line numbers survive stripping, or every site printed below is shifted.
  assert.equal(
    scan("probe.ts", '/*\n * a note\n */\nfunction cleanHrId(v: string) { return String(v).trim().toUpperCase(); }')[0]?.site,
    "probe.ts:4",
    "stripping must preserve line numbers, or every reported site is wrong",
  );

  // ───────────────────────────────────────────────────────────────────────────

  const files = ROOTS.flatMap((r) => walk(r));
  assert.ok(
    files.length > 1000,
    `only ${files.length} source files were scanned — the walk is not reaching the tree, so any count it reports is meaningless`,
  );

  const population: Member[] = [];
  for (const file of files) {
    const rel = file.replace(/\\/g, "/");
    population.push(...scan(rel, readFileSync(file, "utf8"), rel.endsWith("src/lib/hr-id.ts")));
  }

  // Anti-vacuity: the population is dozens of functions and a good share delegate.
  // If either collapses, the detector has stopped matching and a count of zero
  // violations would be meaningless.
  assert.ok(
    population.length >= 30,
    `only ${population.length} HR_ID normaliser definitions were found (expected ~43) — the name pattern or body reader has stopped matching, so the ratchet count is meaningless`,
  );
  const delegating = population.filter((m) => m.delegates).length;
  assert.ok(
    delegating >= 10,
    `only ${delegating} delegating normalisers were found (expected ~19) — the canon-reference detector has stopped matching, so it can no longer tell a delegator from a copy`,
  );

  const violations = population.filter(isBaselineViolation);
  const sites = violations.map((m) => `${m.site}  ${m.name}`).sort();

  // The ratchet, both arms.
  assert.ok(
    violations.length <= BASELINE,
    `${violations.length - BASELINE} new hand-rolled HR_ID normaliser(s) were added — the count went ${BASELINE} -> ${violations.length}.\n` +
      `Call canonicalHrIdForDisplay from @/lib/hr-id instead of writing String(value).trim().toUpperCase() by hand.\n` +
      `Inline normalisers now present:\n  ${sites.join("\n  ")}`,
  );
  assert.ok(
    violations.length >= BASELINE,
    `Good news: hand-rolled HR_ID normalisers dropped ${BASELINE} -> ${violations.length}. Lower BASELINE in this file to ` +
      `${violations.length} so the ground that was won cannot be given back.\n` +
      `(Floor is 20: employee-normalizers.ts normalizeHrId is deliberately unfoldable — see the header.)\n` +
      `Inline normalisers now present:\n  ${sites.join("\n  ")}`,
  );
}
