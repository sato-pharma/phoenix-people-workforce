import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission, systemAccessContext } from "@/lib/auth/permissions";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  filterDirectOrderReportRows,
  parseDirectOrderReportFilters,
} from "@/lib/direct-orders/report-filters";
import { getDirectOrderReport, resolveDirectOrderReportScope } from "@/lib/direct-orders/service";
import type { DirectOrderReportRow } from "@/lib/direct-orders/types";

// ─────────────────────────────────────────────────────────────────────────────
// Live Direct Orders report links (owner request, 2026-08-05).
//
// Two surfaces, deliberately different:
//   'live' — a human page. Passcode required, so a forwarded URL alone is useless.
//   'feed' — CSV for a Google Sheet's IMPORTDATA. Token-only, because a formula cannot type a
//            passcode. It is meant to sit inside a private sheet; the SHEET's Google sharing is
//            then the access control, which is stronger than anything we would rebuild here.
//
// Both are bearer credentials, so both carry mandatory expiry, one-click revoke, a creator-frozen
// scope, and an audited access count.
// ─────────────────────────────────────────────────────────────────────────────

function badRequest(message: string): never {
  throw validationError(message);
}

/** 32 random bytes, URL-safe. Long enough that guessing is not a threat model. */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashPasscode(passcode: string, token: string): string {
  // Salted with the token so two links sharing a passcode do not share a hash.
  return createHash("sha256").update(`${token}:${passcode.trim()}`).digest("hex");
}

function passcodeMatches(input: string, token: string, expected: string | null): boolean {
  if (!expected) return true;
  const candidate = Buffer.from(hashPasscode(input, token), "hex");
  const known = Buffer.from(expected, "hex");
  // Constant-time: a length-varying compare leaks the prefix to a patient caller.
  if (candidate.length !== known.length) return false;
  return timingSafeEqual(candidate, known);
}

export type DirectOrderShareLink = {
  id: string;
  token: string;
  surface: "live" | "feed";
  label: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  hasPasscode: boolean;
  lastAccessedAt: string | null;
  accessCount: number;
  scope: string;
};

const MAX_EXPIRY_DAYS = 180;
const DEFAULT_EXPIRY_DAYS = 30;

/**
 * Create a link. The creator's scope is captured HERE and never re-resolved, so the link cannot
 * widen if they are promoted, and cannot break if they are not.
 */
export async function createDirectOrderReportShareLink(
  access: AccessContext,
  input: {
    surface: "live" | "feed";
    label?: string | null;
    passcode?: string | null;
    expiresInDays?: number | null;
    filters?: unknown;
  },
): Promise<{ token: string; expiresAt: string }> {
  await assertPermission(access, "direct_orders", "export");
  const hrId = access.hrId?.trim();
  if (!hrId) badRequest("Your account has no HR ID; cannot create a share link.");

  const surface = input.surface === "feed" ? "feed" : "live";
  // The human surface must carry a passcode. Letting it be optional would make the safe choice the
  // one that needs extra effort, and that is how a link ends up naked in a WhatsApp group.
  const passcode = String(input.passcode ?? "").trim();
  if (surface === "live" && passcode.length < 4) {
    badRequest("Set a passcode of at least 4 characters for a shareable live link.");
  }

  const days = Math.min(Math.max(Math.floor(Number(input.expiresInDays) || DEFAULT_EXPIRY_DAYS), 1), MAX_EXPIRY_DAYS);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const token = mintToken();
  const scope = resolveDirectOrderReportScope(access);

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("direct_order_report_share_links").insert({
    token,
    surface,
    label: input.label?.toString().trim() || null,
    created_by_hr_id: hrId,
    scope,
    scope_hr_id: hrId,
    filters: input.filters ?? null,
    passcode_hash: surface === "live" ? hashPasscode(passcode, token) : null,
    expires_at: expiresAt,
  });
  if (error) throw error;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? hrId,
    entityType: "direct_order_request",
    entityId: `share-link:${token.slice(0, 8)}`,
    newValues: { surface, scope, expiresAt, hasPasscode: surface === "live" },
    summary: `Direct-orders report ${surface} link created by ${hrId}, scope ${scope}, expires ${expiresAt.slice(0, 10)}.`,
  });

  return { token, expiresAt };
}

/** Every link this person created — so revoking is possible without hunting through email. */
export async function listDirectOrderReportShareLinks(access: AccessContext): Promise<DirectOrderShareLink[]> {
  await assertPermission(access, "direct_orders", "export");
  const supabase = getSupabaseAdmin();
  const isAdmin = access.scope === "system" || access.role === "Super Admin";
  let query = supabase.from("direct_order_report_share_links").select("*").order("created_at", { ascending: false });
  // A Super Admin sees every link, because "who else has published our numbers" is exactly the
  // question this table exists to answer. Everyone else sees only their own.
  if (!isAdmin) query = query.eq("created_by_hr_id", access.hrId ?? "");
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    token: String(row.token),
    surface: String(row.surface) === "feed" ? "feed" : "live",
    label: row.label ? String(row.label) : null,
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    hasPasscode: Boolean(row.passcode_hash),
    lastAccessedAt: row.last_accessed_at ? String(row.last_accessed_at) : null,
    accessCount: Number(row.access_count ?? 0),
    scope: String(row.scope ?? ""),
  }));
}

