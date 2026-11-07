import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "./support/comment-strip.ts";
import {
  POSTGREST_ROW_CEILING,
  resetRowCapNotes,
  rowCapFinding,
  shouldNoteRowCap,
} from "../src/lib/supabase/row-cap-watch.ts";

// ─────────────────────────────────────────────────────────────────────────────
// No read in this app may stop at 1,000 rows and say nothing.
//
// PostgREST cuts a response at its `max-rows` setting (Supabase default 1,000) with no error and no
// marker. Production's setting is unset today — 105,103 rows came back from one unpaged request on
// 2026-11-07 — so the cap that can still bite is the one the CODE writes for itself: a `.limit(1000)`,
// a `ROW_LIMIT = 1000`, a `maxRows: 1_000`. Those cut a read on an uncapped server too.
//
// Part 1 pins the tripwire that reports a read cut at the server's ceiling (row-cap-watch.ts), driven
// against real header shapes rather than read as source.
// Part 2 is the ratchet: it refuses a new hard 1,000 in `src/` or `app/`. An existing one is allowed
// only when it is written down below with the reason it is not a row cap, keyed by file AND the exact
// trimmed line, so editing an exempt line loses its exemption and sends it back to be judged again.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd();

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const rel = (path: string) => path.slice(ROOT.length + 1).replace(/\\/g, "/");

/** The shapes of a self-imposed 1,000-row ceiling. A page size (`const PAGE = 1000`) is deliberately not one. */
const CEILING_SHAPES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: ".limit(1000)", pattern: /\.limit\(\s*1_?000\s*\)/ },
  { name: ".range(0, 999)", pattern: /\.range\(\s*0\s*,\s*999\s*\)/ },
  { name: "limit: 1000", pattern: /\blimit\s*:\s*1_?000\b/ },
  { name: "maxRows: 1000", pattern: /\bmaxRows\s*:\s*1_?000\b/ },
  { name: "p_limit: 1000", pattern: /\bp_limit\s*:\s*1_?000\b/ },
  // A guard that throws, or flags a result partial, when a read comes back with exactly the ceiling.
  { name: "a row count tested against 1000", pattern: /\.length\s*(?:>=|===?)\s*1_?000\b/ },
  {
    name: "a ROW / LIMIT / CAP / CEILING constant set to 1000",
    pattern: /\b(?:const|let)\s+[A-Za-z_$][\w$]*(?:ROWS?|LIMIT|CAP|CEIL(?:ING)?)[\w$]*\s*(?::\s*number\s*)?=\s*1_?000\b/i,
  },
];

/**
 * Each entry is `file::trimmed line`. A line belongs here only when it is NOT a read that can lose
 * rows silently: say which of these it is.
 *   page   — one page of a walk that continues until a short page proves the end
 *   text   — a length limit on text, a width sample, a batch size on a write, or another non-read number
 *   budget — a deliberate cap that SAYS ALOUD when it cut the data (a `truncated` flag, a visible notice,
 *            a refusal), over a table that is nowhere near it
 *   count  — a threshold on a result that was already read in full, never a limit on the read itself
 */
const EXEMPT: ReadonlyArray<{ key: string; why: string }> = [
  {
    key: "src/components/employee-portal/contact-hr-support-page.tsx::const DESCRIPTION_SOFT_LIMIT = 1000;",
    why: "text: a soft length limit on a support ticket's description",
  },
  {
    key: "src/lib/error-monitor/screen-intake.ts::export const SCREEN_MESSAGE_CAP = 1_000;",
    why: "text: the longest error message kept from a screen report",
  },
  {
    key: "src/lib/phoenix-crm/list-template-rules.ts::export const TEMPLATE_ROWS_MAX = 1000;",
    why: "budget: an uploaded list over this many rows is refused with a message, never half-read",
  },
  {
    key: "src/lib/recruitment/cv-lookup.ts::const CV_HALF_LIMIT = 1000;",
    why: "budget: a search's result window; the result carries `truncated` when it fills, and the page says so",
  },
  {
    key: "src/lib/recruitment/interview-calendar.ts::const NOTE_LIMIT = 1000;",
    why: "text: the longest interview note, in characters",
  },
  {
    key: "src/lib/recruitment/mr-hiring/vocabulary.ts::export const MR_BOOKING_NOTES_LIMIT = 1000;",
    why: "text: the Medical Rep booking's notes for the interviewer, in characters — the calendar's NOTE_LIMIT above",
  },
  {
    key: "src/lib/sales/normalizer/phoenix-template-workbook.ts::export const PHOENIX_TEMPLATE_PREWIRED_ROWS = 1000;",
    why: "text: formula rows pre-wired in a downloadable workbook template, not a read",
  },
  {
    key: "src/lib/sales/sos-mapping-templates.ts::const PRODUCT_SPARE_ROWS = 1000;",
    why: "text: spare rows left in a downloadable mapping template, not a read",
  },
  {
    key: "src/lib/supabase/row-cap-watch.ts::export const POSTGREST_ROW_CEILING = 1000;",
    why: "the number the tripwire watches for and the size of one page in every pager: it is the ceiling, not a read",
  },
  {
    key: "src/lib/weekly-planning/calendar-service.ts::const CALENDAR_HEADER_LIMIT = 1000;",
    why: "budget: the legacy plan table holds 280 rows in all, and the calendar reports `hasMoreHeaders` to the page when it fills",
  },
  {
    key: "src/lib/deductions/connectors/half-day.ts::if (visits.length >= 1000 && gpsTraceTotal === 0) {",
    why: "count: visits were already read in full by a pager; 1,000 is only how dense a month must be before an empty GPS feed counts as a failed read",
  },
];

