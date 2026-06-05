// Recruitment / ATS — Google Drive storage adapter (dependency-free).
//
// Authenticates as a Google service account by signing a JWT with node:crypto and
// exchanging it for an access token, then uploads/downloads via the Drive REST
// API with fetch. NO npm dependency. Activates only when both env vars are set:
//   GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY  - the service-account JSON key (stringified)
//   GOOGLE_DRIVE_RECRUITMENT_FOLDER_ID - a Drive folder shared with that account
// Files are served only through our permission-gated download route — never via
// public Drive sharing links.

import crypto from "node:crypto";

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

function rootFolderId(): string | null {
  return process.env.GOOGLE_DRIVE_RECRUITMENT_FOLDER_ID ?? null;
}

export function isDriveConfigured(): boolean {
  return Boolean(readServiceAccount() && rootFolderId());
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

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.token;
  const assertion = signJwt(account, now);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error("Google Drive authentication failed.");
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Google Drive token response was invalid.");
  cachedToken = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) };
  return data.access_token;
}

export const googleDriveFileStorage: RecruitmentFileStorageAdapter = {
  id: "google-drive",
  supportsUpload: true,
  async uploadFile(input: UploadFileInput): Promise<StoredFile> {
    const account = readServiceAccount();
    const folder = rootFolderId();
    if (!account || !folder) throw new Error("Google Drive is not configured.");
    const token = await getAccessToken(account);

    const boundary = `phx${crypto.randomBytes(8).toString("hex")}`;
    const metadata = { name: input.fileName, parents: [folder] };
    const fileBytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
      Buffer.from(JSON.stringify(metadata)),
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${input.mimeType || "application/octet-stream"}\r\n\r\n`),
      fileBytes,
      Buffer.from(`\r\n--${boundary}--`),
    ]);

    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body: body as unknown as BodyInit,
    });
    if (!res.ok) throw new Error("Google Drive upload failed.");
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error("Google Drive upload returned no file id.");
    return { driveFileId: data.id, externalUrl: null };
  },
  async downloadFile(driveFileId: string): Promise<DownloadedFile> {
    const account = readServiceAccount();
    if (!account) throw new Error("Google Drive is not configured.");
    const token = await getAccessToken(account);
    const id = encodeURIComponent(driveFileId);

    const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) throw new Error("Google Drive metadata fetch failed.");
    const meta = (await metaRes.json()) as { name?: string; mimeType?: string };

    const mediaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!mediaRes.ok) throw new Error("Google Drive download failed.");
    const bytes = Buffer.from(await mediaRes.arrayBuffer());
    return { bytes, mimeType: meta.mimeType ?? "application/octet-stream", fileName: meta.name ?? "download" };
  },
};