export async function revokeDirectOrderReportShareLink(access: AccessContext, linkId: string): Promise<void> {
  await assertPermission(access, "direct_orders", "export");
  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase
    .from("direct_order_report_share_links")
    .select("id, created_by_hr_id, token")
    .eq("id", linkId)
    .maybeSingle();
  if (!row) notFoundError("Share link not found.");
  const isAdmin = access.scope === "system" || access.role === "Super Admin";
  const owns = String((row as { created_by_hr_id: string }).created_by_hr_id).toUpperCase() === (access.hrId ?? "").toUpperCase();
  if (!isAdmin && !owns) throw forbiddenError("You can only revoke a link you created.");

  await supabase
    .from("direct_order_report_share_links")
    .update({ revoked_at: new Date().toISOString(), revoked_by_hr_id: access.hrId })
    .eq("id", linkId);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `share-link:${String((row as { token: string }).token).slice(0, 8)}`,
    newValues: { revoked: true },
    summary: `Direct-orders report share link revoked by ${access.hrId ?? "unknown"}.`,
  });
}

export type ResolvedShareLink = {
  rows: DirectOrderReportRow[];
  label: string | null;
  scope: string;
  generatedAt: string;
};

/**
 * Serve a link. Returns the rows the link is entitled to, or throws.
 *
 * Called from an UNAUTHENTICATED route, so this function is the entire security boundary: it
 * checks existence, revocation, expiry and passcode before it reads a single row, and it loads
 * the report as the CREATOR (frozen scope) rather than as the anonymous caller.
 */
export async function resolveDirectOrderReportShareLink(input: {
  token: string;
  passcode?: string | null;
  surface: "live" | "feed";
}): Promise<ResolvedShareLink> {
  const token = String(input.token ?? "").trim();
  if (!token) notFoundError("Link not found.");

  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase
    .from("direct_order_report_share_links")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  // Same answer for "no such link" and "wrong surface": a probing caller learns nothing about
  // which tokens exist.
  if (!row) notFoundError("Link not found.");
  const link = row as Record<string, unknown>;
  if (String(link.surface) !== input.surface) notFoundError("Link not found.");
  if (link.revoked_at) throw forbiddenError("This link has been revoked.");
  if (new Date(String(link.expires_at)).getTime() < Date.now()) throw forbiddenError("This link has expired.");

  if (link.passcode_hash) {
    const supplied = String(input.passcode ?? "");
    if (!supplied || !passcodeMatches(supplied, token, String(link.passcode_hash))) {
      throw forbiddenError("Passcode required.");
    }
  }

  // Load as the CREATOR. `systemAccessContext` reads everything, so the frozen scope is applied
  // here explicitly — this is what stops a District Manager's link from serving company-wide data.
  const creatorHrId = String(link.scope_hr_id ?? "");
  const scope = String(link.scope ?? "own");
  const all = await getDirectOrderReport({
    ...systemAccessContext,
    hrId: creatorHrId,
    role: scope === "all" ? "Super Admin" : scope === "hierarchy" ? "Regional Manager" : "District Manager",
    scope: scope === "all" ? "system" : "self",
  } as AccessContext);

  const filters = parseDirectOrderReportFilters(link.filters ?? {});
  const rows = filterDirectOrderReportRows(all, filters);

  // Count the open. Best-effort: a failed counter must never deny a legitimate read.
  await supabase
    .from("direct_order_report_share_links")
    .update({
      last_accessed_at: new Date().toISOString(),
      access_count: Number(link.access_count ?? 0) + 1,
    })
    .eq("id", String(link.id))
    .then(undefined, () => undefined);

  return {
    rows,
    label: link.label ? String(link.label) : null,
    scope,
    generatedAt: new Date().toISOString(),
  };
}

/** CSV for Google Sheets IMPORTDATA. RFC4180 quoting — a pharmacy name with a comma must survive. */
export function buildDirectOrderReportCsv(rows: DirectOrderReportRow[]): string {
  const headers = [
    "Request ID", "Status", "Requester", "Role", "Line", "Product code", "Product",
    "Quantity", "Bonus", "Deal type", "Discount %", "Sales value (EGP)",
    "Pharmacy", "Pharmacy code", "Brick", "Area", "Region",
    "Collection date", "Sales month", "Payment date", "Paid", "Remaining",
    "Submitted", "Decided", "Waiting on",
  ];
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [headers.map(cell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id, r.status, r.requesterName, r.requesterRole, r.line, r.productCode, r.productName,
        r.qty, r.bonus, r.dealType, r.discountPct ?? "", r.salesValue,
        r.pharmacyName, r.pharmacyCode, r.brickName ?? "", r.areaName ?? "", r.regionName ?? "",
        r.collectionDate ?? "", r.salesMonth ?? "", r.paymentDate ?? "", r.paidAmount ?? "", r.remainingAmount ?? "",
        r.createdAt, r.decidedAt ?? "", r.activeStepLabel,
      ].map(cell).join(","),
    );
  }
  // Leading BOM so Excel opens Arabic pharmacy names correctly instead of as mojibake — the same
  // failure that made tonight's first emails unreadable.
  return `﻿${lines.join("\r\n")}\r\n`;
}
