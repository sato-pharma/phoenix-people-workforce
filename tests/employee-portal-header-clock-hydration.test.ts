import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LAYOUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/components/employee-portal/employee-portal-layout.tsx",
);

// Reproduces the exact expression employee-portal-layout.tsx's header "today" chip used to call
// directly inline during render, unmemoized: `timeZone: "Africa/Cairo"` was already correct, so
// this is NOT the UTC-vs-Cairo bug class (tests/i18n-cairo-date-boundary.test.ts). The hazard is
// render TIMING: React server-renders this component once (computing "now" at the server's render
// instant) and hydrates client-side once more (computing "now" again, independently, moments
// later). Almost every render lands within the same Cairo calendar day and produces identical
// text — but a render that straddles the Cairo midnight boundary does not, and React throws
// hydration error #418 on the two mismatched text nodes.
function formatHeaderDateOldWay(now: Date): string {
  return now.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
}

export function runEmployeePortalHeaderClockHydrationTests() {
  // Cairo is EEST (UTC+3) in September, so Cairo midnight of 6 Sep 2026 is 5 Sep 2026 21:00 UTC.
  // These two instants are 3 seconds apart in real wall-clock time — the kind of gap a server
  // render and its client hydration pass can easily straddle.
  const ssrInstant = new Date("2026-09-05T20:59:59Z"); // 23:59:59 Cairo, 5 Sep
  const hydrateInstant = new Date("2026-09-05T21:00:01Z"); // 00:00:01 Cairo, 6 Sep

  const ssrText = formatHeaderDateOldWay(ssrInstant);
  const hydrateText = formatHeaderDateOldWay(hydrateInstant);

  assert.equal(ssrText, "Sep 5, 2026", "a server render 1 second before Cairo midnight reads the 5th");
  assert.equal(hydrateText, "Sep 6, 2026", "a client hydration 1 second after Cairo midnight reads the 6th");
  assert.notEqual(
    ssrText,
    hydrateText,
    "the OLD inline `new Date()` call is genuinely hydration-unsafe: identical formatting code, two real instants 3 seconds apart across the Cairo midnight boundary, two different text nodes — exactly what throws React hydration error #418",
  );

  // The fix must not merely happen to produce the right string in THIS test file — it must
  // structurally defer the "now" computation until after mount, the same "server default, then
  // correct after mount" shape as ThemeProvider (src/components/layout/theme-provider.tsx), so the
  // server's HTML and the client's FIRST hydration pass always agree (both render nothing),
  // regardless of which instant either side lands on.
  const source = fs.readFileSync(LAYOUT_PATH, "utf8");

  assert.doesNotMatch(
    source,
    /<span className="whitespace-nowrap">\s*\{new Date\(\)\.toLocaleDateString/,
    "the header date must no longer call `new Date()` directly inline in the render body — that is the exact hydration-unsafe pattern being fixed",
  );

  assert.match(
    source,
    /function EmployeePortalHeaderDate\(\)/,
    "the header date must be isolated in its own component so it can defer to a mount effect independently of the rest of the header",
  );

  const componentMatch = source.match(/function EmployeePortalHeaderDate\(\)[\s\S]*?\n\}/);
  assert.ok(componentMatch, "EmployeePortalHeaderDate component body must be found in the layout source");
  const componentSource = componentMatch![0];

  assert.match(
    componentSource,
    /useState<string \| null>\(null\)/,
    "must start from a null placeholder state — never a value computed at first render — so the server HTML and the client's first hydration pass are byte-identical",
  );
  assert.match(
    componentSource,
    /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?\},\s*\[\]\s*\)/,
    "the real 'now' value must be computed inside a mount-only useEffect (empty deps), never during the render body itself",
  );
  assert.match(
    componentSource,
    /if\s*\(!label\)\s*return null;/,
    "before mount the component must render nothing (matching the server's output) rather than guess at a date",
  );
}
