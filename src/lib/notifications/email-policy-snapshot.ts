import { AsyncLocalStorage } from "node:async_hooks";

import type { EmailNotificationPolicy } from "@/lib/notifications/email";

/**
 * One read of the email policy table per drain run, instead of one per email.
 *
 * `resolveNotificationDelivery` asks for a single notification type's policy, and the only way to get
 * one was `getEmailNotificationPolicies()` — a select of the WHOLE table. The outbox drain resolves a
 * delivery per email, so a run of ten read the same table ten times; Sentry flagged it as the
 * "N+1 API Call" on GET /api/notifications/process (PHOENIX-WORKFORCE-4).
 *
 * The snapshot is scoped to ONE run through AsyncLocalStorage, never module-level: nothing outside a
 * run is ever cached (an admin screen and a save always read the table fresh), and two runs, or two
 * tests, can never see each other's copy. Inside a run it is also bounded by a short age, so a run
 * that lasts minutes still notices a policy switched off while it was working.
 */
export const EMAIL_POLICY_SNAPSHOT_MAX_AGE_MS = 10_000;

type PolicyRead = Promise<EmailNotificationPolicy[]>;
type Entry = { loadedAtMs: number; pending: PolicyRead };

const scope = new AsyncLocalStorage<{ current: Entry | null }>();

/** Run `run` with the policy read shared between every delivery it resolves. */
export function withEmailPolicySnapshot<T>(run: () => Promise<T>): Promise<T> {
  return scope.run({ current: null }, run);
}

/**
 * Outside a snapshot scope this is exactly `load()`. Inside one, the held read is reused while it is
 * younger than the max age. A FAILED read is never remembered — the next caller asks again — because
 * remembering it would turn one blip into every email of the run being refused.
 */
export function readEmailPolicies(load: () => PolicyRead, nowMs: number = Date.now()): PolicyRead {
  const held = scope.getStore();
  if (!held) return load();

  const entry = held.current;
  if (entry && nowMs - entry.loadedAtMs < EMAIL_POLICY_SNAPSHOT_MAX_AGE_MS) return entry.pending;

  const pending = load();
  const fresh: Entry = { loadedAtMs: nowMs, pending };
  held.current = fresh;
  pending.catch(() => {
    if (held.current === fresh) held.current = null;
  });
  return pending;
}
