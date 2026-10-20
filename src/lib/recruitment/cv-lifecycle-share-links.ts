// Bearer links for the owner's live CV-lifecycle Google Sheet (owner request, 2026-09-04).
//
// THIS MODULE IS THE ENTIRE SECURITY BOUNDARY FOR AN UNAUTHENTICATED ROUTE. A script running on a
// one-minute timer inside a Google Sheet cannot log in and cannot type a passcode, so the token in
// the URL is the only credential there will ever be. Existence, revocation and expiry are all
// checked here, before a single candidate row is read.
//
// The intended handling — and it is the real access control — is that the URL lives inside a
// PRIVATE sheet's Apps Script and is never given to a person. The sheet's own Google sharing is
// then what decides who sees the data.
//
// WHY THIS IS A THIRD SHARE-LINK MODULE RATHER THAN A SHARED ONE. It is deliberately a near-copy of
// src/lib/marketing-requests/report-share-links.ts, and that duplication is the point: a token here
// unlocks candidate names, phone numbers and the folders their CVs sit in — personal data about
// people who are not employees. Merging the three would give two reports with different audiences
// one revoke list and one blast radius, and a mistake in either would silently widen the other.
//
// WHAT IS DELIBERATELY MISSING, COMPARED WITH THE OTHER TWO:
//
//   * No `allow_files` grant and no file surface. The older sheets can stream an evidence photo;
//     this one links to Drive and to Phoenix, both of which make the reader log in. A CV is the
//     most sensitive document this system holds and an unauthenticated route that streams one is
//     not a feature anybody asked for.
//   * No 'live' human surface and so no passcode. The only consumer is a script. Adding a human
//     page later is a `surface` value and a route, not a migration.

import { randomBytes } from "node:crypto";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { hrIdForStorage } from "@/lib/hr-id";
import { namesByHrId, type EmployeeNameIndex } from "@/lib/employees/names-by-hr-id";
import { noteDeadShareTokenRead } from "@/lib/share-links/refusal-counter";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  buildCvLifecycleCsv,
  buildDailyChannelRollup,
  loadCvLifecycle,
  summarizeCvLifecycle,
  type CvLifecycleDailyRow,
  type CvLifecycleRow,
  type CvLifecycleSummary,
} from "@/lib/recruitment/cv-lifecycle";

const TABLE = "ats_cv_lifecycle_share_links";
const MAX_EXPIRY_DAYS = 365;
const DEFAULT_EXPIRY_DAYS = 90;

/** 32 random bytes, URL-safe. Long enough that guessing is not a threat model. */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A link as the MANAGEMENT screen sees it — deliberately WITHOUT the token.
 *
 * The token is returned exactly once, by `createCvLifecycleShareLink`, to the person who just
 * minted it. It is never in this shape and so can never reach a list, a props payload, a React
 * hydration blob or a browser devtools tab. `tokenPreview` is the first 8 characters, which is what
 * the audit trail already stores: enough to say WHICH link a row is talking about, far too little
 * to BE the link. Anyone who has lost a token revokes it and mints another — that is the whole
 * point of a bearer credential with one-click revoke, and it is cheaper than a screen that can hand
 * the candidate pool to whoever is looking over your shoulder.
 */
export type CvLifecycleShareLink = {
  accessCount: number;
  createdAt: string;
  createdByHrId: string;
  /** The creator's display name, or their HR id when the directory cannot name them. */
  createdByName: string;
  expiresAt: string;
  id: string;
  label: string | null;
  lastAccessedAt: string | null;
  revokedAt: string | null;
  revokedByHrId: string | null;
  revokedByName: string | null;
  tokenPreview: string;
};

/** The first 8 characters, matching what the audit rows above store. Never the whole token. */
function previewOf(token: string): string {
  return String(token ?? "").slice(0, 8);
}

function mapLink(row: Record<string, unknown>, names: EmployeeNameIndex): CvLifecycleShareLink {
  const createdByHrId = String(row.created_by_hr_id ?? "");
  const revokedByHrId = row.revoked_by_hr_id ? String(row.revoked_by_hr_id) : null;
  return {
    accessCount: Number(row.access_count ?? 0),
    createdAt: String(row.created_at ?? ""),
    createdByHrId,
    // Owner rule: human-readable names, never raw ids. The id is the fallback, not the display.
    createdByName: names.get(createdByHrId) ?? createdByHrId,
    expiresAt: String(row.expires_at ?? ""),
    id: String(row.id ?? ""),
    label: row.label ? String(row.label) : null,
    lastAccessedAt: row.last_accessed_at ? String(row.last_accessed_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    revokedByHrId,
    revokedByName: revokedByHrId ? (names.get(revokedByHrId) ?? revokedByHrId) : null,
    tokenPreview: previewOf(String(row.token ?? "")),
  };
}

/**
 * Mint a link.
 *
 * Gated on `recruitment:export`, not `recruitment:read`. Reading the candidate pool inside Phoenix
 * and minting a credential that copies it out to a Google Sheet are different acts, and only the
 * second one survives the person who performed it — so it is the export authority that must be
 * held, and the audit row is required rather than best-effort.
 */
export async function createCvLifecycleShareLink(
  access: AccessContext,
  input: { expiresInDays?: number | null; label?: string | null } = {},
): Promise<{ expiresAt: string; id: string; token: string; url: string }> {
  await assertPermission(access, "recruitment", "export");

  const days = Number(input.expiresInDays ?? DEFAULT_EXPIRY_DAYS);
  if (!Number.isFinite(days) || days <= 0) throw validationError("Expiry must be a positive number of days.");
  if (days > MAX_EXPIRY_DAYS) {
    throw validationError(`Expiry cannot exceed ${MAX_EXPIRY_DAYS} days. A link with no practical end date becomes an unowned copy of the candidate pool.`);
  }

  const token = mintToken();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const createdBy = hrIdForStorage(access.hrId ?? "") ?? "";
  if (!createdBy) throw forbiddenError("A share link must be attributable to a person.");

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      created_by_hr_id: createdBy,
      expires_at: expiresAt,
      label: input.label ? String(input.label).slice(0, 200) : null,
      surface: "feed",
      token,
    })
    .select("id")
    .single();
  if (error) throw error;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? createdBy,
    // The first 8 characters only. Enough to tie a row to a link when reading the log beside the
    // link list; far too little to BE the link. The token itself is never written to the audit
    // trail — a log that stores the credential it audits turns every reader into a holder.
    entityId: `share-link:${token.slice(0, 8)}`,
    entityType: "cv_lifecycle_share_link",
    newValues: { expiresAt, label: input.label ?? null, surface: "feed" },
    summary: `Live CV-lifecycle sheet link created by ${createdBy}, expires ${expiresAt.slice(0, 10)}.`,
  });

  return {
    expiresAt,
    id: String((data as { id?: string } | null)?.id ?? ""),
    token,
    url: `/api/share/cv-lifecycle/${token}/feed`,
  };
}

