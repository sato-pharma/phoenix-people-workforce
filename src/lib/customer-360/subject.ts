/**
 * Who a Customer 360 page is ABOUT.
 *
 * A pharmacy is recorded twice in this system and there is no master record joining the two:
 * `marketing_pharmacies` holds the ones marketing spends on, `direct_order_pharmacies` holds the
 * ones the direct-order desk sells to. Pharmacy Master (`/admin/pharmacy-master`) deliberately only
 * SUGGESTS that two rows are the same physical place — it merges nothing, creates nothing. So there
 * is no company-wide pharmacy id to key this page on, and inventing one here would quietly become
 * the master record that page refuses to be.
 *
 * The subject id therefore names the register it came from: `mkt_<uuid>` or `dor_<uuid>`. It is
 * honest about which book the row lives in, it round-trips through a URL, and it cannot silently
 * merge two pharmacies that a human has never confirmed are one.
 *
 * The two registers still MEET, just not by identity: they meet on the distributor code pair, which
 * is the same key `src/lib/sales/customer-geography.ts` resolves territory with. Measured on
 * production 2026-09-03: 313 marketing pairs and 54 direct-order pairs, of which exactly **3** are
 * the same pair in both books. A page that required a pharmacy to be in both would show 3 rows —
 * which is why the subject is one register's row, with the other register shown as a cross-link
 * when the pair matches.
 */

export type CustomerRegister = "marketing" | "direct-order";

export type CustomerSubjectId = `mkt_${string}` | `dor_${string}`;

export type CustomerSubjectRef = {
  readonly recordId: string;
  readonly register: CustomerRegister;
};

const PREFIX_BY_REGISTER: Record<CustomerRegister, string> = {
  "direct-order": "dor_",
  marketing: "mkt_",
};

/**
 * A UUID, and nothing that merely contains one.
 *
 * The subject id lands in a route segment, so it is attacker-supplied text. Anchoring the pattern
 * means a decoded `recordId` is always safe to hand to a `.eq()` — there is no path where a caller
 * receives a half-parsed id and builds a query out of it.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCustomerSubjectId(ref: CustomerSubjectRef): CustomerSubjectId {
  return `${PREFIX_BY_REGISTER[ref.register]}${ref.recordId}` as CustomerSubjectId;
}

/**
 * Decode a route segment back to a register and a record id, or null if it is not one of ours.
 *
 * Returning null rather than throwing is deliberate: the caller is a page rendering an arbitrary
 * URL, and "no such customer" is a page state, not an exception.
 */
export function decodeCustomerSubjectId(raw: string | null | undefined): CustomerSubjectRef | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  for (const register of Object.keys(PREFIX_BY_REGISTER) as CustomerRegister[]) {
    const prefix = PREFIX_BY_REGISTER[register];
    if (!value.startsWith(prefix)) continue;
    const recordId = value.slice(prefix.length);
    if (!UUID.test(recordId)) return null;
    return { recordId, register };
  }
  return null;
}

/** How the register is named on screen. Never show the raw prefix to a human. */
export function customerRegisterLabel(register: CustomerRegister): string {
  return register === "marketing" ? "Marketing" : "Direct orders";
}
