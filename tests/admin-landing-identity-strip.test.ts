import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Every admin landing surface carries an identity — and WHICH one it carries is pinned per surface.
 *
 * WHY THIS EXISTS. The identity on these pages was removed and restored four times in four days,
 * every time by the owner's own instruction, and every intermediate state was invisible: a landing
 * page with the wrong identity — or none — renders perfectly, CI stays green, and the only signal
 * is the person whose page it is noticing. The SFE Manager's went missing from 2026-09-03 to
 * 2026-09-06 and he had to report it himself.
 *
 * THE HISTORY, because a session holding any three of these will undo the fourth:
 *
 *   1. 2026-09-03 — the full-bleed band (`AdminHeroFrame` + `CeoHeroIdentity`) removed from 131
 *      admin pages: "remove from all pages this dump block".
 *   2. Later the same day — the identity back, but THIN: "I want it to be narrow, to have much
 *      space for the page to show data", under 96px by his own measure. That is
 *      `PhoenixIdentityStrip`, and it went to the HR overview and then /admin ("and /admin").
 *   3. 2026-09-06 — the SFE board found to have no identity at all, and the CEO and Finance boards
 *      the same. All three were given the STRIP.
 *   4. Same day, immediately: "I WANT THE SFE AND THE FINANCE AND CEO TO HAVE THEIR PREVIOUS
 *      IDENTITY BANNER, THE NEW ONE IS ONLY FOR HRs." Asked directly whether /admin reverted too,
 *      he said no — it keeps the strip.
 *
 * So there are TWO identities, and which surface wears which is a decision, not a detail:
 *
 *   BAND  (`CeoHeroIdentity` in a dark `AdminHeroFrame`) — CEO, SFE, Finance
 *   STRIP (`PhoenixIdentityStrip`, 92px)                 — /admin, HR
 *
 * Getting it wrong in EITHER direction has now happened, so both directions are asserted. A test
 * that only checked "an identity is present" would have passed on 2026-09-06 while three boards
 * wore the wrong one.
 */

type Identity = "band" | "strip";

/**
 * The admin-shell landing surfaces (src/lib/auth/landing.ts), and which identity each wears.
 *
 * The FILE is wherever the identity is actually drawn, which is not always the `page.tsx`. Most
 * surfaces are drawn by a component only one route imports — `SystemAdminOverview` for /admin,
 * `HrCommandCenter` for the HR namespace, `FinanceCommandCenter` for Finance — and a single-surface
 * component is the same thing as the page for this rule. The CEO and SFE boards SHARE
 * `CeoCommandCenter`, so theirs is asserted on the shared component once, below.
 *
 * TWO COMPONENTS NOW SERVE THE HR ADDRESS. Since 2026-10-13 the Talent Acquisition seat gets
 * `TalentAcquisitionOverview` at /hr/admin/hr-command-center and every other HR seat keeps
 * `HrCommandCenter` — one route, two components, chosen on the seat's own bundle. Both are listed,
 * because the whole value of this test is that the identity cannot go missing from a landing page
 * in silence, and a bespoke page for one seat is the easiest place in the repo for exactly that to
 * happen: the owner's instruction when he asked for it was *"donot touch photo or identity
 * banner"*, and nothing but this list enforces it.
 */
const LANDING_SURFACES: readonly { file: string; seat: string; wears: Identity }[] = [
  { file: "src/components/admin/system-admin-overview.tsx", seat: "Super Admin (/admin)", wears: "strip" },
  { file: "src/components/hr/hr-command-center.tsx", seat: "HR Advisory / HR Operations", wears: "strip" },
  { file: "src/components/hr/talent-acquisition-overview.tsx", seat: "Talent Acquisition", wears: "strip" },
  { file: "src/components/hr/hr-operations-overview.tsx", seat: "HR Operations Specialist", wears: "strip" },
  { file: "src/components/admin/ceo-command-center.tsx", seat: "CEO and SFE Manager", wears: "band" },
  { file: "src/components/admin/finance-command-center.tsx", seat: "Finance Manager", wears: "band" },
];

/** The page that must supply the band's subject, and the prop it passes. */
const BAND_CALL_SITES: readonly { file: string; seat: string }[] = [
  { file: "app/(admin)/admin/ceo-command-center/page.tsx", seat: "CEO" },
  { file: "app/(admin)/admin/sfe-command-center/page.tsx", seat: "SFE Manager" },
  { file: "app/(admin)/admin/finance-command-center/page.tsx", seat: "Finance Manager" },
];

