// Daily Deductions module: release ONE line, some lines, or a whole employee at a time.
//
// The weekly attendance digest lets HR tick any flagged day and release it on its own. The Daily
// Deductions page works the same way: every tally line (an employee x a deduction type) is released
// separately. A release MERGES into the one active snapshot - it never replaces what was already
// released - and creates the snapshot when none is active. Withdrawing takes a single line back out.
//
// Like publish.ts, nothing here re-scans the connectors: the lines are the figures the owner saw on
// screen, validated structurally and written atomically by phx_release_daily_deduction_lines. And,
// like publish.ts, nothing here writes salary_records or salary_batches.

import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { assertNoDuplicateDailyLines, normalizeDailyLine } from "./lines.ts";
import { notifyDailyDeductionsReleased, type ReleaseNoticeOutcome } from "./notify-release.ts";
import { assertDailyDeductionsPublishActor } from "./permissions.ts";
import { assertIsoDate, cairoTodayIso, resolveDailyRange } from "./range.ts";
import { mapDailyLineRow, mapDailyPublicationRow } from "./service.ts";
import type { DailyDeductionsLine, DailyDeductionsPublication } from "./types.ts";

export type ReleaseDailyResult = {
  publication: DailyDeductionsPublication;
  releasedCount: number;
  /** One per released line: whether that employee (and their managers) were actually told. */
  notifications: ReleaseNoticeOutcome[];
};

export async function releaseDailyLines(input: {
  rangeStart: string;
  rangeEnd: string;
  lines: unknown[];
  actor: Pick<AccessContext, "role" | "hrId" | "loginId">;
  notes?: string | null;
  todayIso?: string;
  /** Injected by the tests so a release never notifies a real employee. */
  notifyReleased?: typeof notifyDailyDeductionsReleased;
}): Promise<ReleaseDailyResult> {
  assertDailyDeductionsPublishActor(input.actor);
  const releasedBy = input.actor.hrId ?? input.actor.loginId ?? "unknown";

  const rangeStart = assertIsoDate(input.rangeStart, "rangeStart");
  const rangeEnd = assertIsoDate(input.rangeEnd, "rangeEnd");

  // Persist the window actually COUNTED, exactly as publish does: the tally never counts today or
  // later, so a stored end that reached today would overstate what the line represents.
  const todayIso = input.todayIso ?? cairoTodayIso();
  const resolved = resolveDailyRange({ from: rangeStart, to: rangeEnd }, todayIso);
  if (resolved.empty) {
    throw new Error(
      `Validation: the range has no fully-elapsed day yet (nothing is countable through ${resolved.effectiveTo}). Nothing was released.`,
    );
  }

  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new Error("Validation: select at least one deduction to release.");
  }

  const lines = input.lines.map(normalizeDailyLine);
  assertNoDuplicateDailyLines(lines);

  const { data, error } = await getSupabaseAdmin().rpc("phx_release_daily_deduction_lines", {
    p_range_start: resolved.from,
    p_range_end: resolved.effectiveTo,
    p_lines: lines,
    p_actor: releasedBy,
    p_notes: input.notes ?? null,
  });
  if (error) {
    throw new Error(`Failed to release the selected daily deductions: ${error.message}`);
  }

  const publication = mapDailyPublicationRow(data as Record<string, unknown>);

  // THE EMPLOYEE IS TOLD. Until 2026-10-12 this path told nobody at all — the owner released a line
  // and the person it charged heard nothing (see notify-release.ts). Best-effort by contract: the
  // snapshot is already written, so a notification failure is reported, never thrown.
  const notifications = await (input.notifyReleased ?? notifyDailyDeductionsReleased)({
    actorHrId: input.actor.hrId ?? null,
    pairs: lines.map((line) => ({
      category: line.category,
      deductionDate: line.deductionDate ?? null,
      employeeHrId: line.employeeHrId,
      employeeHrIdCompact: line.employeeHrIdCompact,
    })),
    publicationId: publication.id,
  });

  try {
    await writeAuditLog({
      actorLoginId: releasedBy,
      entityId: publication.id,
      entityType: "daily_deductions_publication",
      newValues: {
        rangeStart: resolved.from,
        rangeEnd: resolved.effectiveTo,
        released: lines.map((line) => ({
          employeeHrId: line.employeeHrId,
          category: line.category,
          deductionDate: line.deductionDate ?? null,
          daysCount: line.daysCount,
          amount: line.amount,
        })),
        lineCount: publication.lineCount,
        notifications,
      },
      summary: `Daily deductions released: ${lines.length} line${lines.length === 1 ? "" : "s"} (${resolved.from} → ${resolved.effectiveTo}), ${notifications.filter((notice) => notice.status === "sent").length} employee notice${notifications.filter((notice) => notice.status === "sent").length === 1 ? "" : "s"} sent`,
    });
  } catch {
    // writeAuditLog already swallows; defensive in case a custom logger throws.
  }

  return { notifications, publication, releasedCount: lines.length };
}

export type WithdrawDailyLineResult = {
  line: DailyDeductionsLine;
};

/** Take ONE released line back out of the active snapshot. */
export async function withdrawDailyLine(input: {
  lineId: string;
  actor: Pick<AccessContext, "role" | "hrId" | "loginId">;
}): Promise<WithdrawDailyLineResult> {
  assertDailyDeductionsPublishActor(input.actor);
  const actor = input.actor.hrId ?? input.actor.loginId ?? "unknown";
  if (!input.lineId || typeof input.lineId !== "string") {
    throw new Error("Validation: a line id is required to withdraw a released deduction.");
  }

  const { data, error } = await getSupabaseAdmin().rpc("phx_withdraw_daily_deduction_line", {
    p_line_id: input.lineId,
    p_actor: actor,
  });
  if (error) throw new Error(`Failed to withdraw the released deduction: ${error.message}`);
  if (!data) throw new Error("Not found: that released deduction is no longer in the published snapshot.");

  const line = mapDailyLineRow(data as Record<string, unknown>);

  try {
    await writeAuditLog({
      actorLoginId: actor,
      entityId: line.publicationId,
      entityType: "daily_deductions_publication",
      oldValues: {
        employeeHrId: line.employeeHrId,
        category: line.category,
        daysCount: line.daysCount,
        amount: line.amount,
      },
      summary: `Daily deduction withdrawn: ${line.employeeName ?? line.employeeHrId} · ${line.category}`,
    });
  } catch {
    // defensive
  }

  return { line };
}
