/**
 * Phoenix CRM — the location-integrity board, for the Super Admin alone.
 *
 * This is the ONLY reader of `phoenix_crm_location_integrity`. It lives behind `/admin`, which no rep
 * can open at all, so the evidence cannot leak into the field app through a role mistake in a tab or
 * a component: the rep-facing bundle does not import this file and has no route that reaches it.
 *
 * WHAT A FLAG IS AND IS NOT. It is a reason for a human to look — at the photo, at the day, at the
 * rep. It is not a verdict, it triggers nothing, and nobody is told they were flagged. Acting on one
 * is the owner's decision, made after he has looked, exactly as a flagged expense is.
 */

import { forbiddenError } from "@/lib/http/api-errors";
import { PHOENIX_CRM_INTEGRITY_LABELS, type PhoenixCrmIntegrityFlag } from "@/lib/phoenix-crm/location-integrity";
import { type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

export type IntegrityCase = {
  id: string;
  subjectKind: "visit" | "place";
  subjectId: string;
  /** The rep's NAME, never his code (owner's standing rule). */
  repName: string;
  repHrId: string;
  customerName: string;
  seatId: string;
  capturedAt: string;
  visitDate: string | null;
  strong: boolean;
  flags: PhoenixCrmIntegrityFlag[];
  /** Those flags in plain English, ready to print. */
  reasons: string[];
  lat: number | null;
  lon: number | null;
  accuracyMeters: number | null;
  deviceMocked: boolean | null;
  signals: Record<string, unknown>;
  isTest: boolean;
};

export type IntegrityBoard = {
  cases: IntegrityCase[];
  /** How many of the listed cases carry at least one individually damning flag. */
  strongCount: number;
  /** Reps appearing in the list, most cases first — where a pattern shows rather than an incident. */
  byRep: { repHrId: string; repName: string; cases: number; strongCases: number }[];
};

const BOARD_LIMIT = 200;

/**
 * Load the board. Super Admin only — checked here as well as on the route, because this is the one
 * place in Phoenix CRM where reading the data IS the sensitive act.
 */
export async function loadIntegrityBoard(viewer: PhoenixCrmViewer, options: { includeTest?: boolean } = {}): Promise<IntegrityBoard> {
  if (!viewer.isSuperAdmin) throw forbiddenError("The location integrity board is the Super Admin's.");

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("phoenix_crm_location_integrity")
    .select("id, subject_kind, subject_id, seat_id, rep_hr_id, customer_id, captured_at, visit_date, lat, lon, accuracy_meters, device_mocked, flags, strong, signals, is_test")
    .order("strong", { ascending: false })
    .order("captured_at", { ascending: false })
    .limit(BOARD_LIMIT);
  if (options.includeTest !== true) query = query.eq("is_test", false);

  const { data, error } = await query;
  throwIfError(error);
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return { cases: [], strongCount: 0, byRep: [] };

  const customerIds = [...new Set(rows.map((row) => (row.customer_id ? String(row.customer_id) : null)).filter((id): id is string => Boolean(id)))];
  const [people, customers] = await Promise.all([
    loadPeopleNames([...new Set(rows.map((row) => String(row.rep_hr_id ?? "")).filter(Boolean))]),
    customerIds.length === 0
      ? Promise.resolve({ data: [] as Row[] })
      : supabase.from("phoenix_crm_customers").select("id, name").in("id", customerIds),
  ]);
  const customerNames = new Map<string, string>();
  for (const row of ((customers as { data?: Row[] }).data ?? []) as Row[]) customerNames.set(String(row.id), String(row.name ?? ""));

  const cases: IntegrityCase[] = rows.map((row) => {
    const flags = (Array.isArray(row.flags) ? row.flags : []).map((flag) => String(flag)) as PhoenixCrmIntegrityFlag[];
    const repHrId = String(row.rep_hr_id ?? "");
    const customerId = row.customer_id ? String(row.customer_id) : null;
    return {
      id: String(row.id),
      subjectKind: row.subject_kind === "place" ? "place" : "visit",
      subjectId: String(row.subject_id),
      repHrId,
      repName: nameOf(people, repHrId) || repHrId,
      customerName: (customerId ? customerNames.get(customerId) : null) ?? "—",
      seatId: String(row.seat_id ?? ""),
      capturedAt: String(row.captured_at),
      visitDate: row.visit_date ? String(row.visit_date) : null,
      strong: row.strong === true,
      flags,
      reasons: flags.map((flag) => PHOENIX_CRM_INTEGRITY_LABELS[flag] ?? flag),
      lat: row.lat === null || row.lat === undefined ? null : Number(row.lat),
      lon: row.lon === null || row.lon === undefined ? null : Number(row.lon),
      accuracyMeters: row.accuracy_meters === null || row.accuracy_meters === undefined ? null : Number(row.accuracy_meters),
      deviceMocked: typeof row.device_mocked === "boolean" ? row.device_mocked : null,
      signals: (row.signals && typeof row.signals === "object" ? row.signals : {}) as Record<string, unknown>,
      isTest: row.is_test === true,
    };
  });

  const perRep = new Map<string, { repHrId: string; repName: string; cases: number; strongCases: number }>();
  for (const entry of cases) {
    const current = perRep.get(entry.repHrId) ?? { repHrId: entry.repHrId, repName: entry.repName, cases: 0, strongCases: 0 };
    current.cases += 1;
    if (entry.strong) current.strongCases += 1;
    perRep.set(entry.repHrId, current);
  }

  return {
    cases,
    strongCount: cases.filter((entry) => entry.strong).length,
    byRep: [...perRep.values()].sort((left, right) => right.strongCases - left.strongCases || right.cases - left.cases),
  };
}
