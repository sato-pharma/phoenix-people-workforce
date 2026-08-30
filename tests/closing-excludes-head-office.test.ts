import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isHeadOfficeLine } from "../src/lib/sales/access-scope.ts";
import { pickPortalClosingLine } from "../src/lib/sales/monthly-closing-portal.ts";
import { selectClosingLines } from "../src/lib/sales/monthly-distributor-import.ts";

// Head Office must not be offerable as a Monthly Closing (owner decision, 2026-08-05).
//
// WHY: the closing excludes the confidential products LA003 / LA004 / SS001 by construction, and on
// Head Office those products are essentially the whole line. Measured on production for 2026-07 the
// closing showed 546.00 EGP against a line holding 50,965,312.08, with zero targets. A sheet
// reporting 0.001% of a line is a misleading document, not a rounding problem.
//
// The exclusion lives in ONE place — listMonthlyClosingLines — because every surface (admin page,
// /api/sales/monthly-closing, the export route, the details route) takes its line list from there,
// and loadMonthlyClosing only accepts a line that appears in it. That is what makes Head Office
// unreachable rather than merely hidden.
//
// The one caller that must NOT lose it is the scheduled report check, which asks a different
// question — "is every active line published for this period" — and would start firing an email on
// a relaxed condition if its line set quietly shrank.

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Source with comments stripped, so a rule can never be "satisfied" by prose about it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export function runClosingExcludesHeadOfficeTests() {
  // ── The rule itself, EXECUTED ───────────────────────────────────────────────────────────────
  // The exact line values production carries today, including the sentinel and the spellings the
  // source data actually uses.
  const raw = ["Pedia", "CNS", "Anti Infective", "Head Office", "IGNORE", "  ", null, undefined];

  assert.deepEqual(
    selectClosingLines(raw),
    ["Anti Infective", "CNS", "Pedia"],
    "the closing offers the three real sales lines and nothing else — no Head Office, no sentinel, no blanks",
  );
  assert.deepEqual(
    selectClosingLines(raw, { includeHeadOffice: true }),
    ["Anti Infective", "CNS", "Head Office", "Pedia"],
    "the published-everything gate opts Head Office back in — but never the sentinel, which was never a line",
  );
  assert.deepEqual(
    selectClosingLines(["head office", "ignore", "  IGNORE  "], { includeHeadOffice: false }),
    [],
    "both rules are case- and whitespace-insensitive, because the source data is neither",
  );
  assert.deepEqual(
    selectClosingLines(["Pedia", "Pedia", " Pedia "]),
    ["Pedia"],
    "a line repeated across products is offered once",
  );
  assert.deepEqual(selectClosingLines([]), [], "no products means no lines, not a crash");

  // The helper the exclusion rests on still recognises every spelling in the data.
  assert.equal(isHeadOfficeLine("Head Office"), true);
  assert.equal(isHeadOfficeLine("head office"), true, "the check is case-insensitive, as the source data is not consistent");
  assert.equal(isHeadOfficeLine("Pedia"), false);
  assert.equal(isHeadOfficeLine("CNS"), false);
  assert.equal(isHeadOfficeLine("Anti Infective"), false);
  assert.equal(isHeadOfficeLine(null), false, "a null line is not Head Office — it must not be silently excluded");

  const importer = code(read("src/lib/sales/monthly-distributor-import.ts"));

  // The database-backed lister must delegate to the rule above rather than re-implementing it —
  // a second copy is how the picker and the gate would drift apart.
  assert.match(
    importer,
    /return selectClosingLines\(/,
    "listMonthlyClosingLines must route through selectClosingLines, so what is tested is what runs",
  );

  // And the default really is exclusion: the opt-in must be a positive flag, never the fallback.
  assert.ok(
    !/includeHeadOffice\s*[=?]{1,2}\s*true/.test(importer),
    "includeHeadOffice must default to false/undefined, so a caller that says nothing gets the safe answer",
  );

  // A sentinel is not a line for ANY caller — including the published-everything gate, which would
  // otherwise wait forever for "IGNORE" to be published. This is the deliberate asymmetry with
  // Head Office: Head Office IS a real line and stays in that gate; "IGNORE" never was one.
  assert.ok(
    !/includeHeadOffice[^\n]*isNonSalesLine|isNonSalesLine[^\n]*includeHeadOffice/.test(importer),
    "the sentinel filter must not be conditional on the Head Office opt-in — they are separate rules",
  );

  // The scheduled report keeps the whole line set, on purpose.
  const delivery = code(read("src/lib/sales/sos-report-delivery.ts"));
  assert.match(
    delivery,
    /listMonthlyClosingLines\(\{ includeHeadOffice: true \}\)/,
    "the published-everything gate must still count Head Office, or removing it from the closing would relax when a scheduled email fires",
  );

  // Every closing surface takes the default. Naming them keeps a future surface from quietly
  // opting in: a new caller passing includeHeadOffice would have to change this list too.
  for (const path of [
    "app/api/sales/monthly-closing/export/route.ts",
    "app/api/sales/monthly-closing/details/route.ts",
  ]) {
    const source = code(read(path));
    assert.match(source, /listMonthlyClosingLines\(\)/, `${path} must take the default (Head Office excluded)`);
    assert.ok(
      !source.includes("includeHeadOffice"),
      `${path} must never opt Head Office back into a closing surface`,
    );
  }

  // ── THE PORTAL HALF — closed 2026-08-30 ─────────────────────────────────────────────────────
  // Everything above is the ADMIN closing surface, which has excluded Head Office since 2026-08-05.
  // The PORTAL took a different path: resolvePortalClosingScope built allowedLines and stripped
  // Head Office with `|| canViewHeadOfficeLine(access.role)`, so a CEO or Super Admin kept it.
  //
  // The owner closed that: "The head office will not be used in the weekly sales or monthly sales",
  // then "now do the same for the monthly closing line filter".
  //
  // Nothing was lost, because nothing was reachable — the admin side can produce no Head Office
  // closing, and production carried 0 Head Office publications on 2026-08-30 against 1 each for
  // CNS, Pedia and Anti Infective. What WAS reachable is the request: the picker accepts any line
  // in the scope list even with no published period, so `?line=Head Office` resolved rather than
  // being refused for those two roles.

  // 1) With Head Office out of scope, asking for it by name is REFUSED — never quietly swapped for
  //    another line. A silent substitution is the dangerous failure: it serves one line's matrix
  //    under another line's name.
  const askedHeadOffice = pickPortalClosingLine({
    requestedLine: "Head Office",
    allowedLines: ["Anti Infective", "CNS", "Pedia"],
    publishedLines: ["Anti Infective", "CNS", "Pedia"],
  });
  assert.equal(askedHeadOffice.refused, true, "Head Office is out of scope, so asking for it is refused");
  assert.equal(askedHeadOffice.line, null, "a refused line resolves to nothing, never to a substitute");
  assert.ok(
    !askedHeadOffice.availableLines.includes("Head Office"),
    "the portal line picker must not offer Head Office",
  );

  // 2) The same call WOULD have resolved while Head Office sat in scope — so the assertion above is
  //    measuring the scope filter, not merely the absence of a published period.
  assert.equal(
    pickPortalClosingLine({
      requestedLine: "Head Office",
      allowedLines: ["Anti Infective", "CNS", "Head Office", "Pedia"],
      publishedLines: ["Anti Infective", "CNS", "Pedia"],
    }).line,
    "Head Office",
    "with Head Office in scope the picker resolves it even unpublished — which is exactly why the scope filter has to drop it",
  );

  // 3) The scope filter itself carries no role exception any more. Comments are stripped first, so
  //    the prose explaining the old rule can never satisfy the check.
  const portal = code(read("src/lib/sales/monthly-closing-portal.ts"));
  // An exact substring rather than a regex: a regex here would need four escaped brackets and an
  // escaped dot, and a MIS-escaped one still matches something — which is precisely how a source pin
  // becomes a test that only ever passes. This one was written wrong first time and caught itself.
  assert.ok(
    portal.includes(".filter((candidate) => !isHeadOfficeLine(candidate))"),
    "resolvePortalClosingScope must drop Head Office unconditionally",
  );
  assert.ok(
    !portal.includes("canViewHeadOfficeLine"),
    "no role may re-open Head Office as a monthly closing line — not CEO, not Super Admin",
  );
}
