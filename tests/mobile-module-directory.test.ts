import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PORTAL_NAV_REGISTRY,
  isEntryVisible,
} from "../src/components/employee-portal/employee-portal-nav-registry.ts";
import {
  NATIVE_MODULE_SECTION_ORDER,
  buildNativePortalModuleDirectory,
  nativeModulePlacements,
} from "../src/lib/employee-portal/native-module-directory.ts";
import type { EmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";

/**
 * The Android app lists EVERY module the portal lists for the same person, and cannot drift from it.
 *
 * The owner's instruction on 2026-09-28 was "same module same design same everything": the app had
 * three screens against the portal's sixty-odd modules, so one employee opening Phoenix on a tablet
 * and in a browser saw two different products.
 *
 * The fix is a list built from `PORTAL_NAV_REGISTRY` — already held level with the sidebar in BOTH
 * directions by `employee-portal-bottom-nav.test.ts` — plus two things a registry row cannot carry
 * across JSON: which sidebar SECTION it belongs to, and an Ionicons name, because a Lucide component
 * neither serialises nor renders in React Native.
 *
 * Those two are mirrored, so this test is the thing that keeps them honest. It re-derives the
 * sections from `employee-portal-layout.tsx` itself, exactly the way the bottom-nav guard re-derives
 * hrefs, and fails in EITHER direction — a module added to the sidebar with no placement, or a
 * placement left behind by a module that moved. Without it the failure is silent and invisible for
 * months: a new module simply never appears on the phone, and nothing anywhere goes red.
 */

/** The sidebar's own sections, in its own order, with the hrefs each one declares. */
function sidebarSections(): { hrefs: string[]; title: string }[] {
  const source = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  const start = source.indexOf("}: EmployeePortalNavVisibility): EmployeePortalNavSection[] {");
  assert.ok(start > 0, "buildEmployeePortalSections must still be findable in the layout");
  // The builder's body ends at the `.filter(` that drops empty sections.
  const end = source.indexOf(".filter(", start);
  assert.ok(end > start, "the section builder must still end with its empty-section filter");
  const body = source.slice(start, end);

  const sections: { hrefs: string[]; title: string }[] = [];
  const pattern = /title:\s*"([^"]+)"|href:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (match[1]) {
      sections.push({ hrefs: [], title: match[1] });
    } else if (match[2] && sections.length > 0) {
      sections[sections.length - 1]!.hrefs.push(match[2]);
    }
  }
  return sections;
}

/** Every flag off — the narrowest viewer there is. */
function noFlags(): EmployeePortalNavVisibility {
  const visibility: Record<string, boolean> = {};
  for (const entry of PORTAL_NAV_REGISTRY) {
    for (const flag of entry.flags ?? []) visibility[flag] = false;
  }
  return visibility as EmployeePortalNavVisibility;
}

/** Every flag on — what the Super Admin's list is built from. */
function allFlags(): EmployeePortalNavVisibility {
  const visibility: Record<string, boolean> = {};
  for (const entry of PORTAL_NAV_REGISTRY) {
    for (const flag of entry.flags ?? []) visibility[flag] = true;
  }
  return visibility as EmployeePortalNavVisibility;
}

