/**
 * WHO CAN BE PRINTED, FOR EVERYBODY AT ONCE.
 *
 * ── The problem this solves ──
 * The module could already tell you exactly what one person was missing. What it could not tell you
 * was how many people were missing it, or that most of them were missing the SAME thing. Measured on
 * production the day this was written: 108 active employees, 90 of them complete on the employee
 * record, and every single Form 1 blocked by two empty values in `system-settings.ts` that only the
 * owner can supply. Nothing on any screen said so. The owner went back to Excel, which is a rational
 * response to a system that answers "what is missing?" one person at a time and never answers "how
 * much of this is one thing?".
 *
 * ── Why company settings are pulled out ──
 * `collectHiringPackGaps` reports the company-level gaps against every employee, which is correct
 * for the fill screen — you are looking at one person and the form they need is incomplete. Repeated
 * 108 times on a board it is noise that buries the per-person gaps underneath it, and worse, it
 * misreports the WORK: two values look like 216 problems. So this module reports them ONCE, at the
 * top, and counts `readyExceptCompanySettings` so the size of that one fix is visible as the number
 * of people it would unblock.
 *
 * ── Pure on purpose ──
 * Everything here takes already-loaded facts and returns a verdict. The loading lives in
 * `service.ts`, next to the row-mapping it shares with the fill screen, so the two cannot drift
 * apart. Keeping the judgement pure is what lets `tests/hr-forms-readiness.test.ts` exercise it with
 * no database — which matters more than usual here, because the suite runs with PRODUCTION
 * credentials and a readiness check that reached for a client would read live payroll data.
 */

import { arabicAnswersOutstanding } from "@/lib/hiring-pack/arabic-lookups";
import { autoFillHiringPackFacts, type AutoFilledValue } from "@/lib/hiring-pack/auto-fill";
import { describeNationalIdConflict } from "@/lib/hiring-pack/national-id";
import { resolveNationality } from "@/lib/hiring-pack/nationality";
import type {
  HiringPackDocument,
  HiringPackEmployeeFacts,
  HiringPackGap,
  HiringPackProfile,
} from "@/lib/hiring-pack/types";

/** The two papers this board is about. The exit forms answer a different question, for a different population. */
export const READINESS_DOCUMENTS = ["contract", "form1"] as const satisfies readonly HiringPackDocument[];

export type ReadinessDocument = (typeof READINESS_DOCUMENTS)[number];

/** Which value a row filled without anybody typing it, so the screen can say where it came from. */
export type DerivedValue = AutoFilledValue | "nationality";

export type ReadinessRow = {
  hrId: string;
  fullName: string;
  nameAr: string | null;
  jobTitle: string | null;
  hireDate: string | null;
  departed: boolean;
  /** This person's own blocking gaps, per document. Company-level gaps are NOT repeated here. */
  blockers: Record<ReadinessDocument, HiringPackGap[]>;
  /** Non-blocking gaps — the paper prints, the value is chased afterwards. */
  advisories: HiringPackGap[];
  /** True when nothing at all stands in the way, company settings included. */
  ready: Record<ReadinessDocument, boolean>;
  /** True when this person is complete and only the company-level values are outstanding. */
  readyExceptCompanySettings: Record<ReadinessDocument, boolean>;
  /** What was filled without being typed, so a reader can see the paper is not inventing values. */
  derived: DerivedValue[];
  /**
   * Set when the stored date of birth and the national ID disagree.
   *
   * Not a gap — both values are present. It is a warning that one of the two is a typo, and it is
   * shown rather than resolved, because the wrong one gets filed with the Authority either way.
   */
  idConflict: string | null;
};

export type ReadinessSummary = {
  people: number;
  /** Fully printable today, per document. */
  ready: Record<ReadinessDocument, number>;
  /** Printable the moment the company-level values are filled in — the size of that one fix. */
  unlockedByCompanySettings: Record<ReadinessDocument, number>;
  /** Blocked on something of their own, per document. */
  blocked: Record<ReadinessDocument, number>;
  /**
   * The company-level blockers, listed ONCE.
   *
   * Empty when the settings are filled. Non-empty means every person in `unlockedByCompanySettings`
   * is waiting on these and on nothing else.
   */
  companyBlockers: HiringPackGap[];
  /**
   * How many PEOPLE are waiting on an Arabic wording nobody has confirmed yet.
   *
   * Counted from the rows, so somebody missing both their job title and their qualification counts
   * once. The seed tables cannot answer this — summing their per-seed headcounts double-counts that
   * person and reaches a figure larger than the payroll.
   */
  peopleWaitingOnArabicSeeds: number;
  /** How many of the Arabic questions on the sheet are still unanswered — questions, not people. */
  arabicAnswersOutstanding: number;
  /** Rows whose stored birth date disagrees with their national ID. */
  idConflicts: number;
};

export type HiringPackReadiness = {
  summary: ReadinessSummary;
  rows: ReadinessRow[];
};

function emptyDocumentRecord<T>(value: () => T): Record<ReadinessDocument, T> {
  return { contract: value(), form1: value() };
}

/**
 * Fill what the system can work out for itself, so the gaps that remain are the real ones.
 *
 * The same `autoFillHiringPackFacts` the papers print through (`getHiringPack`), so the board can
 * never call a value missing that the paper would print, or the reverse — plus the nationality
 * default, which is reported here because a board must say when a nationality was assumed.
 *
 * Returns NEW objects — the inputs are never mutated. What is derived is reported in `derived`.
 */
