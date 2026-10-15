import type { SystemNotificationChannel } from "@/lib/notifications/system";

// Owner rule (2026-10-15): the routine "it worked" ops confirmations do NOT reach his Telegram.
// His words, after an audit of every system-health alert he had received: "stop the routine
// sync-success alerts reaching my Telegram".
//
// What it cost to leave them on: of 471 system-health alerts delivered to his Telegram between
// 21 June and 15 Oct 2026, 207 were routine confirmations that nothing was wrong — 44% of the
// channel — and `ireports360_sync_success` alone sent 178 of them. The failures those messages
// were meant to make visible arrived in the same stream, so the signal they carried was spent on
// telling him the mirror was fresh. A real one that morning read exactly like the 178 before it.
//
// SCOPED TO THE SUCCESS HALF, AND THAT IS THE WHOLE POINT. Both digests build their event type as
// `<name>_${input.status}`, so the failure events (`ireports360_sync_failed`,
// `background_jobs_run_failed`) do not match this list and keep every channel they had. A guard
// keyed on the module, or on the job, would have taken the failures with them — which is the one
// outcome worse than the noise.
//
// Blocks the TELEGRAM axis only. `in_app` stays, so the confirmation is still on record and still
// renderable in the bell; `push` stays because the owner named Telegram and nothing else, and a
// guard is a bad place to widen an instruction.
//
// Enforced as a hard post-filter in basePolicyChannels rather than by editing the two call sites'
// `channels` arrays alone, for the reason the sibling guards in this folder all give: the call site
// is not the last word. `resolveBasePolicyChannels` falls back to the policy table when a caller
// passes no channels, and the Telegram-failure fallback re-enters the pipeline with its own list.
// The call sites are narrowed too, so the intent is readable where the digest is composed — two
// co-operating values, with the guard as the one that cannot be bypassed.
//
// Same proven pattern as payslip-channel-guard.ts, early-birds-channel-guard.ts and
// phoenix-crm-channel-guard.ts, and deliberately mirrored rather than merged into them: each guard
// stays single-purpose and independently readable, so deleting one can never silently widen
// another.

/**
 * The routine success confirmations, by event type. Each is a cron telling a Super Admin that a
 * scheduled job finished normally — never that anything needs doing.
 */
const ROUTINE_SUCCESS_EVENT_TYPES = new Set<string>([
  "ireports360_sync_success",
  "background_jobs_run_success",
]);

export function isRoutineOpsSuccessEvent(eventType: string | null | undefined): boolean {
  return ROUTINE_SUCCESS_EVENT_TYPES.has(String(eventType ?? "").trim().toLowerCase());
}

export function enforceOpsSuccessTelegramBlock(
  channels: readonly SystemNotificationChannel[],
  eventType: string | null | undefined,
): SystemNotificationChannel[] {
  const deduped = Array.from(new Set(channels));
  return isRoutineOpsSuccessEvent(eventType)
    ? deduped.filter((channel) => channel !== "telegram")
    : deduped;
}
