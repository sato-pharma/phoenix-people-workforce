import type { AccessContext } from "@/lib/auth/permissions";

// The two "look, never write" viewers — a test account (test-persona.ts) and the Super Admin's View as
// Seat (seat-view.ts) — asked by the few places that would otherwise write while merely SHOWING a page.
//
// Dependency-free on purpose (a type import is erased). Those places include the notifications module,
// which the Phoenix MCP server bundles; importing seat-view.ts there would carry the session signer and
// its Supabase session store into a bundle that must hold no administrative IO (infra/phoenix-mcp/build.mjs).

export function isSeatView(access: Pick<AccessContext, "seatView"> | null | undefined): boolean {
  return Boolean(access?.seatView);
}

/**
 * Whether this viewer must leave NO trace — a test account or a seat view. The places that would
 * otherwise write while merely showing a page (archiving stale notices, moving a push identity,
 * persisting a geocoded address) ask this.
 */
export function isReadOnlyViewer(access: Pick<AccessContext, "testPersona" | "seatView"> | null | undefined): boolean {
  return Boolean(access?.testPersona) || Boolean(access?.seatView);
}
