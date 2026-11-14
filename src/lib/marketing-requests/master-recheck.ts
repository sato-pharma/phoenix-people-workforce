import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { assertRealSessionForDecision } from "@/lib/auth/preview-session-guard";
import type { AccessContext } from "@/lib/auth/permissions";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { resolveMarketingPharmacyCodes } from "@/lib/marketing-requests/master-resolution";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// THE NIGHTLY RE-CHECK OF UNRESOLVED PHARMACY CODES (enterprise audit REC-077, F-MKT-011; 14 Nov 2026).
//
// `phx_resolve_marketing_pharmacy_codes` runs once, when a code is captured. A code entered before the
// sales customer master knew its pharmacy read "unresolved" for good, even after the next Sales import
// brought the shop in: on 14 Nov 2026, 9 of the 21 active unresolved codes matched exactly one master shop.
//
// The owner chose "pin untouched, list rest" (14 Nov 2026):
//   * A code NOBODY HAS DECIDED ON (`isUntouchedCode`) is matched every night exactly as it would have
//     been at capture — the same resolver, run on that code alone — and its note says so.
//   * A code a PERSON approved, corrected or wrote a note on is NEVER changed by the night. The master
//     may give that code to a different shop (1536256, «صيدلية زمزم», approved by hand, belongs to
//     another pharmacy in the master), so it is listed in Marketing Control for a person to confirm or
//     keep as decided, one at a time. "Keep as decided" takes it off the list and changes nothing else.
//   * Every change is reported: the night's counts go in the sync job's heartbeat detail.
//
// It never touches `reference_status`, the reference lookup or the validation: only the master
// columns the resolver owns (mapped_*, master_match_kind, master_resolved_at), plus the note line.
// The read-only preview (`phx_preview_marketing_pharmacy_code_matches`, same matching, writes nothing)
// is how both the night and the list see a match before anything is written.
// ─────────────────────────────────────────────────────────────────────────────

export const MASTER_PREVIEW_RPC = "phx_preview_marketing_pharmacy_code_matches";
/** The note the capture flow writes on a code whose reference was not found and nobody touched since. */
export const UNTOUCHED_NOTE = "Reference not found.";
const PINNED_KINDS = new Set(["exact", "digit_normalized"]);

const CODE_COLUMNS =
  "id, pharmacy_id, distributor_id, distributor_pharmacy_code, reference_status, validated_by_hr_id, validated_at, validation_notes, master_match_kind, master_recheck_kept_at";

export type RecheckCodeRow = {
  distributor_id: number | string | null;
  distributor_pharmacy_code: string | null;
  id: string;
  master_match_kind: string | null;
  master_recheck_kept_at: string | null;
  pharmacy_id: string | null;
  reference_status: string | null;
  validated_at?: string | null;
  validated_by_hr_id: string | null;
  validation_notes: string | null;
};

export type MasterMatch = {
  area_code: string | null;
  /** The master area's name, read by the preview itself (marketing code reads no `areas` of its own). */
  area_name: string | null;
  code_id: string;
  customer_code: string | null;
  customer_name: string | null;
  distributor_code: string | null;
  match_kind: string;
};

/** Pure: a code nobody has decided on — the capture flow's own "not found", with no person's hand on it. */
export function isUntouchedCode(row: Pick<RecheckCodeRow, "reference_status" | "validated_by_hr_id" | "validation_notes">): boolean {
  if (row.reference_status !== "not_found") return false;
  if (String(row.validated_by_hr_id ?? "").trim() !== "") return false;
  const note = String(row.validation_notes ?? "").trim();
  return note === "" || note === UNTOUCHED_NOTE;
}

/** Pure: the master pins exactly one shop for this code. Ambiguous and unresolved never pin. */
export function isPinnableMatch(match: Pick<MasterMatch, "match_kind"> | null | undefined): match is MasterMatch {
  return Boolean(match && PINNED_KINDS.has(match.match_kind));
}

export type MasterRecheckPlan = {
  /** Untouched codes the night pins. */
  pin: Array<{ code: RecheckCodeRow; match: MasterMatch }>;
  /** Person-decided codes the master now matches — listed, never changed. */
  awaiting: Array<{ code: RecheckCodeRow; match: MasterMatch }>;
  /** Codes the master still matches to more than one shop. */
  ambiguous: number;
  /** Codes the master still does not know. */
  stillUnmatched: number;
};

