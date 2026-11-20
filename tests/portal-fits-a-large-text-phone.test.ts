import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * The employee portal fits a SMALL ANDROID PHONE ON LARGE TEXT (owner, 2026-11-20: "tranculations and
 * irregulars in the employee portal mobile view android and iphone", then — asked what differs — "Large
 * text on phones" and "Small Android phones").
 *
 * Why the desktop emulator never showed it: the UI font stack leads with Aptos, a Windows/Office face
 * the type scale was calibrated against. An iPhone renders Helvetica Neue and an Android phone Roboto,
 * both wider; and Android Chrome follows the phone's text size as page zoom, so a 360px phone on
 * Large text lays the page out ~280px wide. Measured on production through View as Seat with Arial
 * standing in for the phone faces, at 280px:
 *
 *   - the top bar's title broke into four lines and climbed out of the 54px bar, because the "+ New"
 *     button duplicated the phone bar's floating "+" and took the 40px the title needed;
 *   - LINE · JOINED · REPORTS TO pushed "Reports to / Osama Mohamed" past the screen edge, clipped;
 *   - the rep's KPI tiles cut "OCT 2026" at the tile edge and broke "CALL / RATE" alone;
 *   - Sales vs Target cut "100.0%" beside the achievement ring;
 *   - the incentive policy table was 294px wide in a 256px column;
 *   - My Milestones' NEXT badge spilled over its card border.
 *
 * Each assertion below pins one fix in the source (comments stripped, so an explanation cannot
 * satisfy it).
 */

const LAYOUT = "src/components/employee-portal/employee-portal-layout.tsx";
const CENTER = "src/components/employee-portal/portal-command-center.tsx";
const BAND = "src/components/sales/target-visuals.tsx";
const DASHBOARD = "src/components/employee-portal/employee-portal-dashboard.tsx";
const MILESTONES = "src/components/employee-portal/my-milestones.tsx";
const SHELL = "src/components/employee-portal/enterprise-shell.tsx";
const LOADING = "src/components/employee-portal/employee-portal-route-loading.tsx";
const PLANNER = "src/components/production-planning/production-planning-workspace.tsx";
const EXPENSE = "src/components/employee-portal/personal-expense-workload-dashboard.tsx";

function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

function componentBody(source: string, name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must still exist`);
  const rest = source.slice(start + marker.length);
  const next = rest.search(/\n(?:export )?function /);
  return next === -1 ? source.slice(start) : source.slice(start, start + marker.length + next);
}

export function runPortalFitsALargeTextPhoneTests() {
  const layout = code(LAYOUT);

  // 1. One "+" on a phone. The top bar's "+ New" is desktop-only; the phone bar's floating "+" opens
  //    the same list (PortalBottomNavQuickActions, lg:hidden).
  const quickActions = componentBody(layout, "PortalQuickActions");
  assert.match(
    quickActions,
    /<div className="relative hidden shrink-0 lg:block" ref=\{ref\}>/,
    `${LAYOUT}: the top bar's + New is hidden below lg — on a phone it was a second identical "+" that squeezed the title into four lines`,
  );

  // 2. The top bar's title: under 360px the eyebrow steps aside and the role stands alone, and while
  //    offline the warning replaces the role. The offline branch itself is never hidden.
  const greeting = componentBody(layout, "EmployeePortalGreeting");
  assert.match(greeting, /className="hidden whitespace-nowrap [^"]*min-\[360px\]:block/, `${LAYOUT}: the "Employee Portal" eyebrow is hidden under 360px, and never breaks onto two lines above it`);

  // 2b. The phone bar is NIGHT NAVY below lg (owner, 2026-11-20: "THE UPPER NAV BAR EMPLOYEE PORTAL
  //     MEDICAL REP LOOKS FUCKEN AWFUL", then, shown two designs on the live bar, "A: night navy") — the
  //     ground every portal page header already wears, one flat orange line on top, white icons in
  //     thin frames at one 38px size, and the photo in an orange frame. Desktop keeps its white bar.
  assert.ok(layout.includes("max-lg:border-b-0 max-lg:bg-[#08111f]"), `${LAYOUT}: the bar is night navy below lg`);
  assert.ok(layout.includes("from-sky-500 via-[#F05A1A] to-emerald-500 max-lg:bg-none max-lg:bg-[#F05A1A]"), `${LAYOUT}: one flat orange line on the phone bar, never the gradient`);
  assert.ok(!layout.includes("border-orange-200 bg-orange-50 text-orange-700 shadow-[0_6px_16px"), `${LAYOUT}: the phone menu button is no longer an orange block`);
  assert.ok(layout.includes('h-[38px] w-[38px] shrink-0 items-center justify-center border border-white/15 text-white transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-orange-500/40 lg:hidden'), `${LAYOUT}: the menu is a white icon in a thin frame`);
  assert.ok(layout.includes("max-lg:h-[38px] max-lg:w-[38px] max-lg:border max-lg:border-white/15 max-lg:text-white"), `${LAYOUT}: the inbox matches the menu and search`);
  assert.ok(layout.includes("max-lg:justify-center max-lg:border-orange-500/75 max-lg:bg-transparent max-lg:p-0"), `${LAYOUT}: the photo sits in an orange frame`);
  assert.ok(layout.includes("tracking-[-0.01em] text-white max-[359px]"), `${LAYOUT}: the role reads white on the navy bar`);

  // 3. LINE · JOINED · REPORTS TO: one row, labels never break, cells never shrink below their words.
  const center = code(CENTER);
  const intel = componentBody(center, "IntelField");
  assert.match(intel, /flex min-w-min flex-col/, `${CENTER}: an identity cell keeps its own words as its floor — min-w-0 squeezed "Reports to" off the screen`);
  assert.doesNotMatch(intel, /\bmin-w-0\b/, `${CENTER}: min-w-0 must not come back on the identity cells`);
  assert.match(intel, /whitespace-nowrap text-phx-xs font-black uppercase/, `${CENTER}: the identity labels never break ("REPORTS / TO")`);
  assert.match(intel, /\[overflow-wrap:break-word\]/, `${CENTER}: the identity VALUE wraps inside its cell, never clips`);

  // 4. The rep's KPI tiles: the period stacks under the label in a narrow tile. The grid itself stays
  //    2x2 (his 2026-09-30 rule, pinned by tests/phoenix-crm-today.test.ts) — never a width query on it.
  const tile = componentBody(center, "RepTile");
  assert.match(tile, /flex flex-col gap-0\.5 @\[13rem\]:flex-row/, `${CENTER}: a tile's period stacks under its label below 13rem`);
  assert.doesNotMatch(tile, /className="ml-auto whitespace-nowrap/, `${CENTER}: an unconditional ml-auto period is what cut "OCT 2026" at the tile edge`);

  // 5. Sales vs Target (and every portal CommandBand): the aside wraps under the ring rather than being
  //    squeezed.
  const band = code(BAND);
  assert.match(band, /<div className="flex-1 basis-\[8rem\]">\{aside\}<\/div>/, `${BAND}: the portal band's aside wraps under the ring`);
  assert.doesNotMatch(band, /<div className="min-w-0 flex-1">\{aside\}<\/div>/, `${BAND}: min-w-0 on the aside cut "100.0%" at the panel edge`);

  // 6. The incentive policy tables (both lines' cards): three columns only from 17rem.
  const dashboard = code(DASHBOARD);
  assert.doesNotMatch(dashboard, /"grid grid-cols-\[1fr_80px_1fr\]|`grid grid-cols-\[1fr_80px_1fr\]/, `${DASHBOARD}: an unconditional three-column policy table overflowed a 256px column`);
  assert.equal(
    (dashboard.match(/grid-cols-\[1fr_auto\][^"`]*@\[17rem\]:grid-cols-\[1fr_96px_1fr\]/g) ?? []).length,
    4,
    `${DASHBOARD}: both policy cards (header + rows each) switch to three columns only from 17rem`,
  );

  // 7. My Milestones: the NEXT badge wraps under the label instead of spilling over the card border.
  assert.match(code(MILESTONES), /<span className="flex flex-wrap items-center gap-x-1\.5 gap-y-1">/, `${MILESTONES}: the title row wraps`);

  // 8. Every portal page header is the badge and the title — no sentence under them (owner,
  //    2026-11-20: "REMOVE ALL THESE TEXTS UNDER HEADERS", "ALL HEADERS", "REMOVE THE BIG TEXT UNDER").
  //    The shell draws every page's header, so it must never render `description` again; the three
  //    portal pages that draw their own header lost theirs too.
  const shell = code(SHELL);
  const shellBody = componentBody(shell, "EmployeePortalPageShell");
  assert.doesNotMatch(shellBody, /\{description\}/, `${SHELL}: the header renders no description under the title`);
  assert.doesNotMatch(shellBody, /descriptionClassName/, `${SHELL}: the description paragraph is gone, not merely restyled`);
  assert.doesNotMatch(code(LOADING), /mt-2 h-4 w-full max-w-\[32rem\]/, `${LOADING}: the loading header draws no description bar either`);
  assert.doesNotMatch(code(PLANNER), /\{t\.moduleSubtitle\}<\/p>/, `${PLANNER}: the Production Planner page header has no subtitle line`);
  assert.doesNotMatch(dashboard, /Track workload, trips, and expense efficiency/, `${DASHBOARD}: the Expense Dashboard header has no sentence under it`);
  assert.doesNotMatch(code(EXPENSE), /Track trips, expenses, approvals, and workload/, `${EXPENSE}: the personal Expense Dashboard header has no sentence under it`);

  // 8b. "DELETE ANY TEXT UNDER ANY HEADER": every shared header part marks its sentence
  //     `phx-header-note`, and the portal shell does not draw it. The admin shell keeps it.
  const css = readFileSync("app/globals.css", "utf8");
  assert.match(css, /\.employee-portal-shell \.phx-header-note \{\s*display: none !important;/, "app/globals.css: the portal hides every header sentence");
  assert.doesNotMatch(css, /\.admin-shell[^{]*\.phx-header-note/, "app/globals.css: the admin shell keeps its header sentences");
  assert.match(code("src/components/admin/admin-design-tokens.ts"), /pageHeaderDescriptionClassName =\s*"phx-header-note /, "pageHeaderDescriptionClassName carries the marker");
  assert.match(code("src/components/employee-portal/portal-primitives.tsx"), /className="phx-header-note mt-1 max-w-3xl/, "PortalSection's description carries the marker");
  assert.equal((band.match(/<p className="phx-header-note /g) ?? []).length, 4, `${BAND}: SectionCard (both headers) and CommandBand (both bands) mark their subtitles`);
  assert.match(code("src/components/admin/admin-design-system.tsx"), /<p className="phx-header-note mt-2 text-sm leading-6 text-slate-500">\{description\}<\/p>/, "AdminSectionHeader's description carries the marker");
  // The three a page-by-page tour of the rep's portal still found (20 Nov): Notification Settings on
  // My Profile, Data sync on the Sales Drilldown, and the Business Review's panel notes.
  assert.match(code("src/components/notifications/notification-settings-panel.tsx"), /<p className="phx-header-note mt-1 text-sm text-slate-600">Email, in-app/, "Notification Settings' sentence carries the marker");
  assert.match(code("src/components/sales/territory/territory-sync-panel.tsx"), /<p className="phx-header-note [^"]*">\{SYNC_DESCRIPTION\}<\/p>/, "the Data sync sentence carries the marker");
  assert.match(code("src/components/business-review/concentration.client.tsx"), /<span className="phx-header-note [^"]*">\{note\}<\/span>/, "the Business Review panel note carries the marker");
}
