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

/** One pharmacy linked to a verified marketing customer, with its own capture. */
export type VerifiedMarketingCapturePharmacy = {
  id: string;
  displayName: string;
  /** Short-lived signed URL for the pharmacy's live storefront photo; null when none is on file. */
  photoUrl: string | null;
  location: VerifiedCaptureLocation;
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
  /** The rep's district manager. */
  managerHrId: string | null;
  managerName: string | null;
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
  /** That person's manager. */
  managerHrId: string | null;
  managerName: string | null;
  /** When an admin confirmed it, and who. */
  verifiedAt: string | null;
  verifiedByName: string | null;
  /** The field lane's live storefront photo; null on an invoice-only capture. */
  photoUrl: string | null;
  /** The invoice lane's distributor invoice; null on a field capture. */
  invoiceUrl: string | null;
  invoiceIsPdf: boolean;
  /** The pharmacy trade licence, when one was attached. */
  licenseUrl: string | null;
  location: VerifiedCaptureLocation;
};