/** Pure: who is pinned, who is listed. A code someone kept as decided is neither. */
export function planMasterRecheck(codes: readonly RecheckCodeRow[], matches: readonly MasterMatch[]): MasterRecheckPlan {
  const matchById = new Map(matches.map((match) => [String(match.code_id), match]));
  const plan: MasterRecheckPlan = { ambiguous: 0, awaiting: [], pin: [], stillUnmatched: 0 };
  for (const code of codes) {
    if (code.master_match_kind !== "unresolved") continue;
    const match = matchById.get(String(code.id));
    // Read before the guard: on its false branch TypeScript narrows `match` to undefined.
    const kind = match?.match_kind;
    if (!isPinnableMatch(match)) {
      if (kind === "ambiguous") plan.ambiguous += 1;
      else plan.stillUnmatched += 1;
      continue;
    }
    if (isUntouchedCode(code)) plan.pin.push({ code, match });
    else if (!code.master_recheck_kept_at) plan.awaiting.push({ code, match });
  }
  return plan;
}

function cairoDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(now);
}

function matchLabel(match: Pick<MasterMatch, "customer_code" | "customer_name" | "distributor_code">): string {
  const name = String(match.customer_name ?? "").trim();
  return `${match.distributor_code ?? ""} ${match.customer_code ?? ""}${name ? ` (${name})` : ""}`.trim();
}

/** Pure: the note after a match, the old note kept in front of it. */
export function appendMasterNote(existing: string | null, line: string): string {
  const before = String(existing ?? "").trim();
  return before ? `${before} | ${line}` : line;
}

export function nightlyMatchNote(match: MasterMatch, now: Date): string {
  return `Matched to the sales master by the nightly re-check on ${cairoDate(now)}: ${matchLabel(match)}`;
}

export type MasterRecheckResult = {
  ambiguous: number;
  awaitingConfirmation: number;
  checked: number;
  dryRun: boolean;
  /** Pinned tonight (or, on a dry run, would be). */
  pinned: number;
  /** Planned to pin but the resolver did not leave them pinned — a race with the master; retried tomorrow. */
  notPinned: number;
  stillUnmatched: number;
  detail: string;
};

/** Pure: the heartbeat line. */
export function masterRecheckDetail(result: Omit<MasterRecheckResult, "detail">): string {
  const verb = result.dryRun ? "would pin" : "pinned";
  const parts = [
    `re-check: ${result.checked} unresolved`,
    `${verb} ${result.pinned}`,
    `${result.awaitingConfirmation} awaiting confirmation`,
    `${result.ambiguous} ambiguous`,
    `${result.stillUnmatched} still unknown`,
  ];
  if (result.notPinned > 0) parts.push(`${result.notPinned} not pinned`);
  return parts.join(", ");
}

/** The slice of the client the re-check uses. */
type RecheckClient = ReturnType<typeof getSupabaseAdmin>;

async function readUnresolvedCodes(supabase: RecheckClient, ids?: readonly string[]): Promise<RecheckCodeRow[]> {
  let query = supabase.from("marketing_pharmacy_distributor_codes").select(CODE_COLUMNS).eq("active", true).eq("master_match_kind", "unresolved");
  if (ids) query = query.in("id", [...ids]);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as RecheckCodeRow[];
}

async function previewMatches(supabase: RecheckClient, ids: readonly string[]): Promise<MasterMatch[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.rpc(MASTER_PREVIEW_RPC, { p_code_ids: [...ids] });
  if (error) throw error;
  return (data ?? []) as MasterMatch[];
}

/**
 * The night's run, after the pharmacy-code sync. A failed read throws; the cron reports it as failed.
 * A dry run reads and plans and writes nothing.
 */
export async function runMasterRecheck(options: { dryRun?: boolean; now?: Date } = {}): Promise<MasterRecheckResult> {
  const dryRun = options.dryRun === true;
  const now = options.now ?? new Date();
  const supabase = getSupabaseAdmin();
  const codes = await readUnresolvedCodes(supabase);
  const matches = await previewMatches(supabase, codes.map((code) => code.id));
  const plan = planMasterRecheck(codes, matches);

  let pinned = plan.pin.length;
  let notPinned = 0;
  if (!dryRun && plan.pin.length > 0) {
    const ok = await resolveMarketingPharmacyCodes(supabase, plan.pin.map((entry) => entry.code.id));
    if (!ok) throw new Error(`The nightly re-check could not run the master resolver on ${plan.pin.length} code(s).`);
    // The resolver writes its own verdict; read it back rather than trusting the plan.
    const { data, error } = await supabase
      .from("marketing_pharmacy_distributor_codes")
      .select("id, master_match_kind")
      .in("id", plan.pin.map((entry) => entry.code.id));
    if (error) throw error;
    const kindById = new Map(((data ?? []) as Array<{ id: string; master_match_kind: string | null }>).map((row) => [String(row.id), row.master_match_kind]));
    pinned = 0;
    for (const entry of plan.pin) {
      if (!PINNED_KINDS.has(String(kindById.get(entry.code.id) ?? ""))) {
        notPinned += 1;
        continue;
      }
      pinned += 1;
      // Only the note of a code still untouched: a person who decided it a moment ago keeps their note.
      const note = await supabase
        .from("marketing_pharmacy_distributor_codes")
        .update({ updated_at: now.toISOString(), validation_notes: appendMasterNote(entry.code.validation_notes, nightlyMatchNote(entry.match, now)) })
        .eq("id", entry.code.id)
        .eq("reference_status", "not_found")
        .is("validated_by_hr_id", null);
      if (note.error) throw note.error;
    }
  }

  const result = {
    ambiguous: plan.ambiguous,
    awaitingConfirmation: plan.awaiting.length,
    checked: codes.length,
    dryRun,
    notPinned,
    pinned,
    stillUnmatched: plan.stillUnmatched,
  };
  return { ...result, detail: masterRecheckDetail(result) };
}

