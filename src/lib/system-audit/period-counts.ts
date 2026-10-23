import { cairoWallClock } from "@/lib/format/cairo-zone";
import { sharedScopeLabel } from "@/lib/system-audit/types";

/**
 * Columns 10 and 11, computed the way `system_audit_page` computes them — a TypeScript copy of its
 * `per_person` and `per_sig` CTEs (supabase/migrations/20261023051848_system_audit_functions.sql),
 * for the file sink and the historical runner, which never touch the database.
 *
 *   per_person  distinct `coalesce(correlation_id, id)` per signature × hr_key, over the PERIOD.
 *               One lost visit seen in three modules carries one correlation id and counts once.
 *               Rows with no person form their own group, exactly as the SQL's `group by` does.
 *   per_sig     distinct non-null hr_key per signature, over the PERIOD. A system row is never
 *               counted as an employee.
 *
 * Over the PERIOD, never over the filtered rows: filtering the page to one person must not turn
 * "SHARED — 4 EMPLOYEES AFFECTED" into "UNIQUE — ONLY THIS EMPLOYEE". Same rule, same reason as
 * the SQL; tests/system-audit-period-counts.test.ts pins it.
 */

export type PeriodOccurrence = {
  id: string;
  signatureKey: string;
  hrKey: string | null;
  correlationId?: string | null;
  occurredAt: string;
  isTest?: boolean;
};

export type PeriodWindow = {
  /** Inclusive Cairo calendar dates, YYYY-MM-DD. */
  from?: string | null;
  to?: string | null;
  includeTest?: boolean;
};

/** The Cairo calendar date of an instant, YYYY-MM-DD. */
export function cairoCalendarDate(iso: string): string {
  return cairoWallClock(new Date(iso)).toISOString().slice(0, 10);
}

/**
 * The SQL's `period` CTE: Cairo days turned into bounds (`>= from 00:00 Cairo`, `< to+1 00:00
 * Cairo`), which is the same as the occurrence's Cairo date falling in [from, to]. Test rows leave
 * unless asked for.
 */
export function selectPeriod<T extends PeriodOccurrence>(rows: readonly T[], window: PeriodWindow = {}): T[] {
  return rows.filter((row) => {
    if (row.isTest && !window.includeTest) return false;
    const day = cairoCalendarDate(row.occurredAt);
    if (window.from && day < window.from) return false;
    if (window.to && day > window.to) return false;
    return true;
  });
}

function personGroup(signatureKey: string, hrKey: string | null): string {
  // \u0001 marks the null group so it can never collide with an hr_key spelled "".
  return `${signatureKey}\u0000${hrKey ?? "\u0001"}`;
}

export type PeriodCounts = {
  /** Column 10 for a row: operations this person (or the system group) had with this signature. */
  personOps(signatureKey: string, hrKey: string | null): number;
  /** Distinct people with this signature. */
  people(signatureKey: string): number;
  /** Column 11 for a row. */
  scopeLabel(signatureKey: string, hrKey: string | null): string;
};

/** Counts over `period` — pass the WHOLE period (selectPeriod), never the filtered rows. */
export function computePeriodCounts(period: readonly PeriodOccurrence[]): PeriodCounts {
  const operations = new Map<string, Set<string>>();
  const peopleBySignature = new Map<string, Set<string>>();
  for (const row of period) {
    const group = personGroup(row.signatureKey, row.hrKey);
    const operationKeys = operations.get(group) ?? new Set<string>();
    operationKeys.add(row.correlationId ?? row.id);
    operations.set(group, operationKeys);
    if (row.hrKey) {
      const people = peopleBySignature.get(row.signatureKey) ?? new Set<string>();
      people.add(row.hrKey);
      peopleBySignature.set(row.signatureKey, people);
    }
  }
  const personOps = (signatureKey: string, hrKey: string | null) => operations.get(personGroup(signatureKey, hrKey))?.size ?? 0;
  const people = (signatureKey: string) => peopleBySignature.get(signatureKey)?.size ?? 0;
  return {
    personOps,
    people,
    scopeLabel: (signatureKey, hrKey) => sharedScopeLabel(people(signatureKey), hrKey),
  };
}
