import { randomBytes } from "node:crypto";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { csvCell } from "@/lib/export/csv-cell";
import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission, systemAccessContext } from "@/lib/auth/permissions";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { noteDeadShareTokenRead } from "@/lib/share-links/refusal-counter";
import { hashPasscode, passcodeMatches } from "@/lib/share-links/passcode-hash";
import { hashShareToken, shareTokenLookupHash, shareTokenPreview } from "@/lib/share-links/token-hash";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  APPROVAL_COLUMNS,
  PHARMACY_COLUMNS,
  PRODUCT_COLUMNS,
  REQUEST_COLUMNS,
  approvalRowCells,
  pharmacyRowCells,
  productRowCells,
  requestRowCells,
  type FullReportRequest,
  type RequestFileLinks,
} from "@/lib/marketing-requests/request-report-columns";
import { loadMarketingRequestFullReport } from "@/lib/marketing-requests/request-report-service";
import { hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";

// ─────────────────────────────────────────────────────────────────────────────
// Live Marketing Request report links (owner request, 2026-08-05).
//
// Two surfaces, same reasoning as the Direct Orders equivalent:
//   'live' — a human page. Passcode required, so a forwarded URL alone is useless.
//   'feed' — the CSV bundle the sheet's Apps Script pulls. Token-only, because a script running on
//            a timer cannot type a passcode. It is meant to sit inside a PRIVATE sheet, whose
//            Google sharing then becomes the real access control.
//
// This module is the entire security boundary for an UNAUTHENTICATED route. It checks existence,
// revocation, expiry and passcode before it reads a single request row, and it loads the report as
// the CREATOR rather than as the anonymous caller. A token is stored only as its SHA-256
// (`token_hash`) and its first 8 characters (`token_preview`) — `@/lib/share-links/token-hash` (REC-055).
// ─────────────────────────────────────────────────────────────────────────────

const MAX_EXPIRY_DAYS = 365;
const DEFAULT_EXPIRY_DAYS = 30;
const TABLE = "marketing_request_report_share_links";

function badRequest(message: string): never {
  throw validationError(message);
}

/** 32 random bytes, URL-safe. Long enough that guessing is not a threat model. */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A link as the MANAGEMENT list sees it — deliberately WITHOUT the token.
 *
 * The whole token is returned exactly once, by `createMarketingReportShareLink`, to the person who just minted it. It is
 * never in this shape, so it cannot reach the list response, a props payload, the React tree, devtools
 * or an error report that captured a network body. This token is the entire credential for an
 * unauthenticated route; `tokenPreview` (the first 8 characters, which is also what the audit trail
 * stores) says WHICH link a row is, and is far too little to BE the link. Same shape as
 * `CvLifecycleShareLink`. Someone who has lost a token revokes the link and mints another.
 */
export type MarketingShareLink = {
  accessCount: number;
  allowFiles: boolean;
  createdAt: string;
  expiresAt: string;
  fileAccessCount: number;
  hasPasscode: boolean;
  id: string;
  label: string | null;
  lastAccessedAt: string | null;
  revokedAt: string | null;
  scope: string;
  surface: "live" | "feed";
  tokenPreview: string;
};

/**
 * Create a link. The creator's scope is captured HERE and never re-resolved, so the link cannot
 * widen if they are promoted, and cannot break if they are not.
 */
export async function createMarketingReportShareLink(
  access: AccessContext,
  input: {
    allowFiles?: boolean;
    expiresInDays?: number | null;
    label?: string | null;
    passcode?: string | null;
    surface: "live" | "feed";
  },
): Promise<{ expiresAt: string; token: string }> {
  await assertPermission(access, "expenses", "export");
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
  // Only a company-wide role can mint a company-wide link; everyone else's link is frozen to them.
  const scope = access.scope === "system" || access.role === "Super Admin" || access.role === "CEO" ? "all" : "own";
  const allowFiles = Boolean(input.allowFiles);

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from(TABLE).insert({
    allow_files: allowFiles,
    created_by_hr_id: hrIdForStorage(hrId),
    expires_at: expiresAt,
    label: input.label?.toString().trim() || null,
    passcode_hash: surface === "live" ? hashPasscode(passcode, token) : null,
    scope,
    scope_hr_id: hrIdForStorage(hrId),
    surface,
    token_hash: hashShareToken(token),
    token_preview: shareTokenPreview(token),
  });
  if (error) throw error;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? hrId,
    entityId: `share-link:${shareTokenPreview(token)}`,
    entityType: "marketing_request",
    newValues: { allowFiles, expiresAt, hasPasscode: surface === "live", scope, surface },
    summary: `Marketing request report ${surface} link created by ${hrId}, scope ${scope}, files ${allowFiles ? "ON" : "off"}, expires ${expiresAt.slice(0, 10)}.`,
  });

  return { expiresAt, token };
}