// ─── The Marketing Control list: person-decided codes the master now matches ───

export type MasterRecheckListRow = {
  codeId: string;
  enteredCode: string;
  masterAreaName: string | null;
  masterCustomerCode: string;
  masterCustomerName: string | null;
  masterDistributorCode: string;
  matchKind: "exact" | "digit_normalized";
  note: string | null;
  pharmacyName: string;
  status: string;
  validatedAt: string | null;
  validatedByName: string | null;
  vendorName: string;
};

function assertRecheckAccess(access: AccessContext): void {
  if (access.role !== "Super Admin") throw forbiddenError("Forbidden: confirming a pharmacy code against the sales master is Super Admin only.");
}

const STATUS_LABELS: Record<string, string> = {
  manual_approved: "Approved by hand",
  matched: "Matched",
  not_found: "Not found",
  rejected: "Rejected",
};

async function namesFor(supabase: RecheckClient, codes: readonly RecheckCodeRow[]) {
  const pharmacyIds = [...new Set(codes.map((code) => code.pharmacy_id).filter((id): id is string => Boolean(id)))];
  const vendorIds = [...new Set(codes.map((code) => code.distributor_id).filter((id) => id !== null && id !== undefined))];
  const hrIds = [...new Set(codes.map((code) => String(code.validated_by_hr_id ?? "").trim()).filter(Boolean))];
  const [pharmacies, vendors, people] = await Promise.all([
    pharmacyIds.length ? supabase.from("marketing_pharmacies").select("id, display_name").in("id", pharmacyIds) : { data: [], error: null },
    vendorIds.length ? supabase.from("marketing_distributors").select("id, display_name").in("id", vendorIds) : { data: [], error: null },
    hrIds.length ? supabase.from("employees").select("hr_id, full_name, nickname").in("hr_id", hrIds) : { data: [], error: null },
  ]);
  for (const read of [pharmacies, vendors, people]) if (read.error) throw read.error;
  return {
    person: new Map(
      ((people.data ?? []) as Array<{ full_name: string; hr_id: string; nickname: string | null }>).map((row) => [
        String(row.hr_id).toUpperCase(),
        resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id),
      ]),
    ),
    pharmacy: new Map(((pharmacies.data ?? []) as Array<{ display_name: string; id: string }>).map((row) => [String(row.id), row.display_name])),
    vendor: new Map(((vendors.data ?? []) as Array<{ display_name: string; id: number | string }>).map((row) => [String(row.id), row.display_name])),
  };
}

/** Super Admin. A failed read throws, so the panel says it could not read rather than showing an empty list. */
export async function listCodesAwaitingConfirmation(access: AccessContext): Promise<MasterRecheckListRow[]> {
  assertRecheckAccess(access);
  const supabase = getSupabaseAdmin();
  const codes = await readUnresolvedCodes(supabase);
  const matches = await previewMatches(supabase, codes.map((code) => code.id));
  const { awaiting } = planMasterRecheck(codes, matches);
  if (awaiting.length === 0) return [];
  const names = await namesFor(supabase, awaiting.map((entry) => entry.code));
  return awaiting
    .map(({ code, match }) => ({
      codeId: code.id,
      enteredCode: String(code.distributor_pharmacy_code ?? ""),
      masterAreaName: match.area_name ?? null,
      masterCustomerCode: String(match.customer_code ?? ""),
      masterCustomerName: match.customer_name ?? null,
      masterDistributorCode: String(match.distributor_code ?? ""),
      matchKind: match.match_kind as "exact" | "digit_normalized",
      note: code.validation_notes,
      pharmacyName: (code.pharmacy_id && names.pharmacy.get(String(code.pharmacy_id))) || "Unnamed pharmacy",
      status: STATUS_LABELS[String(code.reference_status ?? "")] ?? String(code.reference_status ?? "Unknown"),
      validatedAt: code.validated_at ?? null,
      validatedByName: code.validated_by_hr_id ? names.person.get(String(code.validated_by_hr_id).toUpperCase()) ?? null : null,
      vendorName: names.vendor.get(String(code.distributor_id)) ?? "Unknown vendor",
    }))
    .sort((left, right) => left.vendorName.localeCompare(right.vendorName) || left.enteredCode.localeCompare(right.enteredCode));
}

