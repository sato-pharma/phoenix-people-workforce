import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CONTACT_HR_DRAFT_KEY_BASE,
  EXPENSE_DECISION_DRAFT_KEY_BASE,
  PUSH_REGISTRATION_MEMO_KEY_BASE,
  UNOWNED_LEGACY_DRAFT_KEYS,
  clearSignedOutDrafts,
  isOwnedByViewer,
  normalizeOwnerHrId,
  ownerScopedStorageKey,
} from "../src/lib/browser-storage/owner-scoped.ts";

/**
 * WHOSE IS THIS DRAFT? (cache audit, 2026-10-26, P0)
 *
 * Six browser-held stores were keyed on the BROWSER alone, so on a shared phone or office PC what one
 * person left behind was restored for — and in the offline queues' case SENT as — whoever signed in
 * next: an outstation money claim, a leave request, a marketing validation visit, a message to HR,
 * a reviewer's unsaved expense decisions and the CRM touch trail (retired on 2026-11-01). The rule is in
 * src/lib/browser-storage/owner-scoped.ts; this suite pins the rule itself, and that every store
 * reads it.
 *
 * The stores are React components, so their half is read as source. Each target is read INSIDE the
 * run function (a module-level read cannot be break-tested in one process), and every pattern names
 * a call with its arguments, which a comment explaining it never spells out.
 */

function source(path: string): string {
  return readFileSync(path, "utf8");
}

