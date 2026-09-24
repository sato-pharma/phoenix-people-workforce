// Verified Captures — the row shapes shared by the server loaders and the client workspace.
//
// Deliberately free of any server import so the `"use client"` gallery can import these types
// directly. Everything here is a plain value already resolved on the server: names not codes,
// signed photo URLs ready to render, times as raw ISO strings the client formats to Cairo.

/**
 * A captured location, kept BOTH raw and broken into its parts (owner ask, 2026-09-25: "make the
 * customer location raw as it is and also separate it to brick, area, gov, clean address").
 *
 * `rawLocation` is the location exactly as it was captured in the field, unedited — the owner's "raw
 * as it is". The remaining fields are that same location resolved into its pieces: the clean street
 * `address`, and the `brick` / `area` / `governorate` it falls in. Any part may be missing.
 */
export type VerifiedCaptureLocation = {
  latitude: number | null;
  longitude: number | null;
  /** The clean street address — the readable line with any brick/area/region tags stripped off. */
  address: string | null;
  /** The location exactly as captured, unedited. Never a bare code (owner rule: names, never codes). */
  rawLocation: string | null;
  /** The brick the capture falls in, by name. */
  brick: string | null;
  /** The area the capture falls in, by name. */
  area: string | null;
  /** The sales region the capture falls in, by name (when the capture carried one). */
  region: string | null;
  /** The governorate the capture falls in, by name. */
  governorate: string | null;
};

/**
 * One distributor code on file for a captured pharmacy, and whether our database recognises it.
 *
 * The owner asked to see the distributor ("DISTB") and the pharmacy's code at it, and to be told
 * "available in our database or no". `inDatabase` is exactly that: true when the pharmacy's customer
 * code at that distributor carries real MONTHLY-CLOSING SALES (a non-zero row in
 * `source_of_sales_channel_customer_rollup`), false when it was entered but our sales data has never
 * seen a sale under it (owner ask, 2026-09-25: "make 'in our database' check monthly-closing sales,
 * not territory mapping").
 */
export type VerifiedCaptureDistributorCode = {
  /** The distributor's readable name, e.g. "Ibn Sina" — never a bare code alone (owner rule). */
  distributorName: string | null;
  /** The distributor's short code, e.g. "IS" — shown beside the name because the owner reads it. */
  distributorCode: string | null;
  /** The pharmacy's customer code at that distributor. */
  customerCode: string | null;
  /** True when this code carries real monthly-closing sales — "available in our database". */
  inDatabase: boolean;
};

/** One pharmacy linked to a verified marketing customer, with its own capture. */
export type VerifiedMarketingCapturePharmacy = {
  id: string;
  displayName: string;
  /** Short-lived signed URL for the pharmacy's live storefront photo; null when none is on file. */
  photoUrl: string | null;
  location: VerifiedCaptureLocation;
  /** Every distributor code on file for this pharmacy, each flagged in/out of our database. */
  distributorCodes: VerifiedCaptureDistributorCode[];
};

/**
 * A marketing customer that is verified by the LIVE evidence (owner rule, 2026-09-24): a complete
 * live photo + location on the customer AND on every pharmacy linked to him — never the stored
 * `validation_status` stamp, which can go stale.
 */
export type VerifiedMarketingCaptureRow = {
  id: string;
  customerCode: string | null;
  displayName: string;
  /** The rep who owns the customer. */
  repHrId: string | null;
  repName: string | null;
  /** The rep's real job title, e.g. "Medical Rep" — shown so the position is never assumed. */
  repTitle: string | null;
  /** The rep's manager (whatever their real title — often not a district manager). */
  managerHrId: string | null;
  managerName: string | null;
  /** The manager's real job title, e.g. "National Sales Manager". */
  managerTitle: string | null;
  areaName: string | null;
  lineName: string | null;
  governorate: string | null;
  capturedAt: string | null;
  /** The customer's own captured photo + location. */
  photoUrl: string | null;
  location: VerifiedCaptureLocation;
  pharmacyCount: number;
  pharmacies: VerifiedMarketingCapturePharmacy[];
};

/** Which lane a direct-order pharmacy was verified through. */
export type VerifiedDirectOrderRoute = "field" | "invoice";

/**
 * A direct-order pharmacy verified through the field lane (live photo + GPS) or the invoice lane
 * (a distributor invoice, no photo/GPS). Catalogue-directory pharmacies are excluded — the owner's
 * choice, 2026-09-24 — because they were never captured in the field at all.
 */
export type VerifiedDirectOrderCaptureRow = {
  id: string;
  pharmacyId: string;
  pharmacyName: string;
  pharmacyCode: string | null;
  route: VerifiedDirectOrderRoute;
  /** The person who submitted the capture. */
  repHrId: string | null;
  repName: string | null;
  /** The requester's real job title — a direct-order requester is often a manager, not a rep. */
  repTitle: string | null;
  /** That person's manager. */
  managerHrId: string | null;
  managerName: string | null;
  /** The manager's real job title. */
  managerTitle: string | null;
  /** When an admin confirmed it, and who. */
  verifiedAt: string | null;
  verifiedByName: string | null;
  /** The verifier's real job title. */
  verifiedByTitle: string | null;
  /** The field lane's live storefront photo; null on an invoice-only capture. */
  photoUrl: string | null;
  /** The invoice lane's distributor invoice; null on a field capture. */
  invoiceUrl: string | null;
  invoiceIsPdf: boolean;
  /** The pharmacy trade licence, when one was attached. */
  licenseUrl: string | null;
  location: VerifiedCaptureLocation;
  /** Every distributor code on file for this pharmacy, each flagged in/out of our database. */
  distributorCodes: VerifiedCaptureDistributorCode[];
};
