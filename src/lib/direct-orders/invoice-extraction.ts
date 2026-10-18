import { writeAuditLog } from "@/lib/admin/audit";
import type { PreparedInvoice } from "@/lib/direct-orders/invoice-scan";
import { prepareInvoicePhoto } from "@/lib/direct-orders/invoice-scan";
import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import {
  createOpenAiResponseText,
  hasAiApiKey,
  OPENAI_ROUTE_BUDGET_MS,
} from "@/lib/ai/openai-client";
import { parseAiJson } from "@/lib/ai/parse-ai-json";
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

// An Egyptian distributor invoice is DENSE with long numbers, and only one identifies the pharmacy.
// A real PharmaOverseas page carries the barcode, the location code الكود المكاني, the sales order
// number رقم أمر البيع, the GLN, and the account number — five candidates for one field. A
// plausible WRONG one is the most damaging thing this reader can produce, because it resolves
// against master data as some OTHER real pharmacy and the order is filed against a customer who
// never placed it.
//
// Two corrections here, both paid for by real invoices rather than reasoning.
//
// The label was wrong. An earlier version of this rule named كود العميل and told the reader to
// return null if it could not find it — generalised from one photograph whose header was partly
// obscured. Four further invoices all print كود الحساب; اسم العميل is the NAME row. Naming a label
// that is not there, and refusing without it, is worse than the vague instruction it replaced.
//
// And the field is often a PAIR: "812702 / 1573334", a branch code and a customer code sharing one
// box. Across five invoices the left half matched nothing in master data and the right half matched
// exactly one pharmacy, every time. The reader is told to report the WHOLE printed value rather
// than choose — choosing is `codeCandidates`' job, where a wrong guess is recoverable and a
// unique-match rule can arbitrate. A reader that picks the wrong half looks certain.
//
// So the rule describes the FIELD (the distributor's account number for this pharmacy, in the
// customer header block) and lists labels as hints, not as the definition. The Ibnsina invoice —
// Latin product names, a different layout, neither Arabic label — is why.
const CUSTOMER_CODE_RULE =
  "The pharmacy's code is the distributor's ACCOUNT NUMBER for this pharmacy. It sits in the " +
  "customer header block, commonly labelled كود الحساب or كود العميل on an Arabic invoice and " +
  "'Customer' or 'Account' on a Latin one. It is frequently printed as TWO numbers separated by a " +
  "slash, for example '812702 / 1573334' — when it is, report the WHOLE printed value including " +
  "the slash and both numbers, exactly as printed, and do not choose between them. " +
  "Several other long numbers share the page and none of them is it: the barcode, the location " +
  "code الكود المكاني, the sales order number رقم أمر البيع, the invoice number, the tax number, " +
  "and the GLN. If no account number is printed, return null — do NOT substitute another number " +
  "from the page.";

const INSTRUCTIONS =
  "You are reading a photographed pharmaceutical distributor invoice from Egypt. Invoices may be " +
  "in Arabic, English, or both, and are often photographed at an angle with glare. " +
  "Transcribe ONLY what is printed. Report the distributor's customer code for the " +
  "pharmacy, the pharmacy name as printed, the invoice date, and one entry per product line with " +
  "its code, name, ordered quantity and any bonus/free quantity. " +
  CUSTOMER_CODE_RULE +
  " If a value is missing, unreadable, or you are unsure, return null for it. " +
  "NEVER guess, complete, correct or infer a code — a wrong code is far worse than a null one, " +
  "because it will be treated as a real pharmacy. Do not invent lines that are not printed.";

/**
 * Asked ONLY when the first pass came back with no customer code.
 *
 * Same photograph, narrower question. The first pass is transcribing an entire invoice — the header
 * block, every product line, dates and quantities — and the one field that matters most for
 * identifying the pharmacy is a single label in a corner. Asking again for just that field is the
 * cheapest thing that can rescue a read, and it costs nothing on the normal path because it only
 * runs when the answer was already null.
 */
const HEADER_ONLY_INSTRUCTIONS =
  "You are looking at a photographed Egyptian pharmaceutical distributor invoice. " +
  "Ignore the product table entirely. Read ONLY the customer/account header block — on a " +
  "right-to-left Arabic invoice this is the upper RIGHT corner, near اسم الحساب and اسم العميل. " +
  CUSTOMER_CODE_RULE +
  " Return the customer code and the pharmacy name as printed, and null for everything else.";

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
 * The same account number, written the two ways a distributor and an invoice each write it.
 *
 * Measured in production, 2026-08-06: SIX invoice reads, six codes read off the paper, and
 * ZERO resolved. The reader was never the problem. Two things stood between a correct read and
 * its pharmacy:
 *
 *   PADDING — `source_of_sales_customer_map` stores PharmaOverseas (`PS`) codes zero-padded to
 *   ten digits, 28,576 of 28,577 rows. The printed invoice carries `1573270`; the map holds
 *   `0001573270`. An exact compare rejects every PharmaOverseas invoice there is.
 *
 *   PAIRS — the header prints `812702 / 1573334`, a branch code and a customer code sharing one
 *   field. Across five real invoices the LEFT half matched nothing and the RIGHT half matched
 *   exactly one pharmacy, every time. Nothing here knew the value could be compound.
 *
 * So: try what is printed, then the same without its leading zeros, then each half of a
 * separated pair. Widest form last.
 */