class FakeStorage {
  private readonly items = new Map<string, string>();
  constructor(entries: Record<string, string>) {
    for (const [key, value] of Object.entries(entries)) this.items.set(key, value);
  }
  get length(): number {
    return this.items.size;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  keys(): string[] {
    return [...this.items.keys()].sort();
  }
}

export function runBrowserStorageOwnerScopedTests() {
  // ── 1. The rule ─────────────────────────────────────────────────────────────────────────────────────
  assert.equal(isOwnedByViewer("B-10", "B-10"), true, "the same person gets their own draft back");
  assert.equal(
    isOwnedByViewer("MR-0412", "MR-0977"),
    false,
    "HEADLINE: rep A's draft or queued entry is NEVER restored or sent for rep B on the same device",
  );
  assert.equal(isOwnedByViewer(" mr-0412 ", "MR-0412"), true, "spaces and letter case never decide who someone is");
  assert.equal(isOwnedByViewer(undefined, "MR-0412"), false, "an entry from before the rule cannot say whose it is, so nobody gets it");
  assert.equal(isOwnedByViewer("", "MR-0412"), false, "nor can an empty owner");
  assert.equal(isOwnedByViewer("MR-0412", ""), false, "a viewer the page has not resolved yet is nobody to restore it for");
  assert.equal(isOwnedByViewer("MR-0412", null), false, "nor is a viewer with no HR id");
  assert.equal(isOwnedByViewer(42, 42), false, "only a string is an HR id");
  assert.equal(normalizeOwnerHrId("  b-10 "), "B-10");
  assert.equal(
    isOwnedByViewer(" aaa ", "AA"),
    true,
    "the owner is resolved through the one canonical HR id shape (@/lib/hr-id), legacy alias included — never a hand-rolled copy",
  );

  assert.equal(ownerScopedStorageKey(CONTACT_HR_DRAFT_KEY_BASE, " b-10 "), `${CONTACT_HR_DRAFT_KEY_BASE}:B-10`, "one key per person");
  assert.notEqual(
    ownerScopedStorageKey(CONTACT_HR_DRAFT_KEY_BASE, "MR-0412"),
    ownerScopedStorageKey(CONTACT_HR_DRAFT_KEY_BASE, "MR-0977"),
    "two people on one browser never share a key",
  );
  assert.equal(ownerScopedStorageKey(CONTACT_HR_DRAFT_KEY_BASE, null), null, "no owner means store nothing");
  assert.equal(ownerScopedStorageKey(EXPENSE_DECISION_DRAFT_KEY_BASE, "   "), null);

  // ── 2. Sign-out clears the unsaved typing, and keeps the offline queues ───────────────────────────────
  {
    const storage = new FakeStorage({
      [`${CONTACT_HR_DRAFT_KEY_BASE}:MR-0412`]: "{}",
      [`${EXPENSE_DECISION_DRAFT_KEY_BASE}:B-10`]: "{}",
      "phoenix-outstation-draft": "{}",
      "phoenix:contact-hr-draft:v1": "{}",
      "phoenix.outstation.expense-approvals.draft.v1": "{}",
      "phoenix-outstation-draft:MR-0412": "{}",
      "phoenix-theme": "dark",
    });
    clearSignedOutDrafts(storage);
    assert.deepEqual(
      storage.keys(),
      ["phoenix-outstation-draft:MR-0412", "phoenix-theme"],
      "sign-out removes every person's unsaved-typing draft and every un-owned legacy key, and leaves the " +
        "owner-checked queue (the outstation claim) and unrelated settings alone",
    );
    assert.equal(UNOWNED_LEGACY_DRAFT_KEYS.length, 3, "the three pre-rule keys are all named");

    assert.doesNotThrow(() => clearSignedOutDrafts(null), "no storage at all still signs out");
    assert.doesNotThrow(
      () =>
        clearSignedOutDrafts({
          get length(): number {
            throw new Error("SecurityError: site data blocked");
          },
          key: () => null,
          removeItem: () => undefined,
        }),
      "a browser with site data blocked still signs out",
    );

    const signOut = source("src/lib/auth/sign-out-client.ts");
    const clearAt = signOut.indexOf("clearSignedOutDrafts(browserLocalStorage());");
    const leaveAt = signOut.indexOf('hardNavigate("/login");');
    const refusedAt = signOut.indexOf("return false;");
    assert.ok(clearAt !== -1, "sign-out clears the drafts");
    assert.ok(clearAt > refusedAt && clearAt < leaveAt, "after the server confirmed the sign-out, and before leaving the page");
  }

  // ── 3. The outstation claim (the money one) ───────────────────────────────────────────────────────────
  {
    const wizard = source("src/components/outstation/mobile-outstation-wizard.tsx");
    assert.match(wizard, /const draftKey = outstationDraftStorageKeyFor\(employeeHrId\);/, "the claim draft is kept under the claimant's own key");
    assert.match(wizard, /isRestorableOutstationLocalDraft\(restore, employeeHrId\)/, "and restored only for the claimant");
    assert.match(wizard, /ownerHrId: employeeHrId,/, "every saved draft says whose claim it is");
    assert.match(wizard, /removeStoredDraft\(outstationDraftStorageKeyBase\);/, "the browser-wide draft from before the rule is removed, never restored");
    assert.doesNotMatch(wizard, /localStorage\.getItem\(outstationDraftStorageKeyBase\)/, "and never read");
  }

  // ── 4. The leave request queue ────────────────────────────────────────────────────────────────────────
  {
    const form = source("src/components/vacation/vacation-request-form.tsx");
    assert.match(
      form,
      /const pending = queue\.filter\(\(item\) => isOwnedByViewer\(item\.ownerHrId, ownerHrId\)\);/,
      "a queued leave request is replayed only under its own person's session",
    );
    assert.doesNotMatch(form, /const pending = \[\.\.\.queue\]/, "never the whole browser's queue");
    assert.match(form, /queueLength: ownQueue\.length/, "and only the viewer's own requests are counted as waiting");
    assert.match(form, /if \(!owner\) return false;/, "a request is never queued without an owner");
    assert.match(form, /useOfflineQueue\(replayVacationRequest, initialData\?\.employee\.hrId/, "the owner is the signed-in employee");
  }

  // ── 5. The marketing validation queue ─────────────────────────────────────────────────────────────────
  {
    const workspace = source("src/components/employee-portal/marketing-validation-workspace.tsx");
    assert.match(
      workspace,
      /const pending = queue\.filter\(\(item\) => isOwnedByViewer\(item\.ownerHrId, viewerHrId\)\);/,
      "a queued visit is replayed only under its own rep's session — never filed as the next rep's visit",
    );
    assert.doesNotMatch(workspace, /const pending = \[\.\.\.queue\]/, "never the whole tablet's queue");
    assert.match(workspace, /useOfflineQueue\(replaySubmission, workspace\.viewerHrId\)/, "the owner is the signed-in rep");
    assert.match(workspace, /ownerHrId: owner,/, "every queued visit says whose it is");
    assert.match(
      workspace,
      /tooOld: unsendableOwners\.filter\(\(owner\) => owner !== "" && owner === viewer\)\.length/,
      "a rep is told only about their own lost visits, not another rep's",
    );
    assert.match(
      workspace,
      /noOwner: unsendableOwners\.filter\(\(owner\) => owner === ""\)\.length/,
      "an entry with no owner is counted apart, so the banner never calls it too old",
    );
    assert.match(workspace, /describeUnsendableQueue\(unsendable\)/, "the banner's words come from the tested helper");
    assert.match(
      workspace,
      /const keep = \[\.\.\.queue, \.\.\.unsendableEntriesToKeep\(unsendableEntries, viewerHrId\)\];/,
      "every write keeps another rep's aged entries and drops the ones the banner has reported",
    );
    assert.match(
      workspace,
      /void saveValidationQueue\(keep\);\n  \}, \[queue, unsendableEntries, viewerHrId\]\);/,
      "and the write runs when only the unsendable entries are found, so a reported entry leaves the device instead of returning on every visit",
    );
    assert.doesNotMatch(workspace, /void saveValidationQueue\(queue\);/, "never the queue alone, which dropped another rep's aged entries");
    assert.match(
      workspace,
      /dismissExpired: \(\) => setUnsendableEntries\(\(current\) => unsendableEntriesToKeep\(current, viewerHrId\)\)/,
      "dismissing the banner keeps another rep's entries for them",
    );
  }

