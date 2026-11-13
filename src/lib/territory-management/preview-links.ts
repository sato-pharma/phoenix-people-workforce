import { randomBytes } from "node:crypto";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { hashShareToken, shareTokenLookupHash, shareTokenPreview } from "@/lib/share-links/token-hash";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { loadTerritoryFilters, loadTerritoryMap } from "@/lib/territory-management/service";
import { hrIdForStorage } from "@/lib/hr-id";

// ─────────────────────────────────────────────────────────────────────────────
// Territory Management preview links (owner request, 2026-08-14).
//
// A link anyone can open with no Phoenix account, no username and no passcode. The recipient picks
// a region, then an area, and sees that area's brick pins. That is the whole surface.
//
// THE PASSCODE IS ABSENT ON PURPOSE. The Direct Orders live link demands one; this one must not,
// because the owner asked for plain open access. Every other control therefore has to carry the
// weight the passcode carried there, and each is tightened rather than merely copied:
//
//   * the token is the entire credential — 32 random bytes, never derived from the creator — and
//     it is stored only as its SHA-256 and first 8 characters (`@/lib/share-links/token-hash`,
//     REC-055); the whole link is shown once, when it is made;
//   * every public read is limited per address and per link before the token is looked up;
//   * expiry is MANDATORY and defaults to 14 days (the owner's figure), capped at 90 rather than
//     the 180 the passcode-protected report link allows;
//   * `area_codes` is frozen at creation and is the containment: every request is intersected
//     against it, so a forged area code reaches nothing;
//   * the response is PROJECTED down to bricks. The internal analysis the admin module shows —
//     residence recommendation, "closer to another area" findings, route/span/gap km, coverage
//     tiles — is stripped here, in the domain, not hidden in the UI. Hiding it in the UI would
//     still ship it in the JSON to an anonymous caller.
//
// THE LINE IS NEVER DISCLOSED. An area's brick allocation only means something inside one line, so
// a link must pin one; the owner asked that the preview not say which. `line_code` is therefore
// frozen on the row, defaulted to Pedia, and deliberately absent from every type returned here.
// ─────────────────────────────────────────────────────────────────────────────

/** The line every preview link is pinned to unless a row says otherwise. Never rendered. */
export const TERRITORY_PREVIEW_DEFAULT_LINE_CODE = "pedia";

const DEFAULT_EXPIRY_DAYS = 14;
// Lower than the Direct Orders report's 180: that link is passcode-protected and this one is not,
// so the window in which a forwarded URL keeps working has to be shorter.
const MAX_EXPIRY_DAYS = 90;

/** 32 random bytes, URL-safe. With no passcode behind it, this is the entire credential. */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export type TerritoryPreviewLink = {
  accessCount: number;
  areaCount: number;
  createdAt: string;
  expiresAt: string;
  id: string;
  label: string | null;
  lastAccessedAt: string | null;
  revokedAt: string | null;
  /** The first 8 characters. The whole link is returned once, by `createTerritoryPreviewLink`. */
  tokenPreview: string;
};

/**
 * Publishing geography past the login wall is the strongest form of export there is, so the gate is
 * `sales:export` and not `sales:read` — a reader who may not download the map must not be able to
 * hand out a public link to it instead.
 *
 * Super Admin on top of that. This module already has exactly one "privileged act" bar — only a
 * Super Admin may move a brick pin — and minting a passwordless public link is at least that
 * privileged. Widening this later is one line; discovering that a District Manager published the
 * company's territory is not recoverable.
 */
async function assertMayPublish(access: AccessContext): Promise<void> {
  await assertPermission(access, "sales", "export");
  if (access.role !== "Super Admin") {
    throw forbiddenError("Forbidden: only a Super Admin can create a public preview link.");
  }
}

/**
 * Mint a link. The creator's visible areas are captured HERE, as literal codes, and never
 * re-resolved: the link cannot widen if they are promoted and cannot break if they are not.
 */
