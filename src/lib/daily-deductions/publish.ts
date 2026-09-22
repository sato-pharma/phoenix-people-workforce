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
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import { assertDailyDeductionsPublishActor } from "./permissions.ts";
import { assertIsoDate, cairoTodayIso, resolveDailyRange } from "./range.ts";
import { mapDailyPublicationRow } from "./service.ts";
import {
  dailyDeductionCategories,
  type DailyDeductionCategory,
  type DailyDeductionsPublication,
  type DailyDeductionsPublishLineInput,
} from "./types.ts";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function assertNonNegativeNumber(value: unknown, label: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`Validation: ${label} must be a number ≥ 0 (got ${JSON.stringify(value)}).`);
  }
  return round2(num);
}

/**
 * Turn one client-supplied tally row into the exact jsonb shape the RPC consumes,
 * failing loudly on anything malformed. The compact HR id is RE-DERIVED server-side
 * from the raw HR id rather than trusted from the client, so the unique key the
 * publication enforces cannot be spoofed into a collision or a split.
 */
function normalizePublishLine(raw: unknown, index: number): DailyDeductionsPublishLineInput {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Validation: line ${index + 1} is not an object.`);
  }
  const line = raw as Record<string, unknown>;

  const category = String(line.category ?? "") as DailyDeductionCategory;
  if (!(dailyDeductionCategories as readonly string[]).includes(category)) {
    throw new Error(`Validation: line ${index + 1} has an unknown category ${JSON.stringify(line.category)}.`);
  }

  const employeeHrId = String(line.employeeHrId ?? "").trim();
  const compact = compactDeductionsHrId(employeeHrId);
  if (!employeeHrId || !compact) {
    throw new Error(`Validation: line ${index + 1} has no resolvable employee HR id.`);
  }

  const unit = line.unit === "amount" ? "amount" : "days";
  const dates = Array.isArray(line.dates) ? line.dates.filter((d): d is string => typeof d === "string") : [];
  const employeeName = typeof line.employeeName === "string" && line.employeeName.trim() ? line.employeeName.trim() : null;

  return {
    category,
    employeeHrId,
    employeeHrIdCompact: compact,
    employeeName,
    unit,
    rawDaysCount: assertNonNegativeNumber(line.rawDaysCount, `line ${index + 1} rawDaysCount`),
    daysCount: assertNonNegativeNumber(line.daysCount, `line ${index + 1} daysCount`),
    amount: assertNonNegativeNumber(line.amount, `line ${index + 1} amount`),
    dates,
    sourceSystem: String(line.sourceSystem ?? ""),
    reason: typeof line.reason === "string" ? line.reason : null,
    hrNote: typeof line.hrNote === "string" ? line.hrNote : undefined,
  };
}

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

  const lines = input.lines.map(normalizePublishLine);

  // At most one line per (employee, category) — the publication's unique index
  // enforces this, but a friendly error beats a raw 23505 from the RPC.
  const seen = new Set<string>();
  for (const line of lines) {
    const key = `${line.category}|${line.employeeHrIdCompact}`;
    if (seen.has(key)) {
      throw new Error(
        `Validation: ${line.employeeName ?? line.employeeHrId} appears twice for ${line.category}. Each employee×category is one tally line.`,
      );
    }
    seen.add(key);
  }

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
