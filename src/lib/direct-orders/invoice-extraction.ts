import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import {
  createOpenAiResponseText,
  hasOpenAiApiKey,
  OPENAI_ROUTE_BUDGET_MS,
} from "@/lib/ai/openai-client";
import { parseAiJson } from "@/lib/recruitment/cv-extraction";
import { searchDirectOrderPharmacyDirectory } from "@/lib/direct-orders/service";
import { listSourceOfSalesProducts } from "@/lib/sales/monthly-distributor-import";

// ─────────────────────────────────────────────────────────────────────────────
// Invoice-photo prefill (spec B5).
//
// Photograph the distributor invoice, and the order form fills itself in.
//
// THE RULE THIS MODULE IS BUILT AROUND: what comes back from the reader is a CLAIM, never a fact.
// Every code it reads is looked up again in master data before it is allowed anywhere near the
// form, and anything that does not resolve is NAMED rather than dropped.
//
// That is not defensive habit, it is the whole point. This module exists because reps typed
// pharmacy codes that did not exist — 12 phantom pharmacies, 509,736 EGP parked against them. A
// reader that confidently produced a plausible-looking code would industrialise exactly that
// failure: instead of one person mistyping, every invoice photo would mint fiction at speed. So a
// customer code the directory has never heard of prefills NOTHING, and says so in words.
//
// Invisible by rule (spec D4): every user-facing string here says the invoice was read. No "AI",
// no model name, no confidence score, no sparkle. The call is server-side so nothing in the
// browser betrays a model.
// ─────────────────────────────────────────────────────────────────────────────

/** ~8 MB of base64 is a generous phone photo; beyond that it is not an invoice. */
export const MAX_INVOICE_IMAGE_BYTES = 8 * 1024 * 1024;

const ALLOWED_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic"]);

export type InvoiceReadLine = {
  productCode: string | null;
  productName: string | null;
  qty: number | null;
  bonus: number | null;
};

export type InvoiceResolvedLine = {
  read: InvoiceReadLine;
  /** Non-null ONLY when the code or name matched a real product in the master list. */
  product: { productCode: string; productName: string; line: string | null } | null;
  /** Why this line could not be used, in words the submitter can act on. */
  problem: string | null;
};

export type InvoiceExtractionResult = {
  /** Verbatim from the reader — kept so the submitter can see what was on the paper. */
  read: {
    distributorCode: string | null;
    customerCode: string | null;
    customerName: string | null;
    invoiceDate: string | null;
    lines: InvoiceReadLine[];
  };
  /** Only ever populated from master data. A customer the directory does not know stays null. */
  resolved: {
    customer: {
      distributorCode: string | null;
      customerCode: string | null;
      customerName: string | null;
      areaCode: string | null;
      areaName: string;
    } | null;
    lines: InvoiceResolvedLine[];
  };
  /** Everything the submitter must fix by hand. Empty means the photo was fully usable. */
  problems: string[];
};

export class InvoiceExtractionError extends Error {
  code: "not_configured" | "unsupported_file" | "too_large" | "unreadable";

  constructor(code: InvoiceExtractionError["code"], message: string) {
    super(message);
    this.name = "InvoiceExtractionError";
    this.code = code;
  }
}

const INSTRUCTIONS =
  "You are reading a photographed pharmaceutical distributor invoice from Egypt. Invoices may be " +
  "in Arabic, English, or both, and are often photographed at an angle with glare. " +
  "Transcribe ONLY what is printed. Report the distributor's customer/account code for the " +
  "pharmacy, the pharmacy name as printed, the invoice date, and one entry per product line with " +
  "its code, name, ordered quantity and any bonus/free quantity. " +
  "If a value is missing, unreadable, or you are unsure, return null for it. " +
  "NEVER guess, complete, correct or infer a code — a wrong code is far worse than a null one, " +
  "because it will be treated as a real pharmacy. Do not invent lines that are not printed.";

