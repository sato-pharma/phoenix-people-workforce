/**
 * WHOSE IS THIS DRAFT? — the one rule every browser-held draft and offline queue obeys
 * (cache audit, 2026-10-26, P0).
 *
 * A phone or a PC is often shared: a rep hands the tablet to the next rep, an office PC serves a
 * whole department. Six stores used to be keyed on the BROWSER alone, so whatever one person left
 * behind was restored for — and in the queues' case SENT as — whoever signed in next. The worst was
 * the outstation wizard: rep A's offline claim, amounts, arrival photo and GPS included, was replayed
 * under rep B's session and filed as B's money claim, and A's claim was gone.
 *
 * The rule, everywhere:
 *   - Every stored draft or queued entry carries the HR id of the person who made it.
 *   - It is restored, counted or sent only for that same person. Another person's entry is left
 *     where it is, so its owner still has it when they sign back in.
 *   - An entry that cannot say whose it is (written before this rule) is never restored or sent:
 *     there is no safe owner to give it to.
 *
 * Sign-out also clears the drafts that are only unsaved typing (`clearSignedOutDrafts`). It does NOT
 * clear the offline queues — those hold work the person was told is safe (a claim, a leave request,
 * a validated visit), and the owner check above is what keeps them from reaching anyone else.
 */

import { canonicalHrIdForDisplay } from "@/lib/hr-id";

/**
 * Two spellings of one HR id compare equal: surrounding spaces, letter case and a legacy alias never
 * decide — the one canonical shape from `@/lib/hr-id`, so a draft is owned by the same person every
 * other screen resolves.
 */
export function normalizeOwnerHrId(value: unknown): string {
  return typeof value === "string" ? (canonicalHrIdForDisplay(value) ?? "") : "";
}

/**
 * True only when the stored owner and the signed-in viewer are the same person. A missing owner on
 * EITHER side is false — an un-owned entry is nobody's to restore, and a viewer the page has not
 * resolved yet is nobody to restore it for.
 */
export function isOwnedByViewer(entryOwnerHrId: unknown, viewerHrId: unknown): boolean {
  const owner = normalizeOwnerHrId(entryOwnerHrId);
  const viewer = normalizeOwnerHrId(viewerHrId);
  return owner !== "" && owner === viewer;
}

/** `base` + `:` + the owner's HR id. Null when there is no owner, which means: store nothing. */
export function ownerScopedStorageKey(base: string, viewerHrId: unknown): string | null {
  const owner = normalizeOwnerHrId(viewerHrId);
  return owner ? `${base}:${owner}` : null;
}

/** The Contact HR message draft — unsaved typing, cleared at sign-out. */
export const CONTACT_HR_DRAFT_KEY_BASE = "phoenix:contact-hr-draft:v2";
/** The expense-approval decision draft — unsaved decisions, cleared at sign-out. */
export const EXPENSE_DECISION_DRAFT_KEY_BASE = "phoenix.outstation.expense-approvals.draft.v2";
/**
 * How one reviewer last ordered the Expense Approvals rail ("value" or "oldest", owner's review
 * 2026-11-07) — per person, so a shared office PC keeps each reviewer's own order. A preference,
 * not a draft: sign-out leaves it, and an empty or unreadable store means "Biggest first".
 */
export const EXPENSE_APPROVAL_VIEW_KEY_BASE = "phoenix.outstation.expense-approvals.view.v1";
/**
 * What this browser last reported to push_subscriptions for one person (onesignal-provider.tsx) —
 * per person, so a shared tablet registers again for whoever signs in next. Not a draft: it is not
 * cleared at sign-out, because the device's subscription is the same when the same person returns.
 */
export const PUSH_REGISTRATION_MEMO_KEY_BASE = "phoenix.push.registration.v1";

/**
 * The visits a phone holds for want of signal (owner, 3 Nov 2026, src/lib/phoenix-crm/visit-outbox.ts). A queue,
 * not a draft: the rep was told it is safe, so sign-out leaves it, and the owner check is what keeps it his.
 */
export const VISIT_OUTBOX_KEY_BASE = "phoenix.crm.visit-outbox.v1";
/** Told on this page when that list changes; a second tab hears the browser's own `storage` event. */
export const VISIT_OUTBOX_CHANGED_EVENT = "phoenix-crm:visit-outbox-changed";

/**
 * Keys from before the owner rule. Each one holds a draft that cannot say whose it is, so each page
 * removes its own on load and sign-out removes them all.
 */
export const UNOWNED_LEGACY_DRAFT_KEYS = [
  "phoenix-outstation-draft",
  "phoenix:contact-hr-draft:v1",
  "phoenix.outstation.expense-approvals.draft.v1",
] as const;

/** What sign-out removes: every legacy key, and every owner's unsaved-typing drafts. */
const SIGN_OUT_CLEARED_PREFIXES = [`${CONTACT_HR_DRAFT_KEY_BASE}:`, `${EXPENSE_DECISION_DRAFT_KEY_BASE}:`] as const;

type KeyedStorage = Pick<Storage, "key" | "length" | "removeItem">;

/**
 * Removes the unsaved-typing drafts and every un-owned legacy key. Never throws: a browser with site
 * data blocked must still be able to sign out.
 */
export function clearSignedOutDrafts(storage: KeyedStorage | null | undefined): void {
  if (!storage) return;
  try {
    const doomed: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key) continue;
      if (
        (UNOWNED_LEGACY_DRAFT_KEYS as readonly string[]).includes(key) ||
        SIGN_OUT_CLEARED_PREFIXES.some((prefix) => key.startsWith(prefix))
      ) {
        doomed.push(key);
      }
    }
    for (const key of doomed) storage.removeItem(key);
  } catch {
    // Storage unavailable: there is nothing to clear, and sign-out goes ahead.
  }
}

/** `window.localStorage`, or null wherever reading it throws (blocked site data, a test runner). */
export function browserLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}
