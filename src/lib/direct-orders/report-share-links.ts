import { randomBytes } from "node:crypto";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { csvCell } from "@/lib/export/csv-cell";
import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission, systemAccessContext } from "@/lib/auth/permissions";
import { hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { noteDeadShareTokenRead } from "@/lib/share-links/refusal-counter";
import { hashPasscode, passcodeMatches } from "@/lib/share-links/passcode-hash";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  DIRECT_ORDER_REPORT_COLUMNS,
  directOrderReportRowCells,
  directOrderShareFileUrl,
  summariseDirectOrderReport,
} from "@/lib/direct-orders/report-columns";
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

/**
 * A link as the MANAGEMENT list sees it — deliberately WITHOUT the token.
 *
 * The whole token is returned exactly once, by `createDirectOrderReportShareLink`, to the person who just minted it. It is
 * never in this shape, so it cannot reach the list response, a props payload, the React tree, devtools
 * or an error report that captured a network body. This token is the entire credential for an
 * unauthenticated route; `tokenPreview` (the first 8 characters, which is also what the audit trail
 * stores) says WHICH link a row is, and is far too little to BE the link. Same shape as
 * `CvLifecycleShareLink`. Someone who has lost a token revokes the link and mints another.
 */
export type DirectOrderShareLink = {
  id: string;
  tokenPreview: string;
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

/** The first 8 characters, matching what the audit rows store. Never the whole token. */
function previewOf(token: unknown): string {
  return String(token ?? "").slice(0, 8);
}

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
    created_by_hr_id: hrIdForStorage(hrId),
    scope,
    scope_hr_id: hrIdForStorage(hrId),
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
  // Case-insensitive for the same reason the request lists are: access.hrId is lower-cased by
  // canonicalHrIdKey while the stored column keeps whatever case the creating session had.
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
    id: String(row.id),
    tokenPreview: previewOf(row.token),
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
  if (!row) throw notFoundError("Share link not found.");
  const isAdmin = access.scope === "system" || access.role === "Super Admin";
  const owns = String((row as { created_by_hr_id: string }).created_by_hr_id).toUpperCase() === (access.hrId ?? "").toUpperCase();
  if (!isAdmin && !owns) throw forbiddenError("You can only revoke a link you created.");

  await supabase
    .from("direct_order_report_share_links")
    .update({ revoked_at: new Date().toISOString(), revoked_by_hr_id: hrIdForStorage(access.hrId) })
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
  allowFiles: boolean;
};

/**
 * Resolve a token WITHOUT loading the report — the cheap half, used by the file route, where
 * loading every order to serve one photograph would be absurd.
 *
 * Returns the raw link row. Throws for anything that is not a live, unexpired, unrevoked link.
 */
export async function assertDirectOrderShareToken(input: {
  requireFiles?: boolean;
  surface: "live" | "feed";
  token: string;
}): Promise<Record<string, unknown>> {
  const token = String(input.token ?? "").trim();
  if (!token) throw notFoundError("Link not found.");

  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase
    .from("direct_order_report_share_links")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  // Same answer for "no such link" and "wrong surface": a probing caller learns nothing about
  // which tokens exist.
  if (!row) throw notFoundError("Link not found.");
  const link = row as Record<string, unknown>;
  if (String(link.surface) !== input.surface) throw notFoundError("Link not found.");
  // Count the refusal before refusing. What the caller gets back is unchanged — same status, same
  // terse message — but a dead token being polled now leaves a trace this application can see, and
  // `dead-token-polling-alert.ts` is what turns that into a message. `refusal-counter.ts` says why
  // only a row that already exists is ever written.
  if (link.revoked_at) {
    await noteDeadShareTokenRead("direct_order_report_share_links", link);
    throw forbiddenError("This link has been revoked.");
  }
  if (new Date(String(link.expires_at)).getTime() < Date.now()) {
    await noteDeadShareTokenRead("direct_order_report_share_links", link);
    throw forbiddenError("This link has expired.");
  }
  // Files are a SEPARATE grant from the table. A token minted to feed a spreadsheet must not become
  // a key to photographs of real shop fronts just because someone guessed the file route exists.
  if (input.requireFiles && !link.allow_files) throw forbiddenError("This link does not carry file access.");
  return link;
}

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
  // Existence, surface, revocation and expiry all live in assertDirectOrderShareToken, so the file
  // route and this one can never drift apart on what counts as a live link.
  const link = await assertDirectOrderShareToken({ surface: input.surface, token });

  if (link.passcode_hash) {
    const supplied = String(input.passcode ?? "");
    if (!supplied || !(await passcodeMatches(supplied, token, String(link.passcode_hash)))) {
      throw forbiddenError("Passcode required.");
    }
  }

  // Load as the CREATOR. `systemAccessContext` reads everything, so the frozen scope is applied
  // here explicitly — this is what stops a District Manager's link from serving company-wide data.
  const creatorHrId = String(link.scope_hr_id ?? "");
  const supabase = getSupabaseAdmin();
  const scope = String(link.scope ?? "own");
  const all = await getDirectOrderReport({
    ...systemAccessContext,
    hrId: creatorHrId,
    role:
      scope === "all"
        ? "Super Admin"
        : scope === "line"
          ? "National Sales Manager"
          : scope === "hierarchy"
            ? "Regional Manager"
            : "District Manager",
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
    allowFiles: Boolean(link.allow_files),
    rows,
    label: link.label ? String(link.label) : null,
    scope,
    generatedAt: new Date().toISOString(),
  };
}

