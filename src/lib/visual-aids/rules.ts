/**
 * Visual Aids — the pure half. No Supabase, no server-only import, so the portal navigation, the
 * client workspace and the tests can all read the same rules.
 *
 * Owner, 2026-09-18: the promotional flyers and visual aids a medical rep shows a doctor during a
 * visit live in Phoenix instead of on WhatsApp. The Marketing Manager, the Group Product Manager and
 * the Super Admin upload them against a product line; a rep — and his district, regional and
 * national sales managers — opens only the ACTIVE aids of his OWN line, full screen, on the tablet.
 * A flyer is never hard-deleted: retiring hides it from the field, replacing uploads a newer version
 * and retires the old one.
 */
import type { PhoenixRole } from "@/lib/auth/permissions";
import { isUuid } from "@/lib/http/uuid";
import { isHeadOfficeLine } from "@/lib/sales/confidential-products";
import { OFFICIAL_LINE_VALUES, resolveOfficialLineValue } from "@/lib/sales/official-lines";

/** The private bucket. Created by supabase/migrations/20260918152921_visual_aids.sql. */
export const VISUAL_AIDS_BUCKET = "visual-aids";

/** Matches `file_size_limit` on the bucket and the table's size check. */
export const VISUAL_AID_MAX_BYTES = 50 * 1024 * 1024;

/** A page count beyond this is not a visual aid; matches the table's check. */
export const VISUAL_AID_MAX_PAGES = 500;

export const VISUAL_AID_TITLE_MAX = 160;
export const VISUAL_AID_PRODUCT_MAX = 120;

export type VisualAidMimeType = "application/pdf" | "image/jpeg" | "image/png";

/** Matches `allowed_mime_types` on the bucket and the table's mime check. */
export const VISUAL_AID_MIME_TYPES: readonly VisualAidMimeType[] = ["application/pdf", "image/jpeg", "image/png"];

const EXTENSION_BY_MIME: Record<VisualAidMimeType, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

export type VisualAidStatus = "active" | "retired";

/**
 * The product lines a visual aid can belong to — DERIVED, never typed out: the official line values
 * the whole sales module uses, minus Head Office, which is not a product line and has no reps. The
 * migration's CHECK constraint spells the same three names, and a test pins the two lists equal.
 */
export const VISUAL_AID_LINES: readonly string[] = OFFICIAL_LINE_VALUES.filter((line) => !isHeadOfficeLine(line));

/** Canonical spelling of a typed line, or null when it is not one of the visual-aid lines. */
export function resolveVisualAidLine(value: string | null | undefined): string | null {
  const official = resolveOfficialLineValue(value);
  return official && VISUAL_AID_LINES.includes(official) ? official : null;
}

/**
 * The seats that upload, retire and replace. Mirrors the `visual_aids:create`/`update` grants in the
 * permission matrix; the routes assert the permission, this list only decides what the page draws.
 */
export const VISUAL_AIDS_MANAGER_ROLES: readonly PhoenixRole[] = [
  "Marketing Manager",
  "Group Product Manager",
  "Super Admin",
] as const;

/**
 * Who is offered the Visual Aids link in the EMPLOYEE PORTAL sidebar. The portal builds its own
 * sidebar from flags (src/lib/employee-portal/navigation.ts reads this list), so a seat missing here
 * has no door however complete its grant is — and a seat here without the grant would get a link the
 * page then refuses. tests/visual-aids.test.ts pins the list against the matrix in both directions.
 *
 * The field force (the rep and the three managers above him) plus the two portal-mode uploaders.
 * Spelled "District Manager" exactly: the bare Head-Office "Manager" rung holds no grant.
 * Super Admin is admin-mode and reaches /admin/visual-aids instead.
 */
export const VISUAL_AIDS_PORTAL_ROLES: readonly PhoenixRole[] = [
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Group Product Manager",
  "Marketing Manager",
] as const;

export class VisualAidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisualAidInputError";
  }
}

export class VisualAidNotFoundError extends Error {
  constructor(message = "That visual aid is not available.") {
    super(message);
    this.name = "VisualAidNotFoundError";
  }
}

/**
 * Which lines a reader may open, from the sales access scope's official line names.
 *
 *   · null (a company-wide viewer)  → every visual-aid line.
 *   · a set                          → those of its lines that are visual-aid lines, canonically spelt.
 *   · an EMPTY set, or a set holding only Head Office → nothing. A rep whose line did not resolve sees
 *     an explanation, never another line's flyers: failing closed is the only safe direction.
 */
export function visualAidLinesForReader(allowedLineNames: ReadonlySet<string> | null): string[] {
  if (allowedLineNames === null) return [...VISUAL_AID_LINES];
  const lines = new Set<string>();
  for (const name of allowedLineNames) {
    const line = resolveVisualAidLine(name);
    if (line) lines.add(line);
  }
  return VISUAL_AID_LINES.filter((line) => lines.has(line));
}