/** Every link, so revoking is possible without hunting through email. */
export async function listMarketingReportShareLinks(access: AccessContext): Promise<MarketingShareLink[]> {
  await assertPermission(access, "expenses", "export");
  const supabase = getSupabaseAdmin();
  const isAdmin = access.scope === "system" || access.role === "Super Admin";
  let query = supabase.from(TABLE).select("*").order("created_at", { ascending: false });
  // A Super Admin sees every link, because "who else has published our numbers" is exactly the
  // question this table exists to answer. Everyone else sees only their own.
  // Case-insensitive because created_by_hr_id is written canonically while rows created before
  // 2026-09-05 hold the lower-cased comparison key. A bare .eq matches ONE of those spellings
  // and returns an empty list for the other — a creator silently loses sight of their own links.
  if (!isAdmin) {
    // An empty key list would build `created_by_hr_id=in.()`, which PostgREST rejects as a SYNTAX
    // ERROR - the screen 500s instead of showing "you have no links". A viewer with no linked HR id
    // owns nothing here by definition, so answer that directly rather than asking the database a
    // question it cannot parse.
    const ownKeys = hrIdLookupKeys(access.hrId);
    if (ownKeys.length === 0) return [];
    query = query.in("created_by_hr_id", ownKeys);
  }
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    accessCount: Number(row.access_count ?? 0),
    allowFiles: Boolean(row.allow_files),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    fileAccessCount: Number(row.file_access_count ?? 0),
    hasPasscode: Boolean(row.passcode_hash),
    id: String(row.id),
    label: row.label ? String(row.label) : null,
    lastAccessedAt: row.last_accessed_at ? String(row.last_accessed_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    scope: String(row.scope ?? ""),
    surface: String(row.surface) === "feed" ? "feed" : "live",
    tokenPreview: String(row.token_preview ?? ""),
  }));
}

export async function revokeMarketingReportShareLink(access: AccessContext, linkId: string): Promise<void> {
  await assertPermission(access, "expenses", "export");
  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase.from(TABLE).select("id, created_by_hr_id, token_preview").eq("id", linkId).maybeSingle();
  if (!row) throw notFoundError("Share link not found.");
  const isAdmin = access.scope === "system" || access.role === "Super Admin";
  const owns = String((row as { created_by_hr_id: string }).created_by_hr_id).toUpperCase() === (access.hrId ?? "").toUpperCase();
  if (!isAdmin && !owns) throw forbiddenError("You can only revoke a link you created.");

  await supabase.from(TABLE).update({ revoked_at: new Date().toISOString(), revoked_by_hr_id: hrIdForStorage(access.hrId) }).eq("id", linkId);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityId: `share-link:${String((row as { token_preview: string | null }).token_preview ?? "")}`,
    entityType: "marketing_request",
    newValues: { revoked: true },
    summary: `Marketing request report share link revoked by ${access.hrId ?? "unknown"}.`,
  });
}

