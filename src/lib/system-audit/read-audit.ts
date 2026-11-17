import { writeAuditLog, type AuditLogInput } from "@/lib/admin/audit";
import { logError } from "@/lib/observability/log";
import { describeSystemAuditFilters } from "@/lib/system-audit/page-query";
import type { SystemAuditFilters } from "@/lib/system-audit/types";

/**
 * Who read what on the System Audit page — one audit row for every read the access registry declares
 * audited (src/lib/security/access-registry.ts: `/api/admin/system-audit`, `/occurrences/:id` and
 * `/security`, each `access-read`, `required: true`).
 *
 * WHY. Those three reads hand over people's data: the incidents ledger names who met which error,
 * the drawer shows a person's last page visits before it, and login security lists people's sign-in
 * addresses. The registry declared each an audited read, yet none wrote a row (deep audit, 17 Nov
 * 2026), so nothing said who had looked. The screenshot routes already write theirs
 * (screenshot-views.ts); these follow the same rules.
 *
 * WHEN. After the Super Admin guard and after the read succeeded — a refused caller, a bad query or a
 * failed read writes nothing, because nothing was seen — and awaited BEFORE the answer leaves, never
 * deferred with `afterResponse` (a crash between the reply and the write would lose it).
 * `writeAuditLog` keeps a slow write in its outbox rather than losing it and never throws, so a slow
 * trail can delay a read but never refuse one.
 */

export type SystemAuditReader = { loginId: string | null; hrId: string | null };

export type SystemAuditRead =
  | { kind: "incidents"; filters: SystemAuditFilters; offset: number; rows: number; total: number }
  | { kind: "people"; search: string; found: number }
  | { kind: "modules"; filters: SystemAuditFilters; found: number }
  | { kind: "occurrence"; occurrenceId: string; personHrId: string | null; personName: string | null; pageVisits: number }
  | { kind: "login_security"; page: number; search: string | null; addresses: number };

const count = (value: number) => value.toLocaleString("en-US");

/** One sentence for the audit log, in the words the page itself uses. */
export function systemAuditReadSummary(read: SystemAuditRead): string {
  switch (read.kind) {
    case "incidents": {
      const shown = read.rows === 0 ? "no rows" : `rows ${count(read.offset + 1)}–${count(read.offset + read.rows)}`;
      return `Viewed the System Audit incidents — ${shown} of ${count(read.total)}. Filters: ${describeSystemAuditFilters(read.filters)}.`;
    }
    case "people":
      return `Searched the System Audit person filter for “${read.search}” — ${count(read.found)} ${read.found === 1 ? "person" : "people"} listed.`;
    case "modules":
      return `Listed the System Audit modules — ${count(read.found)} found. Filters: ${describeSystemAuditFilters(read.filters)}.`;
    case "occurrence": {
      const who = read.personName?.trim() || read.personHrId || "no signed-in person";
      const visits = read.pageVisits > 0 ? `, with their last ${count(read.pageVisits)} page ${read.pageVisits === 1 ? "visit" : "visits"}` : "";
      return `Opened System Audit occurrence ${read.occurrenceId.slice(0, 8)} — ${who}${visits}.`;
    }
    case "login_security":
      return `Viewed login security — people's sign-in addresses (${count(read.addresses)} flagged), page ${count(read.page)}${read.search ? `, search “${read.search}”` : ""}.`;
  }
}

/** The audit row a read writes. Pure, so the shape is pinned without a database. */
export function systemAuditReadAuditRow(reader: SystemAuditReader, read: SystemAuditRead): AuditLogInput {
  return {
    actorLoginId: reader.loginId,
    entityId: read.kind === "occurrence" ? read.occurrenceId : read.kind,
    entityType: "system_audit_view",
    newValues: { ...read, readerHrId: reader.hrId },
    summary: systemAuditReadSummary(read),
  };
}

/** Write the one audit row for a read the Super Admin is about to receive. Never throws. */
export async function recordSystemAuditRead(
  reader: SystemAuditReader,
  read: SystemAuditRead,
  deps: { write?: (input: AuditLogInput) => Promise<void> } = {},
): Promise<void> {
  const row = systemAuditReadAuditRow(reader, read);
  try {
    await (deps.write ?? writeAuditLog)(row);
  } catch (error) {
    // writeAuditLog reports its own failures and keeps the row in the outbox; this catches only a
    // throw from beneath it, so a broken trail is loud in the logs and never refuses the read.
    logError("System Audit read audit row could not be written", {
      labels: { event: "system_audit_read_audit_failed", entityId: row.entityId ?? null },
      context: { actorLoginId: reader.loginId, summary: row.summary },
      error,
    });
  }
}