export function codeCandidates(value: string | null | undefined): string[] {
  const raw = codeKey(value);
  if (!raw) return [];
  const out = [raw];
  const push = (candidate: string) => {
    const key = codeKey(candidate);
    // A bare run of zeros normalizes to the empty string, which would match nothing and cost a
    // lookup to find that out.
    if (key && !out.includes(key)) out.push(key);
  };
  const unpad = (candidate: string) => candidate.replace(/^0+(?=\d)/, "");
  // The loop below covers the un-separated case too — a string with no separator splits to itself,
  // and each part is pushed both as-is and unpadded. An explicit `push(unpad(raw))` above it was
  // redundant, and provably so: removing it changed no candidate list, which is exactly why
  // prove-it-fails could not make its assertion fire.
  //
  // `/` is what PharmaOverseas prints; the others cost nothing and cover the neighbours.
  for (const part of raw.split(/[/\-–—|\\]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    push(trimmed);
    push(unpad(trimmed));
  }
  return out;
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
  input: { imageBase64: string; mimeType: string; source?: "camera" | "upload" },
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

  if (!hasAiApiKey()) {
    // Says so plainly instead of returning an empty result that reads like "nothing on the invoice".
    throw new InvoiceExtractionError(
      "not_configured",
      "Reading invoices is not switched on for this environment. Fill the order in by hand.",
    );
  }

  // ── Make the photograph legible before anyone tries to read it ─────────────
  // The scanner-app step: orientation, tone and contrast, done on the SERVER because the image is
  // already here. A rep on mobile data downloads nothing and their phone does no work — which is
  // the only reason this is affordable at all.
  //
  // `prepareInvoicePhoto` cannot refuse: every failure path inside it returns the original bytes.
  // If it somehow throws anyway, this catch keeps that promise, because an enhancement that can
  // stop a readable invoice from being read is worse than no enhancement.
  const originalBytes = Buffer.from(base64, "base64");
  // Typed as PreparedInvoice rather than inferred from the literal: `Buffer.from` returns the
  // narrow `Buffer<ArrayBuffer>`, so an inferred shape rejects the wider `Buffer` the module
  // returns. Typecheck caught that; the test suite did not, because type-stripping never sees it.
  let scan: PreparedInvoice = {
    bytes: originalBytes,
    mimeType,
    prepared: false,
    originalBytes: originalBytes.length,
    preparedBytes: originalBytes.length,
  };
  try {
    scan = await prepareInvoicePhoto({ bytes: originalBytes, mimeType });
  } catch {
    // The original stands.
  }
  const readableBase64 = scan.prepared ? scan.bytes.toString("base64") : base64;
  const readableMimeType = scan.prepared ? scan.mimeType : mimeType;

  async function ask(instructions: string, prompt: string, purpose: string) {
    const response = await createOpenAiResponseText({
      input: [
        {
          content: [
            { text: prompt, type: "input_text" as const },
            // "high" detail: an invoice is small dense print, and downsampling turns a 6 into an 8.
            {
              detail: "high" as const,
              image_url: `data:${readableMimeType};base64,${readableBase64}`,
              type: "input_image" as const,
            },
          ],
          role: "user" as const,
        },
      ],
      instructions,
      maxOutputTokens: 2_048,
      purpose,
      reasoning: { effort: "low" },
      text: TEXT_FORMAT,
      timeoutMs: OPENAI_ROUTE_BUDGET_MS,
    });
    return parseAiJson(response.outputText);
  }

  const parsed = await ask(INSTRUCTIONS, "Read this distributor invoice.", "direct-orders-invoice-extraction");
  const rawLines = Array.isArray(parsed.lines) ? (parsed.lines as Array<Record<string, unknown>>) : [];

  // ── One focused retry, and only when the code is the thing that is missing ─
  // The first pass transcribes an entire invoice; the customer code is one label in one corner of
  // it, and it is the field that decides WHICH PHARMACY this order belongs to. When it comes back
  // null, asking again for just that field is the cheapest thing that can rescue the read.
  //
  // Three deliberate bounds. It fires ONLY on a miss, so the normal path pays nothing. It runs
  // EXACTLY once — a loop here would turn a dark photograph into a stack of identical calls and a
  // rep watching a spinner. And a failed retry is swallowed: the first read is still worth
  // returning, and a rescue attempt must never be the reason an otherwise usable read turns into
  // an error the submitter sees.
  let retried = false;
  let rescuedByRetry = false;
  if (text(parsed.customer_code) == null) {
    retried = true;
    try {
      const second = await ask(
        HEADER_ONLY_INSTRUCTIONS,
        "Read only the customer header block of this invoice.",
        "direct-orders-invoice-extraction-header",
      );
      const code = text(second.customer_code);
      if (code != null) {
        parsed.customer_code = code;
        // The name only rides along with a code. On its own it is a fuzzy string that resolves to
        // nothing, and carrying it without its code would put a pharmacy name on screen that
        // nothing downstream can act on.
        parsed.customer_name = text(second.customer_name) ?? parsed.customer_name;
        rescuedByRetry = true;
      }
    } catch {
      // Swallowed on purpose — see above. The first read stands.
    }
  }

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
  const resolved = {
    customer: await resolveCustomer(access, read, problems),
    lines: await resolveLines(read.lines, problems),
  };

  // ── How well did that actually go? ─────────────────────────────────────────
  // Recorded because the next decision about this feature — whether to preprocess the photograph
  // before reading it, which costs a multi-megabyte library on the phone of a rep paying for mobile
  // data — should be answered with counts rather than with an impression. Two numbers decide it:
  // how often a customer code comes off the paper at all, and how often the printed lines match
  // real products.
  //
  // `writeAuditLog` swallows its own failures by design, and this is deliberately the version that
  // does: a measurement must never be the reason a rep cannot read their invoice. Nothing here is
  // user-visible, so spec D4 is untouched.
  await writeAuditLog({
    actorLoginId: access.loginId ?? access.hrId ?? "unknown",
    entityType: "direct_order_request",
    entityId: "invoice-read",
    newValues: {
      codeRead: read.customerCode != null,
      codeResolved: resolved.customer != null,
      linesRead: read.lines.length,
      linesMatched: resolved.lines.filter((line) => line.product != null).length,
      qtyMissing: read.lines.filter((line) => line.qty == null).length,
      // The second pass costs a whole extra call on every miss. These two columns are what decide
      // whether it earns that — kept so it can be removed on evidence rather than defended on the
      // grounds that it sounds sensible.
      retried,
      rescuedByRetry,
      // The scanner step costs CPU on every single read. These decide whether it earns that:
      // if `prepared` is true and codeRead does not improve, it is doing nothing but spending.
      prepared: scan.prepared,
      bytesBefore: scan.originalBytes,
      bytesAfter: scan.preparedBytes,
      // Camera or gallery. Recorded, never acted on: if forwarded photos read worse, the answer is
      // better guidance, not refusing them — a rep whose invoice arrived on WhatsApp has no camera
      // shot to offer, and blocking that route sends them back to typing codes by hand.
      source: input.source ?? "upload",
    },
    summary:
      `Invoice read: customer code ${read.customerCode ? "read" : "not read"}` +
      `${rescuedByRetry ? " on the second pass" : retried ? " even on the second pass" : ""}` +
      `${read.customerCode && !resolved.customer ? " but not in master data" : ""}, ` +
      `${resolved.lines.filter((line) => line.product != null).length} of ${read.lines.length} lines matched.`,
  });

  return { read, resolved, problems };
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

  // Each candidate is SEARCHED, not merely filtered out of one result set. Filtering alone was the
  // trap: the directory search is a substring match, so a printed pair like "812702 / 1573334"
  // queries for that whole string, matches nothing, and leaves nothing to filter. The pair only
  // ever resolves if its halves are searched in their own right.
  //
  // Candidates run strongest-first — exactly what is printed, the same without leading zeros, then
  // each half of a pair — and the FIRST form that matches wins, so a genuine exact hit can never be
  // displaced by a looser reading of the same string.
  //
  // A form is accepted ONLY when it identifies exactly one pharmacy. That guard is load-bearing
  // rather than cautious: 89 codes in the customer map become ambiguous once leading zeros are
  // stripped, so taking "the first row that looks close" would file an order against the wrong real
  // pharmacy — the precise failure this module exists to stop, arriving with better handwriting.
  // Two candidates for one code is not a near miss; it is unanswerable from the paper alone, and
  // the submitter must be the one to pick.
  const unpad = (value: string) => value.replace(/^0+(?=\d)/, "");
  let exact: Awaited<ReturnType<typeof searchDirectOrderPharmacyDirectory>>[number] | undefined;
  let ambiguous: string | null = null;

  for (const candidate of codeCandidates(read.customerCode)) {
    const hits = await searchDirectOrderPharmacyDirectory(access, {
      query: candidate,
      distributorCode: read.distributorCode,
      limit: 20,
    });
    const matches = hits.filter(
      (hit) => codeKey(hit.customerCode) === candidate || unpad(codeKey(hit.customerCode)) === candidate,
    );
    if (matches.length === 1) {
      exact = matches[0];
      break;
    }
    if (matches.length > 1) {
      ambiguous = candidate;
      break;
    }
  }

  if (!exact && ambiguous) {
    problems.push(
      `Code ${read.customerCode} on this invoice matches more than one pharmacy in the master ` +
        "database, so Phoenix cannot tell which one it is. Pick the pharmacy from the list yourself.",
    );
    return null;
  }

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
