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
      /import \{ phoenixCrmEntryAvailable \} from "@\/lib\/phoenix-crm\/server\/page";/,
      `${path} asks the module's own gate rather than inventing a second one`,
    );
    assert.match(
      text,
      /phoenixCrmEntryAvailable\(access\)\.catch\(\(\) => false\)/,
      `${path} fails the gate closed — a CRM outage costs the row, never the page`,
    );
    const call = /resolveEmployeePortalNavVisibility\(([\s\S]*?)\n  \);/.exec(text);
    assert.ok(call, `${path} still resolves the portal nav visibility`);
    assert.match(
      call[1],
      /phoenixCrm,\s*$/,
      `${path} passes the gate's answer through as the last argument, or its sidebar loses the row`,
    );
  }

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
  const railClass = 'className="pointer-events-none absolute inset-y-0 left-0 w-[2px] bg-[#F05A1A]"';
  const labelAt = layout.indexOf('<span className={locked ? "opacity-70" : undefined}>{item.label}</span>');
  assert.ok(labelAt > 0, "the row still renders its label span");
  const linkClosesAt = layout.indexOf("</Link>", labelAt);
  const railAt = layout.indexOf(railClass);
  assert.ok(railAt > 0, "the highlighted row draws an orange rail on its left edge");
  assert.ok(
    railAt > linkClosesAt && linkClosesAt > labelAt,
    "the rail sits AFTER the link, outside the row's flex line — inside it, it would add width and wrap a long label",
  );
}
