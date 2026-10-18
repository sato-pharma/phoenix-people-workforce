/**
 * Who may see which customers — and why the PICKER is filtered, not just the page.
 *
 * A Customer 360 list is a picker, and a picker wider than its viewer leaks by itself: the names it
 * offers are the disclosure, whether or not anything is clicked. This repository has already been
 * bitten by exactly that — a cached company-wide filter tree once offered a Medical Rep the names
 * of every rep in the company, and an org walk that climbed to the top presented the whole board's
 * scope as one person's own panel. So the viewer's scope is applied to the LIST, not only to the
 * queries the detail page runs.
 *
 * The bound is applied in the order the sales scope itself ranks them:
 *
 *  1. `canViewAllSales` — a COMPANY-scope role (Super Admin, CEO, and the other company roles).
 *  2. `allowedAreaCodes` — authoritative when present. It is the only signal that survives an area
 *     whose operational owner differs from its geography, so where it exists it is the whole answer
 *     and no wider bound is consulted.
 *  3. `allowedRegionNames` — the fallback bound for roles with no seat-resolved area set.
 *  4. `allowedLineNames` — narrows further when the subject knows its line.
 *
 * If none of those resolves, the answer is an empty list, not the whole company. A viewer seeing
 * nothing is a support question; a viewer seeing everyone else's customers is a data leak.
 */

import type { CustomerSubjectSummary } from "./service";

export type CustomerVisibilityScope = {
  readonly allowedAreaCodes: ReadonlySet<string> | null;
  readonly allowedLineNames: ReadonlySet<string> | null;
  readonly allowedRegionNames: ReadonlySet<string> | null;
  readonly canViewAllSales: boolean;
};

const norm = (value: string | null | undefined): string => (value ?? "").trim().toUpperCase();

function hasNormalized(set: ReadonlySet<string> | null, value: string | null): boolean {
  if (!set) return false;
  const needle = norm(value);
  if (!needle) return false;
  for (const entry of set) {
    if (norm(entry) === needle) return true;
  }
  return false;
}

/**
 * Narrow a subject list to what this viewer is allowed to be offered.
 *
 * Pure on purpose: the scope is resolved once by the caller and the decision itself is a function
 * of data, so the fail-closed branch can be proved in a test without a database or a session.
 */
export function filterCustomerSubjectsForViewer(
  subjects: readonly CustomerSubjectSummary[],
  scope: CustomerVisibilityScope,
): CustomerSubjectSummary[] {
  if (scope.canViewAllSales) return [...subjects];

  // An area bound, where it exists, is the authoritative geography and the whole answer.
  if (scope.allowedAreaCodes) {
    return subjects.filter((subject) => hasNormalized(scope.allowedAreaCodes, subject.areaCode));
  }

  if (scope.allowedRegionNames) {
    return subjects.filter((subject) => {
      if (!hasNormalized(scope.allowedRegionNames, subject.regionName)) return false;
      // A line bound narrows further, but only where the subject actually declares a line —
      // a direct-order pharmacy carries none, and dropping it here would hide real customers.
      if (scope.allowedLineNames && subject.lineName) {
        return hasNormalized(scope.allowedLineNames, subject.lineName);
      }
      return true;
    });
  }

  // No bound resolved and the viewer is not a company-scope role: show nothing.
  return [];
}

/** True when this viewer may open this particular customer. The detail page's own gate. */
export function canViewCustomerSubject(
  subject: CustomerSubjectSummary,
  scope: CustomerVisibilityScope,
): boolean {
  return filterCustomerSubjectsForViewer([subject], scope).length === 1;
}

/** The geography a validated doctor or account is offered by: its validated place. */
export type HubGeography = { areaCode: string | null; regionName: string | null; lines: readonly string[] };

/**
 * The same bound, for Customer 360's validated doctors and accounts. A hub's geography is its
 * validated place; its lines are the lines that hold it validated or visit it. Fail-closed exactly as
 * {@link filterCustomerSubjectsForViewer}: no bound resolved means nothing offered.
 */
export function canViewHubGeography(hub: HubGeography, scope: CustomerVisibilityScope): boolean {
  if (scope.canViewAllSales) return true;
  if (scope.allowedAreaCodes) return hasNormalized(scope.allowedAreaCodes, hub.areaCode);
  if (scope.allowedRegionNames) {
    if (!hasNormalized(scope.allowedRegionNames, hub.regionName)) return false;
    if (scope.allowedLineNames && hub.lines.length > 0) {
      return hub.lines.some((line) => hasNormalized(scope.allowedLineNames, line));
    }
    return true;
  }
  return false;
}
