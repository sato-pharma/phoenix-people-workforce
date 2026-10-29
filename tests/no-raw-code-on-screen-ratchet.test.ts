import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// AGENTS.md §4 and docs/tables-said-once-fit.md rule 4: names, never codes or ids, on every screen.
// Four spellings put a stored value or a filler word in front of a person; this counts each in the .tsx
// that draws screens. A count may FALL as a screen is fixed and may never RISE.
//
//   underscoreReplace  `.replace(/_/g, " ")` on a value people read — prints "pending manager" and
//                      "ceo approved". A domain label function, `humanizeCode` or `codeOrWords`
//                      (@/lib/format/code-label) is the answer.
//   naFiller           the literal "N/A" — a "—" in a table cell, left out of a card.
//   noHrId             the literal "No HR ID" — an id is never on screen beside or instead of a name.
//   hrIdFallback       `hrId ||` — falling back to the HR id when a name is missing prints "B-10".
//
// Comments are stripped first (tests/support/comment-strip.ts), so prose naming the rule never counts.
// Not scanned: src/lib (builds data, exports and emails with their own rules), tests, mobile.
// ─────────────────────────────────────────────────────────────────────────────

const BASELINE = { hrIdFallback: 21, naFiller: 24, noHrId: 4, underscoreReplace: 28 };

const ROOTS = ["app", "src/components"];

const PATTERNS: Readonly<Record<keyof typeof BASELINE, RegExp>> = {
  hrIdFallback: /\bhrId\s*\|\|/,
  naFiller: /(["'`])N\/A\1/,
  noHrId: /No HR ID/,
  underscoreReplace: /\.replace\(\s*\/_\/g/,
};

const ADVICE: Readonly<Record<keyof typeof BASELINE, string>> = {
  hrIdFallback: "never fall back to the HR id on screen: show the name, and tell namesakes apart by job title or line",
  naFiller: 'a "—" in a table cell, left out of a card',
  noHrId: "an HR id is never on screen beside or instead of a name",
  underscoreReplace: "use the domain's label function, else humanizeCode / codeOrWords from @/lib/format/code-label",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      walk(full, out);
    } else if (/\.tsx$/.test(entry)) {
      out.push(full.replace(/\\/g, "/"));
    }
  }
  return out;
}

export function runNoRawCodeOnScreenRatchetTests() {
  const countIn = (snippet: string, key: keyof typeof BASELINE) =>
    stripComments(snippet).split("\n").filter((line) => PATTERNS[key].test(line)).length;

  // Detector controls.
  assert.equal(countIn('{status.replace(/_/g, " ")}', "underscoreReplace"), 1, "a replace on underscores is seen");
  assert.equal(countIn('{String(x ?? "").replace(/_/g, " ")}', "underscoreReplace"), 1, "a replace on a wrapped value is seen");
  assert.equal(countIn('{humanizeCode(status)}', "underscoreReplace"), 0, "the label function is the way");
  assert.equal(countIn('// status.replace(/_/g, " ")', "underscoreReplace"), 0, "a comment is prose");
  assert.equal(countIn('<td>{value ?? "N/A"}</td>', "naFiller"), 1, 'the "N/A" filler is seen');
  assert.equal(countIn("<td>{value ?? 'N/A'}</td>", "naFiller"), 1, "a single-quoted N/A is seen");
  assert.equal(countIn('<td>{value ?? "—"}</td>', "naFiller"), 0, "the dash is the way");
  assert.equal(countIn('"No HR ID"', "noHrId"), 1);
  assert.equal(countIn("{row.name || row.hrId}", "hrIdFallback"), 0, "only an hrId on the LEFT of || is the fallback shape");
  assert.equal(countIn("{row.hrId || row.name}", "hrIdFallback"), 1, "the id-first fallback is seen");

  const files = ROOTS.flatMap((root) => walk(root));
  assert.ok(files.length > 800, `only ${files.length} .tsx files were scanned — the walk is not reaching the tree`);

  const sites: Record<keyof typeof BASELINE, string[]> = { hrIdFallback: [], naFiller: [], noHrId: [], underscoreReplace: [] };
  for (const file of files) {
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      for (const key of Object.keys(PATTERNS) as Array<keyof typeof BASELINE>) {
        if (PATTERNS[key].test(line)) sites[key].push(`${file}:${index + 1}`);
      }
    });
  }

  for (const key of Object.keys(BASELINE) as Array<keyof typeof BASELINE>) {
    const count = sites[key].length;
    assert.ok(
      count <= BASELINE[key],
      `names, never codes — "${key}": ${count - BASELINE[key]} new site(s), the count went ${BASELINE[key]} -> ${count}.\n` +
        `${ADVICE[key]} (docs/tables-said-once-fit.md rule 4).\nLatest sites:\n  ${sites[key].slice(-12).join("\n  ")}`,
    );
    if (count < BASELINE[key]) {
      console.warn(`Good news: "${key}" dropped ${BASELINE[key]} -> ${count}. Lower BASELINE.${key} in tests/no-raw-code-on-screen-ratchet.test.ts to ${count}.`);
    }
  }
}