/** May this reader open this aid? Retired aids are for the managers' list only, never the field. */
export function canReaderOpenVisualAid(
  aid: { lineName: string; status: VisualAidStatus },
  readerLines: readonly string[],
): boolean {
  return aid.status === "active" && readerLines.includes(aid.lineName);
}

export type VisualAidDraft = {
  title: string;
  lineName: string;
  productName: string | null;
  pageCount: number | null;
};

/** Validate what the uploader typed. Every refusal is a sentence for the person who typed it. */
export function parseVisualAidDraft(input: {
  title?: unknown;
  lineName?: unknown;
  productName?: unknown;
  pageCount?: unknown;
}): VisualAidDraft {
  const title = typeof input.title === "string" ? input.title.trim().replace(/\s+/g, " ") : "";
  if (!title) throw new VisualAidInputError("Give the visual aid a title.");
  if (title.length > VISUAL_AID_TITLE_MAX) {
    throw new VisualAidInputError(`Keep the title under ${VISUAL_AID_TITLE_MAX} characters.`);
  }

  const lineName = resolveVisualAidLine(typeof input.lineName === "string" ? input.lineName : null);
  if (!lineName) throw new VisualAidInputError(`Choose the line: ${VISUAL_AID_LINES.join(", ")}.`);

  const rawProduct = typeof input.productName === "string" ? input.productName.trim().replace(/\s+/g, " ") : "";
  if (rawProduct.length > VISUAL_AID_PRODUCT_MAX) {
    throw new VisualAidInputError(`Keep the product name under ${VISUAL_AID_PRODUCT_MAX} characters.`);
  }

  let pageCount: number | null = null;
  if (input.pageCount !== undefined && input.pageCount !== null && input.pageCount !== "") {
    const parsed = Number(input.pageCount);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > VISUAL_AID_MAX_PAGES) {
      throw new VisualAidInputError("That file's page count could not be read. Choose the file again.");
    }
    pageCount = parsed;
  }

  return { title, lineName, productName: rawProduct || null, pageCount };
}

/** The declared type of a chosen file, or a refusal the uploader can act on. */
export function assertVisualAidFileAllowed(input: { contentType: string; size: number }): VisualAidMimeType {
  const contentType = input.contentType.trim().toLowerCase() as VisualAidMimeType;
  if (!VISUAL_AID_MIME_TYPES.includes(contentType)) {
    throw new VisualAidInputError("A visual aid must be a PDF, a JPG or a PNG file.");
  }
  if (!Number.isFinite(input.size) || input.size <= 0) {
    throw new VisualAidInputError("That file is empty. Choose the file again.");
  }
  if (input.size > VISUAL_AID_MAX_BYTES) {
    throw new VisualAidInputError("That file is larger than 50 MB. Export it at a lower resolution and upload it again.");
  }
  return contentType;
}

/**
 * The type the BYTES say they are, from their first bytes. The browser's declared type is only a
 * label; this is what decides, so a renamed file cannot reach a tablet as something it is not.
 */
export function sniffVisualAidMimeType(bytes: Uint8Array): VisualAidMimeType | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return "application/pdf"; // "%PDF-"
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  return null;
}

/** The folder-safe form of whoever is uploading — their HR id, else their login. */
export function visualAidUploaderKey(identity: string | null | undefined): string | null {
  const key = String(identity ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || null;
}

/**
 * Where an upload lands: `uploads/<uploader>/<random>.<ext>`. The server mints it, the browser puts
 * the file there with a one-time signed URL, and the create call hands it back — so the path names
 * its uploader, and `isOwnVisualAidUploadPath` refuses a path minted for anybody else.
 */
export function buildVisualAidUploadPath(input: {
  uploaderKey: string;
  mimeType: VisualAidMimeType;
  uploadId: string;
}): string {
  return `uploads/${input.uploaderKey}/${input.uploadId.toLowerCase()}.${EXTENSION_BY_MIME[input.mimeType]}`;
}

export function isOwnVisualAidUploadPath(path: string, uploaderKey: string | null): boolean {
  if (!uploaderKey) return false;
  const prefix = `uploads/${uploaderKey}/`;
  if (!path.startsWith(prefix)) return false;
  const match = /^([^/]+)\.(pdf|jpg|png)$/.exec(path.slice(prefix.length));
  if (!match) return false;
  const id = match[1];
  return id === id.toLowerCase() && isUuid(id);
}

/** The type a stored path was minted for, read off its extension. */
export function visualAidMimeTypeFromPath(path: string): VisualAidMimeType | null {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "pdf") return "application/pdf";
  if (extension === "jpg") return "image/jpeg";
  if (extension === "png") return "image/png";
  return null;
}
