import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import {
  computeAliasDrift,
  resolveDistributionList,
  sanitizeRoles,
  type AliasDrift,
  type DistributionCandidate,
  type DistributionListSpec,
  type ResolvedDistributionList,
} from "./spec";

/**
 * Database half of the distribution-list domain. The matching logic itself is in ./spec.ts and is
 * pure; this module only loads rows, projects the live directory into candidates, and writes.
 *
 * FAILS CLOSED, and that direction is the opposite of notification role policies next door.
 * resolveNotificationRoleRecipients() falls back to a hardcoded default because an unreadable
 * table there means one digest is missed. Here an unreadable table would mean an unconstrained
 * list, and an unconstrained list is every employee at a live pharmaceutical company. A silent
 * over-send is unrecallable; a silent under-send is recoverable and is reported through
 * `warnings`, which every caller writes into its audit trail.
 */

const distributionListsTable = "distribution_lists";
const companyEmailAliasesTable = "company_email_aliases";

type DistributionListRow = {
  list_key: string;
  label: string | null;
  description: string | null;
  roles: unknown;
  line_ids: unknown;
  area_ids: unknown;
  department_ids: unknown;
  position_ids: unknown;
  region_codes: unknown;
  included_hr_ids: unknown;
  excluded_hr_ids: unknown;
  external_emails: unknown;
  enabled: boolean | null;
  reply_to: string | null;
};

export type CompanyEmailAlias = {
  aliasAddress: string;
  label: string;
  purpose: string;
  provider: "turbify" | "other";
  distributionListKey: string | null;
  recordedMemberEmails: string[];
  recordedAt: string | null;
  recordedBy: string | null;
  isActive: boolean;
  notes: string;
};

const listSelect =
  "list_key,label,description,roles,line_ids,area_ids,department_ids,position_ids,region_codes,included_hr_ids,excluded_hr_ids,external_emails,enabled,reply_to";
const aliasSelect =
  "alias_address,label,purpose,provider,distribution_list_key,recorded_member_emails,recorded_at,recorded_by,is_active,notes";

function textArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => Number(item)).filter((item) => Number.isFinite(item))));
}

function rowToSpec(row: DistributionListRow): DistributionListSpec {
  return {
    areaIds: numberArray(row.area_ids),
    departmentIds: numberArray(row.department_ids),
    description: row.description ?? "",
    enabled: row.enabled !== false,
    excludedHrIds: textArray(row.excluded_hr_ids),
    externalEmails: textArray(row.external_emails),
    includedHrIds: textArray(row.included_hr_ids),
    label: row.label ?? row.list_key,
    lineIds: numberArray(row.line_ids),
    listKey: row.list_key,
    positionIds: numberArray(row.position_ids),
    replyTo: row.reply_to?.trim() ? row.reply_to.trim().toLowerCase() : null,
    regionCodes: textArray(row.region_codes),
    roles: sanitizeRoles(row.roles),
  };
}

function rowToAlias(row: Record<string, unknown>): CompanyEmailAlias {
  return {
    aliasAddress: String(row.alias_address ?? ""),
    distributionListKey: (row.distribution_list_key as string | null) ?? null,
    isActive: row.is_active !== false,
    label: String(row.label ?? ""),
    notes: String(row.notes ?? ""),
    provider: row.provider === "other" ? "other" : "turbify",
    purpose: String(row.purpose ?? ""),
    recordedAt: (row.recorded_at as string | null) ?? null,
    recordedBy: (row.recorded_by as string | null) ?? null,
    recordedMemberEmails: textArray(row.recorded_member_emails).map((email) => email.toLowerCase()),
  };
}

export async function getDistributionListSpecs(): Promise<DistributionListSpec[]> {
  const { data, error } = await getSupabaseAdmin().from(distributionListsTable).select(listSelect).order("label");
  if (error) throw error;
  return ((data ?? []) as DistributionListRow[]).map(rowToSpec);
}

/**
 * Every active employee, projected for the matcher and carrying the app roles their auth
 * account(s) hold. getEmployeeDirectory() has already dropped leavers and system consoles, so a
 * person reaching this function is someone the company still employs.
 */