const exemptKeys = new Set(EXEMPT.map((entry) => entry.key));

export function runRowCapRatchetTests() {
  // ── 1. The tripwire ─────────────────────────────────────────────────────────
  {
    const get = (path: string, extra: Partial<{ method: string; hasRange: boolean }> = {}) => ({
      method: "GET",
      url: `https://abc.supabase.co/rest/v1/${path}`,
      hasRange: false,
      ...extra,
    });

    assert.equal(POSTGREST_ROW_CEILING, 1000, "the ceiling it watches for is PostgREST's own default");

    assert.deepEqual(
      rowCapFinding(get("source_of_sales_customer_map?select=id"), { status: 206, contentRange: "0-999/66109" }),
      { table: "source_of_sales_customer_map", returned: 1000, total: 66109, proven: true },
      "an unranged read the server itself says is partial (206, 1000 of 66,109) is a proven cut",
    );
    assert.deepEqual(
      rowCapFinding(get("rep_rank_standings?select=*"), { status: 200, contentRange: "0-999/*" }),
      { table: "rep_rank_standings", returned: 1000, total: null, proven: false },
      "exactly 1,000 rows with no count is reported, but only as unproven: a table of 1,000 looks the same",
    );

    const quiet = (
      label: string,
      call: ReturnType<typeof get>,
      response: { status: number; contentRange: string | null },
    ) => assert.equal(rowCapFinding(call, response), null, label);

    quiet("a counted read of exactly 1,000 rows is a table that size, not a cut", get("t?select=id"), { status: 200, contentRange: "0-999/1000" });
    quiet("a pager sends a limit, so the page it asked for is never reported", get("t?select=id&order=id&limit=1000"), { status: 200, contentRange: "0-999/*" });
    quiet("an offset walk is a pager too", get("t?select=id&offset=0&limit=1000"), { status: 206, contentRange: "0-999/50000" });
    quiet("a request that carried a Range header chose its own window", get("t?select=id", { hasRange: true }), { status: 206, contentRange: "0-999/50000" });
    quiet("a write is never a capped read", get("t", { method: "POST" }), { status: 200, contentRange: "0-999/*" });
    quiet("a short answer is the whole answer", get("t?select=id"), { status: 200, contentRange: "0-41/*" });
    quiet("a later page does not start at zero", get("t?select=id"), { status: 206, contentRange: "1000-1999/5000" });
    quiet("an answer with no Content-Range says nothing", get("t?select=id"), { status: 200, contentRange: null });
    quiet("an error answer is not a read", get("t?select=id"), { status: 500, contentRange: "0-999/*" });
    quiet("only the data API is watched", { method: "GET", url: "https://abc.supabase.co/auth/v1/admin/users", hasRange: false }, { status: 200, contentRange: "0-999/*" });
    quiet("an unreadable URL is ignored, never thrown", { method: "GET", url: "not a url", hasRange: false }, { status: 200, contentRange: "0-999/*" });

    resetRowCapNotes();
    assert.equal(shouldNoteRowCap("a", 0), true, "the first report of a relation is made");
    assert.equal(shouldNoteRowCap("a", 1_000), false, "a repeat inside ten minutes is held back");
    assert.equal(shouldNoteRowCap("b", 1_000), true, "another relation is reported at once");
    assert.equal(shouldNoteRowCap("a", 10 * 60 * 1000 + 1), true, "after ten minutes the same relation is reported again");
    resetRowCapNotes();
  }

  // ── 2. The ratchet ──────────────────────────────────────────────────────────
  {
    const offenders: string[] = [];
    const seenExempt = new Set<string>();
    let scanned = 0;

    for (const dir of ["src", "app"]) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        scanned += 1;
        // Comments stripped first: several files name the removed ceiling to say why it is gone.
        const code = stripComments(readFileSync(file, "utf8"));
        for (const raw of code.split(/\r?\n/)) {
          const line = raw.trim();
          if (line.length === 0) continue;
          for (const shape of CEILING_SHAPES) {
            if (!shape.pattern.test(line)) continue;
            const key = `${rel(file)}::${line}`;
            if (exemptKeys.has(key)) seenExempt.add(key);
            else offenders.push(`${rel(file)} — ${shape.name}: ${line}`);
          }
        }
      }
    }

    // A ratchet that scanned nothing passes for the wrong reason.
    assert.ok(scanned > 1000, `the ratchet must actually read the source tree (read ${scanned} files)`);

    assert.deepEqual(
      offenders,
      [],
      "a read written with a hard 1,000-row ceiling silently loses every row past it. Page it with fetchAllRows / " +
        "fetchAllRowsKeyset (src/lib/supabase/paginated.ts), or, if the line is not a read, add it to EXEMPT with the reason.",
    );

    const stale = EXEMPT.filter((entry) => !seenExempt.has(entry.key)).map((entry) => entry.key);
    assert.deepEqual(stale, [], "an EXEMPT entry whose line no longer exists is dead weight: delete it");
  }
}
