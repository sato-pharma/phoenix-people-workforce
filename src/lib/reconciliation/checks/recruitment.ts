import { isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { HIRE_HANDOFF_TABLE } from "@/lib/employees/hire-handoff";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { addDaysToDateOnly } from "@/lib/date-only";
import { todayInCairo, toLetterDate } from "@/lib/offers/dates";
import { formatCount, formatList } from "@/lib/reconciliation/compare";
import {
  NEW_HIRE_LOGIN_WINDOW_DAYS,
  findNewHiresWithoutLogin,
  type NewHireForLoginCheck,
} from "@/lib/reconciliation/new-hires-without-login";
import {
  findOverdueAcceptedOffers,
  type AcceptedOfferForHireCheck,
} from "@/lib/reconciliation/overdue-accepted-offers";
import type { ReconciliationCheck, ReconciliationOutcome } from "@/lib/reconciliation/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type AcceptedOfferRow = {
  id: string;
  candidate_name: string | null;
  territory: string | null;
  title: string | null;
  start_date: string | null;
  vacancy_id: number | string | null;
};

type OpenVacancyRow = { id: number | string };

/**
 * Check — every accepted offer whose start date has passed has been turned into a hire.
 *
 * The two sides:
 *   left  — the offers module: accepted offers whose start date is already in the past. The Offers
 *           screen shows each of these as "Offer accepted — <name>, starts <date>".
 *   right — the organogram's own seats: `position_vacancies` for those offers, still `open`.
 *
 * It breaches when an accepted, overdue offer's seat is still empty — i.e. the person the company
 * agreed to hire, on a day that has passed, is not in. Nothing else in the system compares these:
 * accepting an offer and adding the employee are two separate, manual steps with no automation
 * between them, so a dropped hire stays invisible until someone notices the empty chair by eye.
 *
 * `expectation: "holds"`. This is NOT a documented known-open: an overdue accepted offer is a gap
 * to be CLOSED (add the person, or withdraw the offer), so the check should page until it is, then
 * fall quiet. It is false-positive-proof by construction — it reads the seat's own filled/open
 * state, never a name — so a breach always names a real empty chair with an accepted offer behind
 * it. See overdue-accepted-offers.ts for why the vacancy, not a name match, is the signal, and for
 * the one-day grace that keeps a same-day hire from paging.
 */
const acceptedOfferMustProduceAHire: ReconciliationCheck = {
  id: "accepted-offer-overdue-with-seat-still-open",
  title: "Every accepted offer whose start date has passed has been turned into a hire",
  domain: "recruitment",
  severity: "high",
  expectation: "holds",
  async run(): Promise<ReconciliationOutcome> {
    const supabase = getSupabaseAdmin();

    const [offersRead, openVacanciesRead] = await Promise.all([
      supabase
        .from("offers")
        .select("id,candidate_name,territory,title,start_date,vacancy_id")
        .eq("status", "accepted")
        .not("vacancy_id", "is", null),
      // Read the open seats directly rather than through loadOfferVacancyOptions(), which swallows a
      // failed read and returns [] — here that would make every seat look filled and report green on
      // the one night the vacancy read is broken. A thrown read becomes an "errored" result instead,
      // which the harness treats as an alert, never as a pass.
      supabase.from("position_vacancies").select("id").eq("status", "open"),
    ]);

    if (offersRead.error) throw new Error(`Accepted-offer read failed: ${offersRead.error.message}`);
    if (openVacanciesRead.error) throw new Error(`Open-vacancy read failed: ${openVacanciesRead.error.message}`);

    const offers: AcceptedOfferForHireCheck[] = ((offersRead.data ?? []) as AcceptedOfferRow[]).map((row) => ({
      id: String(row.id),
      candidateName: String(row.candidate_name ?? "").trim() || "(unnamed candidate)",
      territory: row.territory?.trim() || null,
      title: row.title?.trim() || null,
      startDate: row.start_date,
      vacancyId: row.vacancy_id == null ? null : Number(row.vacancy_id),
    }));

    const openVacancyIds = new Set(
      ((openVacanciesRead.data ?? []) as OpenVacancyRow[]).map((row) => Number(row.id)).filter(Number.isFinite),
    );

    const today = todayInCairo();
    const overdue = findOverdueAcceptedOffers({ offers, openVacancyIds, today });
    const pastStart = offers.length;

    return {
      left: {
        source: 'offers where status = accepted with a seat pointer — "Offer accepted, starts <date>" on the Offers screen',
        value: `${formatCount(pastStart, "accepted offer")} linked to a seat`,
      },
      right: {
        source: "position_vacancies.status for those seats — the organogram's own record of which chairs are empty",
        value:
          overdue.length === 0
            ? "every overdue accepted offer's seat is filled"
            : `${formatCount(overdue.length, "seat")} still open past the start date`,
      },
      holds: overdue.length === 0,
      detail:
        overdue.length === 0
          ? "No accepted offer is past its start date with an empty seat — every hire the company agreed to has been added."
          : formatList(
              overdue.map(
                (offer) =>
                  `${offer.candidateName}${offer.title ? ` (${offer.title}${offer.territory ? `, ${offer.territory}` : ""})` : offer.territory ? ` (${offer.territory})` : ""} accepted, started ${toLetterDate(offer.startDateIso)} — ${formatCount(offer.daysOverdue, "day")} ago and still not added (seat empty)`,
              ),
            ),
    };
  },
};

type NewHireRow = {
  hr_id: string | null;
  full_name: string | null;
  hire_date: string | null;
  employment_status: string | null;
};

const LOOKUP_CHUNK = 50;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