// `csvCell` is the shared one (`@/lib/export/csv-cell`): RFC4180 quoting — a pharmacy name containing
// a comma must survive the round trip — and a typed cell that starts with `=`, `+`, `-` or `@` is
// neutralised before the sheet opens it (audit S-APP-08).

/**
 * CSV of the order table for the owner's live Google Sheet.
 *
 * The columns are `DIRECT_ORDER_REPORT_COLUMNS` — the SAME array the downloadable .xlsx uses, not a
 * parallel list. The first cut of this function carried its own hand-written 25-column subset,
 * which meant the live Sheet and the export were already two different reports on the day they
 * shipped. They now cannot drift, because there is only one definition of a Direct Orders row.
 */
export function buildDirectOrderReportCsv(rows: DirectOrderReportRow[]): string {
  const lines = [DIRECT_ORDER_REPORT_COLUMNS.map((column) => csvCell(column.label)).join(",")];
  for (const row of rows) {
    lines.push(directOrderReportRowCells(row).map(csvCell).join(","));
  }
  // Leading BOM so Excel opens Arabic pharmacy names correctly instead of as mojibake.
  return `﻿${lines.join("\r\n")}\r\n`;
}

/**
 * The whole workbook as one payload: the cover's headline figures, the By Status breakdown, and
 * the full order table — mirroring the three sheets of the .xlsx export.
 *
 * Delivered as ONE response with `#`-prefixed section markers rather than three endpoints, because
 * every section then describes the same instant. Three sequential fetches of a live report could
 * not promise that, and a cover row reading "14 orders" above a table listing 15 is exactly the
 * kind of quiet inconsistency that destroys trust in a number.
 */
export function buildDirectOrderReportBundleCsv(
  rows: DirectOrderReportRow[],
  scope: string,
  files?: { allowFiles: boolean; baseUrl: string; token: string },
): string {
  const { totalValue, approvedValue, totalUnits, byStatus } = summariseDirectOrderReport(rows);
  const out: string[] = [];

  out.push("#SUMMARY");
  out.push(["Metric", "Value"].map(csvCell).join(","));
  const summaryRows: Array<[string, string]> = [
    ["Visibility scope", scope],
    ["Rows", String(rows.length)],
    ["Total sales value (EGP)", totalValue.toFixed(2)],
    ["Approved sales value (EGP)", approvedValue.toFixed(2)],
    ["Total units", String(totalUnits)],
  ];
  for (const [label, value] of summaryRows) out.push([label, value].map(csvCell).join(","));

  out.push("#BYSTATUS");
  out.push(["Status", "Requests", "Sales value (EGP)"].map(csvCell).join(","));
  for (const entry of byStatus) {
    out.push([entry.status, entry.count, entry.value.toFixed(2)].map(csvCell).join(","));
  }

  out.push("#ORDERS");
  out.push(DIRECT_ORDER_REPORT_COLUMNS.map((column) => csvCell(column.label)).join(","));
  for (const row of rows) {
    // A link is emitted only when the link carries the file grant. Without it the cell stays blank
    // rather than offering a door the caller cannot open.
    const links = files?.allowFiles
      ? { evidence: directOrderShareFileUrl(files.baseUrl, files.token, row.id) }
      : { evidence: null };
    out.push(directOrderReportRowCells(row, links).map(csvCell).join(","));
  }

  return `﻿${out.join("\r\n")}\r\n`;
}
