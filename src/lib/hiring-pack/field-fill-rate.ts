// How many people a field would actually print for — before its rule becomes everyone's rule.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. Editing a field in the field table changes the TEMPLATE: the rule for every
// person the document is printed for. But the editor resolves that rule against the ONE employee on
// screen, so the only feedback anybody gets is one preview. On production today `job_title_ar` is
// stored for 2 of 108 active employees — so a rule reading `{{jobTitleAr}}` previews perfectly
// against either of those two and prints an EMPTY FIELD for everybody else. Silently, and correctly:
// one unresolvable placeholder blanks the whole field by design (`field-template.ts`), because a
// sentence quietly missing its middle is worse than a field that is visibly absent.
//
// A blank on a page that is otherwise complete is the hardest kind of defect to notice, and these
// are papers people sign. So the editor says the number out loud.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// IT IS AN INTERSECTION, NOT A MINIMUM, AND THAT IS WHY A FIELD IS COUNTED WHOLE. A sentence built
// from `{{companyName}}` and `{{jobTitleAr}}` prints only for someone who has BOTH. Two per-key
// counts — 108 and 2 — cannot be combined into that answer: they give 2 whether or not the two
// people with an Arabic job title are inside the other 108. So the request carries each field's
// whole key set, and the count is taken over people who resolve every one of them.
//
// UNBOUND KEYS ARE EXCLUDED FROM THE TEST AND REPORTED SEPARATELY. `COMPANY_NAME`, `ISSUE_DATE` and
// the commercial-register numbers are not read off an employee at all — they are the same for
// everyone, and resolving them would mean building a full document render per person. Counting them
// as filled would inflate the answer and counting them as blank would deflate it, so they are named
// instead, and the UI says the count covers the record fields only.
//
// IT COUNTS WHAT THE PAPER PRINTS, NOT WHAT ONE COLUMN HOLDS. Four values are printed from a `??`
// chain — the Arabic name falls back to the Latin one, Form 1's street to the residence address, the
// insurance start date to the hire date, a last working day to the employee record — and the count
// follows each chain because `paperFieldCurrentValue` does. Before it did, this module reported
// "fills for 0 of 169" for the street beside a row visibly displaying one, and 2 for a start date
// that prints for 168. The chains are declared as `printFallback` in `paper-fields.ts`.
//
// THE DENOMINATOR IS THE PICKER'S OWN LIST — current staff plus the people who have left — because
// that is exactly who this module can print for. A count against every `employees` row would include
// the 17 ledger artefacts and payroll placeholders the roster deliberately excludes, and would
// answer a question nobody asked.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import {
  ACTIVE_EMPLOYMENT_STATUSES_IN_LIST,
  DEPARTED_EMPLOYMENT_STATUSES_IN_LIST,
} from "@/lib/auth/session-lifecycle";
import { loadCompanyDetails } from "@/lib/hiring-pack/company-details-store";
import { paperFieldBinding, paperFieldCurrentValue } from "@/lib/hiring-pack/paper-fields";
import { loadReferenceDepartments } from "@/lib/reference/reference-lists";
import type { PaperFieldSource } from "@/lib/hiring-pack/paper-fields";
import {
  HIRING_PACK_EMPLOYEE_COLUMNS,
  emptyOffboardingProfile,
  emptyProfile,
  mapEmployeeFacts,
  mapOffboardingProfile,
  mapProfile,
  type EmployeeDbRow,
  type OffboardingDbRow,
  type ProfileDbRow,
} from "@/lib/hiring-pack/service";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Said out loud rather than left as a bare -1: this field does not depend on who is being printed. */
export const FILLS_FOR_EVERYONE = -1;

/** How many of the people a field blanks for are named back. Enough to be concrete, not a roster. */
const BLANK_NAME_SAMPLE = 3;

/** One field's answer: how many of the roster it prints for, and which of its keys were countable. */
export type FieldFillRate = {
  /** The key set as it was asked for, comma-joined — the client's own handle on this row. */
  id: string;
  /** Keys that read a value off an employee record, and so were counted. */
  bound: string[];
  /** Keys that are not per-employee — company constants, computed dates. Named, never counted. */
  unbound: string[];
  /** People for whom EVERY bound key resolves to something, or FILLS_FOR_EVERYONE. */
  filled: number;
  /**
   * A few of the people it would print NOTHING for, by name.
   *
   * A number alone is arguable — "blank for 167" invites the reading that those 167 are leavers, or
   * placeholders, or somebody else's problem. Three real names settle it in one glance, and the
   * owner's standing rule is that a screen shows human-readable names rather than counts and codes.
   * Capped at three because the point is to make the number concrete, not to list a roster.
   */
  blankNames: string[];
};

export type FieldFillRateReport = {
  /** Everybody this module can print for — the same list the employee picker offers. */
  roster: number;
  fields: FieldFillRate[];
};

/** The roster's records, ready to be read by the same function that prints them. */
type RosterRecords = PaperFieldSource[];

