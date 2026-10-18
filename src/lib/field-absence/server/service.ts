/**
 * Field Absence Calendar — the one loader both doors call (`/admin/field-absence` and its portal twin
 * `/employee-portals/field-absence`), so neither can drift into reaching further than the other.
 *
 * Order matters and is the security boundary: the matrix grant, then the four named roles, then the
 * scope — and the scope is applied to the ROSTER before a single source is read, so a National Sales
 * Manager's page is never a company page with rows hidden.
 */

import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { cairoTodayIso } from "@/lib/crm/dates";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";

import { canReadFieldAbsence, resolveFieldAbsenceScope, scopeAdmitsLine } from "../access";
import {
  buildFieldAbsenceCalendar,
  isFieldAbsenceTier,
  resolveFieldAbsencePeriod,
  type FieldAbsencePageData,
} from "../rules";
import { loadFieldAbsenceEvidence } from "./evidence";
import { loadFieldAbsenceRoster, loadFieldAbsenceSeats } from "./roster";

export type { FieldAbsencePageData };

export async function loadFieldAbsencePage(
  access: AccessContext,
  params: { view?: string | null; month?: string | null; week?: string | null; line?: string | null },
): Promise<FieldAbsencePageData> {
  await assertPermission(access, "field_absence", "read");
  if (!canReadFieldAbsence(access)) throw new Error("Forbidden: the Field Absence Calendar is not open to this role.");

  const today = cairoTodayIso();
  const period = resolveFieldAbsencePeriod({ month: params.month, today, view: params.view, week: params.week });

  const seats = await loadFieldAbsenceSeats();
  const scope = resolveFieldAbsenceScope(access, seats);

  const lineNames = new Map<string, string>();
  for (const seat of seats) {
    if (seat.lineCode && isFieldAbsenceTier(seat.tier) && scopeAdmitsLine(scope, seat.lineCode)) {
      lineNames.set(seat.lineCode, seat.lineName ?? seat.lineCode);
    }
  }
  const lines = [...lineNames.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
  const line = params.line && lineNames.has(params.line) ? params.line : null;

  const roster =
    scope.basis === "none"
      ? []
      : (await loadFieldAbsenceRoster({ end: period.end, seats, start: period.start, today }))
          .map((person) => ({
            ...person,
            spans: person.spans.filter((span) => scopeAdmitsLine(scope, span.lineCode) && (!line || span.lineCode === line)),
          }))
          .filter((person) => person.spans.length > 0);

  // Nothing after today is read: a future day is drawn blank, never judged.
  const evidenceEnd = period.end < today ? period.end : today;
  const evidence = await loadFieldAbsenceEvidence({
    departedHrIds: roster.filter((person) => !person.employmentActive).map((person) => person.key),
    end: evidenceEnd,
    hrIds: roster.map((person) => person.key),
    start: period.start,
  });

  const calendar = buildFieldAbsenceCalendar({ end: period.end, evidence, people: roster, start: period.start, today });
  const viewer = canonicalHrIdForDisplay(access.hrId);

  return {
    calendar,
    line,
    lines,
    period,
    scope: scope.basis,
    viewerKey: viewer && roster.some((person) => person.key === viewer) ? viewer : null,
  };
}