/** The ledger table not existing yet (its migration not applied) — PostgREST's and Postgres's codes. */
function isLedgerMissing(error: { code?: string | null; message?: string | null }): boolean {
  if (error.code === "PGRST205" || error.code === "42P01") return true;
  return /hire_handoff_steps/i.test(String(error.message ?? "")) && /does not exist|schema cache/i.test(String(error.message ?? ""));
}

/**
 * Check — every active employee hired in the last 60 days has a portal login, or a login step the
 * hire hand-off reconciler is still working on (REC-027, 2026-11-13).
 *
 * The two sides:
 *   left  — the Employee Master: active employees whose hire date is in the last 60 days (Cairo).
 *   right — `app_auth_users` (who holds a login) plus `hire_handoff_steps` login rows still pending
 *           or failed (what the hourly job is retrying).
 *
 * It breaches on a recent hire with neither — the gap the ledger cannot see because it holds no row
 * for him: a hire made before the ledger existed, a ledger write that was lost, or a path that never
 * asks for a login. A login step that GAVE UP excuses nothing; that person still cannot sign in.
 * When the ledger table is not there yet, it is read as holding no rows and the detail says so — the
 * login side is still checked, so the check answers rather than erroring for the whole night.
 */
const newHiresHaveALogin: ReconciliationCheck = {
  id: "new-hires-without-login",
  title: "Every active employee hired in the last 60 days has a portal login, or one being retried",
  domain: "recruitment",
  severity: "high",
  expectation: "holds",
  async run(): Promise<ReconciliationOutcome> {
    const supabase = getSupabaseAdmin();
    const today = todayInCairo();
    const from = addDaysToDateOnly(today, -NEW_HIRE_LOGIN_WINDOW_DAYS) ?? today;

    const hiresRead = await supabase
      .from("employees")
      .select("hr_id,full_name,hire_date,employment_status")
      .gte("hire_date", from);
    if (hiresRead.error) throw new Error(`Recent-hire read failed: ${hiresRead.error.message}`);
    const employees: NewHireForLoginCheck[] = ((hiresRead.data ?? []) as NewHireRow[])
      .filter((row) => String(row.hr_id ?? "").trim())
      .map((row) => ({
        active: isActiveLifecycleStatus(row.employment_status),
        hireDate: row.hire_date,
        hrId: String(row.hr_id).trim(),
        name: String(row.full_name ?? "").trim() || "(unnamed employee)",
      }));
    const recentActive = employees.filter((employee) => employee.active);
    const keys = [...new Set(recentActive.flatMap((employee) => hrIdLookupKeys(employee.hrId)))];

    const loginHrIds: string[] = [];
    const loginStepsInHand: string[] = [];
    let ledgerMissing = false;
    for (const slice of chunks(keys, LOOKUP_CHUNK)) {
      const logins = await supabase.from("app_auth_users").select("hr_id").in("hr_id", slice);
      if (logins.error) throw new Error(`Login read failed: ${logins.error.message}`);
      for (const row of (logins.data ?? []) as Array<{ hr_id: string | null }>) if (row.hr_id) loginHrIds.push(row.hr_id);

      if (ledgerMissing) continue;
      const steps = await supabase
        .from(HIRE_HANDOFF_TABLE)
        .select("employee_hr_id")
        .eq("step", "login")
        .in("status", ["pending", "failed"])
        .in("employee_hr_id", slice);
      if (steps.error) {
        if (isLedgerMissing(steps.error)) {
          ledgerMissing = true;
          continue;
        }
        throw new Error(`Hire hand-off ledger read failed: ${steps.error.message}`);
      }
      for (const row of (steps.data ?? []) as Array<{ employee_hr_id: string | null }>) {
        if (row.employee_hr_id) loginStepsInHand.push(row.employee_hr_id);
      }
    }

    const missing = findNewHiresWithoutLogin({ employees, loginHrIds, loginStepsInHand, today });
    const ledgerNote = ledgerMissing
      ? " The hire hand-off ledger (hire_handoff_steps) does not exist yet, so it was read as holding no login step."
      : "";

    return {
      left: {
        source: `employees with an active status and hire_date on or after ${from} — the Employee Master`,
        value: `${formatCount(recentActive.length, "active employee")} hired in the last ${NEW_HIRE_LOGIN_WINDOW_DAYS} days`,
      },
      right: {
        source: "app_auth_users.hr_id, plus hire_handoff_steps login rows still pending or failed (being retried hourly)",
        value:
          missing.length === 0
            ? "every one has a login or a login being retried"
            : `${formatCount(missing.length, "new hire")} with no login and nothing retrying one`,
      },
      holds: missing.length === 0,
      detail:
        (missing.length === 0
          ? "Every active employee hired in the last 60 days can sign in to the portal, or the hourly hand-off retry is still creating the login."
          : `No portal login, and no login being retried: ${formatList(
            missing.map((hire) => `${hire.name}, hired ${toLetterDate(hire.hireDate)}`),
          )}. Open each on Employee Master and create the login there.`) + ledgerNote,
      findings: missing.map((hire) => ({
        affectedDate: hire.hireDate,
        detail: `${hire.name} was hired on ${toLetterDate(hire.hireDate)} and has no portal login, and nothing is retrying one.`,
        hrId: hire.hrId,
        moduleHref: `/employees?edit=${encodeURIComponent(hire.hrId)}`,
        relatedTable: "app_auth_users",
      })),
    };
  },
};

export const recruitmentReconciliationChecks: ReconciliationCheck[] = [acceptedOfferMustProduceAHire, newHiresHaveALogin];
