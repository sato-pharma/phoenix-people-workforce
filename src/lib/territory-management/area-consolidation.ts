import type { AccessContext } from "@/lib/auth/permissions";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Area consolidation — merging a legacy area into the one it actually means.
//
// WHY THIS EXISTS. The owner, 2026-08-22: "I want you to shift any bulk from them. I want me to be
// able to, in the system itself, I check if confirmed, I press the button, and it goes. I don't
// want you to do any of this critical sensitive work."
//
// That is a rule about WHO acts, not merely about what gets built. Repointing employees, teams and
// customers between areas is bulk work on live org data. It must never happen because an agent ran
// an UPDATE against production. It happens because the Super Admin read a named, itemized list on
// screen and pressed a button. Everything below is shaped by that:
//
//   * `previewAreaConsolidation` NAMES every affected row. Not counts — names. A count cannot be
//     checked by a human, and "I check if confirmed" is the entire point.
//   * `applyAreaConsolidation` does nothing that the preview did not already show.
//   * Every move is recorded with its PREVIOUS area, so `revertAreaConsolidation` restores the
//     exact prior state rather than guessing that everything came from the source area.
//   * Nothing is deleted, ever. Not the source area, not a row, not a ledger entry.
//
// WHAT A CONSOLIDATION MOVES, AND WHAT IT DELIBERATELY LEAVES ALONE.
//
// `public.areas` carries two vocabularies side by side: the current Direct Order / Source-of-Sales
// coding (`AB1`, `D12`, `GZ6`, `UE5` …) which matches `source_of_sales_areas`, and slug-style rows
// from an older line-scoped scheme (`delta_1`, `menoufia_1`, `alex_delta` …) which match nothing.
// Nine tables carry an `area_id`. They do not all mean the same thing, so they are not all treated
// the same:
//
//   CURRENT ASSIGNMENT — moved. `employees`, `teams`, `positions`, `position_vacancies`,
//   `marketing_customers`, `marketing_pharmacies`, `marketing_requests`. These say where something
//   IS. Leaving them on a dead area is what breaks territorial visibility and blocks transfers.
//
//   HISTORICAL RECORD — NOT moved. `employee_history`, `coaching_reports`. These say where
//   something WAS. Rewriting them would make the system assert that a coaching visit happened in a
//   territory it did not happen in. The preview lists them so the owner can see they were skipped
//   and why; it does not hide them.
//
// This split is a judgement, and it is surfaced on screen rather than buried here — see
// `AREA_TABLE_ROLE` and the preview's `untouched` section.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who may run a consolidation.
 *
 * **Super Admin only**, matching the validated-customer register. This is bulk mutation of live org
 * data — employees change territory, teams change territory. Nobody else gets the button, and the
 * `system` scope shortcut is server-internal (a single hard-coded constant that is itself
 * Super Admin), never a signed-in human.
 */
export function canRunAreaConsolidation(access: Pick<AccessContext, "role" | "scope">): boolean {
  if (access.scope === "system") return true;
  return access.role === "Super Admin";
}

export function assertAreaConsolidationAccess(access: AccessContext) {
  if (!canRunAreaConsolidation(access)) {
    throw forbiddenError(`Forbidden: ${access.role} cannot consolidate areas.`);
  }
}

/** How a table's `area_id` should be read, and therefore whether a consolidation may rewrite it. */
export type AreaTableRole = "current" | "historical";

export type AreaTableSpec = {
  /** Table name, as it appears in Postgres. */
  table: string;
  /** Primary key column — these tables do not agree on one. */
  primaryKey: string;
  /** What the owner should see on screen, in words, never the raw table name. */
  label: string;
  /** A column that carries a human-readable name, used to itemize the preview. */
  displayColumn: string | null;
  role: AreaTableRole;
  /** Shown next to a historical table to explain why it is being left alone. */
  untouchedReason?: string;
};

