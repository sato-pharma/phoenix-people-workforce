// The two confidentiality primitives — the restricted product-code list and the Head Office line
// test — together with the line key both are compared on.
//
// Kept in its own dependency-free module, separate from access-scope.ts (which imports the
// server-only Supabase/employee-directory chain), for exactly the reason official-lines.ts is:
// direct-orders/product-family.ts needs both, and the Direct Orders submit form is a CLIENT
// component that imports product-family. Before this split that one import dragged
// access-scope → employee-directory → employee-photo → `node:crypto` into the client bundle,
// which webpack refuses (UnhandledSchemeError). The refusal is deliberate — employee-photo.ts
// keeps that import as its client-bundle tripwire — but it poisons the whole dev server the
// moment /employee-portals/direct-orders/new is compiled: every later request, /api/healthz
// included, then 500s. `next build` tree-shakes the unused chain away, so production always
// rendered the page and only local dev was broken, which is why it went unnoticed.
//
// Values are unchanged, and access-scope.ts re-exports all three, so every existing server
// caller keeps importing them from where it already does.

import type { PhoenixRole } from "@/lib/auth/permissions";

/** Confidential products excluded by default everywhere. Single source of truth. */
export const RESTRICTED_PRODUCT_CODES = ["LA003", "LA004", "SS001"] as const;

/** Case/whitespace-insensitive key for comparing line names from different sources. */
export function normalizeLineKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Case/whitespace-insensitive keys that identify the confidential Head Office line. */
const HEAD_OFFICE_LINE_KEYS = new Set(["head office", "headoffice", "office", "hq"]);

/** True when a line name (employee line or SoS official line) is the confidential Head Office line. */
export function isHeadOfficeLine(line: string | null | undefined): boolean {
  return HEAD_OFFICE_LINE_KEYS.has(normalizeLineKey(line));
}

/**
 * Roles allowed to reveal the confidential Head Office line / restricted products (the locked
 * decision — CEO / Super Admin only). The same check as access-scope.ts's
 * `canViewHeadOfficeLine` / `canViewRestrictedProducts`, duplicated here on purpose (kept in
 * lockstep by hand, the same shape as RESTRICTED_PRODUCT_NAME_FALLBACKS above): those two live in
 * access-scope.ts, which pulls the server-only employee-directory/node:crypto chain, and cannot be
 * imported by monthly-distributor-import.ts — it is reached from several CLIENT components (Monthly
 * Closing, the closing period picker, the portal closing view, the Performance Review). If the
 * locked decision ever changes, update both copies.
 */
export function isConfidentialRevealRole(role: PhoenixRole): boolean {
  return role === "CEO" || role === "Super Admin";
}
