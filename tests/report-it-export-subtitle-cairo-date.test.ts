import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cairoDate } from "../src/lib/format/cairo-datetime.ts";

// Both report-it dashboards used to build the XLSX export's "Exported" subtitle with a bare
// `new Date().toLocaleDateString()` — no locale, no timeZone, so it rendered in whichever zone the
// RUNTIME defaulted to: UTC on the server (Railway) at render time, the browser's own zone at click
// time (the Cairo boundary-crossing math is verified live in this file's own test: on Windows,
// `TZ=UTC node -e "new Date('2026-01-15T22:30:00Z').toLocaleDateString()"` prints "1/15/2026" while
// `TZ=Africa/Cairo` prints "1/16/2026" for the identical instant). Unlike admin-profile-form.tsx's
// React error #418, this specific prop is only read inside ExportXlsxButton's click handler — never
// rendered to the DOM — so it cannot cause a hydration mismatch (confirmed against
// `public.app_error_events`: zero events for /employee-portals/report-it or /admin/report-it in the
// 30-day window that carried dozens of #418s on other routes). It is still the same missing-timeZone
// defect class, just one whose failure mode is a wrong date in the downloaded file rather than a
// thrown error. The fix routes it through the shared `cairoDate()` helper, which pins
// `timeZone: "Africa/Cairo"` explicitly.
const REPORT_IT_DASHBOARD_PATHS = [
  "../src/components/report-it/report-it-employee-dashboard.tsx",
  "../src/components/report-it/report-it-admin-dashboard.tsx",
].map((relative) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), relative));

export function runReportItExportSubtitleCairoDateTests() {
  // Same instants tests/admin-profile-created-at-hydration-safe.test.ts pins for cairoDateTime,
  // minus the time-of-day half — straddling the Cairo day boundary in both EEST (summer, UTC+3)
  // and EET (winter, UTC+2), so a formatter that quietly fell back to the process's own zone would
  // not reproduce these exact strings.
  assert.equal(
    cairoDate("2026-09-01T19:50:53.413814+00:00"),
    "01 Sept 2026",
    "07:50 PM UTC on 1 Sep is already 10:50 PM in Cairo (EEST, UTC+3) — same calendar day here, but must still read from the Cairo clock, not the host's",
  );
  assert.equal(
    cairoDate("2026-07-24T20:59:00Z"),
    "24 Jul 2026",
    "20:59 UTC (EEST) is still the 24th in Cairo",
  );
  assert.equal(
    cairoDate("2026-07-24T21:00:00Z"),
    "25 Jul 2026",
    "21:00 UTC (EEST) has already rolled to the 25th in Cairo — the exact minute a naive UTC render would still call the 24th",
  );
  assert.equal(
    cairoDate("2026-01-15T21:59:00Z"),
    "15 Jan 2026",
    "21:59 UTC (EET, winter) is still the 15th in Cairo",
  );
  assert.equal(
    cairoDate("2026-01-15T22:00:00Z"),
    "16 Jan 2026",
    "22:00 UTC (EET, winter) has already rolled to the 16th in Cairo",
  );

  // No instant renders a dash, not a guessed "today" — matching cairoDateTime's own contract.
  assert.equal(cairoDate(null), "—", "no instant renders a dash, not a computed fallback");
  assert.equal(cairoDate("not-a-date"), "—", "an unparseable value renders a dash, never 'Invalid Date' text");

  // The dashboards themselves must actually be wired to the shared, zone-pinned helper — not merely
  // "some formatter that happens to produce the right string in this test file". A regression that
  // reverts either dashboard to a bespoke `new Date().toLocaleDateString()` would still pass the
  // assertions above (they exercise cairoDate directly) while silently reintroducing a
  // runtime-zone-dependent export date, so pin the wiring itself.
  for (const dashboardPath of REPORT_IT_DASHBOARD_PATHS) {
    const source = fs.readFileSync(dashboardPath, "utf8");
    const fileName = path.basename(dashboardPath);
    assert.match(
      source,
      /import\s*\{[^}]*\bcairoDate\b[^}]*\}\s*from\s*["']@\/lib\/format\/cairo-datetime["']/,
      `${fileName} must import the shared, zone-pinned cairoDate helper`,
    );
    assert.match(
      source,
      /subtitle=\{`Exported \$\{cairoDate\(new Date\(\)\.toISOString\(\)\)\}`\}/,
      `${fileName}'s export subtitle must be built from cairoDate(new Date().toISOString()), not a bespoke ` +
        `formatter — a bare new Date().toLocaleDateString() with no timeZone is exactly what depended on the ` +
        `runtime's own zone`,
    );
  }
}
