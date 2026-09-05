import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cairoDateTime } from "../src/lib/format/cairo-datetime.ts";

// admin-profile-form.tsx used to build "Account created" with a bare
// `new Intl.DateTimeFormat("en-US", {...}).format(new Date(profile.createdAt))` — no `timeZone`,
// so it rendered in whichever zone the RUNTIME defaulted to: UTC on the server (Railway), Cairo
// (or whatever the visitor's OS/browser is set to) on the client. React saw two different text
// nodes for the same instant during hydration and threw error #418 on every profile view for an
// account with a real `created_at` (confirmed live: 13 production events, most recently
// 2026-09-04). The fix routes it through the shared `cairoDateTime()` helper, which pins
// `timeZone: "Africa/Cairo"` explicitly so the formatted string is identical no matter what zone
// the process (or the reader's clock) happens to be in.
const ADMIN_PROFILE_FORM_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/components/admin/admin-profile-form.tsx",
);

export function runAdminProfileCreatedAtHydrationSafeTests() {
  // Same instant, straddling both directions of the Cairo day boundary that
  // tests/i18n-cairo-date-boundary.test.ts already pins for currentCairoDateOnlyIso — Cairo runs
  // UTC+3 (EEST) roughly late April-late October, UTC+2 (EET) otherwise. A formatter that quietly
  // fell back to the process's own zone (UTC in CI, something else on a dev machine) would not
  // reproduce these exact strings, which is exactly the failure mode this pins shut.
  assert.equal(
    cairoDateTime("2026-09-01T19:50:53.413814+00:00"),
    "01 Sept 2026 · 22:50",
    "07:50 PM UTC on 1 Sep is 10:50 PM in Cairo (EEST, UTC+3) — must read the same everywhere, not just on a UTC host",
  );
  assert.equal(
    cairoDateTime("2026-07-24T20:59:00Z"),
    "24 Jul 2026 · 23:59",
    "20:59 UTC (EEST) is still 23:59 on the 24th in Cairo",
  );
  assert.equal(
    cairoDateTime("2026-07-24T21:00:00Z"),
    "25 Jul 2026 · 00:00",
    "21:00 UTC (EEST) has already rolled to the 25th in Cairo — the exact minute a naive UTC render would still call the 24th",
  );
  assert.equal(
    cairoDateTime("2026-01-15T21:59:00Z"),
    "15 Jan 2026 · 23:59",
    "21:59 UTC (EET, winter) is still the 15th in Cairo",
  );
  assert.equal(
    cairoDateTime("2026-01-15T22:00:00Z"),
    "16 Jan 2026 · 00:00",
    "22:00 UTC (EET, winter) has already rolled to the 16th in Cairo",
  );

  // Null/unparseable createdAt degrades to an em dash on both sides of hydration, never to a
  // guessed "now" that would itself vary between server render and client hydrate.
  assert.equal(cairoDateTime(null), "—", "no createdAt renders a dash, not a computed fallback");
  assert.equal(cairoDateTime("not-a-date"), "—", "an unparseable value renders a dash, never 'Invalid Date' text");

  // The component itself must actually be wired to the safe, zone-pinned helper — not merely
  // "some formatter that happens to produce the right string in this test file". A regression
  // that reverts admin-profile-form.tsx to a bespoke, unpinned `Intl.DateTimeFormat` call would
  // still pass the assertions above (they exercise cairoDateTime directly) while silently
  // reintroducing #418 in the browser, so pin the wiring itself.
  const source = fs.readFileSync(ADMIN_PROFILE_FORM_PATH, "utf8");
  assert.match(
    source,
    /import\s*\{[^}]*\bcairoDateTime\b[^}]*\}\s*from\s*["']@\/lib\/format\/cairo-datetime["']/,
    "admin-profile-form.tsx must import the shared, zone-pinned cairoDateTime helper",
  );
  assert.match(
    source,
    /formattedCreatedAt\s*=\s*cairoDateTime\(profile\.createdAt\)/,
    "the 'Account created' field must be built from cairoDateTime(profile.createdAt), not a bespoke formatter — a bare Intl.DateTimeFormat with no timeZone is exactly what rendered UTC on the server and Cairo on the client and threw hydration error #418",
  );
}