export async function computeFieldFillRates(keySets: string[][]): Promise<FieldFillRateReport> {
  const bindingOf = (key: string) => paperFieldBinding(key);
  const anyBound = keySets.some((keys) => keys.some((key) => bindingOf(key) !== null));

  // Nothing to count against a roster we would then have to load — answer before touching the
  // database. A table of purely literal fields is the common case on a form nobody has edited yet.
  if (!anyBound) {
    return {
      roster: 0,
      fields: keySets.map((keys) => ({
        id: keys.join(","),
        blankNames: [],
        bound: [],
        unbound: keys,
        filled: FILLS_FOR_EVERYONE,
      })),
    };
  }

  const records = await loadRosterRecords();

  const fields = keySets.map((keys) => {
    const id = keys.join(",");
    const bound = keys.filter((key) => bindingOf(key) !== null);
    const unbound = keys.filter((key) => bindingOf(key) === null);

    // No bound key means nothing here varies by person: a plain literal, or a company constant.
    // Reporting 0 would read as "prints for nobody", which is the opposite of the truth.
    if (bound.length === 0) {
      return { id, bound, unbound, filled: FILLS_FOR_EVERYONE, blankNames: [] };
    }

    let filled = 0;
    const blankNames: string[] = [];
    for (const record of records) {
      const complete = bound.every((key) => {
        const binding = bindingOf(key);
        if (!binding) return true;
        return paperFieldCurrentValue(record, binding) !== "";
      });
      if (complete) {
        filled += 1;
      } else if (blankNames.length < BLANK_NAME_SAMPLE) {
        blankNames.push(record.employee.fullName);
      }
    }
    return { id, bound, unbound, filled, blankNames };
  });

  return { roster: records.length, fields };
}

/**
 * The whole roster's three record objects, in a handful of queries rather than one pack build each.
 *
 * A `buildHiringPack` call joins departments, resolves terms, computes gaps and looks up a suggested
 * Arabic job title. Doing that once per person to answer "is this field empty" would be several
 * hundred round trips for a number shown beside a text box.
 */
async function loadRosterRecords(): Promise<RosterRecords> {
  const supabase = getSupabaseAdmin();

  // The whole roster, paged (hr_id is the tiebreak): a fixed row count would shrink the "filled"
  // numbers for the same people every time without ever saying so. Typed through the pager's
  // generic: `.select()` over a shared column CONSTANT hands back a row type the client cannot
  // narrow from a literal, so the rows would be `any[]` and every read off them would typecheck
  // against nothing at all.
  let rows: EmployeeDbRow[];
  try {
    rows = await fetchAllRows<EmployeeDbRow>(
      () =>
        supabase
          .from("employees")
          .select(HIRING_PACK_EMPLOYEE_COLUMNS)
          .or(
            `employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST},employment_status.in.${DEPARTED_EMPLOYMENT_STATUSES_IN_LIST}`,
          ),
      "hr_id",
    );
  } catch (error) {
    throw new Error((error as { message?: string } | null)?.message ?? String(error));
  }
  if (rows.length === 0) return [];

  // The department table whole, once — eleven rows, against one join per employee. From the shared
  // one-minute copy (src/lib/reference/reference-lists.ts), which still throws on a failed read, so
  // a department never silently renders as blank here.
  const departmentNames = new Map<number, string | null>();
  for (const department of await loadReferenceDepartments()) {
    if (department.id != null) departmentNames.set(department.id, department.name);
  }

  const hrIds = rows.map((row) => row.hr_id);

  const profiles = new Map<string, ProfileDbRow>();
  for (const row of await chunkedSelect<ProfileDbRow>("employee_hiring_profile", hrIds)) {
    profiles.set(row.hr_id, row);
  }

  const offboarding = new Map<string, OffboardingDbRow>();
  for (const row of await chunkedSelect<OffboardingDbRow>("employee_offboarding_profile", hrIds)) {
    offboarding.set(row.hr_id, row);
  }

  // ONE READ, SHARED BY EVERY RECORD. The company is the same for all of them by construction, so a
  // company-backed key on a form reports "fills for everyone" or "fills for nobody" and never
  // something in between — which is the honest answer, and the reason it is read here rather than
  // defaulted: a count taken against the COMPILED company while the papers print an EDITED one
  // would report a filled field as blank on the very screen that exists to find blank fields.
  const company = await loadCompanyDetails();

  return rows.map((row) => {
    const profileRow = profiles.get(row.hr_id);
    const offboardingRow = offboarding.get(row.hr_id);
    // The RAW `departments.name`: `mapEmployeeFacts` does the Arabic lookup itself, so this
    // reader and the one that prints the paper cannot drift apart on what the field holds.
    const departmentName =
      row.department_id === null ? null : (departmentNames.get(row.department_id) ?? null);
    return {
      employee: mapEmployeeFacts(row, departmentName),
      profile: profileRow ? mapProfile(profileRow) : emptyProfile(row.hr_id),
      offboarding: offboardingRow
        ? mapOffboardingProfile(offboardingRow)
        : emptyOffboardingProfile(row.hr_id),
      company,
    };
  });
}

/**
 * `.in()` over the roster, in chunks.
 *
 * A PostgREST `.in()` carrying several hundred ids returns ZERO rows and no error — the answer is an
 * empty list that looks exactly like "nobody has a profile". This module's whole job is reporting
 * emptiness, so a silent empty result here would be indistinguishable from the finding it exists to
 * report. 50 ids at a time, the size this repository already uses everywhere else it hits this.
 */
async function chunkedSelect<T extends { hr_id: string }>(
  table: string,
  hrIds: string[],
): Promise<T[]> {
  const supabase = getSupabaseAdmin();
  const out: T[] = [];
  for (let index = 0; index < hrIds.length; index += 50) {
    const chunk = hrIds.slice(index, index + 50);
    const { data, error } = await supabase.from(table).select("*").in("hr_id", chunk).returns<T[]>();
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
  }
  return out;
}
