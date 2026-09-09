// The "weekly sales file uploaded" email (owner request, 2026-09-09).
//
// When SFE or a system administrator uploads a weekly sheet, the managers of every LINE whose
// products the sheet actually carries are told that their products have been read. His own example:
// a sheet holding Saginko, Royafloxacin and Tebofortin mails the Anti Infective managers and the CNS
// managers — and nobody else, because no other line appears in it.
//
// One email PER LINE, not one shared email:
//  • the recipients differ per line (each line's own DMs and NSM), and
//  • the product list is the one thing the email exists to carry, so it must be the reader's own
//    line's products. A CNS manager reading a list of Anti Infective products has learnt nothing.
//
// NO SALES FIGURES APPEAR IN THE BODY, on purpose. This is one shared email reaching every District
// Manager on a line at once, and a weekly sheet is national — so any quantity or value in it is
// wider than the region a DM is scoped to on every screen he can open. Product NAMES are what he
// was promised and are safe for the whole line; the numbers stay behind the portal, where each
// reader's own access scope applies. Same reasoning, same conclusion as
// closing-publish-notification.ts.
//
// Head Office never fires. It is not a line anyone manages — no DM seat, no NSM seat — and the
// owner's standing rule is that it is not tracked weekly at all, so a sheet carrying only Head
// Office products correctly sends nothing. isWeeklyTrackedLine is the single gate.

import { escapeEmailHtml, renderPhoenixMetadataTable, renderPhoenixMetadataTableText } from "@/emails/phoenix-email-layout";
import { sendTemplatedEmail } from "@/lib/email-templates/service";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import { isWeeklyTrackedLine } from "@/lib/sales/weekly/tracked-lines";
import { resolveWeeklyUploadLineRecipients } from "@/lib/sales/weekly/upload-notification-recipients";
import type { WeeklyProductSummary } from "@/lib/sales/weekly/types";

