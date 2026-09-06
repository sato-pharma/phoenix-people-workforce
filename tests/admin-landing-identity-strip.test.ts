import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Every admin landing surface carries the identity strip, and no shared component does.
 *
 * WHY THIS EXISTS. The identity on these pages has been removed and restored by the owner three
 * times in four days, each time by instruction, and the state in between was invisible: a landing
 * page with no identity renders perfectly, CI stays green, and the only signal is the person whose
 * own page it is noticing months later that their name is not on it. That is exactly how the SFE
 * Manager's went unnoticed from 2026-09-03 to 2026-09-06 — he was the only seat in the app whose
 * landing page greeted nobody, and he had to report it himself.
 *
 * THE HISTORY, because a session holding one instruction will undo another:
 *
 *   1. 2026-09-03 — the full-bleed black band (`AdminHeroFrame` + `CeoHeroIdentity`) was removed
 *      from 131 admin pages: "remove from all pages this dump block".
 *   2. Later the same day — the identity back, in the employee portal's idiom, thin: "I want it to
 *      be narrow, to have much space for the page to show data", under 96px by his own measure.
 *      That is `PhoenixIdentityStrip`, 88px on a phone and 92px from `sm`, both fixed. It shipped
 *      on the HR overview and /admin, and the other three boards were excluded by name: "you will
 *      keep the CEO and the SFE and the finance as they are today."
 *   3. 2026-09-06 — the exclusion retired, in two steps: "in the SFE manager account recover his
 *      identity banner", then "yes recover the ceo and finance banners too".
 *
 * So the rule that survived all three is: the strip is PRESENT on every admin landing surface, and
 * its HEIGHT is what may never grow. The black band stays gone — pinned separately, by name, in
 * tests/ceo-command-center.test.ts.
 *
 * THE SECOND HALF IS THE ONE THAT BITES. Each mount lives in the PAGE, never in a shared command
 * centre component. `CeoCommandCenter` serves three variants (CEO, SFE and the Super Admin's
 * /admin), so a single strip inside it would draw the identity three times over; and the Finance
 * bands are reused on the Super Admin overview through `FinanceAdminBands`, which already carries
 * a strip one level up, so a strip inside `FinanceCommandCenter` would stack two identities on his
 * page. Two stacked heroes is a defect this repo has shipped three times — the reason
 * tests/workspace-single-hero.test.ts exists — and the tidy-looking refactor that causes it here
 * is "mount it once in the shared component instead of five times in the pages".
 */

/**
 * The five admin-shell landing surfaces, and who lands on each (src/lib/auth/landing.ts).
 *
 * The FILE is wherever the strip is actually drawn, which is not always the `page.tsx`. Two seats
 * are drawn by a component that only one route imports — `SystemAdminOverview` for /admin and
 * `HrCommandCenter` for the HR namespace — and a single-surface component is the same thing as the
 * page for this rule. What matters is that no ONE file feeds several surfaces; that is the list
 * below.
 */
const LANDING_PAGES: readonly { file: string; seat: string }[] = [
  { file: "src/components/admin/system-admin-overview.tsx", seat: "Super Admin (/admin)" },
  { file: "app/(admin)/admin/ceo-command-center/page.tsx", seat: "CEO" },
  { file: "app/(admin)/admin/sfe-command-center/page.tsx", seat: "SFE Manager" },
  { file: "app/(admin)/admin/finance-command-center/page.tsx", seat: "Finance Manager" },
  { file: "src/components/hr/hr-command-center.tsx", seat: "HR Advisory / HR Operations" },
];

/**
 * Components a strip must NOT be mounted in — the ones feeding MORE THAN ONE surface.
 *
 * `system-admin-overview.tsx` and `hr-command-center.tsx` are deliberately absent: they are
 * components, but each is imported by exactly one route, so they are landing surfaces and are
 * listed above instead.
 */
const SHARED_COMPONENTS: readonly string[] = [
  "src/components/admin/ceo-command-center.tsx",
  "src/components/admin/finance-command-center.tsx",
];

export function runAdminLandingIdentityStripTests() {
  // ── 1. every landing surface mounts it ──────────────────────────────────────
  const missing: string[] = [];
  for (const { file, seat } of LANDING_PAGES) {
    const source = readFileSync(file, "utf8");
    // Anchored to the JSX mount, not to the import: a page can import the component and never
    // render it, which is precisely the state /admin/sfe-command-center was NOT in — it had
    // neither — but is the shape a half-finished revert would leave.
    if (!/<PhoenixIdentityStrip\b/.test(source)) missing.push(`${file} (${seat})`);
  }
  assert.deepEqual(
    missing,
    [],
    "these admin landing surfaces render no identity strip, so the seat that lands there is " +
      `greeted by nobody: ${missing.join(", ")}. The owner asked for the identity on all five ` +
      "(2026-09-06, retiring his own 2026-09-03 exclusion). If one is being removed deliberately, " +
      "his instruction to do so belongs in this test beside the entry.",
  );

  // ── 2. …and no shared component does ────────────────────────────────────────
  const doubled: string[] = [];
  for (const file of SHARED_COMPONENTS) {
    const source = readFileSync(file, "utf8");
    // Comments in these files discuss the strip at length and name it — deliberately, so the rule
    // is readable where the mistake would be made. Match the JSX element only.
    if (/<PhoenixIdentityStrip\b/.test(source)) doubled.push(file);
  }
  assert.deepEqual(
    doubled,
    [],
    `${doubled.join(", ")} mounts the identity strip. It must be mounted by the PAGE instead: ` +
      "CeoCommandCenter serves three variants so one mount there draws three identities, and the " +
      "Finance bands are reused on the Super Admin overview which already carries a strip — so a " +
      "mount here stacks two on his page.",
  );

  // ── 3. anti-vacuity ─────────────────────────────────────────────────────────
  // Every path above is read from disk, so a renamed or moved file would make assertion 1 fail
  // loudly (readFileSync throws) rather than pass on an empty set — but assertion 2 CAN pass
  // vacuously if both component paths stop existing, and it would then be watching nothing.
  assert.equal(
    SHARED_COMPONENTS.length,
    2,
    "the shared-component list must still name both command centres; a shortened list is a " +
      "check that stopped watching rather than a rule that changed",
  );
  assert.equal(
    LANDING_PAGES.length,
    5,
    "five admin-shell landing surfaces were pinned when this was written (src/lib/auth/landing.ts). " +
      "A sixth seat with its own landing page must be added here, or its identity goes unwatched",
  );
}
