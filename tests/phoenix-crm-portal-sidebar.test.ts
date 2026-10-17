import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PORTAL_NAV_REGISTRY } from "../src/components/employee-portal/employee-portal-nav-registry.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";

/**
 * Phoenix CRM has a door in the portal sidebar (the owner, 2026-09-23: "put it in the sidebar").
 *
 * ## Why this exists
 *
 * Until that day the module had exactly one door: a button inside the My Visits page. All three
 * lines had been open in `phoenix_crm_line_rollout` since 2026-09-18, and of the 73 rep seats with a
 * reference list waiting, 2 had ever minted one. A module nobody can find is a module nobody uses,
 * and the fix is one sidebar row — not a roster, not a new permission, not a narrower gate.
 *
 * Four things have to hold for that row to appear, and every one of them is a place a later change
 * can silently drop it:
 *
 *   1. the row is driven by the module's OWN gate, `phoenixCrmEntryAvailable`, and by no role list.
 *      That function already weighs the `phoenix_crm` permission, a territory of the viewer's own or
 *      beneath him, and whether his line is open. A second list of roles in navigation.ts would
 *      drift from it the first time the owner opens or closes a line;
 *   2. the flag reaches `buildEmployeePortalSections`. Its parameter list carries a default per
 *      flag, and a flag MISSING from that destructuring is not a type error — it is silently
 *      ignored, and the row never renders;
 *   3. every page that builds its own portal chrome asks the gate too. The profile page and the
 *      payslips page each call `resolveEmployeePortalNavVisibility` themselves, so a flag passed
 *      only by the shell is a row that vanishes the moment the rep opens either of them;
 *   4. the row points at the portal address, `/employee-portals/field-crm` — never the admin twin,
 *      which redirects a portal role straight back.
 */