export type ResolvedMarketingShareLink = {
  allowFiles: boolean;
  generatedAt: string;
  label: string | null;
  requests: FullReportRequest[];
  scope: string;
};

/**
 * Resolve a token WITHOUT loading the report — the cheap half, used by the file route where the
 * caller wants one image and loading fifteen tables to serve it would be absurd.
 *
 * Returns the raw link row. Throws for anything that is not a live, unexpired, unrevoked link.
 */
export async function assertMarketingShareToken(input: {
  requireFiles?: boolean;
  surface: "live" | "feed";
  token: string;
}): Promise<Record<string, unknown>> {
  // Found by its hash; a token that could not have been minted here is not looked up at all.
  const tokenHash = shareTokenLookupHash(input.token);
  if (!tokenHash) throw notFoundError("Link not found.");

  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase.from(TABLE).select("*").eq("token_hash", tokenHash).maybeSingle();
  // Same answer for "no such link" and "wrong surface": a probing caller learns nothing about
  // which tokens exist.
  if (!row) throw notFoundError("Link not found.");
  const link = row as Record<string, unknown>;
  if (String(link.surface) !== input.surface) throw notFoundError("Link not found.");
  // Count the refusal before refusing — the caller's answer is unchanged, but a dead token being
  // polled now leaves a trace Phoenix can see. See `dead-token-polling.ts` for the failure mode.
  if (link.revoked_at) {
    await noteDeadShareTokenRead(TABLE, link);
    throw forbiddenError("This link has been revoked.");
  }
  if (new Date(String(link.expires_at)).getTime() < Date.now()) {
    await noteDeadShareTokenRead(TABLE, link);
    throw forbiddenError("This link has expired.");
  }
  // Files are a separate grant from the table. A token minted for the numbers must not become a
  // key to photographs of real clinics just because someone guessed the file route exists.
  if (input.requireFiles && !link.allow_files) throw forbiddenError("This link does not carry file access.");
  return link;
}

/**
 * Serve a link: the report the link is entitled to, or a throw.
 *
 * Loads as the CREATOR (frozen scope), never as the anonymous caller.
 */
export async function resolveMarketingReportShareLink(input: {
  passcode?: string | null;
  surface: "live" | "feed";
  token: string;
}): Promise<ResolvedMarketingShareLink> {
  const link = await assertMarketingShareToken({ surface: input.surface, token: input.token });

  if (link.passcode_hash) {
    const supplied = String(input.passcode ?? "");
    if (!supplied || !(await passcodeMatches(supplied, String(input.token).trim(), String(link.passcode_hash)))) {
      throw forbiddenError("Passcode required.");
    }
  }

  const scope = String(link.scope ?? "own");
  const { requests } = await loadMarketingRequestFullReport({
    ...systemAccessContext,
    hrId: String(link.scope_hr_id ?? ""),
    // 'own' links are minted by roles that cannot see the whole company. The loader has no
    // per-requester filter today, so a narrow link is deliberately filtered here rather than
    // trusted to a scope string the loader ignores.
    role: scope === "all" ? "Super Admin" : "Product Manager",
    scope: scope === "all" ? "system" : "self",
  } as AccessContext);

  const scoped = scope === "all"
    ? requests
    : requests.filter((request) => (request.requesterHrId ?? "").toUpperCase() === String(link.scope_hr_id ?? "").toUpperCase());

  // Count the open. Best-effort: a failed counter must never deny a legitimate read.
  const supabase = getSupabaseAdmin();
  await supabase
    .from(TABLE)
    .update({ access_count: Number(link.access_count ?? 0) + 1, last_accessed_at: new Date().toISOString() })
    .eq("id", String(link.id))
    .then(undefined, () => undefined);

  return {
    allowFiles: Boolean(link.allow_files),
    generatedAt: new Date().toISOString(),
    label: link.label ? String(link.label) : null,
    requests: scoped,
    scope,
  };
}

