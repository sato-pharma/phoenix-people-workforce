import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canCancelMarketingRequest } from "@/lib/marketing-requests/cancel";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

/**
 * The Cancel action on the Super-Admin oversight inbox.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────
 * The case file already carries a Cancel control (#4239), but the oversight queue ("Everything in
 * approval") is where the owner SEES a live request he wants stopped — one row among the whole
 * company's chain. Making him open each record to call it off is the friction this removes.
 *
 * ── THE LIMIT THAT MATTERS MORE THAN THE FEATURE ─────────────────────────────
 * Cancelling is a decision, and only the oversight viewer (Super Admin) may make it. The shared
 * watch-list renderer is also used by "Coming to me", which is a heads-up list, not a decider's.
 * The Cancel control must be reachable from oversight and UNREACHABLE from "Coming to me", enforced
 * two ways at once: the server marks `canCancel` on oversight rows only, and the component draws the
 * button only when BOTH the reload callback (passed by oversight alone) and `row.canCancel` are
 * present. This suite pins both halves so a future edit cannot quietly widen it.
 */
export async function runMarketingInboxCancelTests() {
  // ── The gate the row flag is computed from ───────────────────────────────────
  // The full matrix lives in marketing-cancel-request.test.ts; this confirms the inbox reuses the
  // same verdict, so the row flag can never diverge from the case file and the route.
  assert.equal(
    canCancelMarketingRequest({ role: "Super Admin", status: "pending_approval" }),
    true,
    "a Super Admin may cancel a live request from the inbox",
  );
  assert.equal(
    canCancelMarketingRequest({ role: "CEO", status: "pending_approval" }),
    false,
    "no role but Super Admin may cancel from the inbox",
  );
  assert.equal(
    canCancelMarketingRequest({ role: "Super Admin", status: "closed" }),
    false,
    "a terminal request offers no cancel, even to a Super Admin",
  );

  const service = source("src/lib/marketing-requests/service.ts");

  // ── Only oversight rows carry canCancel, computed from the shared gate ────────
  assert.match(
    service,
    /canCancel: canCancelMarketingRequest\(\{ role: access\.role, status: request\.status \}\)/,
    "the oversight row must set canCancel from the same gate the case file and route use",
  );

  // The upcoming ("Coming to me") loop must NOT set canCancel — its rows are a heads-up, never a
  // decider's, so no cancel affordance may ever be computable for them.
  const upcomingLoop = service.slice(
    service.indexOf("const upcomingRows: MarketingApproverUpcomingRow[] = [];"),
    service.indexOf("const oversightRows: MarketingApproverOversightRow[] = [];"),
  );
  assert.ok(upcomingLoop.length > 0, "the upcoming loop must exist to be checked");
  assert.doesNotMatch(
    upcomingLoop,
    /canCancel/,
    "a 'Coming to me' row must never carry canCancel — the cancel action is the oversight viewer's alone",
  );

  const inbox = source("src/components/employee-portal/marketing-request-inbox.tsx");

  // ── The button component is wired in ─────────────────────────────────────────
  assert.match(
    inbox,
    /import \{ MarketingInboxCancelButton \} from "@\/components\/marketing-requests\/marketing-inbox-cancel-button"/,
    "the inbox must import the cancel button",
  );

  // ── "Coming to me" gets NO reload callback, so its rows can raise no cancel ───
  assert.match(
    inbox,
    /<ChainWatchList rows=\{upcomingRows\} \/>/,
    "the 'Coming to me' watch list must not receive onCancelled — the cancel control cannot appear there",
  );
  // ── Oversight passes the reload callback that drops a cancelled row ───────────
  assert.match(
    inbox,
    /<ChainWatchList onCancelled=\{\(\) => void loadInbox\(\)\} rows=\{oversightRows\} \/>/,
    "the oversight watch list must pass onCancelled = loadInbox so a cancelled row drops immediately",
  );

  // ── The button renders only when BOTH the callback and the row flag are set ──
  // Two gates, not one: even if a future edit passed onCancelled to the upcoming list, its rows
  // have no canCancel; even if a row wrongly carried canCancel, no callback means no button.
  const cancelGuards = inbox.match(/onCancelled && row\.canCancel \?/g) ?? [];
  assert.equal(
    cancelGuards.length,
    2,
    "both the card and the desktop table must gate the cancel button on onCancelled && row.canCancel",
  );
}