const TEXT_FORMAT = {
  format: {
    name: "phoenix_direct_order_invoice",
    schema: {
      additionalProperties: false,
      properties: {
        customer_code: { type: ["string", "null"] as const },
        customer_name: { type: ["string", "null"] as const },
        distributor_code: { type: ["string", "null"] as const },
        invoice_date: { type: ["string", "null"] as const },
        lines: {
          items: {
            additionalProperties: false,
            properties: {
              bonus: { type: ["number", "null"] as const },
              product_code: { type: ["string", "null"] as const },
              product_name: { type: ["string", "null"] as const },
              qty: { type: ["number", "null"] as const },
            },
            required: ["product_code", "product_name", "qty", "bonus"],
            type: "object" as const,
          },
          type: "array" as const,
        },
      },
      required: ["customer_code", "customer_name", "distributor_code", "invoice_date", "lines"],
      type: "object" as const,
    },
    strict: true as const,
    type: "json_schema" as const,
  },
};

function text(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 && trimmed.toLowerCase() !== "null" ? trimmed : null;
}

/** A count off an invoice is a whole number of boxes. Anything else is a misread, not a quantity. */
function count(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const floored = Math.floor(n);
  return floored > 0 ? floored : n === 0 ? 0 : null;
}

/** Codes differ across sheets only by case and padding noise; compare them the way humans read them. */
function codeKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

/**
 * Read a photographed invoice and resolve everything it claims against master data.
 *
 * Permission is `direct_orders:create` — the same gate as submitting, because prefilling a form is
 * only useful to someone who may submit it, and the directory search this calls is itself
 * scope-limited to the caller's areas.
 */
export async function extractDirectOrderInvoice(
  access: AccessContext,
  input: { imageBase64: string; mimeType: string },
): Promise<InvoiceExtractionResult> {
  await assertPermission(access, "direct_orders", "create");

  const mimeType = String(input.mimeType ?? "").trim().toLowerCase();
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new InvoiceExtractionError(
      "unsupported_file",
      "Take a photo of the invoice, or attach a JPG or PNG of it. Other file types cannot be read.",
    );
  }

  const base64 = String(input.imageBase64 ?? "").trim();
  if (!base64) throw new InvoiceExtractionError("unreadable", "No invoice photo was received.");
  // Length of the base64 text, not the decoded size — checked before decoding so an oversized
  // payload is refused rather than buffered into memory first.
  if (base64.length > MAX_INVOICE_IMAGE_BYTES) {
    throw new InvoiceExtractionError("too_large", "That photo is too large. Take it again at normal quality.");
  }

  if (!hasOpenAiApiKey()) {
    // Says so plainly instead of returning an empty result that reads like "nothing on the invoice".
    throw new InvoiceExtractionError(
      "not_configured",
      "Reading invoices is not switched on for this environment. Fill the order in by hand.",
    );
  }

  const response = await createOpenAiResponseText({
    input: [
      {
        content: [
          { text: "Read this distributor invoice.", type: "input_text" as const },
          // "high" detail: an invoice is small dense print, and downsampling turns a 6 into an 8.
          { detail: "high" as const, image_url: `data:${mimeType};base64,${base64}`, type: "input_image" as const },
        ],
        role: "user" as const,
      },
    ],
    instructions: INSTRUCTIONS,
    maxOutputTokens: 2_048,
    purpose: "direct-orders-invoice-extraction",
    reasoning: { effort: "low" },
    text: TEXT_FORMAT,
    timeoutMs: OPENAI_ROUTE_BUDGET_MS,
  });

  const parsed = parseAiJson(response.outputText);
  const rawLines = Array.isArray(parsed.lines) ? (parsed.lines as Array<Record<string, unknown>>) : [];

  const read = {
    customerCode: text(parsed.customer_code),
    customerName: text(parsed.customer_name),
    distributorCode: text(parsed.distributor_code),
    invoiceDate: text(parsed.invoice_date),
    lines: rawLines.map((line): InvoiceReadLine => ({
      bonus: count(line.bonus),
      productCode: text(line.product_code),
      productName: text(line.product_name),
      qty: count(line.qty),
    })),
  };

  const problems: string[] = [];
  return {
    read,
    resolved: {
      customer: await resolveCustomer(access, read, problems),
      lines: await resolveLines(read.lines, problems),
    },
    problems,
  };
}

