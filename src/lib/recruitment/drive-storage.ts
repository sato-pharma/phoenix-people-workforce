// Recruitment / ATS — Google Drive storage adapter (dependency-free).
//
// Uploads/downloads via the Drive REST API with fetch. NO npm dependency. There are TWO ways to
// authenticate and the difference is not cosmetic — it decides who OWNS the uploaded file:
//
//   USER OAUTH (the live path)    GOOGLE_DRIVE_OAUTH_CLIENT_ID
//                                 GOOGLE_DRIVE_OAUTH_CLIENT_SECRET
//                                 GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN
//     Acts AS the owner's own Google account. Files are owned by him, count against his storage,
//     appear in his Drive, and he can move, rename, share or delete them himself.
//
//   SERVICE ACCOUNT (dormant)     GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY
//     Acts as a robot identity. Files are owned by the SERVICE ACCOUNT, which has no Drive storage
//     of its own — workable inside a Workspace Shared Drive, where the storage belongs to the drive,
//     and a dead end on a personal Gmail account, where there is no such drive to put them in.
//
// The recruitment Drive is a personal Gmail account (owner's decision, 2026-09-03), so user OAuth is
// the live path; the service account is kept, unchanged, for a future Workspace move. User OAuth is
// tried FIRST so that configuring it is enough to switch — nothing has to be removed.
//
// Both need:
//   GOOGLE_DRIVE_RECRUITMENT_FOLDER_ID - the Drive folder everything is filed under
//
// Files are served only through our permission-gated download route — never via
// public Drive sharing links.

import crypto from "node:crypto";

import { fetchWithTimeout, isOutboundTimeoutError } from "@/lib/http/fetch-with-timeout";
import type {
  DownloadedFile,
  RecruitmentFileStorageAdapter,
  StoredFile,
  UploadFileInput,
} from "@/lib/recruitment/file-storage";

type ServiceAccount = { clientEmail: string; privateKey: string };

function readServiceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { client_email?: string; private_key?: string };
    if (!parsed.client_email || !parsed.private_key) return null;
    return { clientEmail: parsed.client_email, privateKey: parsed.private_key.replace(/\\n/g, "\n") };
  } catch {
    return null;
  }
}

export function rootFolderId(): string | null {
  return process.env.GOOGLE_DRIVE_RECRUITMENT_FOLDER_ID ?? null;
}

type UserOAuth = { clientId: string; clientSecret: string; refreshToken: string };

/**
 * The owner's own Google identity, as a stored refresh token.
 *
 * All three parts or nothing: a half-configured OAuth client would otherwise fall through to the
 * service account and file CVs into an identity that cannot hold them, which fails at UPLOAD time
 * with a storage-quota error rather than at configuration time.
 */