export async function listCvLifecycleShareLinks(access: AccessContext): Promise<CvLifecycleShareLink[]> {
  await assertPermission(access, "recruitment", "export");
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  // Both actors on every link, through the one shared lookup: this list is capped at 100 links, so
  // the id set is small, and the mixed-case trap behind the read is `namesByHrId`'s to carry.
  const names = await namesByHrId(
    rows.flatMap((row) => [String(row.created_by_hr_id ?? ""), String(row.revoked_by_hr_id ?? "")]),
  );
  return rows.map((row) => mapLink(row, names));
}

export async function revokeCvLifecycleShareLink(access: AccessContext, linkId: string): Promise<void> {
  await assertPermission(access, "recruitment", "export");
  const id = String(linkId ?? "").trim();
  if (!id) throw validationError("Which link?");

  const revokedBy = hrIdForStorage(access.hrId ?? "") ?? "";
  const supabase = getSupabaseAdmin();
  // `select` on the update so the audit row can name WHICH link died by its token prefix. Reading
  // it back afterwards would race a second revoke; returning it from the write cannot.
  const { data, error } = await supabase
    .from(TABLE)
    .update({ revoked_at: new Date().toISOString(), revoked_by_hr_id: revokedBy })
    .eq("id", id)
    .select("token")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("Link not found.");

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? revokedBy,
    entityId: `share-link:${String((data as { token?: string }).token ?? "").slice(0, 8)}`,
    entityType: "cv_lifecycle_share_link",
    newValues: { revoked: true },
    summary: `Live CV-lifecycle sheet link revoked by ${revokedBy || "unknown"}.`,
  });
}

/**
 * Existence, revocation and expiry — the three checks that stand between a URL and the candidate
 * pool. Every failure answers the same way a missing link does, so a caller probing for live tokens
 * learns nothing about which ones exist.
 */
export async function assertCvLifecycleShareToken(token: string): Promise<Record<string, unknown>> {
  const trimmed = String(token ?? "").trim();
  if (!trimmed) throw notFoundError("Link not found.");

  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase.from(TABLE).select("*").eq("token", trimmed).maybeSingle();
  if (!row) throw notFoundError("Link not found.");

  const link = row as Record<string, unknown>;
  if (String(link.surface) !== "feed") throw notFoundError("Link not found.");
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
  return link;
}

export type ResolvedCvLifecycleFeed = {
  /** Who made the link. The feed has no viewer, so the Talent Acquisition fence follows its maker. */
  createdByHrId: string | null;
  daily: CvLifecycleDailyRow[];
  label: string | null;
  rows: CvLifecycleRow[];
  summary: CvLifecycleSummary;
};

/** Serve a link: the whole lifecycle report, or a throw. */
export async function resolveCvLifecycleShareLink(token: string): Promise<ResolvedCvLifecycleFeed> {
  const link = await assertCvLifecycleShareToken(token);

  const rows = await loadCvLifecycle();

  // Count the open. Best-effort: a failed counter must never deny a legitimate read — the sheet
  // refreshing every minute is the whole point of the feature, and an access-stamp write failing is
  // not a reason to hand the owner an empty report.
  const supabase = getSupabaseAdmin();
  await supabase
    .from(TABLE)
    .update({ access_count: Number(link.access_count ?? 0) + 1, last_accessed_at: new Date().toISOString() })
    .eq("id", String(link.id))
    .then(undefined, () => undefined);

  return {
    createdByHrId: link.created_by_hr_id ? String(link.created_by_hr_id) : null,
    daily: buildDailyChannelRollup(rows),
    label: link.label ? String(link.label) : null,
    rows,
    summary: summarizeCvLifecycle(rows),
  };
}

/** The bundle, built from a resolved feed. Kept here so the route stays a transport shell. */
export function cvLifecycleCsvFor(feed: ResolvedCvLifecycleFeed, baseUrl: string): string {
  return buildCvLifecycleCsv({ baseUrl, daily: feed.daily, rows: feed.rows, summary: feed.summary });
}
