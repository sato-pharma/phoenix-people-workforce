import { canonicalSalesLine } from "../sales/others.ts";

import type { BusinessScope } from "../auth/permissions.ts";

type LineScopedEntity = {
  line?: string | null;
  lineId?: number | null;
  lineName?: string | null;
};

export type PortalSalesLineScope = {
  lineCandidates: string[];
  lineId: number | null;
  lineName: string | null;
};

function normalizeLineName(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function canonicalPortalSalesLine(value: string) {
  const line = canonicalSalesLine(value);
  if (line.includes("anti") && (line.includes("inf") || line.includes("infect"))) {
    return "anti infective";
  }
  return line;
}

function uniqueLines(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];

  values.forEach((value) => {
    const normalized = String(value ?? "").trim();
    const key = normalizeLineName(normalized);
    if (!normalized || seen.has(key)) return;
    seen.add(key);
    result.push(normalized);
  });

  return result;
}

export function portalSalesLinesMatch(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  const leftText = String(left ?? "").trim();
  const rightText = String(right ?? "").trim();
  if (!leftText || !rightText) return false;

  return (
    normalizeLineName(leftText) === normalizeLineName(rightText) ||
    canonicalPortalSalesLine(leftText) === canonicalPortalSalesLine(rightText)
  );
}

export function createPortalSalesLineScope({
  fallbackLine,
  lineId,
  lineName,
}: {
  fallbackLine?: string | null;
  lineId?: number | null;
  lineName?: string | null;
}): PortalSalesLineScope {
  const lineCandidates = uniqueLines([lineName, fallbackLine]);

  return {
    lineCandidates,
    lineId: typeof lineId === "number" ? lineId : null,
    lineName: lineCandidates[0] ?? null,
  };
}

export function lineMatchesPortalSalesScope(
  line: string | null | undefined,
  scope: Pick<PortalSalesLineScope, "lineCandidates">,
) {
  return scope.lineCandidates.some((candidate) =>
    portalSalesLinesMatch(line, candidate),
  );
}

export function employeeMatchesPortalSalesScope(
  employee: LineScopedEntity,
  scope: PortalSalesLineScope,
) {
  if (
    scope.lineId !== null &&
    typeof employee.lineId === "number" &&
    employee.lineId === scope.lineId
  ) {
    return true;
  }

  const employeeLine = employee.lineName ?? employee.line ?? null;
  return lineMatchesPortalSalesScope(employeeLine, scope);
}

export function salesRecordMatchesPortalSalesScope(
  record: Pick<LineScopedEntity, "line">,
  scope: PortalSalesLineScope,
) {
  if (!record.line || scope.lineCandidates.length === 0) return true;
  return lineMatchesPortalSalesScope(record.line, scope);
}

/**
 * The scopes that mean the viewer actually sells something. Anything else — NONE, or a value this
 * build does not recognise — is not a selling viewer.
 */
const SELLING_SALES_SCOPES = new Set<BusinessScope>(["SELF", "TEAM", "HIERARCHY", "LINE", "COMPANY"]);

/**
 * Whether a dashboard should render its sales panels at all.
 *
 * DELIBERATELY FAIL-CLOSED: this asks for membership of the selling set rather than `!== "NONE"`,
 * so an absent or unrecognised scope hides the panels instead of showing them. The two failures
 * are not symmetric. A rep who loses their dashboard says so within the hour; a non-selling viewer
 * shown a zeroed one is told silently, every day, that their achievement is 0.0% and needs
 * attention. That second failure is the one this function exists to end, so it takes the safe side.
 */
export function shouldRenderSalesPanels(viewerSalesScope: BusinessScope | null | undefined): boolean {
  return viewerSalesScope ? SELLING_SALES_SCOPES.has(viewerSalesScope) : false;
}
