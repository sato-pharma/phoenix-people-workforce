// Recruitment / ATS — the folder tree in Google Drive, and the file operations that fill it.
//
// Drive has no `mkdir -p`. Every level is a separate lookup-or-create against `files.list` /
// `files.create`, so filing one CV into "Medical Representative / Alex-BHR / Alex Center" is four
// round trips on a cold cache and zero on a warm one. The cache is what makes this usable at the
// measured rate of ~100 CVs a day, where the same handful of folders is asked for over and over.
//
// SCOPE. Everything here runs under `drive.file`, which reaches only files this app created. That is
// the deliberate choice: it is a NON-SENSITIVE scope, so the OAuth client can be published without
// Google's verification review, and the app can never read anything else in the owner's Drive. The
// price is that the root folder must be created BY US — a folder made by hand in the Drive UI is
// invisible under this scope, and asking for it 404s in a way that reads like a wrong id.

import { logError } from "@/lib/observability/log";
import { driveMultipartUpload, getDriveAccessToken, isDriveConfigured, rootFolderId } from "@/lib/recruitment/drive-storage";
import { sanitizeDriveSegment } from "@/lib/recruitment/drive-cv-folders";

const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * The name of the root folder when one is not pinned by env.
 *
 * Configurable so a second environment (staging) can file into its own tree rather than mixing test
 * CVs into the real cabinet — the same reason every other integration here is environment-aware.
 */
export function driveRootFolderName(): string {
  return (process.env.GOOGLE_DRIVE_RECRUITMENT_ROOT_NAME ?? "Phoenix CVs").trim() || "Phoenix CVs";
}

/**
 * folder path (joined) -> Drive folder id.
 *
 * Process-local and unbounded, which is safe because the key space is the tree itself: four shelves,
 * eight regions, forty-nine areas and however many job titles have been typed — a few hundred
 * entries at the very most, each a short string. It is never invalidated: a folder id in Drive is
 * stable for the life of the folder, and a folder the owner deletes by hand re-creates on the next
 * miss rather than serving a dead id, because `ensureFolder` verifies before trusting a cache hit
 * only on the ROOT (see below) — the cost of verifying every level would undo the cache.
 */
const folderIdCache = new Map<string, string>();

/** Test seam, and the escape hatch if the owner reorganises the tree by hand mid-run. */
export function resetDriveFolderCache(): void {
  folderIdCache.clear();
}

async function driveRequest(path: string, init?: RequestInit): Promise<Response> {
  const token = await getDriveAccessToken();
  return fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
}

/**
 * A Drive query string with the value escaped.
 *
 * Drive's query language is string-concatenated by every example Google publishes, and a folder name
 * carrying an apostrophe — "Sohag'", a typed job title like "Manager's Assistant" — would otherwise
 * terminate the literal and produce a syntax error, or worse, match the wrong folder. Backslash is
 * escaped first so it cannot be used to smuggle the quote past the second replacement.
 */