export async function loadDistributionCandidates(): Promise<{ candidates: DistributionCandidate[]; warnings: string[] }> {
  const warnings: string[] = [];
  const { employees } = await getEmployeeDirectory();

  const rolesByPerson = new Map<string, PhoenixRole[]>();
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("hr_id,role")
      .eq("is_active", true);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ hr_id?: string | null; role?: string | null }>) {
      const key = canonicalHrIdKey(row.hr_id);
      const role = sanitizeRoles([row.role])[0];
      if (!key || !role) continue;
      const held = rolesByPerson.get(key);
      if (held) held.push(role);
      else rolesByPerson.set(key, [role]);
    }
  } catch (error) {
    // A role-based list resolves to nobody without this, which is the fail-closed direction —
    // but it must never read as a deliberately empty audience.
    warnings.push(`App roles unavailable: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 160));
  }

  const candidates = employees.map<DistributionCandidate>((employee) => ({
    areaId: employee.areaId,
    departmentId: employee.departmentId,
    displayName: employee.displayName,
    hrId: employee.hrId,
    lineId: employee.lineId,
    positionId: employee.positionId,
    regionCode: employee.regionCode ?? null,
    roles: rolesByPerson.get(canonicalHrIdKey(employee.hrId) ?? "") ?? [],
    workEmail: employee.workEmail,
  }));

  return { candidates, warnings };
}

export type DistributionResolution = ResolvedDistributionList & { warnings: string[] };

const emptyResolution = (listKey: string, warnings: string[]): DistributionResolution => ({
  emails: [],
  enabled: false,
  externalEmails: [],
  label: listKey,
  listKey,
  members: [],
  refusedReason: warnings[warnings.length - 1] ?? null,
  replyTo: null,
  skipped: [],
  warnings,
});

/** A refusal from the resolver is a warning the caller must see, not a quietly empty audience. */
function withRefusalWarning(resolution: ResolvedDistributionList, warnings: string[]): DistributionResolution {
  return { ...resolution, warnings: resolution.refusedReason ? [...warnings, resolution.refusedReason] : warnings };
}

/**
 * Who a named list resolves to right now. Never throws — the domain senders that will call this
 * have no guard of their own — and reports every reason a list came back short through
 * `warnings` rather than returning a plausible-looking empty audience.
 */
export async function resolveDistributionListByKey(listKey: string): Promise<DistributionResolution> {
  try {
    const [specs, { candidates, warnings }] = await Promise.all([getDistributionListSpecs(), loadDistributionCandidates()]);
    const spec = specs.find((item) => item.listKey === listKey);
    if (!spec) return emptyResolution(listKey, [...warnings, `Distribution list "${listKey}" does not exist.`]);
    // resolveDistributionList refuses a switched-off or unbounded list itself — see spec.ts.
    return withRefusalWarning(resolveDistributionList(spec, candidates), warnings);
  } catch (error) {
    logError("Distribution list resolution failed", {
      error,
      labels: { event: "distribution_list_resolve_failed", listKey },
    });
    return emptyResolution(listKey, [`Distribution list "${listKey}" could not be read: ${error instanceof Error ? error.message : "unknown error"}`]);
  }
}

/** Every list with its current membership — what the admin screen renders. */
export async function resolveAllDistributionLists(): Promise<DistributionResolution[]> {
  const [specs, { candidates, warnings }] = await Promise.all([getDistributionListSpecs(), loadDistributionCandidates()]);
  return specs.map((spec) => withRefusalWarning(resolveDistributionList(spec, candidates), warnings));
}

/**
 * The ROLE LIST a named list carries — not its resolved recipients.
 *
 * For a caller that already owns a recipient pipeline (the Monthly Closing publish resolves seats
 * from the organogram, checks employment status, filters the shared sales exclusion list and splits
 * To/Cc/Bcc), swapping in a fully-resolved audience would replace all of that. Handing back only
 * the roles lets such a caller keep every downstream step byte-identical and gain exactly one
 * thing: which roles it uses becomes editable without a developer.
 *
 * NEVER THROWS, and falls back to `fallback` — the caller's own hardcoded default — on any failure
 * or on a switched-off list. Same direction as resolveNotificationRoleRecipients: an unreadable
 * table must reproduce today's behaviour rather than silently shrink an audience. That is the
 * OPPOSITE of resolveDistributionListByKey's fail-closed rule, and deliberately so — there the risk
 * is reaching too many people, here it is a high-stakes email quietly going out without its Cc.
 *
 * An ENABLED list naming no roles is honoured as "no roles" rather than overridden by the fallback,
 * because otherwise a role could never be REMOVED, which is the whole point of making it editable.
 */
export async function resolveDistributionListRoles(
  listKey: string,
  fallback: readonly PhoenixRole[],
): Promise<{ roles: PhoenixRole[]; warnings: string[] }> {
  const warnings: string[] = [];
  try {
    const specs = await getDistributionListSpecs();
    const spec = specs.find((item) => item.listKey === listKey);
    if (!spec) {
      warnings.push(`Distribution list "${listKey}" does not exist — using the built-in default.`);
      return { roles: [...fallback], warnings };
    }
    if (!spec.enabled) {
      warnings.push(`Distribution list "${listKey}" is switched off — using the built-in default.`);
      return { roles: [...fallback], warnings };
    }
    // This call site consumes ONLY `roles`. A name or address added to the list would otherwise sit
    // there doing nothing, which reads as "they are on the list" — so say so rather than ignore it.
    const inert = [
      spec.includedHrIds.length > 0 ? "named people" : null,
      spec.excludedHrIds.length > 0 ? "exclusions" : null,
      spec.externalEmails.length > 0 ? "external addresses" : null,
    ].filter(Boolean);
    if (inert.length > 0) {
      warnings.push(
        `Distribution list "${listKey}" carries ${inert.join(", ")}, which this email ignores — it reads the roles only.`,
      );
    }
    if (spec.roles.length === 0) {
      warnings.push(`Distribution list "${listKey}" names no roles, so nobody is added from it.`);
    }
    return { roles: spec.roles, warnings };
  } catch (error) {
    warnings.push(
      `Distribution list "${listKey}" could not be read (${error instanceof Error ? error.message : "unknown error"}) — using the built-in default.`,
    );
    return { roles: [...fallback], warnings };
  }
}

export type DistributionListUpdate = Partial<
  Pick<
    DistributionListSpec,
    | "label"
    | "description"
    | "roles"
    | "lineIds"
    | "areaIds"
    | "departmentIds"
    | "positionIds"
    | "regionCodes"
    | "includedHrIds"
    | "excludedHrIds"
    | "externalEmails"
    | "enabled"
  >
>;

export async function updateDistributionList(
  listKey: string,
  input: DistributionListUpdate,
  actor: AccessContext,
): Promise<DistributionListSpec> {
  const specs = await getDistributionListSpecs();
  const before = specs.find((item) => item.listKey === listKey);
  if (!before) throw new Error(`Distribution list "${listKey}" does not exist.`);

  const next: DistributionListSpec = {
    ...before,
    ...input,
    listKey,
    roles: input.roles ? sanitizeRoles(input.roles) : before.roles,
  };

  const { data, error } = await getSupabaseAdmin()
    .from(distributionListsTable)
    .update({
      area_ids: next.areaIds,
      department_ids: next.departmentIds,
      description: next.description,
      enabled: next.enabled,
      excluded_hr_ids: next.excludedHrIds,
      external_emails: next.externalEmails,
      included_hr_ids: next.includedHrIds,
      label: next.label,
      line_ids: next.lineIds,
      position_ids: next.positionIds,
      region_codes: next.regionCodes,
      roles: next.roles,
      updated_at: new Date().toISOString(),
      updated_by: actor.hrId ?? actor.loginId ?? "system",
    })
    .eq("list_key", listKey)
    .select(listSelect)
    .single();
  if (error) throw error;

  await writeRequiredAuditLog({
    actorLoginId: actor.loginId ?? actor.hrId ?? null,
    entityId: listKey,
    entityType: "distribution_list",
    newValues: next as unknown as Record<string, unknown>,
    oldValues: before as unknown as Record<string, unknown>,
    summary: `${actor.hrId ?? "admin"} changed distribution list "${listKey}".`,
  });

  return rowToSpec(data as DistributionListRow);
}

// ── Company email aliases (the Turbify register) ─────────────────────────────────────────────

export async function getCompanyEmailAliases(): Promise<CompanyEmailAlias[]> {
  const { data, error } = await getSupabaseAdmin().from(companyEmailAliasesTable).select(aliasSelect).order("alias_address");
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(rowToAlias);
}

export type AliasWithDrift = CompanyEmailAlias & {
  drift: AliasDrift | null;
  /** Null when no list drives this alias — there is then nothing to compare against, which is a
   *  registration waiting for a decision, not a fault. */
  expectedEmails: string[] | null;
  recordedAgeDays: number | null;
};

/**
 * Each alias beside what its Phoenix list says it should hold. `toRemove` entries reasoned
 * `left_company` are the ones that matter — a leaver still receiving company mail is exactly what
 * a password reset does NOT fix (docs/agents-owner-rules.md).
 */
export async function getCompanyEmailAliasesWithDrift(): Promise<{ aliases: AliasWithDrift[]; warnings: string[] }> {
  const [aliases, resolutions, { candidates, warnings }] = await Promise.all([
    getCompanyEmailAliases(),
    resolveAllDistributionLists(),
    loadDistributionCandidates(),
  ]);

  const byKey = new Map(resolutions.map((resolution) => [resolution.listKey, resolution]));
  const activeEmails = candidates.map((candidate) => candidate.workEmail ?? "").filter(Boolean);
  const now = Date.now();

  const withDrift = aliases.map<AliasWithDrift>((alias) => {
    const resolution = alias.distributionListKey ? byKey.get(alias.distributionListKey) : undefined;
    const expectedEmails = resolution ? resolution.emails : null;
    const recordedAt = alias.recordedAt ? Date.parse(alias.recordedAt) : NaN;
    return {
      ...alias,
      drift: expectedEmails
        ? computeAliasDrift({ activeEmails, expectedEmails, recordedEmails: alias.recordedMemberEmails })
        : null,
      expectedEmails,
      recordedAgeDays: Number.isFinite(recordedAt) ? Math.floor((now - recordedAt) / 86_400_000) : null,
    };
  });

  return { aliases: withDrift, warnings };
}

/** Register an alias, or edit what it is for. Membership is NOT set here — that is a separate,
 *  separately-stamped attestation, so registering an address can never look like having checked
 *  who is on it. */
export async function upsertCompanyEmailAlias(
  input: {
    aliasAddress: string;
    label: string;
    purpose?: string;
    provider?: "turbify" | "other";
    distributionListKey?: string | null;
    isActive?: boolean;
    notes?: string;
  },
  actor: AccessContext,
): Promise<CompanyEmailAlias> {
  const address = input.aliasAddress.trim().toLowerCase();
  if (!address.includes("@")) throw new Error("An alias must be an email address.");
  const actorId = actor.hrId ?? actor.loginId ?? "system";

  const { data, error } = await getSupabaseAdmin()
    .from(companyEmailAliasesTable)
    .upsert(
      {
        alias_address: address,
        distribution_list_key: input.distributionListKey ?? null,
        is_active: input.isActive ?? true,
        label: input.label.trim() || address,
        notes: input.notes ?? "",
        provider: input.provider ?? "turbify",
        purpose: input.purpose ?? "",
        updated_at: new Date().toISOString(),
        updated_by: actorId,
      },
      { onConflict: "alias_address" },
    )
    .select(aliasSelect)
    .single();
  if (error) throw error;

  await writeRequiredAuditLog({
    actorLoginId: actor.loginId ?? actor.hrId ?? null,
    entityId: address,
    entityType: "company_email_alias",
    newValues: { distributionListKey: input.distributionListKey ?? null, label: input.label },
    oldValues: null,
    summary: `${actorId} registered company email alias "${address}".`,
  });

  return rowToAlias(data as Record<string, unknown>);
}

/**
 * Record what a human just saw in the Turbify control panel. This is an ATTESTATION — Turbify has
 * no API, so nothing here can be verified from Phoenix — which is why it stamps who said it and
 * when, and why the reader shows that age rather than presenting it as current truth.
 */
export async function recordAliasMembership(
  aliasAddress: string,
  memberEmails: string[],
  actor: AccessContext,
): Promise<CompanyEmailAlias> {
  const address = aliasAddress.trim().toLowerCase();
  const emails = Array.from(new Set(memberEmails.map((email) => email.trim().toLowerCase()).filter(Boolean)));
  const actorId = actor.hrId ?? actor.loginId ?? "system";

  const { data, error } = await getSupabaseAdmin()
    .from(companyEmailAliasesTable)
    .update({
      recorded_at: new Date().toISOString(),
      recorded_by: actorId,
      recorded_member_emails: emails,
      updated_at: new Date().toISOString(),
      updated_by: actorId,
    })
    .eq("alias_address", address)
    .select(aliasSelect)
    .single();
  if (error) throw error;

  await writeRequiredAuditLog({
    actorLoginId: actor.loginId ?? actor.hrId ?? null,
    entityId: address,
    entityType: "company_email_alias",
    newValues: { recordedMemberEmails: emails },
    oldValues: null,
    summary: `${actorId} recorded ${emails.length} member(s) on alias "${address}".`,
  });

  return rowToAlias(data as Record<string, unknown>);
}
