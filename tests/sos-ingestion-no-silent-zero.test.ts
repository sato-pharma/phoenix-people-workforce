import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A cell the parser cannot read must never become a zero.
//
// engine.ts wrote `qty: Number.isFinite(qty) ? qty : 0` and the same for value, on the raw-import
// path that carries 99.6% of production rows. So "1,2OO" (letter O), an Arabic-Indic numeral, "n/a"
// or a European "1.234,56" all silently became 0 — the sale vanished from every total with nothing
// to review. discountFrac then clamped out-of-range values into [0,1], so a "150" typo became a
// 100% discount that zeroed the row, AND upload-validation's discount_out_of_range check could
// never fire because nothing out-of-range survived the clamp.
//
// parser.ts had two more: the batch period fell back to `new Date()` (the server's UTC clock, so a
// sheet stating no period was filed under the UPLOAD month — or the month before it, just after
// midnight Cairo on the 1st), and duplicateHash covered only the headers, first five rows and row
// count.

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const read = (p: string) => code(readFileSync(join(process.cwd(), p), "utf8"));

export function runSosIngestionNoSilentZeroTests() {
  const engine = read("src/lib/sales/normalizer/engine.ts");

  // ── An unreadable qty/value/discount raises an exception, not a zero ────────
  assert.match(engine, /const badQty = !Number\.isFinite\(qty\) && nonEmpty\(qtyRaw\)/, "unreadable qty must be detected");
  assert.match(engine, /const badValue = /, "unreadable sheet value must be detected");
  assert.match(engine, /const badDiscount = /, "unreadable/out-of-range discount must be detected");
  assert.match(
    engine,
    /reason: badQty \? "unparseable_qty" : badValue \? "unparseable_value" : "discount_out_of_range"/,
    "each bad cell must reach the exceptions list with a specific reason",
  );
  assert.match(
    engine,
    /if \(badQty \|\| badValue \|\| badDiscount\) \{[\s\S]{0,600}continue;/,
    "a row with an unreadable cell must be skipped into exceptions, never emitted as a coded row",
  );

  // An EMPTY cell still legitimately means zero — parseNum returns NaN for empty too, so the
  // non-empty check is what keeps this from rejecting every blank quantity.
  assert.match(
    engine,
    /const nonEmpty = \(raw: unknown\) => String\(raw \?\? ""\)\.trim\(\) !== "";/,
    "only a NON-EMPTY unreadable cell is an error; a blank quantity is a real zero",
  );

  // ── discountFrac rejects rather than clamps ────────────────────────────────
  {
    const fn = engine.slice(engine.indexOf("function discountFrac"), engine.indexOf("function discountFrac") + 900);
    assert.ok(
      !/Math\.min\(1, Math\.max\(0, fraction\)\)/.test(fn),
      "the silent clamp must stay gone — it turned a '150' typo into a row-zeroing 100% discount",
    );
    assert.match(fn, /if \(fraction < 0 \|\| fraction >= 1\) return Number\.NaN;/, "out-of-range must return NaN");
    assert.match(fn, /if \(!Number\.isFinite\(n\)\) return Number\.NaN;/, "an unreadable discount must return NaN");
    assert.match(fn, /if \(!text\) return 0;/, "an EMPTY discount cell still means no discount");
  }

  // ── The period is never guessed from the server clock ──────────────────────
  {
    const parser = read("src/lib/sales/parser.ts");
    assert.ok(
      !/new Date\(\)\.getMonth\(\) \+ 1/.test(parser),
      "the upload-date period fallback must stay gone — it filed sales under the wrong month",
    );
    assert.ok(!/new Date\(\)\.getFullYear\(\)/.test(parser), "same for the year fallback");
    assert.match(parser, /"missing_period"/, "a sheet with no period must be refused, not guessed at");

    // ── duplicateHash must cover every row ───────────────────────────────────
    assert.ok(
      !/sample: rows\.slice\(0, 5\)/.test(parser),
      "hashing only the first five rows let a corrected workbook look identical and a true duplicate slip through",
    );
    assert.match(
      parser,
      /for \(const row of rows\) hash\.update\(JSON\.stringify\(row\)\);/,
      "every row must contribute to the fingerprint",
    );
  }

  // ── The new reasons are part of the contract ───────────────────────────────
  {
    const types = read("src/lib/sales/normalizer/types.ts");
    for (const reason of ["unparseable_qty", "unparseable_value", "discount_out_of_range"]) {
      assert.ok(types.includes(`"${reason}"`), `NormalizerException.reason must include ${reason}`);
    }
  }
}