// `csvCell` is the shared one (`@/lib/export/csv-cell`): RFC4180 quoting — a customer name containing
// a comma must survive the round trip — and a typed cell that starts with `=`, `+`, `-` or `@` is
// neutralised before the sheet opens it (audit S-APP-08).

/** Where a token-scoped file lives. Kept beside the CSV builder so the two cannot disagree. */
export function shareFileUrl(baseUrl: string, token: string, kind: "evidence" | "invoice" | "proof", requestCode: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/api/share/marketing-requests/${encodeURIComponent(token)}/file?kind=${kind}&request=${encodeURIComponent(requestCode)}`;
}

/**
 * The whole workbook as ONE payload: every sheet, `#`-prefixed section markers, one response.
 *
 * One response rather than four endpoints because every section then describes the same instant.
 * Four sequential fetches of a live report could not promise that, and a Requests tab listing a
 * request whose products tab has not caught up yet is exactly the quiet inconsistency that
 * destroys trust in a report.
 */
export function buildMarketingReportBundleCsv(input: {
  allowFiles: boolean;
  baseUrl: string;
  requests: FullReportRequest[];
  scope: string;
  token: string;
}): string {
  const { allowFiles, baseUrl, requests, scope, token } = input;
  const out: string[] = [];

  const totalCost = requests.reduce((sum, request) => sum + (request.estimatedCost ?? 0), 0);
  const totalRoi = requests.reduce((sum, request) => sum + (request.expectedRoiValue ?? 0), 0);

  out.push("#SUMMARY");
  out.push(["Metric", "Value"].map(csvCell).join(","));
  const summary: Array<[string, string]> = [
    ["Visibility scope", scope],
    ["Requests", String(requests.length)],
    ["Total amount (EGP)", totalCost.toFixed(2)],
    ["Total estimated ROI (EGP)", totalRoi.toFixed(2)],
    ["Product lines", String(requests.reduce((sum, request) => sum + request.products.length, 0))],
    ["Approval steps", String(requests.reduce((sum, request) => sum + request.approvalSteps.length, 0))],
    ["Pharmacy links", String(requests.reduce((sum, request) => sum + request.pharmacies.length, 0))],
    ["Files clickable", allowFiles ? "Yes" : "No"],
  ];
  for (const [label, value] of summary) out.push([label, value].map(csvCell).join(","));

  out.push("#REQUESTS");
  out.push(REQUEST_COLUMNS.map((column) => csvCell(column.label)).join(","));
  for (const [index, request] of requests.entries()) {
    const links: RequestFileLinks = allowFiles
      ? {
        evidence: shareFileUrl(baseUrl, token, "evidence", request.requestCode),
        invoice: shareFileUrl(baseUrl, token, "invoice", request.requestCode),
        transferProof: shareFileUrl(baseUrl, token, "proof", request.requestCode),
      }
      : { evidence: null, invoice: null, transferProof: null };
    out.push(requestRowCells(request, index + 1, links).map(csvCell).join(","));
  }

  out.push("#PRODUCTS");
  out.push(PRODUCT_COLUMNS.map((column) => csvCell(column.label)).join(","));
  for (const request of requests) {
    for (const product of request.products) out.push(productRowCells(request, product).map(csvCell).join(","));
  }

  out.push("#APPROVALS");
  out.push(APPROVAL_COLUMNS.map((column) => csvCell(column.label)).join(","));
  for (const request of requests) {
    for (const step of request.approvalSteps) out.push(approvalRowCells(request, step).map(csvCell).join(","));
  }

  out.push("#PHARMACIES");
  out.push(PHARMACY_COLUMNS.map((column) => csvCell(column.label)).join(","));
  for (const request of requests) {
    for (const pharmacy of request.pharmacies) out.push(pharmacyRowCells(request, pharmacy).map(csvCell).join(","));
  }

  // Leading BOM so Excel opens Arabic customer names correctly instead of as mojibake.
  return `﻿${out.join("\r\n")}\r\n`;
}
