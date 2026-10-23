/**
 * What /api/errors/screen accepts — the body the browser's error screenshot arrives in, checked field
 * by field before anything is stored. Pure, so every refusal is pinned without a request or a bucket
 * (tests/user-error-screens.test.ts).
 *
 * The picture is a data URL of a JPEG (or WebP) whose DECODED bytes are at most 1.2 MB and whose first
 * bytes really are that format — a data URL that merely says `image/jpeg` is not trusted. Every string
 * is capped; paths keep their path and lose their query (a query can carry an id or a token).
 */

import { isScreenKind, pathWithoutQuery, type ScreenKind } from "@/lib/error-monitor/screen-capture-rules";

/** Where the pictures live: a private bucket, and one row each in the table (migration 20261023203000). */
export const USER_ERROR_SCREENS_BUCKET = "user-error-screens";
export const USER_ERROR_SCREENS_TABLE = "user_error_screens";
/** Kept this long, then removed by the nightly System Audit sweep (owner, 23 Oct 2026). */
export const USER_ERROR_SCREENS_RETENTION_DAYS = 90;

/** The decoded picture the route stores. The bucket itself refuses anything over 1.5 MB. */
export const SCREEN_IMAGE_MAX_BYTES = 1_200_000;
/** The whole request body: the picture in base64 (4/3 of 1.2 MB) plus the few small fields. */
export const SCREEN_BODY_MAX_BYTES = 1_700_000;
/** Pictures one person may store in any rolling hour, counted from the table. */
export const SCREEN_RATE_LIMIT_PER_HOUR = 40;
export const SCREEN_MESSAGE_CAP = 1_000;
export const SCREEN_PATH_CAP = 512;

export type ScreenImageType = "image/jpeg" | "image/webp";

export type ScreenReport = {
  kind: ScreenKind;
  httpStatus: number | null;
  method: string | null;
  apiPath: string | null;
  pagePath: string | null;
  message: string | null;
  width: number | null;
  height: number | null;
  image: { contentType: ScreenImageType; bytes: Uint8Array };
};

export type ScreenReportParse = { ok: true; report: ScreenReport } | { ok: false; message: string };

const DATA_URL = /^data:(image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/** Decoded size of a base64 body without decoding it. */
export function base64DecodedLength(body: string): number {
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isWebp(bytes: Uint8Array): boolean {
  const ascii = (from: number, to: number) => Array.from(bytes.subarray(from, to), (byte) => String.fromCharCode(byte)).join("");
  return bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
}

/** The picture from a data URL, or the reason it is refused. */
export function decodeScreenImage(dataUrl: unknown): { ok: true; contentType: ScreenImageType; bytes: Uint8Array } | { ok: false; message: string } {
  if (typeof dataUrl !== "string" || !dataUrl) return { ok: false, message: "The picture is missing." };
  // Checked on the text first, so an oversized body is refused before it is decoded.
  if (dataUrl.length > SCREEN_BODY_MAX_BYTES) return { ok: false, message: "The picture is larger than 1.2 MB." };
  const match = DATA_URL.exec(dataUrl);
  if (!match) return { ok: false, message: "The picture must be a JPEG or WebP data URL." };
  const contentType = match[1] as ScreenImageType;
  const declared = base64DecodedLength(match[2]);
  if (declared === 0) return { ok: false, message: "The picture is empty." };
  if (declared > SCREEN_IMAGE_MAX_BYTES) return { ok: false, message: "The picture is larger than 1.2 MB." };
  const bytes = new Uint8Array(Buffer.from(match[2], "base64"));
  if (bytes.length === 0 || bytes.length > SCREEN_IMAGE_MAX_BYTES) return { ok: false, message: "The picture is larger than 1.2 MB." };
  const real = contentType === "image/jpeg" ? isJpeg(bytes) : isWebp(bytes);
  if (!real) return { ok: false, message: `The picture is not really ${contentType === "image/jpeg" ? "a JPEG" : "a WebP image"}.` };
  return { ok: true, contentType, bytes };
}

function cappedText(value: unknown, cap: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > cap ? text.slice(0, cap) : text;
}

function cappedPath(value: unknown, mustStartWith: string): string | null {
  const path = pathWithoutQuery(cappedText(value, SCREEN_PATH_CAP * 4));
  if (!path || !path.startsWith(mustStartWith)) return null;
  return path.length > SCREEN_PATH_CAP ? path.slice(0, SCREEN_PATH_CAP) : path;
}

function dimension(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 20_000 ? value : null;
}

/** The body, checked. Anything not listed here is ignored; anything malformed in a listed field is refused or dropped. */
export function parseScreenReport(body: unknown): ScreenReportParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "The request body must be a JSON object." };
  const record = body as Record<string, unknown>;
  if (!isScreenKind(record.kind)) return { ok: false, message: "kind must be error_screen, refused_request or failed_request." };

  const status = record.status;
  let httpStatus: number | null = null;
  if (status !== null && status !== undefined) {
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
      return { ok: false, message: "status must be an HTTP status between 100 and 599." };
    }
    httpStatus = status;
  }
  if (record.kind === "refused_request" && (httpStatus === null || httpStatus < 400 || httpStatus > 499)) {
    return { ok: false, message: "A refused request carries its 4xx status." };
  }

  const image = decodeScreenImage(record.image);
  if (!image.ok) return { ok: false, message: image.message };

  const methodText = cappedText(record.method, 10)?.toUpperCase() ?? null;
  const method = methodText && /^[A-Z]{3,7}$/.test(methodText) ? methodText : null;
  const apiPath = cappedPath(record.apiPath, "/api/");
  if (record.kind !== "error_screen" && !apiPath) return { ok: false, message: "A refused or failed request names its /api/ path." };

  return {
    ok: true,
    report: {
      kind: record.kind,
      httpStatus,
      method,
      apiPath: record.kind === "error_screen" ? null : apiPath,
      pagePath: cappedPath(record.pagePath, "/"),
      message: cappedText(record.message, SCREEN_MESSAGE_CAP),
      width: dimension(record.width),
      height: dimension(record.height),
      image: { contentType: image.contentType, bytes: image.bytes },
    },
  };
}

/** Is a declared Content-Length over the body cap? A missing header is not (the read is capped too). */
export function screenBodyTooLarge(contentLength: string | null): boolean {
  const length = Number(contentLength);
  return Number.isFinite(length) && length > SCREEN_BODY_MAX_BYTES;
}

/** A storage-path-safe form of an HR id or login: letters, digits and dashes only. */
export function screenOwnerFolder(value: string | null | undefined): string {
  const cleaned = String(value ?? "").trim().replace(/[^A-Za-z0-9-]+/g, "_").slice(0, 60);
  return cleaned || "unknown";
}

/** `<cairo yyyy-mm-dd>/<owner>/<id>.<jpg|webp>` — the object's path in the bucket. */
export function screenStoragePath(input: { cairoDate: string; owner: string | null | undefined; id: string; contentType: ScreenImageType }): string {
  const extension = input.contentType === "image/webp" ? "webp" : "jpg";
  return `${input.cairoDate}/${screenOwnerFolder(input.owner)}/${input.id}.${extension}`;
}