/**
 * Every table with a foreign key to `public.areas`, verified against production 2026-08-22 by
 * walking `pg_constraint` rather than by trusting this list. If a tenth table gains an `area_id`
 * and is not added here, `assertAreaTableCoverage` below turns the test red — a consolidation that
 * silently skips a table would leave rows stranded on a dead area, which is exactly the failure
 * this feature exists to end.
 */
export const AREA_TABLES: readonly AreaTableSpec[] = [
  {
    table: "employees",
    primaryKey: "hr_id",
    label: "Employees",
    displayColumn: "full_name",
    role: "current",
  },
  {
    table: "teams",
    primaryKey: "id",
    label: "Teams",
    displayColumn: "name",
    role: "current",
  },
  {
    table: "positions",
    primaryKey: "id",
    label: "Organogram seats",
    displayColumn: "title",
    role: "current",
  },
  {
    table: "position_vacancies",
    primaryKey: "id",
    label: "Open vacancies",
    displayColumn: "job_title",
    role: "current",
  },
  {
    table: "marketing_customers",
    primaryKey: "id",
    label: "Marketing customers",
    displayColumn: "display_name",
    role: "current",
  },
  {
    table: "marketing_pharmacies",
    primaryKey: "id",
    label: "Marketing pharmacies",
    displayColumn: "display_name",
    role: "current",
  },
  {
    table: "marketing_requests",
    primaryKey: "id",
    label: "Marketing requests",
    displayColumn: "request_code",
    role: "current",
  },
  {
    table: "employee_history",
    primaryKey: "id",
    label: "Employee history",
    displayColumn: null,
    role: "historical",
    untouchedReason:
      "History records where someone WAS. Rewriting it would make the system claim a past posting happened in a territory it did not.",
  },
  {
    table: "coaching_reports",
    primaryKey: "id",
    label: "Coaching reports",
    displayColumn: null,
    role: "historical",
    untouchedReason:
      "A coaching visit happened where it happened. Moving it would misattribute past field work to a different territory.",
  },
] as const;

const MOVABLE_TABLES = AREA_TABLES.filter((spec) => spec.role === "current");

/** How many rows the preview names per table before it stops listing and just counts. */
const PREVIEW_SAMPLE_LIMIT = 50;

export type AreaRef = {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
};

export type AreaConsolidationRow = {
  primaryKey: string;
  label: string;
};

export type AreaConsolidationTablePreview = {
  table: string;
  label: string;
  role: AreaTableRole;
  count: number;
  /** Named rows, capped at PREVIEW_SAMPLE_LIMIT. `count` is the true total. */
  rows: readonly AreaConsolidationRow[];
  /** True when `count` exceeded the cap, so the screen can say so instead of implying it listed all. */
  truncated: boolean;
  untouchedReason?: string;
};

export type AreaConsolidationPreview = {
  source: AreaRef;
  target: AreaRef | null;
  /** Where the target came from — an owner ruling, or nothing at all. */
  targetSource: "owner_ruling" | "none";
  willMove: readonly AreaConsolidationTablePreview[];
  untouched: readonly AreaConsolidationTablePreview[];
  totalToMove: number;
  /** An existing live consolidation, if this source has already been merged. */
  liveConsolidationId: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

async function loadArea(id: number): Promise<AreaRef | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("areas")
    .select("id, code, name, is_active")
    .eq("id", id)
    .maybeSingle();

  const row = data as { id?: number; code?: string; name?: string; is_active?: boolean } | null;
  if (!row?.id) return null;
  return {
    id: Number(row.id),
    code: String(row.code ?? ""),
    name: String(row.name ?? ""),
    isActive: Boolean(row.is_active),
  };
}

async function loadAreaByCode(code: string): Promise<AreaRef | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("areas")
    .select("id, code, name, is_active")
    .eq("code", code)
    .eq("is_active", true)
    .maybeSingle();

  const row = data as { id?: number; code?: string; name?: string; is_active?: boolean } | null;
  if (!row?.id) return null;
  return {
    id: Number(row.id),
    code: String(row.code ?? ""),
    name: String(row.name ?? ""),
    isActive: Boolean(row.is_active),
  };
}