export function enrichForReadiness(
  employee: HiringPackEmployeeFacts,
  profile: HiringPackProfile,
): { employee: HiringPackEmployeeFacts; profile: HiringPackProfile; derived: DerivedValue[] } {
  const filled = autoFillHiringPackFacts(employee, profile);
  const derived: DerivedValue[] = [...filled.autoFilled];

  // The company default. Reported as derived rather than applied quietly — see the module header
  // in `nationality.ts` for why a nationality is the one default that must stay visible.
  const resolvedNationality = resolveNationality(profile.nationality, employee);
  if (resolvedNationality.defaulted) derived.push("nationality");

  return {
    employee: filled.employee,
    profile: { ...filled.profile, nationality: resolvedNationality.value },
    derived,
  };
}

/**
 * One person's verdict.
 *
 * `collectGaps` is injected rather than imported so this file stays pure and the test can drive it
 * without pulling in `service.ts`, which reaches for a Supabase client at module scope.
 */
export function buildReadinessRow(
  employee: HiringPackEmployeeFacts,
  profile: HiringPackProfile,
  collectGaps: (employee: HiringPackEmployeeFacts, profile: HiringPackProfile) => HiringPackGap[],
): ReadinessRow {
  const enriched = enrichForReadiness(employee, profile);
  const gaps = collectGaps(enriched.employee, enriched.profile);

  const blockers = emptyDocumentRecord<HiringPackGap[]>(() => []);
  const companyBlockers = emptyDocumentRecord<HiringPackGap[]>(() => []);
  const advisories: HiringPackGap[] = [];

  for (const gap of gaps) {
    if (!gap.blocking) {
      // Only advise about the two documents this board covers — an occupation code missing from
      // Form 6 is not this screen's business and would read as noise against a new joiner.
      if (gap.documents.some((document) => isReadinessDocument(document))) advisories.push(gap);
      continue;
    }
    for (const document of gap.documents) {
      if (!isReadinessDocument(document)) continue;
      if (gap.source === "company-settings") companyBlockers[document].push(gap);
      else blockers[document].push(gap);
    }
  }

  const ready = emptyDocumentRecord(() => false);
  const readyExceptCompanySettings = emptyDocumentRecord(() => false);
  for (const document of READINESS_DOCUMENTS) {
    const own = blockers[document].length === 0;
    ready[document] = own && companyBlockers[document].length === 0;
    readyExceptCompanySettings[document] = own && companyBlockers[document].length > 0;
  }

  return {
    hrId: employee.hrId,
    fullName: employee.fullName,
    nameAr: employee.nameAr,
    jobTitle: employee.jobTitle,
    hireDate: employee.hireDate,
    departed: employee.departed,
    blockers,
    advisories,
    ready,
    readyExceptCompanySettings,
    derived: enriched.derived,
    idConflict: describeNationalIdConflict(employee.nationalId, employee.birthDate),
  };
}

function isReadinessDocument(document: HiringPackDocument): document is ReadinessDocument {
  return (READINESS_DOCUMENTS as readonly HiringPackDocument[]).includes(document);
}

/**
 * The whole board.
 *
 * `companyBlockers` is taken from the first row that has any, deliberately: they are company-level
 * values, identical on every row by construction, and listing them once is the entire point of
 * separating them. Taking them from a row rather than recomputing them means the board can never
 * disagree with the rows it is summarising.
 */
export function summarizeReadiness(
  rows: ReadinessRow[],
  companyBlockers: HiringPackGap[],
): ReadinessSummary {
  const ready = emptyDocumentRecord(() => 0);
  const unlocked = emptyDocumentRecord(() => 0);
  const blocked = emptyDocumentRecord(() => 0);

  for (const row of rows) {
    for (const document of READINESS_DOCUMENTS) {
      if (row.ready[document]) ready[document] += 1;
      else if (row.readyExceptCompanySettings[document]) unlocked[document] += 1;
      else blocked[document] += 1;
    }
  }

  return {
    people: rows.length,
    ready,
    unlockedByCompanySettings: unlocked,
    blocked,
    companyBlockers,
    peopleWaitingOnArabicSeeds: rows.filter((row) => waitsOnArabic(row)).length,
    arabicAnswersOutstanding: arabicAnswersOutstanding(),
    idConflicts: rows.filter((row) => row.idConflict !== null).length,
  };
}

/** The company-level blockers as they appear on any row — they are identical across the board. */
export function extractCompanyBlockers(gaps: HiringPackGap[]): HiringPackGap[] {
  const seen = new Set<string>();
  return gaps.filter((gap) => {
    if (gap.source !== "company-settings" || !gap.blocking) return false;
    if (!gap.documents.some((document) => isReadinessDocument(document))) return false;
    if (seen.has(gap.field)) return false;
    seen.add(gap.field);
    return true;
  });
}

/**
 * Is this person held up by an Arabic wording that has not been confirmed?
 *
 * The two fields the seed tables answer. Somebody blocked on either is waiting on the question
 * sheet rather than on anything HR can type today, and counting them ONCE is the point — see
 * `arabicAnswersOutstanding` for why the seed tables cannot simply be summed instead.
 */
function waitsOnArabic(row: ReadinessRow): boolean {
  return READINESS_DOCUMENTS.some((document) =>
    row.blockers[document].some((gap) => gap.field === "jobTitleAr" || gap.field === "qualification"),
  );
}
