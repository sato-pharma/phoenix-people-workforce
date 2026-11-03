// Employee 360 — the personnel chapter: leave, probation, company devices, rank and incentive.
//
// Every figure comes from its own screen's function, never a copy of its rule. Each read is gated on
// its own and fails on its own: a section the viewer may not see is simply absent, and a section whose
// read failed is named on the page instead of showing an empty one or a zero. This is the one loader
// the three report pages share; the rest of their loading is still copied across them.

import {
  canAccess,
  createAccessContext,
  normalizeRole,
  type AccessContext,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { getOutstandingDevicesFor } from "@/lib/devices/service";
import type { DeviceCategory } from "@/lib/devices/types";
import {
  canViewEmployee360Subject,
  canViewPersonMoney,
  subjectHasIncentiveTab,
  type Employee360Scope,
  type Employee360SubjectRow,
} from "@/lib/employee-360/access";
import { personIncentiveFigures, type PersonIncentiveFigures } from "@/lib/employee-360/person-incentive";
import { getEmployeePortalIncentiveData } from "@/lib/employee-portal/service";
import { hrIdsMatch } from "@/lib/hr-id";
import { forbiddenError } from "@/lib/http/api-errors";
import { getProbationRows } from "@/lib/probation/service";
import { loadRankProfile } from "@/lib/rep-ranks/server/read";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  canViewEmployeeLeaveRecord,
  getEmployeeAnnualLeaveBalanceDays,
  getEmployeeLeaveRequestsForRecord,
  type EmployeeLeaveRecordLine,
} from "@/lib/vacation/service";

export type PersonnelLeave = {
  /** What the person can request today. Null when the balance is not shown, never 0. */
  balanceDays: number | null;
  requests: EmployeeLeaveRecordLine[];
};

export type PersonnelProbation = {
  daysRemaining: number;
  endDate: string;
  hireDate: string;
};

export type PersonnelDevice = {
  assignmentId: string;
  assetTag: string;
  category: DeviceCategory;
  identifier: string;
  issuedOn: string;
  /** Null for a viewer who may not see it: the figure does not reach their browser. */
  agreedValueEgp: number | null;
};

export type PersonnelDevices = {
  items: PersonnelDevice[];
  /** Whether this viewer is shown values at all, so the page can say why a column is missing. */
  showValues: boolean;
};

/** Scores and rank only. A rep's metrics never leave the server for a portal (rep-ranks.md). */
export type PersonnelRank = {
  rankEnglish: string;
  rankArabic: string;
  stars: number;
  rollingScore: number | null;
  monthTrail: { label: string; total: number | null; rankEnglish: string }[];
};

export type Employee360PersonnelRecords = {
  leave: PersonnelLeave | null;
  probation: PersonnelProbation | null;
  devices: PersonnelDevices | null;
  rank: PersonnelRank | null;
  /** The person's sign-in, when the viewer may see their incentive and the person has the tab. */
  incentiveSignIn: SubjectSignIn | null;
  /** The sections whose read failed, for the report's "Could not be read just now" notice. */
  unread: string[];
};

const MONTH_TRAIL_SHOWN = 6;
const LEAVE_REQUESTS_SHOWN = 6;

/** The person's sign-in, which is what their own Incentive tab reads under. Null when they have none. */
export type SubjectSignIn = { loginId: string; role: PhoenixRole };

async function readSubjectSignIn(hrId: string): Promise<SubjectSignIn | null> {
  // `ilike` with no wildcard is an exact, case-insensitive match. normalizeHrId is lower case and the
  // column is not, so an `eq` on it finds nobody and says nothing.
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("login_id,role")
    .ilike("hr_id", hrId.trim())
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as { login_id: string | null; role: string | null } | null;
  return row?.login_id && row.role ? { loginId: row.login_id, role: normalizeRole(row.role) } : null;
}

