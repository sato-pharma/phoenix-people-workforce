// The INVOICE REFERENCE on a counted closing row — and the reason, named in words, when a feed
// does not carry one.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Every other field on a `ClosingDetailRow` has its own column in `source_of_sales_import_rows`.
// This one does not: no distributor agreed on a name for it, so the importer leaves it inside
// `raw_row` under whatever heading that supplier's own sheet used. Read on 2026-10-13, Anti
// Infective September: Overseas says `Invoice Serial`, EGD says `INVOICE_NO`, Ramco says `فاتورة`,
// EP-PHS says `inv_no`, a tender file says `Customer Reference`, and a direct order carries the
// request id under `requestId`.
//
// 🔴 IBN SINA'S FEED CARRIES NO REFERENCE AT ALL — not under another heading, not empty: the key is
// absent from every row (819 of Anti Infective September's 1,913 rows). That is a fact about the
// supplier's file, not a load failure, so the sheet says so in words rather than leaving the cell
// blank. A blank cell in an audit column reads as "we lost it".
//
// 🔴 THE KEYS ARE READ SERVER-SIDE, ONE EXTRACTION PER FEED, NEVER BY SHIPPING `raw_row`. The blob
// holds the whole imported line — twenty-odd columns of supplier text per row — and 21,000 of them
// is tens of megabytes across the wire for one string each. `->>` extracts in Postgres and sends
// only the string.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Each feed's own heading for the invoice reference, in the order they are tried.
 *
 * Order matters only where a sheet could carry two of these headings at once, which none does
 * today; it is kept stable so a row's reference cannot change spelling between two exports.
 */
export const INVOICE_REF_KEYS: readonly { alias: string; key: string }[] = [
  { alias: "invoice_ref_eg", key: "INVOICE_NO" },
  { alias: "invoice_ref_ps", key: "Invoice Serial" },
  { alias: "invoice_ref_rm", key: "فاتورة" },
  { alias: "invoice_ref_ep", key: "inv_no" },
  { alias: "invoice_ref_tender", key: "Customer Reference" },
  { alias: "invoice_ref_direct", key: "requestId" },
];

/**
 * The PostgREST `select` fragment that reads them, aliased so the mapper never touches `raw_row`.
 *
 * ⚠ A KEY WITH A SPACE IN IT HAS TO BE QUOTED — `raw_row->>"Invoice Serial"`. Unquoted, PostgREST
 * reads the space as the end of the column and the whole select fails, which takes the entire
 * details read down rather than one column (a select is one string: a bad fragment anywhere in it
 * fails every row). Pinned by `tests/closing-detail-invoice-ref.test.ts`.
 */
export const INVOICE_REF_SELECT: string = INVOICE_REF_KEYS
  .map(({ alias, key }) => `${alias}:raw_row->>${key.includes(" ") ? `"${key}"` : key}`)
  .join(",");

/** Trim to a string, or null — an empty reference is no reference. */
function reference(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** The first heading this row actually carries, or null when its feed supplies none. */
export function invoiceRefOf(raw: Record<string, unknown>): string | null {
  for (const { alias } of INVOICE_REF_KEYS) {
    const found = reference(raw[alias]);
    if (found !== null) return found;
  }
  return null;
}

/**
 * What the Invoice reference column says when there is no reference — never a blank cell.
 *
 * Three different absences, and a reader can act on each: an Office allocation row is not an
 * invoice at all (it is the Office channel's money spread across areas by the golden rule), a
 * direct order is identified by its request rather than by an invoice, and a distributor feed that
 * simply does not carry the column is the supplier's own omission.
 */
export function invoiceRefAbsence(input: {
  isDirect: boolean;
  isOfficeAllocation: boolean;
}): string {
  if (input.isOfficeAllocation) return "office allocation, not an invoice";
  if (input.isDirect) return "direct order, no invoice reference";
  return "not carried in this distributor's feed";
}
