import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { formatDateOnly } from "../src/lib/date-only.ts";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

const COACHING_DATE_COMPONENTS = [
  // These two are thin next/dynamic wrappers (see performance follow-up); the real
  // implementation — and the date-only formatting this test guards — lives in the
  // sibling "-impl.tsx" file.
  "src/components/coaching/employee-coaching-list-impl.tsx",
  "src/components/coaching/employee-coaching-review-impl.tsx",
  "src/components/coaching/coaching-report-detail.tsx",
  "src/components/coaching/coaching-reports-center.tsx",
  "src/components/coaching/coaching-analytics-dashboard.tsx",
];

/**
 * Coaching date-only displays must go through the shared formatDateOnly helper,
 * which parses AND formats in the same (local) timezone. The previous inline
 * code parsed local midnight but formatted with timeZone: "UTC", so a literal
 * date shifted back a day on non-UTC clients (Cairo browsers showed the prior
 * day). This pins the fix and guards against the pattern creeping back.
 */
export async function runCoachingDateFormattingTests() {
  // Behavioural pin: the shared helper preserves the literal date-only day.
  const formatted = formatDateOnly(
    "2026-07-15",
    "en-US",
    { day: "2-digit", month: "short", year: "numeric" },
    "-",
  );
  assert.match(formatted, /\b15\b/, "formatDateOnly keeps the literal day (15), not an off-by-one shift");
  assert.match(formatted, /2026/, "formatDateOnly keeps the year");

  for (const path of COACHING_DATE_COMPONENTS) {
    const src = source(path);
    assert.match(src, /formatDateOnly/, `${path} routes date-only formatting through the shared helper`);
    // Guard against the old parse-local / format-UTC off-by-one pattern returning.
    assert.doesNotMatch(
      src,
      /new Date\(`\$\{[^}]*\.slice\(0, 10\)\}T00:00:00`\)/,
      `${path} must not hand-parse date-only strings (off-by-one risk)`,
    );
  }
}