/** Same env-var convention the other sales notification modules use for their one CTA link. */
function appUrl(path: string) {
  const base = (process.env.NOTIFICATION_DASHBOARD_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
  if (!base) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export type WeeklyUploadLineSend = {
  line: string;
  sent: boolean;
  reason?: string;
  productNames: string[];
  toCount: number;
  ccCount: number;
  warnings: string[];
};

export type WeeklyUploadNotificationResult = {
  /** One entry per tracked line found in the sheet, in the order they were notified. */
  lines: WeeklyUploadLineSend[];
  /** Lines present in the sheet that are deliberately not notified (Head Office, IGNORE). */
  skippedUntrackedLines: string[];
};

type ProductRef = { productCode: string; productName: string };

/**
 * Group the sheet's products by line, tracked lines only, de-duplicated and name-sorted.
 * Pure — the whole "which lines does this sheet touch" decision is testable without a database.
 */
export function groupWeeklyProductsByTrackedLine(byProduct: WeeklyProductSummary[]): {
  byLine: Map<string, ProductRef[]>;
  skippedUntrackedLines: string[];
} {
  const byLine = new Map<string, ProductRef[]>();
  const seenPerLine = new Map<string, Set<string>>();
  const skipped = new Set<string>();

  for (const product of byProduct ?? []) {
    const line = String(product.officialLine ?? "").trim();
    const code = String(product.productCode ?? "").trim();
    const name = String(product.productName ?? "").trim() || code;
    if (!line || !code) continue;
    if (!isWeeklyTrackedLine(line)) {
      skipped.add(line);
      continue;
    }
    const seen = seenPerLine.get(line) ?? new Set<string>();
    if (seen.has(code.toUpperCase())) continue;
    seen.add(code.toUpperCase());
    seenPerLine.set(line, seen);
    const bucket = byLine.get(line) ?? [];
    bucket.push({ productCode: code, productName: name });
    byLine.set(line, bucket);
  }

  for (const bucket of byLine.values()) {
    bucket.sort((a, z) => a.productName.localeCompare(z.productName));
  }
  return { byLine, skippedUntrackedLines: [...skipped].sort() };
}

function weekLabel(weekStart: string | null, weekNumber: number | null): string {
  const parts: string[] = [];
  if (weekStart) parts.push(`week of ${formatPhoenixLongDate(weekStart)}`);
  if (weekNumber != null) parts.push(`week ${weekNumber}`);
  return parts.join(" · ") || "this week";
}

async function sendOneLine(input: {
  batchId: string;
  distributorName: string;
  line: string;
  products: ProductRef[];
  weekStart: string | null;
  weekNumber: number | null;
}): Promise<WeeklyUploadLineSend> {
  const { batchId, distributorName, line, products, weekStart, weekNumber } = input;
  const productNames = products.map((product) => product.productName);
  const { to, cc, warnings } = await resolveWeeklyUploadLineRecipients(line);

  // No active DM on the line — the NSM still gets told, as the To rather than a lone Cc, so the
  // line is never silently uninformed just because a district seat is vacant or its holder left.
  const primary = to.length > 0 ? to : cc;
  const secondary = to.length > 0 ? cc : [];
  if (primary.length === 0) {
    return { line, sent: false, reason: "No active District Manager or NSM resolved for this line.", productNames, toCount: 0, ccCount: 0, warnings };
  }

  const period = weekLabel(weekStart, weekNumber);
  const countLabel = `${products.length} ${line} product${products.length === 1 ? "" : "s"}`;
  const subject = `${line} — weekly sales uploaded (${distributorName}, ${period})`;
  const action = { href: appUrl("/employee-portals/weekly-sales"), label: "Open Weekly Sales" };

  // Product NAMES and codes only. One mail reaches every District Manager on the line off a
  // NATIONAL sheet, so a sales figure here would be wider than the region each reader is scoped
  // to everywhere else — pinned by tests/weekly-upload-line-notification.test.ts.
  const productListHtml =
    `<ul>${products
      .map((product) => `<li>${escapeEmailHtml(product.productName)} <span style="opacity:0.7">(${escapeEmailHtml(product.productCode)})</span></li>`)
      .join("")}</ul>`;
  const productListText = products.map((product) => `  - ${product.productName} (${product.productCode})`).join("\n");

  const metadataRows = [
    { label: "Line", value: line },
    { label: "Distributor", value: distributorName },
    { label: "Week", value: period },
    { label: "Products on your line", value: String(products.length) },
  ];

  // Wording lives in /admin/email-templates under "Weekly Sales Uploaded". Routing stays here —
  // who hears about an upload is decided by the line's organogram, not by recipient rules.
  const result = await sendTemplatedEmail({
    context: {
      ctaLabel: action.label,
      ctaUrl: action.href,
      detailsTable: renderPhoenixMetadataTable(metadataRows),
      detailsTableText: renderPhoenixMetadataTableText(metadataRows),
      distributorName,
      line,
      periodLabel: period,
      productCountLabel: countLabel,
      productList: productListHtml,
      productListText,
      subject,
    },
    fallbackTo: primary.map((recipient) => recipient.email),
    // The batch id is unique per persisted upload, so this is one send per line per upload.
    // Deleting a batch and re-uploading it mints a new id and legitimately notifies again.
    idempotencyKey: `weekly-upload:${batchId}:${line}`,
    origin: { eventType: "weekly_sales_uploaded", module: "sales" },
    overrides: {
      cc: secondary.map((recipient) => recipient.email),
      replaceRecipients: true,
      to: primary.map((recipient) => recipient.email),
    },
    templateKey: "weekly_sales_uploaded",
  });

  return {
    line,
    sent: !result.skipped,
    reason: result.skipped ? result.reason : undefined,
    productNames,
    toCount: primary.length,
    ccCount: secondary.length,
    warnings,
  };
}

/**
 * Tell each tracked line's District Managers and National Sales Manager that a weekly sheet
 * carrying their products has landed.
 *
 * Never throws. The upload has already persisted by the time this runs, so a notification failure
 * must never turn a stored batch into an error response — every per-line failure is captured in the
 * returned result and logged, and the caller ignores the outcome.
 */
export async function notifyWeeklyUploadLines(input: {
  batchId: string;
  distributorName: string;
  byProduct: WeeklyProductSummary[];
  weekStart: string | null;
  weekNumber: number | null;
}): Promise<WeeklyUploadNotificationResult> {
  const { byLine, skippedUntrackedLines } = groupWeeklyProductsByTrackedLine(input.byProduct);
  const lines: WeeklyUploadLineSend[] = [];

  for (const [line, products] of [...byLine.entries()].sort(([a], [z]) => a.localeCompare(z))) {
    try {
      lines.push(
        await sendOneLine({
          batchId: input.batchId,
          distributorName: input.distributorName,
          line,
          products,
          weekStart: input.weekStart,
          weekNumber: input.weekNumber,
        }),
      );
    } catch (error) {
      // One line failing must not stop the others being told.
      logError("weekly_upload_line_notification_failed", {
        error,
        labels: { event: "weekly_upload_line_notification_failed" },
        context: { batchId: input.batchId, line },
      });
      lines.push({
        line,
        sent: false,
        reason: error instanceof Error ? error.message : "unknown error",
        productNames: products.map((product) => product.productName),
        toCount: 0,
        ccCount: 0,
        warnings: [],
      });
    }
  }

  return { lines, skippedUntrackedLines };
}
