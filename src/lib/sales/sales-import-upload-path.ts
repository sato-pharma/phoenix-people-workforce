import { createHash } from "node:crypto";

import { canonicalHrIdKey } from "@/lib/hr-id";

// The storage path of a large sales workbook, defined once. A workbook over ~4MB cannot be POSTed
// through a function, so the browser uploads it straight to the private `sales-imports` bucket through
// a signed URL from /api/sales/monthly-import/upload-url, then hands the path back to validate, detect,
// preview, commit or cancel, to the /sales/upload analyze and commit pair, or to weekly verify, validate
// and upload. Each of those reads the object with the service-role client and most then delete it, so
// a path is honoured only when it is an upload slot the server minted for the SAME caller: upload-url
// mints with buildSalesImportUploadPath, and every route checks isOwnSalesImportUploadPath before any
// storage call.
//
// Server-only: node:crypto must never reach a client bundle. Only app/api routes import this module.

export const SALES_IMPORT_UPLOAD_ROOT = "incoming";

// What a route answers, with a 400, for a storage path that is not the caller's own upload slot.
export const SALES_UPLOAD_PATH_REFUSAL = {
  code: "invalid_upload_path",
  error: "This file reference does not match your upload. Please upload the workbook again.",
} as const;

// The per-upload id is crypto.randomUUID(): lowercase hex in the 8-4-4-4-12 shape.
const uploadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The owner segment is a SHA-256 digest of the caller's identity, cut to 32 lowercase hex characters.
const ownerPattern = /^[0-9a-f]{32}$/;

export type SalesImportUploadCaller = {
  hrId?: string | null;
  loginId?: string | null;
};

/**
 * The owner segment of a caller's upload slots: a digest of the HR id, or of the login id for an
 * account that has no HR id. A digest, not the id itself, because squeezing an id into one path
 * segment is lossy (`a@b.com` and `a-b.com` would both become `a-b.com` and share slots), and a login
 * id is often an email address, which has no business in a storage key. Null for a caller with
 * neither: such a caller owns no slot at all, rather than one shared with every caller like it.
 */
export function salesImportUploadOwner(caller: SalesImportUploadCaller | null | undefined): string | null {
  const hrId = canonicalHrIdKey(caller?.hrId);
  const loginId = String(caller?.loginId ?? "").trim();
  const identity = hrId ? `hr:${hrId}` : loginId ? `login:${loginId}` : null;
  return identity ? createHash("sha256").update(identity).digest("hex").slice(0, 32) : null;
}

/** The workbook's name as one path segment: safe characters only, always ending .xlsx or .xls. */
export function sanitizeSalesImportFileName(name: unknown): string {
  const cleaned = String(name ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = cleaned || "upload.xlsx";
  return /\.(xlsx|xls)$/i.test(safe) ? safe : `${safe}.xlsx`;
}

/**
 * The storage path of one large-file upload slot: `incoming/<owner>/<upload id>/<file name>`.
 * upload-url mints exactly this, and no route accepts anything else. Null when the caller has no
 * identity to own the slot.
 */
export function buildSalesImportUploadPath(input: {
  caller: SalesImportUploadCaller | null | undefined;
  fileName: unknown;
  uploadId: string;
}): string | null {
  const owner = salesImportUploadOwner(input.caller);
  if (!owner || !uploadIdPattern.test(input.uploadId)) return null;
  return [SALES_IMPORT_UPLOAD_ROOT, owner, input.uploadId, sanitizeSalesImportFileName(input.fileName)].join("/");
}

/** The parts of an upload slot path, or null for any path that is not exactly one. */
export function parseSalesImportUploadPath(storagePath: string | null | undefined) {
  const segments = String(storagePath ?? "").split("/");
  if (segments.length !== 4) return null;
  const [root, owner, uploadId, fileName] = segments;
  if (root !== SALES_IMPORT_UPLOAD_ROOT || !ownerPattern.test(owner) || !uploadIdPattern.test(uploadId)) return null;
  // The name must be exactly what the sanitizer mints. "." and ".." are path steps, not names, so they
  // are refused outright as well.
  if (/^\.+$/.test(fileName) || sanitizeSalesImportFileName(fileName) !== fileName) return null;
  return { fileName, owner, uploadId };
}

/**
 * True only for an upload slot the server minted for THIS caller. Every route that takes a storage
 * path downloads the object with the service-role client, and most then delete it, so an unchecked
 * path let any importer read, and then erase, another importer's workbook. Check before any storage
 * call.
 */
export function isOwnSalesImportUploadPath(input: {
  caller: SalesImportUploadCaller | null | undefined;
  storagePath: string | null | undefined;
}): boolean {
  const parsed = parseSalesImportUploadPath(input.storagePath);
  const owner = salesImportUploadOwner(input.caller);
  return parsed !== null && owner !== null && parsed.owner === owner;
}
