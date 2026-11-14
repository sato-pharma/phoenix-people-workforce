import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import { roundCurrency } from "@/lib/payroll/money";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Who a PUBLISHED run held back, read from what the run itself recorded (audit findings 43, 46, 52).
 *
 * A held row is dropped at publish: no salary_record is written for it. So every report built from
 * salary_records quietly treats a held person as absent: missing from the statutory filing, looking
 * like a new joiner in the next month's population comparison, and left out of last month's total on
 * the Executive Summary.
 *
 * Two records exist, and they are NOT equally complete:
 *   - the `published` audit row's `heldExcluded` count, on every published run;
 *   - its `held` list with each person's amounts, only on runs published since 2026-09-10.
 * July and August 2026 carry the count alone (checked on production 2026-09-11), so every reader here
 * says which of the two it had rather than presenting a count as a full account.
 */

export type PublishedHeldPerson = {
  hrId: string;
  compact: string;
  name: string;
  firstPartAlreadyPaid: number;
  /** Part 1 the bank files did not pay (held at Part 1 confirm); 0 on runs published before it was recorded. */
  firstPartWithheld: number;
  secondPartWithheld: number;
  monthTotal: number;
  /** The filing figures publish recorded for them; null on runs published before these were recorded. */
  socialInsurance: number | null;
  employmentIncomeTax: number | null;
};

export type PublishedHoldRecord = {
  /** How many publish dropped as held. Null when the run has no published audit row. */
  heldExcluded: number | null;
  /** Each held person with their amounts. Null when publish recorded only the count. */
  held: PublishedHeldPerson[] | null;
};

const NO_RECORD: PublishedHoldRecord = { heldExcluded: null, held: null };

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? roundCurrency(parsed) : null;
}

/** Pure: the hold record inside one `published` audit row's detail. */
export function parsePublishedHoldDetail(detail: unknown): PublishedHoldRecord {
  const record = (detail ?? {}) as { heldExcluded?: unknown; held?: unknown };
  const count = Number(record.heldExcluded);
  const heldExcluded = record.heldExcluded !== undefined && Number.isFinite(count) && count >= 0 ? count : null;
  if (!Array.isArray(record.held)) return { heldExcluded, held: null };
  const held = (record.held as Array<Record<string, unknown>>)
    .map((entry) => {
      const hrId = String(entry.hrId ?? "").trim();
      return {
        hrId,
        compact: compactHrKey(hrId),
        name: String(entry.name ?? "").trim() || hrId,
        firstPartAlreadyPaid: roundCurrency(num(entry.firstPartAlreadyPaid)),
        firstPartWithheld: roundCurrency(num(entry.firstPartWithheld)),
        secondPartWithheld: roundCurrency(num(entry.secondPartWithheld)),
        monthTotal: roundCurrency(num(entry.monthTotal)),
        socialInsurance: numOrNull(entry.socialInsurance),
        employmentIncomeTax: numOrNull(entry.employmentIncomeTax),
      };
    })
    .filter((entry) => entry.compact);
  return { heldExcluded: heldExcluded ?? held.length, held };
}

/**
 * The newest `published` audit row's hold record for a run. A retried publish writes a second row, and
 * the newest one stands (the same rule `loadHeldBalances` applies).
 *
 * A failed read throws, a missing table included, and so does a PUBLISHED run with no record (enterprise
 * audit 2026-11-13, F-PAY-002): answering "nobody was held" for it would print a filing note and a
 * reconciliation that leave the held people out. A run not yet published has no record by design.
 */
export async function readPublishedHoldRecord(runId: string): Promise<PublishedHoldRecord> {
  const { data, error } = await getSupabaseAdmin()
    .from("automated_payroll_audit")
    .select("detail,created_at")
    .eq("run_id", runId)
    .eq("action", "published")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = ((data ?? []) as Array<{ detail?: unknown }>)[0];
  if (row) return parsePublishedHoldDetail(row.detail);

  const { data: run, error: runError } = await getSupabaseAdmin()
    .from("automated_payroll_runs")
    .select("phase")
    .eq("id", runId)
    .maybeSingle();
  if (runError) throw runError;
  if ((run as { phase?: string } | null)?.phase === "published") {
    throw new Error(
      "Conflict: This payroll run is published but its record of who was held is missing, so the held people cannot be " +
        "shown. Nothing is listed rather than a list that leaves them out. Report this to the payroll owner.",
    );
  }
  return NO_RECORD;
}

/**
 * The HR ids a run's own draft rows mark as held. The identity half for a month whose publish recorded
 * only a count: draft rows are kept after publish, so they still say who was held.
 */
export async function heldDraftHrIds(runId: string): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("automated_payroll_draft_rows")
    .select("employee_hr_id")
    .eq("run_id", runId)
    .eq("on_hold", true);
  if (error) throw error;
  return ((data ?? []) as Array<{ employee_hr_id: string | null }>)
    .map((row) => String(row.employee_hr_id ?? "").trim())
    .filter(Boolean);
}

/** The run behind a salary batch Automated Payroll published (`automated-payroll:<runId>`); null for any other batch. */
export function automatedPayrollRunIdFromBatchFileName(fileName: string | null | undefined): string | null {
  const match = /^automated-payroll:([0-9a-f-]{36})$/i.exec(String(fileName ?? "").trim());
  return match ? match[1] : null;
}

function egp(value: number | null): string {
  return value === null ? "not recorded" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The words a statutory filing prints under its TOTAL for the people publish held back (audit finding 43).
 * Null when nobody was held, or when this is not a batch Automated Payroll published.
 */
export function heldExcludedFilingNote(record: PublishedHoldRecord): string | null {
  const lead =
    "held employees are NOT in this filing. A held row is dropped at publish with no salary record, so they " +
    "carry no social insurance or income tax above and are not in the totals";
  if (record.held && record.held.length > 0) {
    const people = record.held.map((person) =>
      person.socialInsurance === null && person.employmentIncomeTax === null
        ? person.name
        : `${person.name} (employee SI ${egp(person.socialInsurance)}, income tax ${egp(person.employmentIncomeTax)})`,
    );
    return `${record.held.length} ${lead}: ${people.join("; ")}.`;
  }
  if (record.heldExcluded !== null && record.heldExcluded > 0) {
    return `${record.heldExcluded} ${lead}. Their names and filing figures were not recorded when this month was published.`;
  }
  return null;
}
