import { createHmac, timingSafeEqual } from "node:crypto";

import type { AccessContext } from "@/lib/auth/permissions";
import { previousAuthSecret } from "@/lib/auth/previous-secret";

import type { ClosingExportFilter } from "./closing-export-payload";

/**
 * The seal on a Monthly Closing workbook's Export PDF links.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A LINK CARRIES ITS OWN PERMISSION. Owner, 2026-09-14: "any one who receive the closing can
 * export". Until then the PDF route admitted only a caller whose sales scope is company-wide — the
 * gate the workbook download itself passes — so a manager who was SENT the file opened it, read every
 * figure in it, clicked Export PDF and was told "This report covers the whole line"; and a reader whose
 * default browser was not signed in to Phoenix was told he had no permission at all. Refusing either
 * of them protected nothing: the PDF prints pages that are already in their hands.
 *
 * The gate could not simply be lowered, because the link is a URL and a URL can be edited. Admit any
 * reader on the query string alone and `line=Pedia` becomes `line=CNS`, a line he was never sent. So
 * the workbook export SEALS the selection it was built from — line, month and filters — and the PDF
 * route reads that selection OUT OF THE SEAL, never off the query string. Only two things still come
 * from the URL: which page (every page of the file is already his), and on the Rep Card which area
 * (the sheet's own dropdown appends it; the card is drawn from the sealed selection, so an area outside
 * that file finds no card).
 *
 * THE SEAL IS NOT PERMISSION TO SEE MORE THAN THE FILE. The detail rows are loaded through
 * `sealedReaderAccess` below: company-wide, like the file, but never revealing El Qema's source —
 * that rule is about who is LOOKING, and whoever downloaded the file is not the person looking now.
 *
 * NO EXPIRY, deliberately. A closing workbook is kept and forwarded for months, and the owner's rule is
 * about whoever receives it, not when. Rotating `PHOENIX_AUTH_SECRET` retires every seal at once —
 * after the grace window of `PHOENIX_AUTH_SECRET_PREVIOUS` (src/lib/auth/previous-secret.ts) ends.
 *
 * Stateless, like the payroll acknowledgment and the unsubscribe link: an HMAC under
 * `PHOENIX_AUTH_SECRET`. The signed text is prefixed with this purpose, so a signature minted for a
 * session or an unsubscribe link — same secret — can never be replayed as a seal. With no secret
 * nothing seals, the links go out bare, and the route keeps its company-wide gate.
 *
 * SHORT, because of Excel. The Rep Card's link is a `=HYPERLINK()` formula, whose string literal and
 * whose link are each capped at 255 characters. So the payload is a positional array rather than an
 * object and the signature is 128 bits of the HMAC — ample for a MAC, and the difference between a
 * link that fits and one Excel refuses.
 */

const PURPOSE = "phoenix.closing-pdf-link.v1";

/** 16 bytes of HMAC-SHA256 — 22 base64url characters. */
const SIGNATURE_BYTES = 16;

/** The Excel cap on a `=HYPERLINK()` link and on a formula's string literal. */
export const EXCEL_HYPERLINK_LIMIT = 255;

/** The PDF renderer every Export PDF link points at. */
export const CLOSING_PDF_PATH = "/api/sales/monthly-closing/premium-export/pdf";

export type SealedClosingSelection = {
  filter: ClosingExportFilter;
  /**
   * Whether the person who downloaded the workbook could see the Head Office line's detail rows (the
   * CEO or the Super Admin). Carried so the PDF shows what the file shows, and no more.
   */
  headOffice: boolean;
  line: string | null;
  period: string | null;
};

type SealPayload = [
  version: 1,
  line: string,
  period: string,
  regionCodes: string[],
  areaCodes: string[],
  productCodes: string[],
  search: string,
  headOffice: 0 | 1,
];

function signingSecret(): string | null {
  return process.env.PHOENIX_AUTH_SECRET?.trim() || null;
}

function sign(secret: string, encoded: string): Buffer {
  return createHmac("sha256", secret).update(`${PURPOSE}\n${encoded}`).digest().subarray(0, SIGNATURE_BYTES);
}