export function runMobileModuleDirectoryTests() {
  const placements = nativeModulePlacements();
  const sidebar = sidebarSections();

  // ── The sections, and their order, are the sidebar's ──────────────────────────────────────────
  // Filtered to the sections that actually declare a destination: "Recruitment & Hiring" and
  // "People Management" are deliberately empty in the sidebar (the retired Talent Acquisition seat's
  // tooling), and the sidebar drops an empty section itself.
  const sidebarOrder = sidebar.filter((section) => section.hrefs.length > 0).map((s) => s.title);
  assert.deepEqual(
    [...NATIVE_MODULE_SECTION_ORDER],
    sidebarOrder,
    "the app's section titles and their order must be the sidebar's own — a renamed or reordered sidebar section has to reach the phone",
  );

  // ── Every module has a placement, in the section the sidebar files it under ────────────────────
  // A module the sidebar lists twice (My Coaching Reports, Report It) is filed under the FIRST
  // section, because this list shows each module once.
  const firstSectionOf = new Map<string, string>();
  for (const section of sidebar) {
    for (const href of section.hrefs) {
      if (!firstSectionOf.has(href)) firstSectionOf.set(href, section.title);
    }
  }

  const registryHrefs = new Set<string>();
  for (const entry of PORTAL_NAV_REGISTRY) {
    registryHrefs.add(entry.href);

    const placement = placements[entry.href];
    assert.ok(
      placement,
      `${entry.href} is in the portal nav registry with no native placement: it would be missing from the app's Modules list, silently. Add it to MODULE_PLACEMENT in src/lib/employee-portal/native-module-directory.ts.`,
    );
    assert.equal(
      placement.section,
      firstSectionOf.get(entry.href),
      `${entry.href} is filed under "${placement.section}" for the app but under "${String(firstSectionOf.get(entry.href))}" in the sidebar`,
    );
    assert.match(
      placement.icon,
      /^[a-z][a-z0-9-]*$/,
      `${entry.href} needs a real Ionicons glyph name — a blank or mistyped one renders as nothing, which reads as a broken row`,
    );
  }

  // ── And no placement outlives its module ───────────────────────────────────────────────────────
  for (const href of Object.keys(placements)) {
    assert.ok(
      registryHrefs.has(href),
      `${href} has a native placement but is no longer in the portal nav registry — remove it rather than leaving a dead row's icon behind`,
    );
  }

  // ── The viewer's own list ──────────────────────────────────────────────────────────────────────
  const everything = buildNativePortalModuleDirectory({ lockedModuleKeys: [], visibility: allFlags() });
  assert.ok(everything.length >= 8, "a viewer with every flag on should see most of the sidebar's sections");
  assert.deepEqual(
    everything.map((section) => section.title),
    NATIVE_MODULE_SECTION_ORDER.filter((title) => everything.some((s) => s.title === title)),
    "sections come back in the sidebar's order, never in registry order",
  );

  const flatHrefs = everything.flatMap((section) => section.modules.map((module) => module.href));
  assert.equal(
    flatHrefs.length,
    new Set(flatHrefs).size,
    "a module appears once — the sidebar lists Coaching and Report It twice and the app must not",
  );
  const expectedVisible = new Set(
    PORTAL_NAV_REGISTRY.filter((entry) => isEntryVisible(entry, allFlags())).map((entry) => entry.href),
  );
  assert.deepEqual(
    new Set(flatHrefs),
    expectedVisible,
    "every visible registry entry reaches the app's list, and nothing else does",
  );

  // Labels are the DESCRIPTIVE names, never the bottom bar's width-bound short forms: the app has a
  // full-width row, and "Vac Appr" on a list with room for "Leave Approvals" is a worse screen.
  const leaveApprovals = everything
    .flatMap((section) => section.modules)
    .find((module) => module.href === "/employee-portals/approvals/vacation");
  assert.equal(leaveApprovals?.label, "Leave Approvals", "rows carry fullLabel, not the bar's short label");
  assert.equal(leaveApprovals?.badge, "vacation-approvals-pending", "a queue's pending badge reaches the phone");

  // ── Visibility is the registry's, not a second opinion ─────────────────────────────────────────
  const narrowest = buildNativePortalModuleDirectory({ lockedModuleKeys: [], visibility: noFlags() });
  const narrowHrefs = new Set(narrowest.flatMap((section) => section.modules.map((m) => m.href)));
  for (const entry of PORTAL_NAV_REGISTRY) {
    const flagged = (entry.flags ?? []).length > 0;
    assert.equal(
      narrowHrefs.has(entry.href),
      !flagged,
      `${entry.href} with every flag off should ${flagged ? "not " : ""}be listed`,
    );
  }

  // ── A locked module keeps its row, wearing a padlock ───────────────────────────────────────────
  // Taking it away would say "this was removed", which is harsher than the administrator chose; the
  // web sidebar keeps it for exactly that reason, and the page behind it refuses itself either way.
  const locked = buildNativePortalModuleDirectory({
    lockedModuleKeys: ["payslips"],
    visibility: allFlags(),
  });
  const payslips = locked
    .flatMap((section) => section.modules)
    .find((module) => module.href === "/employee-portals/payslips");
  assert.ok(payslips, "a locked module is still listed");
  assert.equal(payslips?.locked, true, "and is marked locked, so the app can draw the padlock");

  // ── The route asks exactly what the portal shell asks ──────────────────────────────────────────
  const route = readFileSync("app/api/employee-portals/navigation/route.ts", "utf8");
  assert.match(
    route,
    /assertPermission\(access,\s*"employee_profile",\s*"read"\)/,
    "the navigation route asserts the same gate EmployeePortalServerShell asserts before it renders anything",
  );
  assert.match(
    route,
    // TEN since 2026-10-13, when the gate gained `placeChecks`. The count is not the point and never
    // was — the ORDER is, because every input is a boolean or a string and a swapped pair type-checks
    // perfectly while answering about somebody else. So each argument is named, and an input added to
    // the shell without being added here leaves this list short and fails.
    /resolveEmployeePortalNavVisibility\(\s*data\.employee\.roleLabel,\s*access\.role,\s*data\.employee\.line,\s*data\.employee\.department,\s*data\.employee\.hrId,\s*hasDeviceMapping,\s*sharedInterviewCalendar,\s*phoenixCrm\.crm,\s*phoenixCrm\.forecast,\s*phoenixCrm\.placeChecks,\s*phoenixCrm\.doubleVisitRequests,\s*phoenixCrm\.myMap,\s*\)/,
    "visibility is resolved with the shell's own twelve inputs in the shell's own order — a reordered argument list silently hands the phone a different role's list",
  );

  // ── The screen obeys the two look rules that a list like this breaks first ─────────────────────
  const screen = readFileSync("mobile/src/app/(portal)/modules.tsx", "utf8");
  // `numberOfLines` and `ellipsizeMode` are the only two ways React Native truncates, and both are
  // banned here: a clipped module name is exactly the ellipsis the owner's rule forbids. (A literal
  // "…" is fine — "Loading your modules…" is a sentence, not a cut-off name.)
  assert.ok(
    !/numberOfLines/.test(screen) && !/ellipsizeMode/.test(screen),
    "no module name is ever truncated — where that collides with fitting the screen, wrapping wins",
  );
  // Comments stripped first — this file's own header explains WHY there is no horizontal scroll, and
  // a scan that reads its own explanation as the defect is a check that can only ever fail.
  const screenCode = screen.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(
    !/\bhorizontal\b/.test(screenCode),
    "never a horizontal scroll, at any width — no ScrollView here may carry `horizontal`",
  );
  assert.match(
    screen,
    /openPortalModule\(/,
    "rows open through the signed-in hand-off, never a raw browser call that would land a rep on the login page",
  );
}