const BAND = /<CeoHeroIdentity\b/;
const STRIP = /<PhoenixIdentityStrip\b/;

/**
 * The file with its comments removed.
 *
 * NOT optional rigour — it is the whole reason assertion 2 works. Every file this test reads
 * discusses BOTH identities at length, by name, and quotes the props it must pass; that is
 * deliberate, so the rule is readable exactly where the mistake gets made. The first version of
 * assertion 2 matched `welcome={null}` anywhere in the source, and system-admin-overview.tsx says
 * those very characters in the note above the prop — so breaking the prop on purpose left the test
 * GREEN. Measured, while proving this file red.
 *
 * Line comments and block comments only; a `//` inside a string literal would be eaten too, which
 * no file here has and which would fail loudly (a missing assertion) rather than silently.
 */
function codeOnly(source: string): string {
  return stripComments(source);
}

export function runAdminLandingIdentityStripTests() {
  // ── 1. each surface wears its OWN identity, and only that one ───────────────
  const wrong: string[] = [];
  for (const { file, seat, wears } of LANDING_SURFACES) {
    // Comments stripped first, then anchored to the JSX element rather than the name: these
    // files discuss both identities at length, and a name-match would see every mention.
    const source = codeOnly(readFileSync(file, "utf8"));
    const hasBand = BAND.test(source);
    const hasStrip = STRIP.test(source);
    const want = wears === "band" ? hasBand : hasStrip;
    const other = wears === "band" ? hasStrip : hasBand;
    if (!want) wrong.push(`${file} (${seat}) draws no ${wears}`);
    if (other) wrong.push(`${file} (${seat}) draws a ${wears === "band" ? "strip" : "band"} as well`);
  }
  assert.deepEqual(
    wrong,
    [],
    "the identity on an admin landing surface is not the one the owner assigned it:\n  " +
      wrong.join("\n  ") +
      "\n\nBAND (CeoHeroIdentity) = CEO / SFE / Finance. STRIP (PhoenixIdentityStrip) = /admin, HR. " +
      "Both directions have been got wrong inside four days, so if this is a deliberate change, " +
      "his instruction belongs here beside the entry.",
  );

  // ── 2. /admin passes welcome={null}, which is what keeps it to ONE identity ─
  //
  // `CeoCommandCenter` draws the band whenever `welcome` is non-null. /admin renders that same
  // component AND its own strip, so a profile passed there would stack two identities on one page
  // — the defect tests/workspace-single-hero.test.ts exists for, reached by a different route.
  const adminOverview = codeOnly(readFileSync("src/components/admin/system-admin-overview.tsx", "utf8"));
  assert.match(
    adminOverview,
    /welcome=\{null\}/,
    "/admin must pass welcome={null} to CeoCommandCenter. It carries the thin strip itself, so a " +
      "profile here would draw a band underneath it — two identities on the Super Admin's page.",
  );

  // ── 3. every band call site actually supplies a subject ─────────────────────
  //
  // The band is conditional on `welcome`, so a page that stops passing one loses its identity in
  // total silence — no error, no empty frame, just a board that greets nobody. That is precisely
  // what happened to the SFE Manager for three days.
  const starved: string[] = [];
  for (const { file, seat } of BAND_CALL_SITES) {
    const source = codeOnly(readFileSync(file, "utf8"));
    if (!/welcome=\{/.test(source)) starved.push(`${file} (${seat})`);
  }
  assert.deepEqual(
    starved,
    [],
    `these pages render a command centre but pass no welcome profile, so the identity band is ` +
      `silently omitted: ${starved.join(", ")}`,
  );

  // ── 4. anti-vacuity ─────────────────────────────────────────────────────────
  // Assertion 1 reads every path from disk, so a moved file throws rather than passing on an empty
  // set. The counts are what stop the LISTS being quietly shortened, which would leave the
  // assertions running against fewer surfaces with nothing to say about it.
  assert.equal(
    LANDING_SURFACES.length,
    6,
    "six files draw the admin landing identities: /admin, the three components behind the HR " +
      "address, Finance, and the one the CEO and SFE boards share. A shorter list is a check that " +
      "stopped watching, not a rule that changed",
  );
  assert.equal(
    BAND_CALL_SITES.length,
    3,
    "three pages must supply a band subject — CEO, SFE and Finance",
  );
}