export async function loadEmployee360PersonnelRecords(input: {
  access: AccessContext;
  target: Employee360SubjectRow;
  scope: Employee360Scope;
}): Promise<Employee360PersonnelRecords> {
  const { access, target, scope } = input;
  const money = canViewPersonMoney(access, target, scope);
  const unread: string[] = [];

  // Runs the read only for a viewer the gate admits; a failure names the section and shows nothing.
  const guarded = async <T,>(name: string, gate: () => boolean | Promise<boolean>, read: () => Promise<T | null>): Promise<T | null> => {
    try {
      return (await gate()) ? await read() : null;
    } catch {
      unread.push(name);
      return null;
    }
  };

  const [leave, probation, devices, rank, incentiveSignIn] = await Promise.all([
    guarded<PersonnelLeave>(
      "Leave",
      // The reads below run for the person, so this gate is the only thing between them and the viewer.
      async () => (await canAccess(access, "leave", "read")) && (await canViewEmployeeLeaveRecord(access, target.hrId)),
      async () => {
        const [balanceDays, requests] = await Promise.all([
          getEmployeeAnnualLeaveBalanceDays(target.hrId),
          getEmployeeLeaveRequestsForRecord(target.hrId, LEAVE_REQUESTS_SHOWN),
        ]);
        return balanceDays == null && requests.length === 0 ? null : { balanceDays, requests };
      },
    ),
    // No row is not "not on probation": the list is the viewer's own and medical reps only, so a
    // missing row says nothing, and nothing is what the page says.
    guarded<PersonnelProbation>(
      "Probation",
      () => canAccess(access, "probation", "read"),
      async () => {
        const row = (await getProbationRows(access)).find((candidate) => hrIdsMatch(candidate.hr_id, target.hrId));
        return row ? { daysRemaining: row.days_remaining, endDate: row.probation_end_date, hireDate: row.hire_date } : null;
      },
    ),
    guarded<PersonnelDevices>(
      "Company devices",
      async () => money || (await canAccess(access, "company_devices", "read")),
      async () => {
        const held = await getOutstandingDevicesFor(target.hrId);
        if (held.length === 0) return null;
        return {
          showValues: money,
          items: held.map((device) => ({
            assignmentId: device.assignmentId,
            assetTag: device.assetTag,
            category: device.category,
            identifier: device.identifier,
            issuedOn: device.issuedOn,
            agreedValueEgp: money ? device.agreedValueEgp : null,
          })),
        };
      },
    ),
    guarded<PersonnelRank>(
      "Rank",
      () => canAccess(access, "early_birds", "read"),
      async () => {
        const profile = await loadRankProfile(target.hrId);
        if (!profile) return null;
        return {
          rankEnglish: profile.rank.english,
          rankArabic: profile.rank.arabic,
          stars: profile.stars,
          rollingScore: profile.rollingScore,
          monthTrail: profile.monthTrail.slice(0, MONTH_TRAIL_SHOWN).map((month) => ({
            label: month.label,
            total: month.total,
            rankEnglish: month.rank.english,
          })),
        };
      },
    ),
    guarded<SubjectSignIn>(
      "Incentive",
      async () => money && (await canAccess(access, "incentive", "read")),
      async () => {
        const signIn = await readSubjectSignIn(target.hrId);
        return signIn && subjectHasIncentiveTab(signIn.role) ? signIn : null;
      },
    ),
  ]);

  return { leave, probation, devices, rank, incentiveSignIn, unread };
}

/**
 * One person's incentive, read through the same function their own tab calls, in their own access
 * context, so a manager sees the number the person sees. It is the heaviest read on the report, so the
 * page streams it in rather than waiting for it. The gate is asked again here: reaching this function
 * is what reads the money, whatever the page decided to draw.
 */
export async function loadEmployee360PersonIncentive(input: {
  access: AccessContext;
  target: Employee360SubjectRow;
  scope: Employee360Scope;
  signIn: SubjectSignIn;
}): Promise<PersonIncentiveFigures> {
  const { access, target, scope, signIn } = input;
  if (
    !canViewEmployee360Subject(access, target, scope) ||
    !canViewPersonMoney(access, target, scope) ||
    !subjectHasIncentiveTab(signIn.role) ||
    !(await canAccess(access, "incentive", "read"))
  ) {
    throw forbiddenError("This incentive is shown only to the person, their managers, the CEO and the Super Admin.");
  }
  const subjectAccess = createAccessContext({ hrId: target.hrId, loginId: signIn.loginId, role: signIn.role, source: "session" });
  return personIncentiveFigures(await getEmployeePortalIncentiveData(subjectAccess));
}
