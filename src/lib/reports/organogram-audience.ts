/**
 * Organogram AUDIENCE — who a viewer has picked out of the chart, and what they can do
 * with that pick (copy their work emails, export them as a sheet).
 *
 * Domain-first: every rule lives here and the dialog is presentation only, so the
 * picker, the toolbar export and the tests all agree by construction.
 *
 * ## Scope is NOT enforced here
 *
 * This module only ever narrows the rows it is handed. The security boundary is
 * server-side, upstream, in `getOrganogramReport()` — a Product Manager receives her
 * line's rows, a Regional Manager only their own seat subtree, and Head Office is
 * stripped for anyone without `canAccessHeadOffice`. A filter here can subtract from
 * that, never add to it. Do not "improve" this by fetching rows client-side.
 *
 * ## Why work email is safe to carry in bulk
 *
 * Work email already sits in the SAFE (non-sensitive) "Contact" section of the
 * node-detail popup, which every organogram viewer can open on every person in scope
 * (organogram-employee-detail.ts). And the organogram itself is manager/head-office
 * only: `app/employee-portals/organogram/page.tsx` admits just the company-scoped and
 * line-scoped roles. So this changes the ergonomics of reaching those addresses, not
 * who may see them.
 *
 * ## The mobile number is in the SHEET only, and never on the row
 *
 * The mobile sits in that same safe Contact section, and on 2026-08-23 the owner asked for
 * it in the export. Two boundaries hold it in place:
 *
 * - **Not in the clipboard.** Copy exists to fill a To or Bcc field; a phone number in
 *   that string is noise at best.
 * - **Not on `OrganogramReportRow`.** The sheet is built in the browser, so a field on the
 *   row would hand every viewer's page every colleague's number on every load, exported or
 *   not. `buildOrganogramExportRows` takes the numbers as a separate argument instead,
 *   fetched from `/api/reports/organogram/contact-numbers` at the moment Export is pressed
 *   (`organogram-contact-numbers-client.ts`). `tests/organogram-whatsapp-gate.test.ts`
 *   pins the row half of that.
 */

import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import { formatDateOnly } from "@/lib/date-only";
import { canonicalHrIdKey } from "@/lib/hr-id";
import {
  normalizeSearchValue,
  rowKey,
  rowMatchesOrganogramSearch,
} from "@/lib/reports/organogram-view-model";
import type { OrganogramReportRow } from "@/lib/reports/vacancies";

/* ------------------------------------------------------------------ */
/*  Filters                                                            */
/* ------------------------------------------------------------------ */

export type OrganogramAudienceFacet = "lineNames" | "regionNames" | "areaNames" | "roles";

/** Facets are rendered in this order — widest structural grouping first. */
export const ORGANOGRAM_AUDIENCE_FACETS: OrganogramAudienceFacet[] = [
  "lineNames",
  "regionNames",
  "areaNames",
  "roles",
];

export const ORGANOGRAM_AUDIENCE_FACET_LABELS: Record<OrganogramAudienceFacet, string> = {
  areaNames: "Area",
  lineNames: "Line",
  regionNames: "Region",
  roles: "Role",
};

export type OrganogramAudienceFilters = {
  areaNames: string[];
  /** Vacant seats have nobody to email; off by default, on when exporting structure. */
  includeOpenSeats: boolean;
  lineNames: string[];
  regionNames: string[];
  roles: string[];
  search: string;
};

export const EMPTY_ORGANOGRAM_AUDIENCE_FILTERS: OrganogramAudienceFilters = {
  areaNames: [],
  includeOpenSeats: false,
  lineNames: [],
  regionNames: [],
  roles: [],
  search: "",
};

/**
 * The human role label for a row. Seat-sourced rows carry the tier title here
 * ("Medical Representative", "District Sales Manager"), so this groups by what the
 * chart actually draws — an acting DM groups with the district managers she stands in
 * for, which is the whole point of picking "every DM on this line".
 */
export function organogramAudienceRole(row: OrganogramReportRow): string {
  return row.positionTitle?.trim() || row.jobTitle?.trim() || "Unassigned";
}

const FACET_VALUE: Record<OrganogramAudienceFacet, (row: OrganogramReportRow) => string | null> = {
  areaNames: (row) => row.areaName,
  lineNames: (row) => row.lineName,
  regionNames: (row) => row.regionName,
  roles: (row) => organogramAudienceRole(row),
};

function matchesFacet(
  row: OrganogramReportRow,
  facet: OrganogramAudienceFacet,
  selected: string[],
): boolean {
  if (selected.length === 0) return true;
  // A row with no value for a facet under filter is OUT, never silently in: the CEO has
  // no line, so "everyone on Anti infective" must not sweep him up.
  const value = normalizeSearchValue(FACET_VALUE[facet](row));
  if (!value) return false;
  return selected.some((choice) => normalizeSearchValue(choice) === value);
}

