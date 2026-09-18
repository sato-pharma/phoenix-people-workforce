// A saved customer mapping's name and address, as sos_customer_map_fill_blanks takes them.
//
// Until 2026-09-18 a customer mapping was saved as the key and the brick only - every mapping made on
// the normalizer, by Auto-map or from the upload screen landed nameless (2,484 normalizer rows and 69
// Auto-map rows that day), and the free steps, which learn from a mapping's name and address, could
// not learn from any of them. saveMappings (mapping.ts) now sends each saved mapping's sheet name and
// address to that function, which writes them into BLANK fields only.

export type CustomerDetailRow = { address: string | null; customer_code: string; customer_name: string | null; distributor_code: string };

/** Null when the sheet carried neither a name nor an address, so nothing is sent. */
export function customerDetailRow(distributorCode: string, customerCode: string, name: unknown, address: unknown): CustomerDetailRow | null {
  const clean = (value: unknown) => (typeof value === "string" ? value.trim() : "") || null;
  const customerName = clean(name);
  const customerAddress = clean(address);
  if (!customerName && !customerAddress) return null;
  return { address: customerAddress, customer_code: customerCode, customer_name: customerName, distributor_code: distributorCode };
}