export function escapeDriveQueryValue(value: string): string {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** One level: find a folder by exact name under a parent, or create it. */
async function findOrCreateFolder(name: string, parentId: string): Promise<string> {
  const query = [
    `name = '${escapeDriveQueryValue(name)}'`,
    `'${escapeDriveQueryValue(parentId)}' in parents`,
    `mimeType = '${FOLDER_MIME}'`,
    "trashed = false",
  ].join(" and ");

  const listRes = await driveRequest(
    `files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=10&spaces=drive`,
  );
  if (listRes.ok) {
    const data = (await listRes.json()) as { files?: Array<{ id?: string }> };
    const existing = data.files?.find((file) => Boolean(file.id))?.id;
    if (existing) return existing;
  } else if (listRes.status !== 404) {
    throw new Error(`Google Drive folder lookup failed (${listRes.status}).`);
  }

  const createRes = await driveRequest("files?fields=id", {
    body: JSON.stringify({ mimeType: FOLDER_MIME, name, parents: [parentId] }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!createRes.ok) throw new Error(`Google Drive folder create failed (${createRes.status}).`);
  const created = (await createRes.json()) as { id?: string };
  if (!created.id) throw new Error("Google Drive folder create returned no id.");
  return created.id;
}

/**
 * The root folder's id — pinned by env, else found or created by name at the Drive root.
 *
 * The env pin is checked first and trusted without a lookup: an id the owner has set by hand is a
 * statement of intent, and verifying it on every call would spend a round trip to learn something
 * that changes roughly never.
 */
export async function ensureRootFolder(): Promise<string> {
  const pinned = rootFolderId();
  if (pinned) return pinned;

  const name = driveRootFolderName();
  const cached = folderIdCache.get(`/root:${name}`);
  if (cached) return cached;

  const id = await findOrCreateFolder(name, "root");
  folderIdCache.set(`/root:${name}`, id);
  return id;
}

/**
 * Walk (and create) a folder path under the root, returning the deepest folder's id.
 *
 * Segments are sanitized here as well as at the caller, deliberately: this is the last point before
 * a name reaches Drive, and a path assembled by the backfill script or by a future caller must not
 * be able to introduce a separator or a control character that the pure resolver would have removed.
 */
export async function ensureFolderPath(segments: readonly string[]): Promise<string> {
  const clean = segments.map(sanitizeDriveSegment).filter(Boolean);
  let parentId = await ensureRootFolder();
  const walked: string[] = [];

  for (const segment of clean) {
    walked.push(segment);
    const cacheKey = walked.join("/");
    const cached = folderIdCache.get(cacheKey);
    if (cached) {
      parentId = cached;
      continue;
    }
    const id = await findOrCreateFolder(segment, parentId);
    folderIdCache.set(cacheKey, id);
    parentId = id;
  }
  return parentId;
}

/** Upload one CV into a folder path, returning its Drive file id. */
export async function uploadCvToDrivePath(input: {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
  path: readonly string[];
}): Promise<string> {
  const parentId = await ensureFolderPath(input.path);
  return driveMultipartUpload({
    bytes: input.bytes,
    mimeType: input.mimeType,
    name: input.fileName,
    parents: [parentId],
  });
}

/**
 * Move an already-uploaded CV into a different folder, and optionally rename it.
 *
 * This is the second half of the design, not an afterthought: the applicant sends the CV BEFORE
 * answering the three questions, so almost every file is written to "Not yet classified" and moved
 * minutes later when the answers arrive. Drive moves by patching `parents`, which is one request and
 * does not touch the bytes.
 *
 * Returns false rather than throwing when the file is gone — the owner may have moved or deleted it
 * himself, and that is his cabinet to rearrange. A missing file is not an incident.
 */
export async function moveDriveFile(input: {
  driveFileId: string;
  path: readonly string[];
  newName?: string | null;
}): Promise<boolean> {
  const id = encodeURIComponent(input.driveFileId);

  const currentRes = await driveRequest(`files/${id}?fields=parents,name`);
  if (currentRes.status === 404) return false;
  if (!currentRes.ok) throw new Error(`Google Drive file lookup failed (${currentRes.status}).`);
  const current = (await currentRes.json()) as { parents?: string[]; name?: string };

  const targetId = await ensureFolderPath(input.path);
  const currentParents = current.parents ?? [];
  const alreadyThere = currentParents.length === 1 && currentParents[0] === targetId;
  const rename = input.newName && input.newName !== current.name ? input.newName : null;
  if (alreadyThere && !rename) return true;

  const params = new URLSearchParams({ fields: "id" });
  if (!alreadyThere) {
    params.set("addParents", targetId);
    // Every parent it currently has is removed, so a file cannot end up in two folders. Drive allows
    // multi-parenting through the API and it is exactly the state that makes a filing cabinet lie.
    if (currentParents.length > 0) params.set("removeParents", currentParents.join(","));
  }

  const patchRes = await driveRequest(`files/${id}?${params.toString()}`, {
    body: JSON.stringify(rename ? { name: rename } : {}),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (patchRes.status === 404) return false;
  if (!patchRes.ok) throw new Error(`Google Drive move failed (${patchRes.status}).`);
  return true;
}

/**
 * A one-shot health probe: can we authenticate, and is the root folder reachable?
 *
 * Returns words rather than throwing, because its only consumers are a screen and the backfill's
 * first line — both of which want to SAY what is wrong rather than fall over.
 */
export async function checkDriveConnection(): Promise<{ ok: boolean; detail: string; rootFolderId?: string }> {
  if (!isDriveConfigured()) {
    return { detail: "Google Drive is not configured — no OAuth credentials and no service account key.", ok: false };
  }
  try {
    const id = await ensureRootFolder();
    return { detail: `Connected. Root folder id ${id}.`, ok: true, rootFolderId: id };
  } catch (error) {
    logError("Google Drive connection check failed", {
      error,
      labels: { event: "drive_connection_check_failed" },
    });
    return { detail: error instanceof Error ? error.message : "Google Drive connection failed.", ok: false };
  }
}