/** Narrow the viewer's already-scoped rows to their current picks. Only ever subtracts. */
export function filterOrganogramAudience(
  rows: OrganogramReportRow[],
  filters: OrganogramAudienceFilters,
): OrganogramReportRow[] {
  const query = normalizeSearchValue(filters.search);

  return rows.filter((row) => {
    if (!filters.includeOpenSeats && row.type !== "employee") return false;
    for (const facet of ORGANOGRAM_AUDIENCE_FACETS) {
      if (!matchesFacet(row, facet, filters[facet])) return false;
    }
    return rowMatchesOrganogramSearch(row, query);
  });
}

export type OrganogramAudienceOptions = Record<OrganogramAudienceFacet, string[]>;

/**
 * The choices to offer for each facet, CASCADING: picking a line shrinks the region and
 * area lists to that line's, so the viewer never picks a combination that resolves to
 * nobody. Each facet's own selection is excluded from its own base set (otherwise the
 * list would collapse to what is already picked) and re-added afterwards, so a chip can
 * always be un-picked even when another facet has since excluded it.
 */
export function buildOrganogramAudienceOptions(
  rows: OrganogramReportRow[],
  filters: OrganogramAudienceFilters,
): OrganogramAudienceOptions {
  const options = {} as OrganogramAudienceOptions;

  for (const facet of ORGANOGRAM_AUDIENCE_FACETS) {
    const scoped = filterOrganogramAudience(rows, { ...filters, [facet]: [] });
    const values = new Set<string>();
    for (const row of scoped) {
      const value = FACET_VALUE[facet](row)?.trim();
      if (value) values.add(value);
    }
    for (const picked of filters[facet]) {
      const value = picked.trim();
      if (value) values.add(value);
    }
    options[facet] = [...values].sort((a, b) => a.localeCompare(b, "en"));
  }

  return options;
}

/* ------------------------------------------------------------------ */
/*  Selection                                                          */
/* ------------------------------------------------------------------ */

/** Stable per-row identity — the same key the chart uses, so a dual-seated person's
 *  two boxes stay two independent ticks. */
export function organogramAudienceKey(row: OrganogramReportRow): string {
  return rowKey(row);
}

/**
 * What the action buttons act on.
 *
 * Ticking nobody means "everyone I have filtered to" — that is the one-press path
 * (filter to a district, hit copy). Ticking anyone switches to exactly those ticks.
 * The tick set is intersected with the filtered rows, so a tick left behind by a
 * since-changed filter can never leak a person back into the list.
 */
export function resolveOrganogramAudienceSelection(
  filteredRows: OrganogramReportRow[],
  selectedKeys: ReadonlySet<string>,
): OrganogramReportRow[] {
  if (selectedKeys.size === 0) return filteredRows;
  return filteredRows.filter((row) => selectedKeys.has(organogramAudienceKey(row)));
}

/* ------------------------------------------------------------------ */
/*  Emails                                                             */
/* ------------------------------------------------------------------ */

/** Outlook's own separator. Gmail, Outlook Web and Apple Mail all accept it. */
export const ORGANOGRAM_EMAIL_SEPARATOR = "; ";

/**
 * The only domain a COPIED address may belong to. `employees.work_email` is a free-text
 * field, and on 2026-10-20 three newly hired reps had their personal Gmail typed into it
 * (one as `gamil.com`); the copy button pasted those into a company mail's To field. A
 * personal address is not a work email, so it never reaches the clipboard — the person is
 * listed as left out instead, exactly like someone with no address.
 */
export const ORGANOGRAM_COMPANY_EMAIL_DOMAIN = "satopharma.com";

export function isOrganogramCompanyEmail(email: string | null | undefined): boolean {
  const value = email?.trim().toLowerCase() ?? "";
  const at = value.lastIndexOf("@");
  if (at < 1) return false;
  const domain = value.slice(at + 1);
  return domain === ORGANOGRAM_COMPANY_EMAIL_DOMAIN || domain.endsWith(`.${ORGANOGRAM_COMPANY_EMAIL_DOMAIN}`);
}

export type OrganogramAudienceEmails = {
  emails: string[];
  /** People in the pick with no company work email — surfaced, never silently dropped. */
  missing: Array<{ hrId: string; name: string }>;
  /** Open seats in the pick, which have nobody to email. */
  openSeats: number;
};

export function organogramAudienceName(row: OrganogramReportRow): string {
  return row.displayName?.trim() || row.fullName?.trim() || row.hrId;
}

/**
 * Pull the work emails out of a pick.
 *
 * Deduplicates case-insensitively so a person holding two seats is mailed once, and
 * reports who was skipped so the count on screen can never be a misleading silent
 * subset ("copy 27" when 30 were ticked).
 */
