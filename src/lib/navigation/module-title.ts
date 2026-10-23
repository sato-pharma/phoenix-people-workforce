// ─────────────────────────────────────────────────────────────────────────────
// Phoenix Workforce — what the browser tab is called.
//
// ONE resolver, shared by both halves of the answer, because both have to agree or
// the tab's name visibly flickers as a page loads:
//
//   • the SERVER half — `generateMetadata` in the two shell layouts. This is what
//     names a tab on its FIRST paint: a link opened in a new tab, a bookmark, a
//     pasted URL, the entry the browser writes into its history list. Nothing a
//     client effect does can reach those, because they are read before any script
//     of ours has run.
//   • the CLIENT half — `DocumentTitleSync`, which renames the tab on in-app
//     navigation, where a parent layout's `generateMetadata` never runs again.
//
// The name is the MODULE the viewer is in, and it has TWO sources, in this order.
//
// FIRST, the label the page's own sidebar row carries. That is what keeps the tab
// agreeing with the rail beside it, and it covers detail routes with no row of their
// own (`/employee-portals/employee-360/a-12`) by the same longest-prefix rule the
// sidebar highlights with.
//
// SECOND, the address itself — and this is NOT a rare fallback, so do not treat it as
// one. Measured 2026-09-04: a nav row names 57 of the portal's 118 routes and 170 of
// the admin shell's 260. The rest are reached from hub cards and from role-gated
// sections the seed config does not enumerate, and for those the address is the only
// thing that names them. It also covers whatever page is added next, before anyone
// remembers to give it a row.
//
// Which is why `nameFromSegments` composes rather than taking the last segment: the
// leaf alone gives `/coaching/analytics` and `/probation/analytics` the same tab name,
// which is the exact indistinguishable-tabs problem this file exists to fix, reproduced
// one level down.
// ─────────────────────────────────────────────────────────────────────────────

import { getNavigationSections, type NavigationSectionItem } from "@/config/system-navigation";
import { systemIdentity } from "@/config/system-settings";
import { isUuid } from "@/lib/http/uuid";
import type { NavigationMode, PhoenixRole } from "@/lib/auth/permissions";
import { getActiveHref, getSections, normalizePathnameForMode } from "@/lib/navigation/active-path";

/** Module and brand are joined by a middot, matching the app's own heading style. */
export const TITLE_SEPARATOR = " · ";

/**
 * Spellings the humanizer must not sentence-case. Only forms that actually occur in a
 * route segment today are listed — an open-ended dictionary would be guesswork, and a
 * wrong expansion is worse than a plain capitalisation.
 */
const SEGMENT_ACRONYMS: Readonly<Record<string, string>> = {
  ats: "ATS",
  crm: "CRM",
  cv: "CV",
  dsms: "DSMs",
  dv: "DV",
  hr: "HR",
  kpis: "KPIs",
  roi: "ROI",
  sfe: "SFE",
};

/**
 * A path segment as it was written, not as the browser escaped it.
 *
 * `location.pathname` keeps percent-encoding, so the Call rate drill-down key `crm:1468` reaches
 * the CLIENT half as `crm%3A1468` and the SERVER half as `crm:1468` — one page, two spellings, and
 * the tab visibly renamed itself between them. Decoding first means every test below sees one
 * shape. `decodeURIComponent` throws on a malformed escape (a lone `%`), and a bad URL must not
 * take the title resolver down with it, so a segment that will not decode keeps its raw form.
 */