/** Read one listed code and its match now, refusing anything no longer on the list. */
async function readListedCode(supabase: RecheckClient, codeId: string): Promise<{ code: RecheckCodeRow; match: MasterMatch }> {
  if (!/^[0-9a-f-]{36}$/i.test(codeId)) throw validationError("Name the code.");
  const [code] = await readUnresolvedCodes(supabase, [codeId]);
  if (!code) throw notFoundError("That code is no longer unresolved, so there is nothing to confirm.");
  const [match] = await previewMatches(supabase, [codeId]);
  const { awaiting } = planMasterRecheck([code], match ? [match] : []);
  if (awaiting.length === 0) {
    throw conflictError(
      code.master_recheck_kept_at
        ? "That code was already kept as decided."
        : "The sales master no longer matches that code to exactly one shop, so it cannot be confirmed.",
    );
  }
  return awaiting[0];
}

async function actorName(supabase: RecheckClient, access: AccessContext): Promise<string> {
  const hrId = String(access.hrId ?? "").trim();
  if (!hrId) return "Super Admin";
  const { data } = await supabase.from("employees").select("hr_id, full_name, nickname").eq("hr_id", hrId).maybeSingle();
  const row = data as { full_name: string; hr_id: string; nickname: string | null } | null;
  return row ? resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id) : "Super Admin";
}

/** Confirm the master's shop for a person-decided code: the resolver runs on that code alone. */
export async function confirmMasterMatch(access: AccessContext, input: { codeId: string }): Promise<MasterRecheckListRow[]> {
  assertRecheckAccess(access);
  assertRealSessionForDecision(access, "confirm a pharmacy code against the sales master");
  const supabase = getSupabaseAdmin();
  const { code, match } = await readListedCode(supabase, String(input.codeId ?? "").trim());

  const ok = await resolveMarketingPharmacyCodes(supabase, [code.id]);
  if (!ok) throw new Error("The sales master could not be matched just now. Nothing was changed; try again in a minute.");
  const reread = await supabase.from("marketing_pharmacy_distributor_codes").select("master_match_kind").eq("id", code.id).maybeSingle();
  if (reread.error) throw reread.error;
  const kind = String((reread.data as { master_match_kind: string | null } | null)?.master_match_kind ?? "");
  if (!PINNED_KINDS.has(kind)) throw conflictError("The sales master changed while you confirmed, so the code was not matched. Reload the list.");

  const now = new Date();
  const who = await actorName(supabase, access);
  const note = appendMasterNote(code.validation_notes, `Confirmed against the sales master by ${who} on ${cairoDate(now)}: ${matchLabel(match)}`);
  const write = await supabase.from("marketing_pharmacy_distributor_codes").update({ updated_at: now.toISOString(), validation_notes: note }).eq("id", code.id);
  if (write.error) throw write.error;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityId: code.id,
    entityType: "marketing_control",
    newValues: { master_match_kind: kind, mapped_customer_code: match.customer_code, mapped_distributor_code: match.distributor_code },
    oldValues: { master_match_kind: "unresolved" },
    summary: `Pharmacy code ${code.distributor_pharmacy_code ?? ""} was confirmed against the sales master: ${matchLabel(match)}.`,
  });
  return listCodesAwaitingConfirmation(access);
}

/** Keep a person-decided code as it is: it leaves the list, and nothing else about it changes. */
export async function keepCodeAsDecided(access: AccessContext, input: { codeId: string }): Promise<MasterRecheckListRow[]> {
  assertRecheckAccess(access);
  assertRealSessionForDecision(access, "keep a pharmacy code as decided");
  const supabase = getSupabaseAdmin();
  const { code, match } = await readListedCode(supabase, String(input.codeId ?? "").trim());

  const now = new Date().toISOString();
  const keptBy = access.hrId ?? access.loginId ?? null;
  const write = await supabase
    .from("marketing_pharmacy_distributor_codes")
    .update({ master_recheck_kept_at: now, master_recheck_kept_by_hr_id: keptBy })
    .eq("id", code.id)
    .is("master_recheck_kept_at", null);
  if (write.error) throw write.error;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityId: code.id,
    entityType: "marketing_control",
    newValues: { master_recheck_kept_at: now },
    oldValues: { master_recheck_kept_at: null },
    summary: `Pharmacy code ${code.distributor_pharmacy_code ?? ""} was kept as decided; the sales master gives it to ${matchLabel(match)}.`,
  });
  return listCodesAwaitingConfirmation(access);
}