/**
 * A code off the paper only becomes a pharmacy if the DIRECTORY agrees it exists.
 *
 * Searching by the code and requiring an exact match back is the important part. A fuzzy name
 * search would happily return the nearest-looking pharmacy, and prefilling that is how an order
 * silently lands on the wrong customer — worse than no prefill, because it looks deliberate.
 */
async function resolveCustomer(
  access: AccessContext,
  read: InvoiceExtractionResult["read"],
  problems: string[],
): Promise<InvoiceExtractionResult["resolved"]["customer"]> {
  if (!read.customerCode) {
    problems.push("No customer code could be read from the invoice — choose the pharmacy yourself.");
    return null;
  }

  const hits = await searchDirectOrderPharmacyDirectory(access, {
    query: read.customerCode,
    distributorCode: read.distributorCode,
    limit: 20,
  });
  const exact = hits.find((hit) => codeKey(hit.customerCode) === codeKey(read.customerCode));

  if (!exact) {
    // Deliberately does NOT fall back to the closest name match. The whole module exists because a
    // code that does not exist was accepted once; a reader that quietly picks a neighbour would do
    // it at scale and with more conviction.
    problems.push(
      `Customer code ${read.customerCode} on this invoice is not in the master database` +
        `${read.customerName ? ` (printed as "${read.customerName}")` : ""}. ` +
        "Search for the pharmacy by name, or submit it for validation.",
    );
    return null;
  }

  return {
    areaCode: exact.areaCode,
    areaName: exact.areaName,
    customerCode: exact.customerCode,
    customerName: exact.customerName,
    distributorCode: exact.distributorCode,
  };
}

/**
 * Match each printed line to a real product. Code first, exact name second, nothing third.
 *
 * A line that cannot be matched is returned WITH its problem rather than filtered out. Dropping it
 * would make a five-line invoice silently arrive as four, and the submitter would have no way to
 * notice — this module already learned that lesson from the half-filled distributor row that used
 * to be discarded on submit while the screen claimed it could not be.
 */
async function resolveLines(lines: InvoiceReadLine[], problems: string[]): Promise<InvoiceResolvedLine[]> {
  if (lines.length === 0) {
    problems.push("No product lines could be read from this photo — check it is in focus and try again.");
    return [];
  }

  const products = await listSourceOfSalesProducts();
  const byCode = new Map(products.map((p) => [codeKey(p.productCode), p]));
  const byName = new Map(products.map((p) => [String(p.productName ?? "").trim().toLowerCase(), p]));

  return lines.map((read): InvoiceResolvedLine => {
    const match =
      (read.productCode ? byCode.get(codeKey(read.productCode)) : undefined) ??
      (read.productName ? byName.get(read.productName.trim().toLowerCase()) : undefined) ??
      null;

    if (!match) {
      const label = read.productName ?? read.productCode ?? "an unreadable line";
      const problem = `${label} is not a Phoenix product — pick the product yourself for this line.`;
      problems.push(problem);
      return { read, product: null, problem };
    }
    if (read.qty == null || read.qty <= 0) {
      const problem = `No quantity could be read for ${match.productName} — type it in.`;
      problems.push(problem);
      return {
        read,
        product: { line: match.line ?? null, productCode: match.productCode, productName: match.productName },
        problem,
      };
    }
    return {
      read,
      product: { line: match.line ?? null, productCode: match.productCode, productName: match.productName },
      problem: null,
    };
  });
}
