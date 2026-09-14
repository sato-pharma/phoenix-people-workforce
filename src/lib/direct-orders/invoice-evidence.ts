/**
 * A distributor invoice as validation evidence for a new direct-order pharmacy.
 *
 * WHY IT EXISTS. Owner's instruction, 2026-09-14: a rep may validate a new pharmacy with the invoice
 * a distributor issued to it — no pin, no storefront photo, no licence — because an invoice is a
 * real distributor vouching for the shop. The price of skipping the field visit is a LIMIT: at most
 * {@link DIRECT_ORDER_INVOICE_SLOT_LIMIT} pharmacies per rep may stand on an invoice alone at once.
 * The rep frees a slot by validating one of them in the field with a live photo and location, and a
 * rejected invoice claim gives its slot back. A sixth is refused until a slot opens.
 *
 * LIKE THE LICENCE, NOT A LIVE CAPTURE. An invoice asserts nothing about place or time — it is a
 * document, and it arrives as a photo, a scan or a PDF. The camera and the file picker are both
 * offered, and the same three file types the licence takes are accepted, for the same reason: an
 * approver must be able to open it in a browser tab.
 */

/** Its own private bucket — never `direct-order-evidence`, whose JPEG-only allow-list is a guard. */
export const DIRECT_ORDER_INVOICE_BUCKET = "direct-order-invoices";

/** How many pharmacies one rep may hold on an invoice alone at the same time. Owner, 2026-09-14. */
export const DIRECT_ORDER_INVOICE_SLOT_LIMIT = 5;

/** A scanner's PDF or a phone photo of a printed invoice routinely clears the 2MB live-capture cap. */
export const DIRECT_ORDER_INVOICE_MAX_BYTES = 5 * 1024 * 1024;

export const DIRECT_ORDER_INVOICE_CONTENT_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;

export type DirectOrderInvoiceContentType = (typeof DIRECT_ORDER_INVOICE_CONTENT_TYPES)[number];

/** For the `accept` attribute of a file input, so the picker filters to what the server takes. */
export const DIRECT_ORDER_INVOICE_ACCEPT_ATTRIBUTE = DIRECT_ORDER_INVOICE_CONTENT_TYPES.join(",");

export type DirectOrderValidationRoute = "field" | "invoice";

export function isDirectOrderInvoiceContentType(value: unknown): value is DirectOrderInvoiceContentType {
  return (DIRECT_ORDER_INVOICE_CONTENT_TYPES as readonly string[]).includes(String(value ?? ""));
}

/** Anything that is not exactly `invoice` is the field route — every row written before this is one. */
export function normalizeDirectOrderValidationRoute(value: unknown): DirectOrderValidationRoute {
  return String(value ?? "").trim() === "invoice" ? "invoice" : "field";
}

const EXTENSION_BY_CONTENT_TYPE: Record<DirectOrderInvoiceContentType, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

export type ParsedDirectOrderInvoiceFile = {
  bytes: Buffer;
  contentType: DirectOrderInvoiceContentType;
  extension: string;
};

function refuse(message: string): never {
  throw new Error(message);
}

/**
 * Parse `data:<type>;base64,<payload>` into storable bytes. Thrown as a plain `Error`; the service
 * turns it into its own 400.
 *
 * Same structure as `parsePharmacyLicenseDataUrl`, and for the same reasons: no regex ever runs
 * across the payload (a greedy quantifier over megabytes exhausts V8's regexp stack), the header
 * quantifiers are bounded, the size is decided from the ENCODED length before anything is decoded,
 * and the charset is proven by re-encoding because Node's decoder silently skips junk.
 */
export function parseDirectOrderInvoiceDataUrl(dataUrl: unknown): ParsedDirectOrderInvoiceFile {
  const raw = typeof dataUrl === "string" ? dataUrl.trim() : "";
  if (!raw) refuse("Attach the distributor invoice.");

  const header = /^data:([a-z]{1,40}\/[a-z0-9.+-]{1,60});base64,/i.exec(raw);
  if (!header) refuse("The distributor invoice must be a photo or a PDF attached inside the app.");

  const contentType = String(header![1]).toLowerCase();
  if (!isDirectOrderInvoiceContentType(contentType)) {
    refuse("The distributor invoice must be a JPEG, a PNG, or a PDF.");
  }

  const payload = raw.slice(header![0].length).replace(/\s+/g, "");
  if (!payload) refuse("The distributor invoice file is empty. Attach it again.");

  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const encodedBytes = Math.floor((payload.length * 3) / 4) - padding;
  if (encodedBytes > DIRECT_ORDER_INVOICE_MAX_BYTES) {
    refuse("The distributor invoice file is too large. Attach a file under 5 MB.");
  }

  const bytes = Buffer.from(payload, "base64");
  if (bytes.length === 0) refuse("The distributor invoice file is empty. Attach it again.");

  const withoutPadding = (value: string) => value.replace(/=+$/, "");
  if (withoutPadding(bytes.toString("base64")) !== withoutPadding(payload)) {
    refuse("The distributor invoice must be a photo or a PDF attached inside the app.");
  }
  if (bytes.length > DIRECT_ORDER_INVOICE_MAX_BYTES) {
    refuse("The distributor invoice file is too large. Attach a file under 5 MB.");
  }

  const typed = contentType as DirectOrderInvoiceContentType;
  return { bytes, contentType: typed, extension: EXTENSION_BY_CONTENT_TYPE[typed] };
}

export type DirectOrderInvoiceSlotCount = { used: number; limit: number };

/** "2 of 5 pharmacies validated by invoice" — one wording for the rep, the desk and the approver. */
export function directOrderInvoiceSlotLabel(slots: DirectOrderInvoiceSlotCount): string {
  return `${slots.used} of ${slots.limit} ${slots.limit === 1 ? "pharmacy" : "pharmacies"} validated by invoice`;
}

/** The refusal a sixth invoice claim gets, and what the rep can do about it. */
export function directOrderInvoiceSlotsFullMessage(slots: DirectOrderInvoiceSlotCount): string {
  return (
    `You have ${slots.used} of ${slots.limit} pharmacies validated by invoice. ` +
    "Validate one of them with a live photo and location to free a slot, or validate this pharmacy with a live photo and location now."
  );
}