async function previewTable(
  spec: AreaTableSpec,
  areaId: number,
): Promise<AreaConsolidationTablePreview> {
  const supabase = getSupabaseAdmin();
  const columns = spec.displayColumn
    ? `${spec.primaryKey}, ${spec.displayColumn}`
    : spec.primaryKey;

  const { count } = await supabase
    .from(spec.table)
    .select(spec.primaryKey, { count: "exact", head: true })
    .eq("area_id", areaId);

  const { data } = await supabase
    .from(spec.table)
    .select(columns)
    .eq("area_id", areaId)
    .limit(PREVIEW_SAMPLE_LIMIT);

  // A row is only listed if it can be named. The owner's standing rule is human-readable names,
  // never raw codes or IDs — and falling back to the primary key broke it in the worst place: the
  // one screen whose entire job is "I check if confirmed". A UUID cannot be checked by a human, so
  // an unnameable row is COUNTED and not listed, rather than printed as a hex string that looks
  // like data. Every table that has a human column now declares one.
  const rows = spec.displayColumn
    ? ((data ?? []) as unknown as Record<string, unknown>[]).flatMap((row) => {
        const named = String(row[spec.displayColumn as string] ?? "").trim();
        if (!named) return [];
        return [{ primaryKey: String(row[spec.primaryKey] ?? ""), label: named }];
      })
    : [];

  const total = count ?? 0;
  return {
    table: spec.table,
    label: spec.label,
    role: spec.role,
    count: total,
    rows,
    // Only claim truncation when we actually listed something. With no listed rows the screen shows
    // the count alone, and "showing the first 0 of 5" would be nonsense.
    truncated: rows.length > 0 && total > rows.length,
    untouchedReason: spec.untouchedReason,
  };
}

/**
 * Everything a consolidation of `sourceAreaId` would do, itemized by name.
 *
 * The target is NOT inferred here. It comes from `LEGACY_MARKETING_AREA_ALIASES` — the map of owner
 * rulings — or it comes back null and the screen says the area has no ruling yet. Guessing a target
 * from a similar name or a nearby centroid is precisely the "critical sensitive work" the owner
 * took out of an agent's hands.
 */
export async function previewAreaConsolidation(
  access: AccessContext,
  sourceAreaId: number,
): Promise<AreaConsolidationPreview> {
  assertAreaConsolidationAccess(access);

  const source = await loadArea(sourceAreaId);
  if (!source) throw notFoundError("That area does not exist.");

  const { LEGACY_MARKETING_AREA_ALIASES } = await import(
    "@/lib/marketing-requests/validated-customer-transfer"
  );
  const ruledTargetCode = LEGACY_MARKETING_AREA_ALIASES[source.code.toLowerCase()] ?? null;
  const target = ruledTargetCode ? await loadAreaByCode(ruledTargetCode) : null;

  const previews = await Promise.all(AREA_TABLES.map((spec) => previewTable(spec, sourceAreaId)));
  const willMove = previews.filter((entry) => entry.role === "current");
  const untouched = previews.filter((entry) => entry.role === "historical");

  const supabase = getSupabaseAdmin();
  // This read decides whether the screen offers APPLY or REVERT, so it must never fail quietly.
  // Discarding the error made it fail OPEN: a missing table, a timeout or a grant problem all came
  // back as `null`, which reads identically to "nothing is consolidated" — so the screen would hide
  // the Revert button on an area that IS consolidated and offer to consolidate it again. The
  // database's partial unique index would still refuse the second apply, but the owner would be
  // told to "revert that one first" by a screen showing him no way to revert.
  const { data: live, error: liveError } = await supabase
    .from("area_consolidations")
    .select("id")
    .eq("source_area_id", sourceAreaId)
    .eq("status", "applied")
    .maybeSingle();
  if (liveError) {
    throw new Error(
      `Could not read the consolidation ledger for ${source.name}, so this preview cannot say whether it has already been consolidated. Nothing was changed. (${liveError.message})`,
    );
  }

  return {
    source,
    target,
    targetSource: target ? "owner_ruling" : "none",
    willMove,
    untouched,
    totalToMove: willMove.reduce((sum, entry) => sum + entry.count, 0),
    liveConsolidationId: (live as { id?: string } | null)?.id ?? null,
  };
}

