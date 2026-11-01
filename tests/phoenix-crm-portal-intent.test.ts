import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PHOENIX_CRM_ADD_VISIT_HREF,
  PHOENIX_CRM_WEEKLY_PLAN_HREF,
  portalQuickActions,
} from "../src/lib/employee-portal/portal-quick-actions.ts";
import { phoenixCrmModulePath } from "../src/lib/phoenix-crm/modules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the portal's "+" reaching the right screen (owner, 2026-09-29: "the + in the bottom bar
 * and the top bar should include Add visit and Make weekly plan; Phoenix CRM is the module medical reps
 * use most").
 *
 * The two actions are plain links to the module's own page, `/visits?add=visit` and `/plan?add=week`,
 * and that page answers them. Three ways this breaks silently, each pinned below:
 *
 *   1. The link names a tab or an ask the page does not read — the rep lands on the page and nothing
 *      opens, which looks exactly like a slow phone.
 *   2. The page answers the ask by REMOUNTING the tab — a visit half entered is lost to a stray tap on
 *      "+". So the ask is a counter the tab watches, never a key.
 *   3. The ask stays in the address — the second tap on the same action is then no change at all, and
 *      "+ Add visit" works once per page load. The page takes the word off once it has read it.
 */

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

export function runPhoenixCrmPortalIntentTests(): void {
  // ── 1. The links name what the page reads ──────────────────────────────────────────────────────
  const visit = new URL(PHOENIX_CRM_ADD_VISIT_HREF, "https://phoenix.local");
  const plan = new URL(PHOENIX_CRM_WEEKLY_PLAN_HREF, "https://phoenix.local");
  // The module's OWN page, never the chooser's `?tab=`: the chooser only redirects a `?tab=` to this
  // same address, so pointing the "+" at it cost every tap a second server round trip.
  assert.equal(
    visit.pathname,
    phoenixCrmModulePath("/employee-portals/field-crm", "visits"),
    "Add visit opens the Visits module's own page, not the chooser that would only redirect there",
  );
  assert.equal(
    plan.pathname,
    phoenixCrmModulePath("/employee-portals/field-crm", "plan"),
    "Make weekly plan opens the Plan module's own page, not the chooser that would only redirect there",
  );
  assert.deepEqual([visit.searchParams.get("tab"), visit.searchParams.get("add")], [null, "visit"]);
  assert.deepEqual([plan.searchParams.get("tab"), plan.searchParams.get("add")], [null, "week"]);
  const modulePage = source("app/employee-portals/field-crm/[module]/page.tsx");
  assert.match(modulePage, /initialTab=\{moduleKey\}/, "the module page opens the module its address names");
  const chooser = source("app/employee-portals/field-crm/page.tsx");
  assert.match(
    chooser,
    /redirect\(`\$\{phoenixCrmModulePath\(PHOENIX_CRM_PORTAL_PATH, tab\)\}\$\{add \? `\?add=\$\{add\}` : ""\}`\)/,
    "and the chooser still forwards an old `?tab=…&add=…` to that same address, so a saved link keeps working",
  );

  const app = source("src/components/phoenix-crm/phoenix-crm-app.tsx");
  const order = /const TAB_ORDER: readonly TabKey\[\] = \[([^\]]+)\]/.exec(source("src/lib/phoenix-crm/opening-tab.ts"))?.[1] ?? "";
  for (const tab of ["visits", "plan"]) {
    assert.ok(order.includes(`"${tab}"`), `the page has a "${tab}" tab for the link to open`);
  }
  assert.match(app, /value === "visit" \|\| value === "week"/, "the page reads exactly the two asks the links send");
  assert.match(app, /useSearchParams\(\)/, "the page reads the address it is on, so a tap while it is open is seen");

  // ── 2. Answered by a counter, never a remount ───────────────────────────────────────────────────
  assert.match(app, /setAddVisitNonce\(\(value\) => value \+ 1\)/, "Add visit bumps a counter");
  assert.match(app, /setPlanWeekNonce\(\(value\) => value \+ 1\)/, "Make weekly plan bumps a counter");
  assert.match(app, /addNonce=\{addVisitNonce\}/, "the Visits tab is handed the counter");
  assert.match(app, /weekNonce=\{planWeekNonce\}/, "the Plan board is handed the counter");
  for (const key of [/key=\{`\$\{seatId\}\|\$\{test\}\|\$\{addVisitNonce/, /key=\{[^}]*planWeekNonce/]) {
    assert.doesNotMatch(app, key, "a counter in a key would remount the tab and drop work under way");
  }

  // ── 3. The ask is read once ─────────────────────────────────────────────────────────────────────
  assert.match(app, /url\.searchParams\.delete\("add"\)/, "the word comes off the address once read");

  // ── Who is offered them ─────────────────────────────────────────────────────────────────────────
  const none = { showDashboardTab: true } as Parameters<typeof portalQuickActions>[0];
  const rep = { ...none, showPhoenixCrmTab: true, showMedicalRepExpensesTab: true };
  assert.deepEqual(
    portalQuickActions(rep)
      .slice(0, 2)
      .map((action) => action.href),
    [PHOENIX_CRM_ADD_VISIT_HREF, PHOENIX_CRM_WEEKLY_PLAN_HREF],
    "a rep with Phoenix CRM open is offered both, first",
  );
  assert.equal(
    portalQuickActions({ ...none, showPhoenixCrmTab: true }).some((action) => action.id.startsWith("crm-")),
    false,
    "a manager is not offered them — he enters visits through the page itself",
  );

  console.log("phoenix-crm portal intent: OK");
}