export async function createTerritoryPreviewLink(
  access: AccessContext,
  input: { expiresInDays?: number | null; label?: string | null },
): Promise<{ areaCount: number; expiresAt: string; token: string }> {
  await assertMayPublish(access);
  const hrId = access.hrId?.trim();
  if (!hrId) throw validationError("Your account has no HR ID; cannot create a preview link.");

  const lineCode = TERRITORY_PREVIEW_DEFAULT_LINE_CODE;
  // The creator's OWN scope, resolved once, right now. Everything the link will ever serve is
  // decided by this call.
  const filters = await loadTerritoryFilters(lineCode, access);
  const areaCodes = filters.areas.map((area) => area.areaCode).filter(Boolean);
  if (areaCodes.length === 0) {
    throw validationError("You have no territory to share, so this link would show nothing.");
  }

  const days = Math.min(
    Math.max(Math.floor(Number(input.expiresInDays) || DEFAULT_EXPIRY_DAYS), 1),
    MAX_EXPIRY_DAYS,
  );
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const token = mintToken();

  const { error } = await getSupabaseAdmin().from("territory_preview_links").insert({
    area_codes: areaCodes,
    created_by_hr_id: hrIdForStorage(hrId),
    expires_at: expiresAt,
    label: input.label?.toString().trim() || null,
    line_code: lineCode,
    token_hash: hashShareToken(token),
    token_preview: shareTokenPreview(token),
  });
  if (error) throw error;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? hrId,
    entityType: "territory_preview_link",
    entityId: `preview-link:${shareTokenPreview(token)}`,
    newValues: { areaCount: areaCodes.length, expiresAt, hasPasscode: false, lineCode },
    summary:
      `Territory preview link created by ${hrId} — ${areaCodes.length} areas, no passcode, ` +
      `expires ${expiresAt.slice(0, 10)}.`,
  });

  return { areaCount: areaCodes.length, expiresAt, token };
}

/** Every live and dead link, so revoking is possible without hunting through WhatsApp. */
export async function listTerritoryPreviewLinks(access: AccessContext): Promise<TerritoryPreviewLink[]> {
  await assertMayPublish(access);
  const { data, error } = await getSupabaseAdmin()
    .from("territory_preview_links")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    accessCount: Number(row.access_count ?? 0),
    areaCount: Array.isArray(row.area_codes) ? row.area_codes.length : 0,
    createdAt: str(row.created_at),
    expiresAt: str(row.expires_at),
    id: str(row.id),
    label: row.label ? str(row.label) : null,
    lastAccessedAt: row.last_accessed_at ? str(row.last_accessed_at) : null,
    revokedAt: row.revoked_at ? str(row.revoked_at) : null,
    tokenPreview: str(row.token_preview),
  }));
}

export async function revokeTerritoryPreviewLink(access: AccessContext, linkId: string): Promise<void> {
  await assertMayPublish(access);
  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase
    .from("territory_preview_links")
    .select("id, token_preview")
    .eq("id", linkId)
    .maybeSingle();
  if (!row) throw notFoundError("Preview link not found.");

  await supabase
    .from("territory_preview_links")
    .update({ revoked_at: new Date().toISOString(), revoked_by_hr_id: hrIdForStorage(access.hrId) })
    .eq("id", linkId);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "territory_preview_link",
    entityId: `preview-link:${str((row as { token_preview: string | null }).token_preview)}`,
    newValues: { revoked: true },
    summary: `Territory preview link revoked by ${access.hrId ?? "unknown"}.`,
  });
}

// ── the anonymous read path ──────────────────────────────────────────────────

type PreviewLinkRow = {
  areaCodes: Set<string>;
  id: string;
  label: string | null;
  lineCode: string;
};

/**
 * Resolve a token. Called from UNAUTHENTICATED routes, so this is the single liveness gate for
 * every public surface — existence, revocation and expiry are all decided here, once, so the two
 * routes cannot drift on what counts as a live link.
 *
 * A missing token and a revoked one answer differently on purpose: "not found" tells a probing
 * caller nothing, while a holder of a link that used to work deserves to know it was switched off
 * rather than being left to think the page is broken.
 */
export async function assertTerritoryPreviewToken(token: string): Promise<PreviewLinkRow> {
  // Found by its hash; a token that could not have been minted here is not looked up at all.
  const tokenHash = shareTokenLookupHash(token);
  if (!tokenHash) throw notFoundError("Link not found.");

  const { data: row } = await getSupabaseAdmin()
    .from("territory_preview_links")
    .select("*")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (!row) throw notFoundError("Link not found.");

  const link = row as Record<string, unknown>;
  if (link.revoked_at) throw forbiddenError("This link has been switched off.");
  if (new Date(str(link.expires_at)).getTime() < Date.now()) throw forbiddenError("This link has expired.");

  const frozen = Array.isArray(link.area_codes) ? (link.area_codes as unknown[]) : [];
  return {
    // Upper-cased once here so every comparison downstream is against one normalised set.
    areaCodes: new Set(frozen.map((code) => str(code).trim().toUpperCase()).filter(Boolean)),
    id: str(link.id),
    label: link.label ? str(link.label) : null,
    lineCode: str(link.line_code) || TERRITORY_PREVIEW_DEFAULT_LINE_CODE,
  };
}

/**
 * Record that someone looked. Wrapped whole in try/catch on purpose: this is bookkeeping, and a
 * broken counter must never turn a live link into a dead one. Guarding only the final write would
 * have left the read-then-increment lookup able to throw straight out of a legitimate open.
 */
