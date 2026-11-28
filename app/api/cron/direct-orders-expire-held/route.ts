import { NextResponse } from "next/server";

import { systemAccessContext } from "@/lib/auth/permissions";
import { sendDirectOrderReceiptReminders } from "@/lib/direct-orders/receipt-books";
import { expireStaleHeldDirectOrders } from "@/lib/direct-orders/service";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The held-order 14-day clock (spec B6 — docs/specs/direct-orders-v2.md).
 *
 * Daily sweep: any direct order still `held` 14 days after it was parked expires — logged,
 * evented, the requester notified. A held lane with no drain would grow into exactly the swamp
 * of unresolvable requests the owner is draining now; this keeps it a parking lot.
 *
 * Runs as the system context; each expiry is individually registry-gated (`expire_held`),
 * audited, and evented in the service.
 *
 * WIRED TO THE DEAD-MAN'S-SWITCH 2026-08-23, after this clock ran dead for nine nights unseen.
 * `CRON_SECRET` was rotated on Railway on 2026-08-14; the GitHub Actions copy that
 * .github/workflows/direct-orders-sweeps.yml sends was never re-aligned, so every nightly run
 * 401'd from 2026-08-14 to 2026-08-22 and nobody was told. The workflow's own comment claims a red
 * run "emails the owner" — nine silent nights say otherwise, and a red run in a log nobody opens is
 * not an alert. Healthchecks alerts on the ping that DIDN'T arrive, so it catches the case the
 * workflow cannot report on: the request never reaching this handler at all.
 *
 * THE DELIVERY-RECEIPT REMINDERS RIDE THIS SWEEP (owner, 28 Nov 2026): each manager is told inside Phoenix, never
 * by email, the day before an original of his delivery receipt is due and once it is late
 * (sendDirectOrderReceiptReminders). Each notice is sent once, by its key, so a re-run adds nothing. It runs after
 * the expiry and on its own: a failure is logged and never undoes or hides the expiry result.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/direct-orders-expire-held");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-direct-orders-expire-held", () =>
      expireStaleHeldDirectOrders(systemAccessContext),
    );
    let receiptReminders: { due: number; late: number } | { failed: true };
    try {
      receiptReminders = await sendDirectOrderReceiptReminders();
    } catch (error) {
      logError("Direct order receipt reminders failed", {
        labels: { event: "cron_failed", job: "direct-orders-receipt-reminders" },
        error,
      });
      receiptReminders = { failed: true };
    }
    return NextResponse.json({ success: true, ...result, receiptReminders });
  } catch (error) {
    logError("Held direct-order expiry sweep failed", {
      labels: { event: "cron_failed", job: "direct-orders-expire-held" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Expiry sweep failed.");
    return NextResponse.json({ error: "expire_held_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