function signatureMatches(received: Buffer, expected: Buffer): boolean {
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Trimmed, blank-free, de-duplicated and SORTED, so one selection always seals to one text. */
function codes(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].sort();
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Seal the selection a workbook was built from. Null when there is no secret to sign with. */
export function sealClosingSelection(selection: SealedClosingSelection): string | null {
  const secret = signingSecret();
  if (!secret) return null;

  const payload: SealPayload = [
    1,
    selection.line ?? "",
    selection.period ?? "",
    codes(selection.filter.regionCodes),
    codes(selection.filter.areaCodes),
    codes(selection.filter.productCodes),
    selection.filter.search.trim(),
    selection.headOffice ? 1 : 0,
  ];
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(secret, encoded).toString("base64url")}`;
}

/**
 * The selection a seal carries, or null.
 *
 * Every no is the same no — a forged or truncated signature, an edited payload, a token signed for a
 * different purpose, a missing secret. The caller then treats the link as unsealed, which is exactly
 * the gate every link had before seals existed.
 */
export function openClosingSelectionSeal(
  token: string | null | undefined,
  now: Date = new Date(),
): SealedClosingSelection | null {
  const secret = signingSecret();
  if (!secret || !token) return null;

  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) return null;

  const received = Buffer.from(signature, "base64url");
  if (!signatureMatches(received, sign(secret, encoded))) {
    // A workbook sent before the secret rotation keeps its Export PDF links until the end date in
    // src/lib/auth/previous-secret.ts. A new seal is always signed with the current secret.
    const previous = previousAuthSecret(now);
    if (!previous || !signatureMatches(received, sign(previous, encoded))) return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(payload) || payload.length !== 8 || payload[0] !== 1) return null;

  const [, line, period, regionCodes, areaCodes, productCodes, search, headOffice] = payload as unknown[];
  if (typeof line !== "string" || typeof period !== "string" || typeof search !== "string") return null;
  if (!isStringList(regionCodes) || !isStringList(areaCodes) || !isStringList(productCodes)) return null;

  return {
    filter: { areaCodes, productCodes, regionCodes, search },
    headOffice: headOffice === 1,
    line: line || null,
    period: period || null,
  };
}

export type SealedPdfRequest = {
  /** The Rep Card's area — the LAST `area=`, because the sheet's formula appends it to the base. */
  cardArea: string;
  selection: SealedClosingSelection;
  sheet: string;
};

/**
 * A PDF request whose selection comes from its seal. Null when the link carries no valid seal.
 *
 * `line`, `period`, `region`, `product` and `search` on the query string are IGNORED here. The page
 * links still carry them so a URL reads as what it is, but reading them would be the whole hole.
 */
export function sealedPdfRequest(params: URLSearchParams): SealedPdfRequest | null {
  const selection = openClosingSelectionSeal(params.get("seal"));
  if (!selection) return null;

  const areas = params.getAll("area").map((value) => value.trim()).filter(Boolean);
  return {
    cardArea: areas[areas.length - 1] ?? "",
    selection,
    sheet: (params.get("sheet") ?? "Overview").trim(),
  };
}

/**
 * Who the detail rows of a sealed PDF are loaded as.
 *
 * The Super Admin reading his own link is himself, and sees El Qema's source as he always does.
 * Everyone else — signed in or not — reads as a company-wide viewer who is NOT the Super Admin, so the
 * El Qema mask applies (`canRevealClosingSource` tests the role and a `system` scope; this is neither).
 * The role only decides Head Office's detail rows, and it follows what the downloader could see.
 */
export function sealedReaderAccess(selection: SealedClosingSelection, reader: AccessContext): AccessContext {
  if (reader.source !== "guest" && reader.role === "Super Admin") return reader;
  return {
    hrId: null,
    loginId: null,
    role: selection.headOffice ? "CEO" : "Finance Manager",
    scope: "company",
    source: "system",
  };
}

/**
 * The Rep Card's sealed link base, or null when it would not fit Excel's cap.
 *
 * The base goes inside a formula string literal and the dropdown's area code is appended to it, so
 * both must stay under 255. Line and month are left off the URL — the seal carries them. A workbook
 * narrowed by so many filters that even this overflows gets the unsealed base instead: company-wide
 * readers keep their card, and nobody is handed a link Excel cannot hold.
 */
export function sealedRepCardPdfBase(origin: string, seal: string): string | null {
  const base = `${origin}${CLOSING_PDF_PATH}?${new URLSearchParams({ sheet: "Rep Card", seal }).toString()}`;
  // Room for `&area=` and a generous area code.
  return base.length + "&area=".length + 12 <= EXCEL_HYPERLINK_LIMIT ? base : null;
}