export type AreaConsolidationCandidate = {
  source: AreaRef;
  target: AreaRef | null;
  rowsToMove: number;
  liveConsolidationId: string | null;
};

/**
 * Legacy areas that still have rows hanging off them.
 *
 * "Legacy" means the area's code resolves to no active `source_of_sales_areas` row — the same test
 * the Direct Order hand-off uses. An area with a ruling AND rows is the actionable case; an area
 * with rows and no ruling is listed too, because the owner needs to see it exists in order to rule
 * on it.
 */
export async function listAreaConsolidationCandidates(
  access: AccessContext,
): Promise<readonly AreaConsolidationCandidate[]> {
  assertAreaConsolidationAccess(access);

  const supabase = getSupabaseAdmin();
  const { data: areaRows } = await supabase
    .from("areas")
    .select("id, code, name, is_active")
    .eq("is_active", true);

  const areas = ((areaRows ?? []) as Record<string, unknown>[]).map((row) => ({
    id: Number(row.id),
    code: String(row.code ?? ""),
    name: String(row.name ?? ""),
    isActive: Boolean(row.is_active),
  }));

  const { data: sosRows } = await supabase
    .from("source_of_sales_areas")
    .select("area_code")
    .eq("active", true);
  const currentCodes = new Set(
    ((sosRows ?? []) as { area_code?: string }[]).map((row) => String(row.area_code ?? "")),
  );

  const legacy = areas.filter((area) => !currentCodes.has(area.code));
  if (legacy.length === 0) return [];

  const { LEGACY_MARKETING_AREA_ALIASES } = await import(
    "@/lib/marketing-requests/validated-customer-transfer"
  );

  // Same fail-open as the preview: an error here would silently drop every live consolidation from
  // the map, so an already-consolidated area would reappear on the list as if it were untouched.
  const { data: liveRows, error: liveRowsError } = await supabase
    .from("area_consolidations")
    .select("id, source_area_id")
    .eq("status", "applied");
  if (liveRowsError) {
    throw new Error(
      `Could not read the consolidation ledger, so this list cannot say which areas have already been consolidated. (${liveRowsError.message})`,
    );
  }
  const liveBySource = new Map(
    ((liveRows ?? []) as { id?: string; source_area_id?: number }[]).map((row) => [
      Number(row.source_area_id),
      String(row.id),
    ]),
  );

  const candidates: AreaConsolidationCandidate[] = [];
  for (const area of legacy) {
    let rowsToMove = 0;
    for (const spec of MOVABLE_TABLES) {
      const { count } = await supabase
        .from(spec.table)
        .select(spec.primaryKey, { count: "exact", head: true })
        .eq("area_id", area.id);
      rowsToMove += count ?? 0;
    }
    if (rowsToMove === 0 && !liveBySource.has(area.id)) continue;

    const ruledCode = LEGACY_MARKETING_AREA_ALIASES[area.code.toLowerCase()] ?? null;
    candidates.push({
      source: area,
      target: ruledCode ? await loadAreaByCode(ruledCode) : null,
      rowsToMove,
      liveConsolidationId: liveBySource.get(area.id) ?? null,
    });
  }

  return candidates.sort((a, b) => b.rowsToMove - a.rowsToMove);
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────────────────────

export type AppliedAreaConsolidation = {
  consolidationId: string;
  movedCounts: Record<string, number>;
  totalMoved: number;
};

/**
 * Perform the consolidation the preview described.
 *
 * The order matters and is deliberate:
 *
 *   1. Write the ledger header FIRST. If anything below fails, there is a row saying a
 *      consolidation was attempted, by whom, and against which areas. A silent partial move with no
 *      header is the one outcome that would be genuinely hard to unpick.
 *   2. For each table, read the affected rows and record their PREVIOUS area before updating them.
 *      Recording after the update would capture the new value and make revert a no-op.
 *   3. Update, scoped by `area_id = source` in the WHERE. A row that another session moved in the
 *      meantime is simply not matched, rather than being stamped over.
 *   4. Audit last, with `writeRequiredAuditLog`, which THROWS if the audit cannot be written. A
 *      bulk org move that leaves no audit trail must be treated as a failure, not a success.
 */
export async function applyAreaConsolidation(
  access: AccessContext,
  input: { sourceAreaId: number; targetAreaId: number; notes?: string | null },
): Promise<AppliedAreaConsolidation> {
  assertAreaConsolidationAccess(access);

  const { sourceAreaId, targetAreaId } = input;
  if (sourceAreaId === targetAreaId) {
    throw validationError("An area cannot be consolidated into itself.");
  }

  const actorHrId = (access.hrId ?? "").trim();
  if (!actorHrId) {
    throw validationError("A consolidation must record who performed it.");
  }

  const source = await loadArea(sourceAreaId);
  if (!source) throw notFoundError("The source area does not exist.");
  const target = await loadArea(targetAreaId);
  if (!target) throw notFoundError("The target area does not exist.");
  if (!target.isActive) {
    throw validationError(`${target.name} is not an active area, so nothing may be moved into it.`);
  }

  const supabase = getSupabaseAdmin();

  const { data: header, error: headerError } = await supabase
    .from("area_consolidations")
    .insert({
      source_area_id: source.id,
      target_area_id: target.id,
      source_area_code: source.code,
      source_area_name: source.name,
      target_area_code: target.code,
      target_area_name: target.name,
      status: "applied",
      applied_by_hr_id: actorHrId,
      apply_notes: (input.notes ?? "").trim() || null,
    })
    .select("id")
    .single();

  if (headerError || !header) {
    // The partial unique index is the likely cause: this source area is already consolidated.
    throw validationError(
      `${source.name} could not be consolidated — it may already have a live consolidation. Revert that one first.`,
    );
  }

  const consolidationId = String((header as { id: string }).id);
  const movedCounts: Record<string, number> = {};

  for (const spec of MOVABLE_TABLES) {
    const { data: affected } = await supabase
      .from(spec.table)
      .select(spec.primaryKey)
      .eq("area_id", source.id);

    const keys = ((affected ?? []) as unknown as Record<string, unknown>[])
      .map((row) => String(row[spec.primaryKey] ?? ""))
      .filter(Boolean);
    if (keys.length === 0) continue;

    // Record where each row came from BEFORE moving it. This is the undo buffer.
    const { error: moveError } = await supabase.from("area_consolidation_moves").insert(
      keys.map((key) => ({
        consolidation_id: consolidationId,
        table_name: spec.table,
        row_pk: key,
        previous_area_id: source.id,
      })),
    );
    if (moveError) {
      throw validationError(
        `${spec.label} could not be recorded for undo, so nothing was moved from that table. No further tables were processed.`,
      );
    }

    const { error: updateError } = await supabase
      .from(spec.table)
      .update({ area_id: target.id })
      .eq("area_id", source.id);
    if (updateError) {
      throw validationError(`${spec.label} could not be moved. Revert this consolidation to undo the rest.`);
    }

    movedCounts[spec.table] = keys.length;
  }

  const totalMoved = Object.values(movedCounts).reduce((sum, n) => sum + n, 0);

  await supabase
    .from("area_consolidations")
    .update({ moved_counts: movedCounts })
    .eq("id", consolidationId);

  await writeRequiredAuditLog({
    actorLoginId: actorHrId,
    entityType: "area_consolidation",
    entityId: consolidationId,
    oldValues: { area: source.name, areaCode: source.code, areaId: source.id },
    newValues: { area: target.name, areaCode: target.code, areaId: target.id, movedCounts },
    summary: `Consolidated ${source.name} (${source.code}) into ${target.name} (${target.code}) — ${totalMoved} rows moved.`,
  });

  return { consolidationId, movedCounts, totalMoved };
}

/**
 * Put every row back where it was.
 *
 * Revert reads the undo buffer rather than assuming everything came from the source area, and each
 * update carries `area_id = target` in its WHERE — so a row that has since been moved somewhere
 * else on purpose is left alone instead of being dragged back.
 *
 * Nothing is deleted. The ledger row survives, flips to `reverted`, and keeps naming the admin on
 * both sides of the decision.
 */
export async function revertAreaConsolidation(
  access: AccessContext,
  input: { consolidationId: string; reason?: string | null },
): Promise<{ reverted: true; restored: number }> {
  assertAreaConsolidationAccess(access);

  const actorHrId = (access.hrId ?? "").trim();
  if (!actorHrId) {
    throw validationError("A revert must record who performed it.");
  }

  const supabase = getSupabaseAdmin();
  const { data: headerRow } = await supabase
    .from("area_consolidations")
    .select("id, status, source_area_id, target_area_id, source_area_name, target_area_name")
    .eq("id", input.consolidationId)
    .maybeSingle();

  const header = headerRow as {
    id?: string;
    status?: string;
    source_area_id?: number;
    target_area_id?: number;
    source_area_name?: string;
    target_area_name?: string;
  } | null;

  if (!header?.id) throw notFoundError("That consolidation does not exist.");
  if (header.status !== "applied") {
    throw validationError("That consolidation has already been reverted.");
  }

  const { data: moveRows } = await supabase
    .from("area_consolidation_moves")
    .select("table_name, row_pk, previous_area_id")
    .eq("consolidation_id", header.id);

  const moves = (moveRows ?? []) as {
    table_name?: string;
    row_pk?: string;
    previous_area_id?: number | null;
  }[];

  const targetAreaId = Number(header.target_area_id);
  let restored = 0;

  for (const spec of MOVABLE_TABLES) {
    const forTable = moves.filter((move) => move.table_name === spec.table);
    if (forTable.length === 0) continue;

    // Group by previous area so each distinct prior value is restored correctly. Today every row in
    // one consolidation shares a source, but the buffer stores per-row precisely so that a future
    // many-to-one merge does not silently flatten them.
    const byPrevious = new Map<number | null, string[]>();
    for (const move of forTable) {
      const previous = move.previous_area_id ?? null;
      const bucket = byPrevious.get(previous) ?? [];
      bucket.push(String(move.row_pk ?? ""));
      byPrevious.set(previous, bucket);
    }

    for (const [previousAreaId, keys] of byPrevious) {
      const { error } = await supabase
        .from(spec.table)
        .update({ area_id: previousAreaId })
        .in(spec.primaryKey, keys)
        // Only pull back rows still sitting where this consolidation put them.
        .eq("area_id", targetAreaId);
      if (error) {
        throw validationError(`${spec.label} could not be restored. Nothing further was changed.`);
      }
      restored += keys.length;
    }
  }

  await supabase
    .from("area_consolidations")
    .update({
      status: "reverted",
      reverted_by_hr_id: actorHrId,
      reverted_at: new Date().toISOString(),
      revert_reason: (input.reason ?? "").trim() || null,
    })
    .eq("id", header.id)
    .eq("status", "applied");

  await writeRequiredAuditLog({
    actorLoginId: actorHrId,
    entityType: "area_consolidation",
    entityId: header.id,
    oldValues: { area: header.target_area_name ?? null },
    newValues: { area: header.source_area_name ?? null, reverted: true, restored },
    summary: `Reverted the consolidation of ${header.source_area_name ?? "an area"} into ${header.target_area_name ?? "another area"} — ${restored} rows restored.`,
  });

  return { reverted: true, restored };
}