function readUserOAuth(): UserOAuth | null {
  const clientId = (process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET ?? "").trim();
  const refreshToken = (process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN ?? "").trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

/**
 * Configured means an IDENTITY is configured. The root folder id is deliberately NOT required.
 *
 * Both paths request the `drive.file` scope, which grants access only to files this app itself
 * created — a folder the owner makes by hand in the Drive UI is INVISIBLE under it. So pinning a
 * hand-made folder id here would fail with a 404 that reads like a wrong id. Instead the app creates
 * its own root folder on first use and finds it again by name thereafter (see drive-tree.ts).
 * `GOOGLE_DRIVE_RECRUITMENT_FOLDER_ID` stays supported for pinning that id once it exists, and for a
 * future Workspace Shared Drive where the broader scope makes a hand-made folder reachable.
 */
export function isDriveConfigured(): boolean {
  return Boolean(readUserOAuth() || readServiceAccount());
}

/** Which identity Drive calls are being made as — for the health screen and the backfill's log. */
export function driveAuthMode(): "user_oauth" | "service_account" | "none" {
  if (readUserOAuth()) return "user_oauth";
  if (readServiceAccount()) return "service_account";
  return "none";
}

// Pure — exported for unit testing the claim shape.
export function buildDriveJwtClaim(clientEmail: string, nowSeconds: number) {
  return {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/drive.file",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signJwt(account: ServiceAccount, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify(buildDriveJwtClaim(account.clientEmail, nowSeconds)));
  const signingInput = `${header}.${claim}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(account.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

// Keyed by identity, not a bare single slot: switching from the service account to user OAuth (or
// back, for a Workspace move) must not serve a token minted for the OTHER identity out of the cache.
// That failure is silent and confusing — the call succeeds and the file lands in the wrong Drive.
let cachedToken: { mode: string; token: string; expiresAt: number } | null = null;

/** Shared body of both grants: post the form, read the token, cache it under this identity. */
async function exchangeForAccessToken(mode: string, body: URLSearchParams): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.mode === mode && cachedToken.expiresAt > now + 60) return cachedToken.token;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    // Google answers `invalid_grant` for a REVOKED or EXPIRED refresh token, which is the one failure
    // here that a person has to act on rather than a retry fixing — an OAuth client left in "Testing"
    // publishing status expires its refresh tokens after seven days. Named explicitly so the log says
    // what to do instead of "authentication failed".
    const detail = await res.text().catch(() => "");
    if (/invalid_grant/i.test(detail)) {
      throw new Error(
        "Google Drive refused the stored credentials (invalid_grant). The refresh token has been revoked or expired — re-authorise the Drive connection.",
      );
    }
    throw new Error("Google Drive authentication failed.");
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Google Drive token response was invalid.");
  cachedToken = { expiresAt: now + (data.expires_in ?? 3600), mode, token: data.access_token };
  return data.access_token;
}

async function getServiceAccountToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return exchangeForAccessToken(
    "service_account",
    new URLSearchParams({
      assertion: signJwt(account, now),
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    }),
  );
}

async function getUserOAuthToken(oauth: UserOAuth): Promise<string> {
  return exchangeForAccessToken(
    "user_oauth",
    new URLSearchParams({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
    }),
  );
}

/**
 * An access token for whichever identity is configured — user OAuth first.
 *
 * Exported because every Drive operation outside this file (creating the folder tree, moving a CV
 * when the applicant finally answers, the backfill) needs the SAME token and the same cache. A
 * second auth path would double the token traffic and, worse, could authenticate as a different
 * identity than the uploader.
 */
export async function getDriveAccessToken(): Promise<string> {
  const oauth = readUserOAuth();
  if (oauth) return getUserOAuthToken(oauth);
  const account = readServiceAccount();
  if (account) return getServiceAccountToken(account);
  throw new Error("Google Drive is not configured.");
}

/** Test seam: drop the cached token so a test can assert the identity switch above. */
export function resetDriveTokenCache(): void {
  cachedToken = null;
}

/**
 * One multipart upload into a named parent.
 *
 * Extracted from the adapter because the CV mirror uploads into a DEEP folder (the region/area tree)
 * while the storage adapter's own contract has no parent parameter. One implementation rather than
 * two: the multipart body assembly is fiddly enough that a second copy would drift.
 */
export async function driveMultipartUpload(input: {
  bytes: ArrayBuffer | Buffer;
  mimeType: string;
  name: string;
  parents: string[];
}): Promise<string> {
  const token = await getDriveAccessToken();
  const boundary = `phx${crypto.randomBytes(8).toString("hex")}`;
  const metadata = { name: input.name, parents: input.parents };
  const fileBytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(JSON.stringify(metadata)),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${input.mimeType || "application/octet-stream"}\r\n\r\n`),
    fileBytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    body: body as unknown as BodyInit,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    method: "POST",
    // A CV is ~333 KB on average and 985 KB at the 95th percentile (measured 2026-09-03), so this is
    // generous. It exists so a stalled upload cannot wedge the intake worker, which processes a
    // whole queue in one cron tick.
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // The characteristic failure of a SERVICE ACCOUNT on a personal Drive: the account has no
    // storage of its own, so the request authenticates fine and then cannot hold the file. Named,
    // because the fix is to change identity, not to retry.
    if (/storageQuotaExceeded/i.test(detail)) {
      throw new Error(
        "Google Drive refused the upload: the signed-in identity has no storage quota. A service account cannot own files on a personal Drive — configure the user OAuth credentials instead.",
      );
    }
    throw new Error("Google Drive upload failed.");
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error("Google Drive upload returned no file id.");
  return data.id;
}

/** A Drive read that ran out of time fails with the message of a refused read; anything else is unchanged. */
function asDriveFailure(message: string) {
  return (error: unknown): never => {
    throw isOutboundTimeoutError(error) ? new Error(message, { cause: error }) : error;
  };
}

export const googleDriveFileStorage: RecruitmentFileStorageAdapter = {
  id: "google-drive",
  supportsUpload: true,
  async uploadFile(input: UploadFileInput): Promise<StoredFile> {
    const folder = rootFolderId();
    if (!isDriveConfigured() || !folder) throw new Error("Google Drive is not configured.");
    const id = await driveMultipartUpload({
      bytes: input.bytes,
      mimeType: input.mimeType,
      name: input.fileName,
      parents: [folder],
    });
    return { driveFileId: id, externalUrl: null };
  },
  async downloadFile(driveFileId: string): Promise<DownloadedFile> {
    if (!isDriveConfigured()) throw new Error("Google Drive is not configured.");
    const token = await getDriveAccessToken();
    const id = encodeURIComponent(driveFileId);

    // Deadlines (REC-050): neither read had one, so a Drive that stalled held the CV download open
    // until the platform cut the request. A run-out throws the SAME error as Drive refusing the read,
    // so the person sees the failure they already see for a refusal, never a new one.
    // The name and type are one small answer; the file itself (a CV is ~1 MB at the 95th
    // percentile) is given a minute, half the upload's two.
    const metaRes = await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType`, {
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 15_000,
    }).catch(asDriveFailure("Google Drive metadata fetch failed."));
    if (!metaRes.ok) throw new Error("Google Drive metadata fetch failed.");
    const meta = (await metaRes.json()) as { name?: string; mimeType?: string };

    const mediaRes = await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 60_000,
    }).catch(asDriveFailure("Google Drive download failed."));
    if (!mediaRes.ok) throw new Error("Google Drive download failed.");
    const bytes = Buffer.from(await mediaRes.arrayBuffer());
    return { bytes, mimeType: meta.mimeType ?? "application/octet-stream", fileName: meta.name ?? "download" };
  },
};