export function runPhoenixCrmPortalSidebarTests() {
  const source = (path: string) => readFileSync(path, "utf8");

  // ── 1. The flag is the module's own gate, not a role list ──────────────────────────────────────

  // Truthy only when the caller says so. Role, line and department are the flag inputs every other
  // portal row keys on, so proving the CRM row ignores all of them is proving it is not a role test.
  const repWithCrm = resolveEmployeePortalNavVisibility(
    "Medical Rep",
    "Medical Rep",
    "Anti Infective",
    "Sales",
    "B-999",
    false,
    false,
    true,
  );
  assert.equal(repWithCrm.showPhoenixCrmTab, true, "a rep the module lets in gets the sidebar row");

  const repWithoutCrm = resolveEmployeePortalNavVisibility(
    "Medical Rep",
    "Medical Rep",
    "Anti Infective",
    "Sales",
    "B-999",
    false,
    false,
    false,
  );
  assert.equal(
    repWithoutCrm.showPhoenixCrmTab,
    false,
    "and a rep the module refuses does not — the row asks phoenixCrmEntryAvailable and nothing else",
  );

  // The same answer for a role that could never be mistaken for a field seat, in both directions:
  // whoever holds the gate holds the row, and holding a senior title alone never opens it.
  assert.equal(
    resolveEmployeePortalNavVisibility("HR Manager", "HR Operations", null, "HR", "B-998", false, false, true)
      .showPhoenixCrmTab,
    true,
    "the flag follows the module's gate, never the viewer's title",
  );
  assert.equal(
    resolveEmployeePortalNavVisibility(
      "National Sales Manager",
      "National Sales Manager",
      "Pedia",
      "Sales",
      "B-997",
      false,
      false,
      false,
    ).showPhoenixCrmTab,
    false,
    "and a senior sales title with no open line still gets no row",
  );

  // Omitting the argument entirely is the same as refusing — a caller that forgets the flag shows
  // no row rather than showing one it never checked.
  assert.equal(
    resolveEmployeePortalNavVisibility("Medical Rep", "Medical Rep", "CNS", "Sales", "B-996", false, false)
      .showPhoenixCrmTab,
    false,
    "an unpassed flag fails closed",
  );

  // No role set may be spelled out for this flag in navigation.ts: the module's gate is the only
  // authority, and a second copy here is the drift this test exists to prevent.
  const navigation = source("src/lib/employee-portal/navigation.ts");
  const assignment = /showPhoenixCrmTab:\s*([^\n]*)/.exec(navigation);
  assert.ok(assignment, "navigation.ts still assigns showPhoenixCrmTab");
  assert.match(
    assignment[1],
    /hasPhoenixCrmEntry === true/,
    "the flag is the passed gate verbatim, with no role, line or department test bolted onto it",
  );

  // ── 2. The flag reaches the sidebar builder, and points at the portal address ──────────────────

  const layout = source("src/components/employee-portal/employee-portal-layout.tsx");
  const builderStart = layout.indexOf("function buildEmployeePortalSections({");
  assert.ok(builderStart > 0, "buildEmployeePortalSections still builds the portal rail");
  const destructuring = layout.slice(builderStart, layout.indexOf("}: EmployeePortalNavVisibility)", builderStart));
  assert.match(
    destructuring,
    /showPhoenixCrmTab = false,/,
    "showPhoenixCrmTab is destructured by the rail builder — a flag left out of this list is silently ignored",
  );

  assert.match(
    layout,
    /\.\.\.\(showPhoenixCrmTab\s*\?\s*\[\{ href: "\/employee-portals\/field-crm", label: "Phoenix CRM", icon: ClipboardList, highlight: true as const \}\]\s*:\s*\[\]\),/,
    "the rail row points at the portal address, under the module's own name, and carries the highlight",
  );

  // ── 3. Every page that builds its own portal chrome asks the gate ──────────────────────────────

  for (const path of [
    "src/components/employee-portal/employee-portal-server-shell.tsx",
    "app/employee-portals/profile/page.tsx",
    "app/payslips/page.tsx",
  ]) {
    const text = source(path);
    assert.match(
      text,
      /import \{ NO_PHOENIX_CRM_ENTRIES, phoenixCrmSidebarEntries(?:, type PhoenixCrmSidebarEntries)? \} from "@\/lib\/phoenix-crm\/server\/sidebar-entries";/,
      `${path} asks the module's own gate rather than inventing a second one`,
    );
    assert.match(
      text,
      /phoenixCrmSidebarEntries\(access\)\.catch\(\(\) => NO_PHOENIX_CRM_ENTRIES\)/,
      `${path} fails the gate closed — a CRM outage costs the rows, never the page`,
    );
    const call = /resolveEmployeePortalNavVisibility\(([\s\S]*?)\n  \);/.exec(text);
    assert.ok(call, `${path} still resolves the portal nav visibility`);
    assert.match(
      call[1],
      // THREE answers since 2026-10-13, when the gate gained `placeChecks` for the district
      // manager's own board. Every answer the gate returns has to arrive here, last and in order:
      // one left out is not a type error anywhere — the row simply never draws, for the one person
      // the module decided to show it to.
      /phoenixCrm\.crm,\s*phoenixCrm\.forecast,\s*phoenixCrm\.placeChecks,\s*phoenixCrm\.doubleVisitRequests,\s*phoenixCrm\.managerPlans,\s*$/,
      `${path} passes all five of the gate's answers through, last and in order, or its sidebar loses a row`,
    );
  }

  // ── 3a. The sidebar gate's own module never reaches the overview loader (2026-10-17) ─────────────
  // Every portal page draws the sidebar, so whatever sidebar-entries.ts imports is compiled into all
  // of them. Its functions lived in page.ts beside loadPhoenixCrmOverview — 227 files the gate never
  // calls — until they moved; one import of page.ts here, direct or through overview, undoes it.
  {
    const imports = source("src/lib/phoenix-crm/server/sidebar-entries.ts").match(/^import[^;]*;/gm) ?? [];
    assert.ok(imports.length > 0, "sidebar-entries.ts's import lines must be readable for this check to mean anything");
    for (const line of imports) {
      assert.doesNotMatch(
        line,
        /from\s+"@\/lib\/phoenix-crm\/server\/(?:page|overview)"/,
        `the sidebar gate must not import the page loader or the overview — every portal page would compile them (${line})`,
      );
    }
  }

  // ── 3b. The Daily Forecast row under Forecast & Target (owner, 2026-10-01) ────────────────────
  //
  // "Put it under forecast in sidebar": the CNS daily forecast is a Phoenix CRM tab, and this row is
  // its second door. It follows the SAME gate as the tab — `forecastIsOffered`, through
  // `phoenixCrmSidebarEntries` — never a role list, or a Pedia rep is offered a row that opens onto
  // "not yours to open".
  const forecastOn = resolveEmployeePortalNavVisibility("Medical Rep", "Medical Rep", "CNS", "Sales", "B-995", false, false, true, true);
  assert.equal(forecastOn.showDailyForecastTab, true, "a rep the module offers the forecast gets the row");
  const forecastOff = resolveEmployeePortalNavVisibility("Medical Rep", "Medical Rep", "CNS", "Sales", "B-995", false, false, true, false);
  assert.equal(
    forecastOff.showDailyForecastTab,
    false,
    "and nobody else — the flag is the gate's answer, never the line name the viewer carries",
  );
  assert.equal(
    resolveEmployeePortalNavVisibility("Medical Rep", "Medical Rep", "CNS", "Sales", "B-995", false, false, true).showDailyForecastTab,
    false,
    "an unpassed forecast flag fails closed",
  );
  const forecastAssignment = /showDailyForecastTab:\s*([^\n]*)/.exec(navigation);
  assert.ok(forecastAssignment, "navigation.ts still assigns showDailyForecastTab");
  assert.equal(forecastAssignment[1], "hasPhoenixCrmForecast === true,", "the forecast flag is the passed gate verbatim");

  assert.match(destructuring, /showDailyForecastTab = false,/, "the rail builder destructures the forecast flag");
  const forecastSection = layout.slice(layout.indexOf('title: "Forecast & Target",'), layout.indexOf('title: "Recruitment",'));
  assert.match(
    forecastSection,
    /\.\.\.\(showDailyForecastTab \? \[\{ href: "\/employee-portals\/field-crm\/forecast", label: "Daily Forecast", icon: PackageCheck \}\] : \[\]\),/,
    "the row sits in Forecast & Target and opens the forecast module's own portal address",
  );
  assert.ok(
    forecastSection.indexOf('"/employee-portals/make-it-happen"') < forecastSection.indexOf('"/employee-portals/field-crm/forecast"'),
    "directly under Make It Happen, the section's forecast planner",
  );
  const forecastEntry = PORTAL_NAV_REGISTRY.find((row) => row.href === "/employee-portals/field-crm/forecast");
  assert.ok(forecastEntry, "the registry lists Daily Forecast, so the phone and the quick-nav grid reach it too");
  assert.deepEqual(forecastEntry.flags, ["showDailyForecastTab"], "on the same flag as the rail row");

  // ── 4. The phone's registry carries it too, under a label of its own ───────────────────────────

  const entry = PORTAL_NAV_REGISTRY.find((row) => row.href === "/employee-portals/field-crm");
  assert.ok(entry, "the bottom-nav and quick-nav registry lists Phoenix CRM");
  assert.deepEqual(entry.flags, ["showPhoenixCrmTab"], "and gates it on the same flag as the rail");
  assert.equal(
    entry.permission,
    undefined,
    "with no permission copy: the page has no single machine-readable gate to mirror",
  );

  // "CRM" alone already belongs to the vendor CRM Master board. Two tabs reading the same word is a
  // rep guessing which one he wants, so the short label has to differ from every other short label.
  const shortLabels = PORTAL_NAV_REGISTRY.map((row) => row.label);
  const duplicated = shortLabels.filter((label) => label === entry.label);
  assert.equal(duplicated.length, 1, `"${entry.label}" is not shared with another portal destination`);

  // ── 5. It is the sidebar's ONE standout row, and the highlight costs the row no width ─────────
  //
  // The owner asked for "a special highlight in side bar" (2026-09-30), hours after the premium
  // launcher built for the same want was called awful and reverted whole (#4958). So the shape of
  // the answer matters as much as the fact of it, and three things are pinned here.

  // A standout is only a standout while it is alone. A second highlighted row is the failure mode:
  // nothing about it errors, the sidebar simply stops having a flagship.
  assert.equal(
    (layout.match(/highlight: true as const/g) ?? []).length,
    1,
    "exactly ONE sidebar row carries the highlight — a second one and neither is a standout",
  );

  // The row keeps its square edges: the owner's no-round-corners rule, and the reason the highlighted
  // row drops the `rounded` its siblings still carry.
  assert.match(
    layout,
    /\$\{highlighted \? "" : "rounded"\}/,
    "the highlighted row is square-edged, per the no-round-corners rule",
  );

  // A padlock outranks a flagship: "you cannot open this" must not be dressed as the best row here.
  assert.match(
    layout,
    /const highlighted = item\.highlight === true && !locked;/,
    "a locked row keeps its padlock treatment rather than the highlight",
  );

  // The rail lives OUTSIDE the link, absolutely positioned and click-through. This is the assertion
  // that matters structurally: the portal's label span has no `truncate`, so a node added INSIDE the
  // row's flex line pushes a long label onto a second line — and wrapping is what the owner's
  // no-horizontal-scroll rule forbids. Proven by position, not by reading the class alone.
  const railClass = 'className="pointer-events-none absolute inset-y-0 left-0 w-[4px] bg-[#F05A1A]"';
  // Anchored on the label EXPRESSION rather than the span's full class attribute — those classes are
  // styling and move with the look, and a pin that breaks when styling moves teaches the next reader
  // to treat this file's failures as noise. But it is SCOPED to the real row first: pin mode renders
  // its own `<span>{item.label}</span>` further up, and an unscoped search lands there and answers
  // questions about a different element entirely.
  const rowAt = layout.indexOf('<div className="group/row relative" data-active-row=');
  assert.ok(rowAt > 0, "the sidebar still renders its rows through one wrapper");
  const labelAt = layout.indexOf(">{item.label}</span>", rowAt);
  assert.ok(labelAt > rowAt, "the row still renders its label span");
  const linkClosesAt = layout.indexOf("</Link>", labelAt);
  const railAt = layout.indexOf(railClass);
  assert.ok(railAt > 0, "the highlighted row draws an orange rail on its left edge");
  assert.ok(
    railAt > linkClosesAt && linkClosesAt > labelAt,
    "the rail sits AFTER the link, outside the row's flex line — inside it, it would add width and wrap a long label",
  );

  // ── 6. The highlight carries NO FILL at rest — the one thing the owner rejected twice ──────────
  //
  // The first version rested on `#FFF6F0`, the hover tint one shade off the ACTIVE row's `#FFF0E7`,
  // and he turned it down on sight: "you are highlighting it the same". A permanent pale-orange row
  // says *you are here* on a page you are not on, which is worse than no highlight — it makes the
  // sidebar lie about where you are. He then picked option D from four rendered mockups: a heavy
  // orange rail, orange type, no fill. So the absence of a resting background is the RULE here, and
  // the obvious-looking "improvement" of adding a tint back is precisely what this catches.
  const highlightDecl = /const NAV_HIGHLIGHT_CLASS = "([^"]*)";/.exec(layout);
  assert.ok(highlightDecl, "the standout row's resting face is still declared in one place");
  const restingClasses = highlightDecl[1].split(/\s+/).filter((cls) => cls && !cls.startsWith("hover:"));
  assert.deepEqual(
    restingClasses.filter((cls) => cls.startsWith("bg-")),
    [],
    "the standout row carries NO fill at rest — a resting tint is the ACTIVE state's own signal, and it was rejected twice",
  );
  assert.ok(
    restingClasses.includes("text-[#F05A1A]"),
    "with no fill, the orange type is what carries the highlight",
  );

  // ── 7. The Phoenix logo sits BEFORE the name, in the icon's place ──────────────────────────────
  //
  // Owner, 2026-09-30: "before the Phoenix CRM, put the logo". It takes the icon's PLACE rather than
  // joining it, which is what keeps the row no wider than a sibling — the same reason the padlock
  // replaces the icon instead of sitting beside it.
  const logoAt = layout.indexOf("src={systemAssets.iconLogo}");
  assert.ok(logoAt > 0, "the standout row renders the Phoenix logo from the documented brand asset");
  assert.ok(logoAt < labelAt, "the logo comes BEFORE the row's name");
  assert.ok(
    logoAt < layout.indexOf("<RowIcon"),
    "the logo is the highlighted row's own mark and RowIcon is the other branch — the row never carries both",
  );

  // ── 9. The premium polish is DEPTH, and it costs the row no width ─────────────────────────────
  //
  // Owner, 2026-09-30: "it needs a more premium polish". The lever is depth — a white face, a warm
  // hairline, one soft orange shadow — because the two other levers are closed: corners must stay
  // square (and the standing note on restoring premium polish from history says to take the depth
  // ONLY, never the radius), and a resting tint is the active row's signal, pinned above.
  //
  // It is a LAYER behind the link rather than a border on it. A border on the row would push the
  // label a pixel off the siblings' left edge and widen the row; this cannot.
  const plateAt = layout.indexOf('className="pointer-events-none absolute inset-0 border border-[#F3D8C4] bg-white shadow-');
  assert.ok(plateAt > 0, "the standout row is lifted by a plate: a white face, a warm hairline and a soft orange shadow");
  const linkOpensAt = layout.lastIndexOf("<Link", labelAt);
  assert.ok(
    plateAt < linkOpensAt,
    "the plate is drawn BEFORE the link, so it paints behind the row rather than over its text",
  );
  const plateEndsAt = layout.indexOf("/>", plateAt);
  assert.ok(
    !layout.slice(plateAt, plateEndsAt).includes("rounded"),
    "the plate is square — the premium treatment takes the depth only, never the radius",
  );

  // ── 8. Phoenix CRM is its own band, ABOVE My Workspace ────────────────────────────────────────
  //
  // Owner, 2026-09-30: "move it above the workspace, my workspace". Three places have to agree or the
  // band is half-built: the section itself, the collapsed rail's icon map (the collapsed sidebar is
  // NOTHING but that strip of icons), and the native module mirror — the last of which has its own
  // drift test.
  const crmBandAt = layout.indexOf('title: "Phoenix CRM",');
  const workspaceAt = layout.indexOf('title: "My Workspace",');
  assert.ok(crmBandAt > 0 && workspaceAt > 0, "both bands are still built");
  assert.ok(crmBandAt < workspaceAt, "the Phoenix CRM band sits ABOVE My Workspace");
  assert.match(
    layout,
    /title: "Phoenix CRM",\s*\n\s*hideTitle: true,/,
    "the band has no header — the one row already carries the name, and a headerless band cannot fold away",
  );
  assert.match(
    layout,
    /if \(title === "Phoenix CRM"\) return ClipboardList;/,
    "the collapsed rail can name the band — without an entry it would draw the fallback glyph",
  );
}
