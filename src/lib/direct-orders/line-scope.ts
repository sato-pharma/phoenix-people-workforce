// ─────────────────────────────────────────────────────────────────────────────
// Which line a direct order belongs to, and which lines have none (owner, 2026-10-29).
//
// An AREA is shared by every line, so a pharmacy in a Pedia rep's area can carry an Anti Infective
// order. A rep's Area Direct Orders window read by area alone and so showed one line's orders and
// products to another line's reps (measured on production: 40 Anti Infective orders on Pedia reps'
// screens, 20 Pedia orders on Anti Infective reps', 87 on CNS reps'). The window now keeps an order
// only when its own `line` is the rep's line.
//
// CNS runs no direct orders, so a CNS rep is not offered the window at all.
//
// Pure and import-free: the portal sidebar (client components) and the server service read it alike.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One comparable key for a line, whichever way it is spelled — the order's "Anti Infective", the
 * seat map's `anti_infective` and a directory "Anti-Infective" all read `antiinfective`.
 */
export function directOrderLineKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Lines that run no direct orders at all (owner, 2026-10-29: "CNS … they do not have direct"). */
export const LINES_WITHOUT_DIRECT_ORDERS: ReadonlySet<string> = new Set(["cns"]);

/** True when the line runs direct orders. A blank line answers false — never a window onto every line. */
export function lineHasDirectOrders(line: string | null | undefined): boolean {
  const key = directOrderLineKey(line);
  return key !== "" && !LINES_WITHOUT_DIRECT_ORDERS.has(key);
}

/** True when an order of `orderLine` belongs on the screen of a rep on `repLine`. */
export function isDirectOrderOnRepLine(orderLine: string | null | undefined, repLine: string | null | undefined): boolean {
  const rep = directOrderLineKey(repLine);
  return rep !== "" && directOrderLineKey(orderLine) === rep;
}
