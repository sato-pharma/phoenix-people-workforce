/**
 * People: find someone, and read one person's record.
 *
 * Who a seat may see, and which fields, is the screens' own rule:
 *  - A seat holding `employees:read` (the owner) sees the Employee Directory exactly as
 *    app/(admin)/employees/page.tsx loads it — `filterEmployeeDirectoryForAccess`, which also blanks
 *    pay for a seat the directory blanks it for. Pay, bank and national ID included (owner, 17 Nov 2026).
 *  - Any other seat (the CEO: the employees hard boundary is Super Admin only) sees the people
 *    Employee 360 opens for it (`resolveEmployee360VisibleRows`, app/(admin)/employee-360/page.tsx), the
 *    people the company organogram draws for it (`getOrganogramReport`, app/(admin)/organogram/page.tsx),
 *    and himself — and only the fields those two screens print: name, title, line, area, manager,
 *    status, hire date. Never pay, bank or ID.
 */
import { z } from "zod";

import { canAccess, filterEmployeeDirectoryForAccess, type AccessContext } from "@/lib/auth/permissions";
import {
  buildEmployee360Scope,
  canViewEmployee360Subject,
  isEmployee360Subject,
  resolveEmployee360VisibleRows,
} from "@/lib/employee-360/access";
import { getEmployee360Summary } from "@/lib/employee-360/service";
import {
  getEmployeeDirectoryRows,
  isActiveLifecycleStatus,
  type EmployeeDirectoryData,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { canonicalHrIdKey, hrIdsMatch } from "@/lib/hr-id";
import { canAccessCompanyOrganogram, getOrganogramReport } from "@/lib/reports/organogram";

import { capRows, cappedNote, matchPeople, personLabel, pickFields, scalarFields } from "@/lib/chatgpt-connector/tools/helpers";
import { defineTool, ToolRefusal } from "@/lib/chatgpt-connector/types";

/** The fields both screens a non-directory seat can open print about a person. */
const BASIC_PERSON_FIELDS = [
  "hrId",
  "fullName",
  "displayName",
  "nickname",
  "nameAr",
  "jobTitle",
  "positionTitle",
  "departmentName",
  "lineName",
  "areaName",
  "regionName",
  "managerHrId",
  "managerName",
  "employmentStatus",
  "hireDate",
  "lastWorkingDate",
] as const satisfies readonly (keyof EmployeeDirectoryRow)[];

function emptyDirectory(employees: EmployeeDirectoryRow[]): EmployeeDirectoryData {
  return {
    employees,
    lookups: {
      areas: [],
      departments: [],
      lines: [],
      managers: [],
      positions: [],
      teams: [],
      statuses: [],
      medicalRepVacancies: [],
      workforceVacancies: [],
    },
    summary: { activeEmployees: 0, employeesWithoutManagers: 0, totalEmployees: 0, uniqueAreas: 0, uniqueLines: 0 },
  };
}

export type VisiblePeople = {
  rows: EmployeeDirectoryRow[];
  /** True when the seat sees whole directory records (pay, bank and ID as the directory shows them). */
  fullRecords: boolean;
};

/** The people this seat may see, by the screens' own rules (see the file header). */
async function loadVisiblePeople(ctx: AccessContext, includeFormer: boolean): Promise<VisiblePeople> {
  const all = await getEmployeeDirectoryRows({ includeInactive: true });
  const wanted = includeFormer ? all : all.filter((row) => isActiveLifecycleStatus(row.employmentStatus));

  if (await canAccess(ctx, "employees", "read")) {
    return { rows: filterEmployeeDirectoryForAccess(emptyDirectory(wanted), ctx).employees, fullRecords: true };
  }

  const keys = new Set<string>();
  for (const row of await resolveEmployee360VisibleRows(all, ctx)) {
    const key = canonicalHrIdKey(row.hrId);
    if (key) keys.add(key);
  }
  if (await canAccess(ctx, "organogram", "read")) {
    const report = canAccessCompanyOrganogram(ctx) ? await getOrganogramReport(ctx, { mode: "company" }) : null;
    for (const row of report?.organogramRows ?? []) {
      if (row.type !== "employee") continue;
      const key = canonicalHrIdKey(row.hrId);
      if (key) keys.add(key);
    }
  }
  const selfKey = canonicalHrIdKey(ctx.hrId);
  if (selfKey) keys.add(selfKey);
  return {
    rows: wanted.filter((row) => {
      const key = canonicalHrIdKey(row.hrId);
      return key != null && keys.has(key);
    }),
    fullRecords: false,
  };
}

function basicPerson(row: EmployeeDirectoryRow) {
  return pickFields(row, BASIC_PERSON_FIELDS);
}

export const findPeopleTool = defineTool({
  name: "phoenix_find_people",
  title: "Find people",
  description:
    "Search Phoenix employees by English or Arabic name, nickname or HR id (e.g. 'Ibtissam', 'ابتسام', 'B-158'). " +
    "Returns each match's HR id, name, Arabic name, job title, line, area, region, manager, status and hire date. " +
    "Use it first whenever a question names a person, then pass the HR id to the other tools. " +
    "Current employees only unless includeFormer is true.",
  input: {
    query: z.string().min(1).max(120).describe("A name (English or Arabic), nickname or HR id."),
    includeFormer: z.boolean().optional().describe("Also search people who have left. Default false."),
  },
  run: async (ctx, input) => {
    const { rows } = await loadVisiblePeople(ctx, input.includeFormer ?? false);
    const matches = matchPeople(rows, input.query);
    const capped = capRows(matches, 50);
    if (capped.total === 0) {
      return {
        summary: `Nobody you can see matches "${input.query}"${input.includeFormer ? "" : " among current employees (try includeFormer)"}.`,
        data: { matches: [], total: 0 },
      };
    }
    const names = capped.rows.slice(0, 5).map((row) => `${personLabel(row)}${row.jobTitle ? `, ${row.jobTitle}` : ""}`);
    return {
      summary: `${capped.total} match${capped.total === 1 ? "" : "es"} for "${input.query}": ${names.join("; ")}${capped.total > 5 ? "; …" : ""}.${cappedNote(capped.total, capped.rows.length)}`,
      data: { matches: capped.rows.map(basicPerson), total: capped.total, capped: capped.capped },
    };
  },
});

export const personTool = defineTool({
  name: "phoenix_person",
  title: "One person's record",
  description:
    "The full Phoenix record of one employee by HR id — everything your role's screens show about them " +
    "(for the owner: the Employee Directory record including salary, bank, national ID, insurance and contract fields; " +
    "for the CEO: the Employee 360 / organogram fields). For a field-force employee it adds their Employee 360 " +
    "visit and check-in summary for this year to date. Find the HR id first with phoenix_find_people.",
  input: {
    hrId: z.string().min(1).max(40).describe("The employee's HR id, e.g. B-158."),
  },
  run: async (ctx, input) => {
    const { rows, fullRecords } = await loadVisiblePeople(ctx, true);
    const target = rows.find((row) => hrIdsMatch(row.hrId, input.hrId));
    if (!target) throw new ToolRefusal(`No employee you can see has the HR id ${input.hrId}.`);

    // Employee 360's own gate (app/(admin)/employee-360/[hrId]/page.tsx): the 360 scope, and only for
    // the field-force families the report covers.
    const all = await getEmployeeDirectoryRows({ includeInactive: true });
    const scope = await buildEmployee360Scope(all, ctx);
    let employee360: Record<string, string | number | boolean | null> | null = null;
    if (isEmployee360Subject(target) && canViewEmployee360Subject(ctx, target, scope)) {
      const summary = await getEmployee360Summary(target.hrId, undefined, { hrId: ctx.hrId, role: ctx.role }).catch(() => null);
      employee360 = summary ? scalarFields(summary) : null;
    }

    const record = fullRecords ? target : basicPerson(target);
    const pieces = [
      `${personLabel(target)}`,
      target.jobTitle,
      [target.lineName, target.areaName].filter(Boolean).join(", ") || null,
      target.managerName ? `reports to ${target.managerName}` : null,
      target.employmentStatus ? `status ${target.employmentStatus}` : null,
      target.hireDate ? `hired ${target.hireDate}` : null,
    ].filter(Boolean);
    return {
      summary: `${pieces.join(" · ")}.${fullRecords ? "" : " Your role sees the Employee 360 and organogram fields only."}`,
      data: { person: record, fullRecord: fullRecords, employee360 },
    };
  },
});