async function stampAccess(linkId: string, countIt: boolean): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();
    const patch: Record<string, unknown> = { last_accessed_at: new Date().toISOString() };
    if (countIt) {
      const { data } = await supabase
        .from("territory_preview_links")
        .select("access_count")
        .eq("id", linkId)
        .maybeSingle();
      patch.access_count = Number((data as { access_count?: unknown } | null)?.access_count ?? 0) + 1;
    }
    await supabase.from("territory_preview_links").update(patch).eq("id", linkId);
  } catch {
    /* bookkeeping only — never deny a read because the counter failed */
  }
}

export type PreviewRegion = { areaCount: number; regionCode: string; regionName: string };
export type PreviewArea = { areaCode: string; areaName: string; regionCode: string };
export type PreviewFilters = { areas: PreviewArea[]; label: string | null; regions: PreviewRegion[] };

/**
 * The regions and areas this link may show — the first thing the public page asks for.
 *
 * Names are read live so a renamed area is not stale, but the SET is the frozen one: an area added
 * to the creator's scope after the link was sent does not appear in it.
 *
 * Counts as one open. Picking an area afterwards only stamps the timestamp, so "opens" stays a
 * count of people who looked rather than of clicks.
 */
export async function loadTerritoryPreviewFilters(token: string): Promise<PreviewFilters> {
  const link = await assertTerritoryPreviewToken(token);
  // No AccessContext: there is no caller to scope by. The frozen list below is what narrows this,
  // and it was itself produced by a scoped call at creation time.
  const filters = await loadTerritoryFilters(link.lineCode);
  const areas = filters.areas.filter((area) => link.areaCodes.has(area.areaCode.trim().toUpperCase()));

  const regionCounts = new Map<string, { areaCount: number; regionName: string }>();
  for (const area of areas) {
    if (!area.regionCode) continue;
    const current = regionCounts.get(area.regionCode);
    if (current) current.areaCount += 1;
    else regionCounts.set(area.regionCode, { areaCount: 1, regionName: area.regionName });
  }

  await stampAccess(link.id, true);

  return {
    areas: areas
      .map((area) => ({ areaCode: area.areaCode, areaName: area.areaName, regionCode: area.regionCode }))
      .sort((a, b) => a.areaName.localeCompare(b.areaName)),
    label: link.label,
    regions: [...regionCounts.entries()]
      .map(([regionCode, entry]) => ({ areaCount: entry.areaCount, regionCode, regionName: entry.regionName }))
      .sort((a, b) => a.regionName.localeCompare(b.regionName)),
  };
}

export type PreviewBrick = {
  blockCode: string;
  brickId: string;
  brickName: string;
  lat: number;
  lng: number;
};

export type PreviewAreaBricks = {
  areaCode: string;
  areaName: string;
  bricks: PreviewBrick[];
  /**
   * Bricks that belong to this area but have no trustworthy pin. Listed, never dropped: on a map an
   * unplotted brick is indistinguishable from one nobody covers, which would invent gaps that are
   * not real and hide ones that are. The internal REASON (never geocoded / wrong governorate /
   * shared town-centre pin) is deliberately not published — "no confirmed location" is the honest
   * part, the rest is our own data-quality bookkeeping.
   */
  unlocated: Array<{ brickId: string; brickName: string }>;
};

/**
 * One area's bricks. The area code is intersected against the frozen list BEFORE anything is read,
 * so a hand-typed code for a neighbouring territory returns "not found" rather than that
 * territory's geography.
 */
export async function loadTerritoryPreviewArea(token: string, areaCode: string): Promise<PreviewAreaBricks> {
  const link = await assertTerritoryPreviewToken(token);
  const requested = str(areaCode).trim();
  if (!requested || !link.areaCodes.has(requested.toUpperCase())) {
    throw notFoundError("Not found: that area is not part of this link.");
  }

  const map = await loadTerritoryMap({ areaCodes: [requested], lineCode: link.lineCode });
  await stampAccess(link.id, false);

  const area = map.areas.find((entry) => entry.areaCode === requested);
  // Project down to the pins. `map` also carries the residence recommendation, the mis-assignment
  // findings and the route/span/gap figures; returning the object wholesale would publish all of
  // that to an anonymous caller even though nothing renders it.
  return {
    areaCode: requested,
    areaName: area?.areaName ?? requested,
    bricks: map.bricks
      .filter((brick) => brick.areaCode === requested)
      .map((brick) => ({
        blockCode: brick.blockCode,
        brickId: brick.brickId,
        brickName: brick.brickName,
        lat: brick.lat,
        lng: brick.lng,
      }))
      .sort((a, b) => a.brickName.localeCompare(b.brickName)),
    unlocated: map.unlocated
      .filter((brick) => brick.areaCode === requested)
      .map((brick) => ({ brickId: brick.brickId, brickName: brick.brickName }))
      .sort((a, b) => a.brickName.localeCompare(b.brickName)),
  };
}