function decodeSegment(segment: string): string {
  if (!segment.includes("%")) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Is this segment an identifier rather than a name?
 *
 * Detail routes end in one, and an id is never a module name — "A 12" is not a page.
 * The `letter-digits` shape is here for HR ids specifically: they are spelled `a-12`,
 * which is otherwise indistinguishable from an ordinary hyphenated word.
 */
function looksLikeIdentifier(rawSegment: string): boolean {
  const segment = decodeSegment(rawSegment);
  if (/^\d+$/.test(segment)) return true;
  if (isUuid(segment)) return true;
  if (/^[a-z]{1,3}-\d+$/i.test(segment)) return true;
  // A `kind:value` composite key. `repKeyOf` in crm/reps-plans.ts emits three of them — `crm:1468`,
  // `hr:b-141` and `name:Bishoy Bahaa` — and the Call rate drill-down under Reps List (the Reps Plans
  // one until the 2026-09-21 merge) carries one as its whole path segment, in both shells. None of the shapes above matches, so the key was falling through
  // to the humanizer and naming the tab `Crm%3A1468` on a page whose body reads "Bishoy Bahaa".
  //
  // The COLON alone is the test, and the value half is deliberately unconstrained: no module in
  // either shell has a colon in its name, while `name:` carries whatever the CRM holds — a rule
  // written against `crm`/`hr` would keep titling a tab "Name:bishoy Bahaa", which is the same
  // defect with a friendlier face.
  if (segment.includes(":")) return true;
  // A long unbroken token is a token, not a phrase — share links carry one.
  return segment.length >= 24 && !segment.includes("-");
}

/** `private-calendar` -> `Private Calendar`, `contact-hr-support` -> `Contact HR Support`. */
export function humanizeSegment(segment: string): string {
  return decodeSegment(segment)
    .split("-")
    .filter(Boolean)
    .map((word) => SEGMENT_ACRONYMS[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Leaf segments that do not name a page on their own, and what to do about each kind.
 *
 * This is the whole point of the exercise, not a refinement of it. `/coaching/analytics` and
 * `/probation/analytics` both end in the same word, so naming a tab from the leaf alone gives
 * two tabs called "Analytics" — which is the state the owner asked to be rid of, reproduced
 * one level down. The parent segment is what tells them apart.
 *
 * An ACTION reads in front of its subject ("New Coaching"); a FACET reads behind it
 * ("Coaching Analytics"). Both lists are closed and short on purpose: a segment that is not in
 * either is a page name in its own right and must be left exactly as it is written.
 */
const ACTION_SEGMENTS = new Set(["new", "edit", "create", "import", "export", "upload"]);
const FACET_SEGMENTS = new Set([
  "all",
  "analytics",
  "archived",
  "calendar",
  "control",
  "dashboard",
  "detail",
  "inbox",
  "list",
  "overview",
  "report",
  "reports",
  "screening",
  "settings",
  "summary",
  "view",
]);

/**
 * `["coaching","analytics"]` -> `Coaching Analytics`; `["coaching","new"]` -> `New Coaching`.
 *
 * CONSERVATIVE on purpose — it composes a parent in only for the two segment classes above.
 * These segments are the whole path, so an eager rule would prefix the shell itself and turn
 * `/employee-portals/crm` into "Employee Portals CRM".
 */
function nameFromSegments(segments: readonly string[]): string | null {
  const leaf = segments[segments.length - 1];
  if (!leaf) return null;
  const parent = segments[segments.length - 2];
  if (!parent) return humanizeSegment(leaf);
  const key = leaf.toLowerCase();
  if (ACTION_SEGMENTS.has(key)) return `${humanizeSegment(leaf)} ${humanizeSegment(parent)}`;
  if (FACET_SEGMENTS.has(key)) return `${humanizeSegment(parent)} ${humanizeSegment(leaf)}`;
  return humanizeSegment(leaf);
}

/**
 * The name for a page that sits BELOW the nav row that matched it.
 *
 * A row is matched by prefix, so one row claims everything beneath it — and taking its label
 * would then name every page under it identically. Measured 2026-09-04, that is not a corner
 * case: fifteen pages under `/employee-portals/sales-analytics` (a module retired on 2026-09-17)
 * would all have opened a tab called "Sales Analytics", and four under `/employee-portals/marketing-requests` a tab called
 * "Marketing Requests". Since the tab exists to tell pages apart, the part of the address BELOW
 * the row is the part that has to speak.
 *
 * `remainder` is what is left of the path after the row's own href, already stripped of
 * identifier segments — so a plain detail route arrives here empty and keeps the row's label,
 * which is what a detail page wants.
 */
function nameUnderNavRow(remainder: readonly string[], rowLabel: string): string {
  const leaf = remainder[remainder.length - 1];
  if (!leaf) return rowLabel;
  const key = leaf.toLowerCase();
  // Two levels down, the deeper pair says it best on its own: "Weekly Sales By Distributor"
  // beats "Sales Analytics By Distributor", and beats the whole address spelled out.
  const parentName = remainder.length >= 2 ? humanizeSegment(remainder[remainder.length - 2]) : rowLabel;
  if (ACTION_SEGMENTS.has(key)) return `${humanizeSegment(leaf)} ${parentName}`;
  if (FACET_SEGMENTS.has(key) || remainder.length >= 2) return `${parentName} ${humanizeSegment(leaf)}`;
  return humanizeSegment(leaf);
}

/**
 * Which of several rows sharing one href this viewer actually sees, and what THEY call it.
 *
 * Two rows can legitimately name the same address under mutually exclusive role gates —
 * `/employee-portals/coaching` is "My Coaching Reports" to a Medical Rep and "Team Coaching
 * Reports" to their District Manager. Taking the first match would put the rep's wording on
 * the manager's tab, which is not merely untidy: the tab would contradict the rail beside it.
 *
 * The same reasoning covers `labelByRole`, where one row is worded differently per role.
 * This deliberately does NOT gate on permissions — it is choosing a NAME for a page the
 * viewer has already been served, never deciding what they may open.
 */
function pickLabelForRole(items: readonly NavigationSectionItem[], role?: PhoenixRole): string | undefined {
  if (!items.length) return undefined;
  const owned = role ? items.find((item) => item.roles?.includes(role)) : undefined;
  const ungated = items.find((item) => !item.roles?.length);
  const item = owned ?? ungated ?? items[0];
  return (role && item.labelByRole?.[role]) || item.label;
}

/**
 * The label the sidebar row at `href` carries for `role` — the row's own words, exactly as the rail
 * draws them, and NEVER a name composed from the address below the row (that is what
 * `resolveModuleName` does for a tab, where telling sibling pages apart is the point). Null when no
 * row of this mode has that href.
 *
 * For the System Audit, whose column 3 must be the module name the person saw in their sidebar, not
 * a derived one. FIRST the row the rail itself draws for the role — `getSections`, the sidebar's own
 * gating, relabelling and first-copy-wins dedupe — so a link listed twice reads as the copy the
 * person was shown. Only when the role is not offered the row at all (a permission the person held
 * that day, a seat fence) does it fall back to the per-role pick, with every copy whose
 * `excludedRoles` names the role set aside — the gate the rail never waives.
 */
const railLabelCache = new Map<string, Map<string, string>>();

function railLabels(mode: NavigationMode, role: PhoenixRole): Map<string, string> {
  const cacheKey = `${mode}\u0000${role}`;
  const cached = railLabelCache.get(cacheKey);
  if (cached) return cached;
  const labels = new Map<string, string>();
  for (const section of getSections(getNavigationSections(mode), mode, {}, role)) {
    for (const item of section.items) if (!labels.has(item.href)) labels.set(item.href, item.label);
  }
  railLabelCache.set(cacheKey, labels);
  return labels;
}

export function sidebarRowLabel(href: string, mode: NavigationMode, role?: PhoenixRole): string | null {
  if (role) {
    const drawn = railLabels(mode, role).get(href);
    if (drawn) return drawn;
  }
  const items = getNavigationSections(mode)
    .flatMap((section) => section.items)
    .filter((item) => item.href === href);
  const offered = role ? items.filter((item) => !item.excludedRoles?.includes(role)) : items;
  return pickLabelForRole(offered.length > 0 ? offered : items, role) ?? null;
}

/**
 * The module name for an address, or `null` when the address names nothing at all.
 *
 * `pathAndQuery` may carry a query string, and it matters: `?tab=`/`?action=` is how
 * two sidebar rows share one path, so dropping it would name the tab after the wrong
 * one of the pair. The two parameter names are read in the sidebar's own order.
 */
export function resolveModuleName(
  pathAndQuery: string,
  mode: NavigationMode,
  role?: PhoenixRole,
): string | null {
  const [rawPath = "", rawQuery = ""] = pathAndQuery.split("#")[0].split("?");
  if (!rawPath.startsWith("/")) return null;

  const query = new URLSearchParams(rawQuery);
  const activeTab = query.get("action") ?? query.get("tab");
  const pathname = normalizePathnameForMode(rawPath, mode);

  const sections = getNavigationSections(mode);
  const activeHref = getActiveHref(pathname, sections, activeTab);
  if (activeHref) {
    const label = pickLabelForRole(
      sections.flatMap((section) => section.items).filter((item) => item.href === activeHref),
      role,
    );
    if (label) {
      // The row was matched by prefix, so the page may sit below it — name it from what is
      // below, or every page under one row opens an identically named tab.
      const remainder = pathname
        .slice(activeHref.split("?")[0].length)
        .split("/")
        .filter(Boolean)
        .filter((segment) => !looksLikeIdentifier(segment));
      return nameUnderNavRow(remainder, label);
    }
  }

  // No row owns this address — derive a name from the address itself. Identifier
  // segments are dropped first so a detail route is named after its page, not its row id.
  const named = pathname.split("/").filter(Boolean).filter((segment) => !looksLikeIdentifier(segment));
  return nameFromSegments(named);
}

/**
 * Where a module name came from: a sidebar row, or the address.
 *
 * Exists for `tests/module-tab-titles.test.ts`, which polices duplicate tab names and has to
 * tell the two apart. A duplicate this file DERIVED is its own defect; a duplicate it INHERITED
 * from two rows the config gives the same label is the app's own naming, and the tab mirroring
 * the rail faithfully is the correct behaviour there, not a bug to route around here.
 */
export function moduleNameSource(pathAndQuery: string, mode: NavigationMode): "nav" | "address" | "none" {
  const [rawPath = "", rawQuery = ""] = pathAndQuery.split("#")[0].split("?");
  if (!rawPath.startsWith("/")) return "none";
  const query = new URLSearchParams(rawQuery);
  const pathname = normalizePathnameForMode(rawPath, mode);
  const activeHref = getActiveHref(pathname, getNavigationSections(mode), query.get("action") ?? query.get("tab"));
  return activeHref ? "nav" : "address";
}

/** The full `document.title` for an address: `Module · Phoenix Workforce`. */
export function resolveDocumentTitle(
  pathAndQuery: string,
  mode: NavigationMode,
  role?: PhoenixRole,
): string {
  const moduleName = resolveModuleName(pathAndQuery, mode, role);
  return moduleName ? `${moduleName}${TITLE_SEPARATOR}${systemIdentity.appName}` : systemIdentity.appName;
}
