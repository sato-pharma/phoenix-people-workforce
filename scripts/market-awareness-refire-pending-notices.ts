import { createClient } from "@supabase/supabase-js";

import { systemAccessContext } from "@/lib/auth/permissions";
import { notifyDecisionPending } from "@/lib/market-awareness/notifications";
import { getActivity } from "@/lib/market-awareness/service";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "market-awareness-refire-pending-notices",
  entry: import.meta.url,
  known: ["--send"],
});

// ─────────────────────────────────────────────────────────────────────────────
// Re-send the decision notice for every market-awareness activity still waiting on someone.
//
// Owner instruction, 2026-09-28: "trigger emails to the CEO, CC everyone in the workflow, and of
// course omar.anwar@satopharma.com is in the BCC", restated as "refire them i told u".
//
// WHY A SCRIPT AND NOT A CLICK. There is no re-notify anywhere in the product, deliberately: the
// notice is a side effect of a state change, and nothing changes state here. The four activities
// below are sitting at pending_ceo and have each already had one notice; this sends a second,
// under today's addressing rather than the one they went out with.
//
// WHAT IS DIFFERENT THIS TIME. Until this branch the notice went To: whoever must act, Cc: nobody —
// so the CEO's copy named him and no one else, and the requester and the approvers who moved it
// never learned it had reached the top. The notice now copies the requester, his manager, every
// approver slot and everyone who has already decided. The BCC needed nothing: send-phoenix-email.ts
// puts omar.anwar@satopharma.com on every automated email the system sends.
//
// 🔴 THIS SENDS REAL EMAIL TO REAL EXECUTIVES, and it also reaches the admin Telegram, because
// every automated email is mirrored there. It is DRY RUN by default and needs --send to fire.
//
// 🔴 IT MUST RUN WITH PRODUCTION'S ENVIRONMENT, and the only supported way is:
//
//   railway run --service phoenix-people-workforce -- node --experimental-strip-types \
//     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
//     scripts/market-awareness-refire-pending-notices.ts --send
//
// A plain local run writes production (.env.local points at the production Supabase) but the local
// Resend key cannot send, so it would mark the deliveries and emit nothing — the worst outcome
// available, because the dedupe then refuses a real retry.
//
// EACH SEND CARRIES ITS OWN notificationKey. The ordinary event key is a hash of the action url,
// event type, module, recipient and title, all identical to the first notice, so without a fresh
// key the delivery claim reads "already sent" and every one of these is skipped in silence.
// ─────────────────────────────────────────────────────────────────────────────

type PendingRow = { id: string; activity_code: string; status: string; title: string | null };

/** Statuses where a named person still owes a decision. `on_hold` is excluded: it is frozen on
 *  purpose and nothing is being asked of anyone, so a notice would be a lie. */
const WAITING_STATUSES = ["pending_group", "pending_manager", "pending_ceo"] as const;

/** The step each waiting status hands to, matching `currentStep` in the workflow. */
const STEP_FOR_STATUS: Record<string, "group" | "manager" | "ceo"> = {
  pending_ceo: "ceo",
  pending_group: "group",
  pending_manager: "manager",
};

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * The CEO seat holders, read the way the service reads them.
 *
 * Filtered in JS, not with `.in("role", …)`: `app_auth_users.role` is free text and its casing is
 * not guaranteed, so a case-sensitive match returns nobody — which looks exactly like "the seat is
 * vacant" and would send this script away reporting nothing to do.
 */
async function ceoHrIds(): Promise<string[]> {
  const { data, error } = await adminClient()
    .from("app_auth_users")
    .select("hr_id, role, is_active")
    .eq("is_active", true)
    .limit(1000);
  if (error) throw error;
  return ((data as Array<{ hr_id?: string | null; role?: string | null }> | null) ?? [])
    .filter((row) => String(row.role ?? "").trim().toLowerCase() === "ceo")
    .map((row) => row.hr_id)
    .filter((hrId): hrId is string => Boolean(hrId?.trim()));
}

async function main() {
  const send = process.argv.includes("--send");
  const stamp = new Date().toISOString().slice(0, 16);

  const { data, error } = await adminClient()
    .from("market_awareness_activities")
    .select("id, activity_code, status, title")
    .in("status", [...WAITING_STATUSES])
    .order("created_at", { ascending: true });
  if (error) throw error;

  const rows = (data as PendingRow[] | null) ?? [];
  console.log(`${rows.length} activity(ies) still waiting on a decision.`);
  if (rows.length === 0) return;

  const ceo = await ceoHrIds();
  console.log(`CEO seat holders: ${ceo.length > 0 ? ceo.join(", ") : "(none — a ceo-step notice would reach nobody)"}`);

  if (!send) {
    for (const row of rows) {
      console.log(`  DRY RUN  ${row.activity_code}  ${row.status}  ${row.title ?? "(untitled)"}`);
    }
    console.log("\nNothing was sent. Re-run with --send, under `railway run`, to fire.");
    return;
  }

  let notified = 0;
  for (const row of rows) {
    const step = STEP_FOR_STATUS[row.status];
    if (!step) {
      console.log(`  SKIP     ${row.activity_code}  unknown waiting status ${row.status}`);
      continue;
    }
    try {
      const activity = await getActivity(systemAccessContext, row.id);
      const result = await notifyDecisionPending({
        actionUrl: "/employee-portals/market-awareness/inbox",
        activity,
        ceoHrIds: step === "ceo" ? ceo : [],
        // Plan, step and MINUTE: two refires minutes apart are two events, and a retry of this
        // script inside the same minute is correctly deduplicated rather than sending twice.
        notificationKey: `market_awareness_refire:${row.id}:${step}:${stamp}`,
        step,
      });
      notified += result.notified;
      console.log(`  SENT     ${row.activity_code}  step=${step}  recipients=${result.notified}  ${row.title ?? ""}`);
    } catch (caught) {
      // Reported, never thrown: one activity that cannot be loaded must not stop the other three.
      console.log(`  FAILED   ${row.activity_code}  ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
  console.log(`\nDone. ${notified} recipient notice(s) dispatched across ${rows.length} activity(ies).`);
  console.log("Confirm delivery in notification_deliveries and email_delivery_events — a 'sent' row is the outbox, not the inbox.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