  // ── 6. The two unsaved-typing drafts ──────────────────────────────────────────────────────────────────
  {
    const contact = source("src/components/employee-portal/contact-hr-support-page.tsx");
    assert.match(contact, /ownerScopedStorageKey\(CONTACT_HR_DRAFT_KEY_BASE, data\.employee\.hrId\)/, "the message to HR is kept per person");
    assert.match(contact, /localStorage\.getItem\(draftKey\)/, "and read back from that person's key");
    assert.doesNotMatch(contact, /localStorage\.getItem\(LEGACY_SUPPORT_DRAFT_KEY\)/, "never from the browser-wide key");

    const page = source("app/(admin)/admin/outstation/expense-approvals/page.tsx");
    assert.match(page, /viewerHrId=\{access\.hrId\}/, "the expense queue is told who the reviewer is");
    const expense = source("src/components/outstation/expense-approvals-workspace.tsx");
    assert.match(expense, /if \(!draftKey\) return null;/, "with no reviewer, no decision draft is read");
    assert.match(expense, /function writeExpenseDecisionDraft\(draftKey: string \| null, decisions: Record<string, Decision>\) \{\s*if \(!draftKey\) return;/, "and none is written");
  }

  // ── 7. The push registration memo (1 Nov 2026) ───────────────────────────────────────────────────────
  // What this browser last reported to push_subscriptions, per person: a shared tablet registers
  // again for whoever signs in next, and one person's memo never silences another's registration.
  {
    assert.equal(
      ownerScopedStorageKey(PUSH_REGISTRATION_MEMO_KEY_BASE, " pd-0030 "),
      `${PUSH_REGISTRATION_MEMO_KEY_BASE}:PD-0030`,
      "the memo is kept under the person's own key",
    );
    assert.equal(ownerScopedStorageKey(PUSH_REGISTRATION_MEMO_KEY_BASE, null), null, "a session with no push identity keeps no memo");

    const storage = new FakeStorage({
      [`${PUSH_REGISTRATION_MEMO_KEY_BASE}:PD-0030`]: "{}",
      [`${CONTACT_HR_DRAFT_KEY_BASE}:PD-0030`]: "{}",
    });
    clearSignedOutDrafts(storage);
    assert.deepEqual(
      storage.keys(),
      [`${PUSH_REGISTRATION_MEMO_KEY_BASE}:PD-0030`],
      "sign-out keeps the memo: it is not a draft, its key already names the person, and the device's subscription is the same when the same person returns",
    );

    const provider = source("src/components/notifications/onesignal-provider.tsx");
    assert.match(
      provider,
      /const memoKey = ownerScopedStorageKey\(PUSH_REGISTRATION_MEMO_KEY_BASE, identity\);/,
      "the provider keys the memo by the person it just resolved — never by the browser alone",
    );
  }
}
