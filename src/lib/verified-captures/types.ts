// Verified Captures — the row shapes shared by the server loaders and the client workspace.
//
// Deliberately free of any server import so the `"use client"` gallery can import these types
// directly. Everything here is a plain value already resolved on the server: names not codes,
// signed photo URLs ready to render, times as raw ISO strings the client formats to Cairo.

/** A captured GPS point plus its human-readable address. Any part may be missing. */
export type VerifiedCaptureLocation = {
  latitude: number | null;
  longitude: number | null;
  /** A readable address, never a bare code (owner rule: names, never codes). */
  address: string | null;
};

/**
 * One distributor code on file for a captured pharmacy, and whether our database recognises it.
 *
 * The owner asked to see the distributor ("DISTB") and the pharmacy's code at it, and to be told
 * "available in our database or no". `inDatabase` is exactly that: true when the code is mapped into
 * our sales territory (a `mapped_area_code` on the direct-order table, `reference_status = matched`
 * on the marketing one), false when it was entered but our reference data has never matched it.
 */
export type VerifiedCaptureDistributorCode = {
  /** The distributor's readable name, e.g. "Ibn Sina" — never a bare code alone (owner rule). */
  distributorName: string | null;
  /** The distributor's short code, e.g. "IS" — shown beside the name because the owner reads it. */
  distributorCode: string | null;
  /** The pharmacy's customer code at that distributor. */
  customerCode: string | null;
  /** True when this code is mapped into our sales territory — "available in our database". */
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