export function collectOrganogramAudienceEmails(
  rows: OrganogramReportRow[],
): OrganogramAudienceEmails {
  const emails: string[] = [];
  const seen = new Set<string>();
  const missing: Array<{ hrId: string; name: string }> = [];
  let openSeats = 0;

  for (const row of rows) {
    if (row.type !== "employee") {
      openSeats += 1;
      continue;
    }
    const email = row.workEmail?.trim() ?? "";
    if (!isOrganogramCompanyEmail(email)) {
      missing.push({ hrId: row.hrId, name: organogramAudienceName(row) });
      continue;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }

  return { emails, missing, openSeats };
}

export function formatOrganogramEmailList(emails: string[]): string {
  return emails.join(ORGANOGRAM_EMAIL_SEPARATOR);
}

/* ------------------------------------------------------------------ */
/*  XLSX export                                                        */
/* ------------------------------------------------------------------ */

/**
 * The structure sheet's columns — the flattened SAFE sections of the node-detail popup
 * (Identity, Placement, Reporting & tenure, Contact).
 *
 * No column is `numeric`, so the builder adds no TOTAL row: summing HR IDs or hire
 * dates would be meaningless. **Do not add a salary, national ID, birth date, gender,
 * address or bank column here** — see OrganogramWorkFields. Contact details stop at the
 * work email and the mobile, which is where the popup's safe section stops too.
 */
export const ORGANOGRAM_EXPORT_COLUMNS: ExportColumn[] = [
  { key: "hrId", label: "HR ID", width: 12 },
  { key: "name", label: "Name", width: 28 },
  { key: "nameAr", label: "Arabic Name", width: 24 },
  { key: "title", label: "Title", width: 26 },
  { key: "hrJobTitle", label: "HR Job Title", width: 26 },
  { key: "type", label: "Type", width: 11 },
  { key: "status", label: "Status", width: 12 },
  { key: "workEmail", label: "Work Email", width: 32 },
  // Filled from the server at export time, never from the row. `text` keeps Excel from
  // eating the leading zero — which is exactly how 124 of the 175 rows in
  // `employees.mobile_number` lost theirs before they ever reached this app.
  { key: "mobile", label: "Mobile", text: true, width: 16 },
  { key: "department", label: "Department", width: 18 },
  { key: "line", label: "Line", width: 18 },
  { key: "region", label: "Region", width: 18 },
  { key: "area", label: "Area", width: 18 },
  { key: "team", label: "Team", width: 16 },
  { key: "hireDate", label: "Hire Date", width: 14 },
  { key: "contractType", label: "Contract Type", width: 16 },
  { key: "contractRenewal", label: "Contract Renewal", width: 16 },
  { key: "manager", label: "Reports To", width: 26 },
  { key: "managerHrId", label: "Manager HR ID", width: 14 },
  { key: "seatId", label: "Seat ID", width: 22 },
];

function exportDate(value: string | null | undefined): string {
  if (!value) return "";
  return formatDateOnly(value, "en", { day: "2-digit", month: "short", year: "numeric" });
}

function titleCase(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  return trimmed
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Flatten the picked rows into sheet rows.
 *
 * `mobileByHrId` is separate from `rows` on purpose — see the header. It is keyed by
 * `canonicalHrIdKey`, comes from `fetchOrganogramMobileNumbers()`, and is optional:
 * omit it and the Mobile column is blank, which is what every caller that has no
 * business pulling numbers gets, tests included.
 */
export function buildOrganogramExportRows(
  rows: OrganogramReportRow[],
  mobileByHrId?: ReadonlyMap<string, string> | null,
): ExportRow[] {
  return rows.map((row) => {
    const isVacancy = row.type === "vacancy";
    const mobileKey = canonicalHrIdKey(row.hrId);
    return {
      area: row.areaName ?? "",
      contractRenewal: exportDate(row.contractRenewalDate),
      contractType: titleCase(row.contractType),
      department: row.employeeDepartmentName ?? "",
      hireDate: exportDate(row.hireDate),
      hrId: row.hrId,
      hrJobTitle: row.employeeJobTitle ?? "",
      line: row.lineName ?? "",
      manager: row.managerName ?? "",
      managerHrId: row.managerHrId ?? "",
      // A vacant seat has nobody to call, so it stays blank rather than borrowing a number.
      mobile: isVacancy || !mobileKey ? "" : (mobileByHrId?.get(mobileKey) ?? ""),
      name: isVacancy ? "Open Vacancy" : organogramAudienceName(row),
      nameAr: row.nameAr ?? "",
      region: row.regionName ?? "",
      seatId: row.seatId ?? "",
      status: isVacancy ? "Open Seat" : titleCase(row.employmentStatus) || titleCase(row.status),
      team: row.employeeTeamName ?? "",
      title: row.positionTitle ?? row.jobTitle ?? "",
      type: isVacancy ? "Vacancy" : "Employee",
      workEmail: isVacancy ? "" : (row.workEmail ?? ""),
    };
  });
}
