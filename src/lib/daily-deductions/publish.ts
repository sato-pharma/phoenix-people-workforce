// Daily Deductions module: publish + supersede.
//
// Unlike the month module, publish does NOT re-scan the connectors. The owner
// computes the running tally on screen (runConnectorForRange, one request per
// connector), reviews it, and clicks publish; the reviewed lines come back here
// and are validated STRUCTURALLY, then written atomically by
// phx_publish_daily_deductions. A full server-side re-scan on the publish click
// is exactly what put the month module's single-request publish over the 300s
// Cloud Run limit (#1377) — and this is a governance/reporting snapshot the owner
// personally reviewed, not a salary commit, so the reviewed figure IS the input.
//
// Nothing here writes salary_records/salary_batches. The only output is the
// daily_deductions_publications / daily_deductions_lines snapshot.

import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { assertDailyDeductionsPublishActor } from "./permissions.ts";
import { assertIsoDate, cairoTodayIso, resolveDailyRange } from "./range.ts";
import { mapDailyPublicationRow } from "./service.ts";
import { assertNoDuplicateDailyLines, normalizeDailyLine } from "./lines.ts";
import type { DailyDeductionsPublication } from "./types.ts";

export type PublishDailyResult = {
  publication: DailyDeductionsPublication;
  lineCount: number;
  employeeCount: number;
};

/**
 * Publish (or re-publish) the running tally for a range. Re-publishing atomically
 * supersedes the prior active snapshot inside phx_publish_daily_deductions, so at
 * most one snapshot is ever active — the "publish anytime, latest wins" model.
 */
export async function publishDailyTally(input: {
  rangeStart: string;
  rangeEnd: string;
  lines: unknown[];
  actor: Pick<AccessContext, "role" | "hrId" | "loginId">;
  notes?: string | null;
  todayIso?: string;
}): Promise<PublishDailyResult> {
  assertDailyDeductionsPublishActor(input.actor);
  const publishedBy = input.actor.hrId ?? input.actor.loginId ?? "unknown";

  const rangeStart = assertIsoDate(input.rangeStart, "rangeStart");
  const rangeEnd = assertIsoDate(input.rangeEnd, "rangeEnd");

  // Persist the range actually COUNTED, not the raw picker value: the tally never
  // counts today or later, so a snapshot whose stored end reached today would
  // overstate the window it represents. This clamps rangeEnd to the last elapsed
  // day exactly as the compute did, and refuses a range with no elapsed day.
  const todayIso = input.todayIso ?? cairoTodayIso();
  const resolved = resolveDailyRange({ from: rangeStart, to: rangeEnd }, todayIso);
  if (resolved.empty) {
    throw new Error(
      `Validation: the range has no fully-elapsed day yet (nothing is countable through ${resolved.effectiveTo}). Nothing was published.`,
    );
  }

  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new Error("Validation: there are no tally lines to publish.");
  }

  const lines = input.lines.map(normalizeDailyLine);

  assertNoDuplicateDailyLines(lines);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_publish_daily_deductions", {
    p_range_start: resolved.from,
    p_range_end: resolved.effectiveTo,
    p_lines: lines,
    p_actor: publishedBy,
    p_notes: input.notes ?? null,
  });
  if (error) {
    throw new Error(`Failed to publish the daily deductions tally: ${error.message}`);
  }

  const publication = mapDailyPublicationRow(data as Record<string, unknown>);

  try {
    await writeAuditLog({
      actorLoginId: publishedBy,
      entityId: publication.id,
      entityType: "daily_deductions_publication",
      newValues: {
        rangeStart: resolved.from,
        rangeEnd: resolved.effectiveTo,
        lineCount: publication.lineCount,
        employeeCount: publication.employeeCount,
      },
      summary: `Daily deductions tally published for ${resolved.from} → ${resolved.effectiveTo}`,
    });
  } catch {
    // writeAuditLog already swallows; defensive in case a custom logger throws.
  }

  return { publication, lineCount: publication.lineCount, employeeCount: publication.employeeCount };
}

/** Supersede the active snapshot without replacing it (clears the running tally). */
export async function supersedeDailyPublication(input: {
  publicationId: string;
  actor: Pick<AccessContext, "role" | "hrId" | "loginId">;
}): Promise<DailyDeductionsPublication> {
  assertDailyDeductionsPublishActor(input.actor);
  const actor = input.actor.hrId ?? input.actor.loginId ?? "unknown";
  if (!input.publicationId || typeof input.publicationId !== "string") {
    throw new Error("Validation: a publication id is required to supersede.");
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_supersede_daily_deductions", {
    p_publication_id: input.publicationId,
    p_actor: actor,
  });
  if (error) throw new Error(`Failed to supersede the daily deductions tally: ${error.message}`);
  if (!data) throw new Error("Not found: that daily deductions publication does not exist or is already superseded.");

  const publication = mapDailyPublicationRow(data as Record<string, unknown>);

  try {
    await writeAuditLog({
      actorLoginId: actor,
      entityId: publication.id,
      entityType: "daily_deductions_publication",
      newValues: { status: "superseded" },
      summary: `Daily deductions tally superseded (${publication.rangeStart} → ${publication.rangeEnd})`,
    });
  } catch {
    // defensive
  }

  return publication;
}
