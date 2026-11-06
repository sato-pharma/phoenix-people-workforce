import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import {
  NEEDS_YOU_EMAIL_HR_ID,
  enforceNeedsYouOwnerOnlyEmail,
  isNeedsYouModule,
} from "../src/lib/notifications/needs-you-recipient-guard.ts";

/**
 * "What needs you" emails exactly one person, and no code path can widen that.
 *
 * WHY THIS EXISTS. The board is a list of the decisions waiting on the owner — who is on leave,
 * whose contract is expiring, which month is unpublished, which claim is held. It is his private
 * queue. The failure this guard prevents is that list arriving in somebody else's inbox, and a sent
 * email cannot be recalled: there is no undo, no correction, and no way to know who read it.
 *
 * Every other channel guard in this folder asks "may this MODULE send email at all". This one is
 * the first to key on WHO, which makes two of its properties load-bearing in a way its siblings'
 * are not, and both are asserted below.
 *
 *   FAIL CLOSED. Email survives only when the recipient is PROVABLY the owner. An absent, empty or
 *   unresolved recipient strips email rather than allowing it. The two outcomes are not symmetric:
 *   a missing digest is noticed the next morning and costs nothing; a misdirected one has already
 *   happened. The natural-reading inverse — "strip email when the recipient is provably somebody
 *   else" — is exactly backwards and is what these assertions exist to stop.
 *
 *   ALIASES, NOT STRING EQUALITY. B-10 also signs in as PHX-1 and admin-HR. A raw `=== "B-10"`
 *   compare would strip email from the owner's OWN digest whenever the console account resolved it
 *   — a guard failing the one person it protects, silently, and only on some days. The three ids
 *   below were confirmed against the real `isSamePerson` before this test was written.
 */
export function runNeedsYouEmailOwnerOnlyTests() {
  const ALL: readonly ("in_app" | "email" | "telegram" | "push")[] = ["in_app", "email", "telegram", "push"];
  const guard = (module: string | null | undefined, hrId: string | null | undefined) =>
    enforceNeedsYouOwnerOnlyEmail(ALL, module, hrId);

  // ── 1. Somebody else never receives it ─────────────────────────────────────
  for (const stranger of ["B-77", "A-1", "b-77", "SFE-2"]) {
    assert.ok(
      !guard("needs_you", stranger).includes("email"),
      `${stranger} would have received the owner's private decision queue by email. There is no undo ` +
        "for a sent email — this is the failure the whole guard exists to prevent.",
    );
  }

  // ── 2. The owner keeps it, under every id he signs in as ───────────────────
  // Verified against the real isSamePerson before writing: B-10, PHX-1 and admin-HR are one person,
  // case-insensitively. A raw string compare passes assertion 1 and fails every line here.
  for (const own of ["B-10", "b-10", "PHX-1", "phx-1", "admin-HR", "ADMIN-HR"]) {
    assert.ok(
      guard("needs_you", own).includes("email"),
      `${own} is the owner, and the guard stripped email from his OWN digest. isSamePerson resolves ` +
        "his alias accounts; a `=== \"B-10\"` compare does not, and the breakage shows up only on the " +
        "days the console account resolved him.",
    );
  }

  // ── 3. Fail CLOSED — the direction that cannot be got wrong ────────────────
  for (const missing of [null, undefined, "", "   "]) {
    assert.ok(
      !guard("needs_you", missing).includes("email"),
      `an unresolved recipient (${JSON.stringify(missing)}) kept email. Not proven is not the same as ` +
        "proven to be him, and the safe direction is silence: a missing digest costs a morning, a " +
        "misdirected one cannot be taken back.",
    );
  }

  // ── 4. It owns ONE module and must never become a general recipient filter ──
  for (const other of ["phoenix_crm", "payroll", "attendance_digest", "outstation", null, undefined, ""]) {
    assert.deepEqual(
      guard(other, "B-77"),
      [...ALL],
      `the guard altered the ${String(other)} module's channels. Each guard here keys on its own ` +
        "module string; one that reaches wider silently changes deliveries nobody reviewed.",
    );
  }
  assert.equal(isNeedsYouModule("  NEEDS_YOU "), true, "the module key is trimmed and case-folded, as its siblings are");
  assert.equal(isNeedsYouModule("needs_you_extra"), false, "and it is not a prefix match");

  // Only email is ever removed — in-app is how he sees it at all, and stripping Telegram would make
  // a stranger's board vanish rather than merely not be emailed.
  const stripped = guard("needs_you", "B-77");
  for (const kept of ["in_app", "telegram", "push"] as const) {
    assert.ok(stripped.includes(kept), `${kept} must not be touched — this guard removes email and nothing else`);
  }

  // ── 5. A guard nothing calls blocks nothing ────────────────────────────────
  const system = stripComments(readFileSync("src/lib/notifications/system.ts", "utf8"));
  assert.match(
    system,
    /import \{ enforceNeedsYouOwnerOnlyEmail \} from "@\/lib\/notifications\/needs-you-recipient-guard";/,
    "system.ts must import the guard",
  );
  const base = /function basePolicyChannels\([^)]*\) \{([\s\S]*?)\n\}/.exec(system);
  assert.ok(base, "system.ts still has basePolicyChannels");
  assert.match(
    base[1],
    /enforceNeedsYouOwnerOnlyEmail\(\w+, input\.module, input\.recipientHrId\)/,
    "basePolicyChannels must actually run the guard, keyed on the module AND the recipient",
  );
  // The existing pin in phoenix-crm-email-block.test.ts requires the CRM blocks to come LAST. This
  // guard is chained BEFORE them, following the outstation guard's documented precedent — they key on
  // disjoint modules, so order changes nothing and no existing test has to be edited. Since
  // 2026-10-01 the CRM email block also takes the event type, for its one owner-ordered exception
  // (the request to edit a sent week), and since 2026-10-02 a CRM PUSH block is chained after it for
  // the 06:55 digest — that one is the chain's last line now, the form its own test pins.
  assert.match(
    base[1],
    /enforcePhoenixCrmEmailBlock\(\w+, input\.module, input\.eventType\)/,
    "the phoenix_crm email block must stay in the chain after this guard — it is pinned by its own test",
  );
  assert.match(
    base[1],
    /return enforcePhoenixCrmPushBlock\(\w+, input\.module, input\.eventType\);\s*$/,
    "and the phoenix_crm push block must remain the chain's last line, for the same reason",
  );

  // ── 6. The guard must SEE a resolved recipient, or fail-closed strips his own digest ──
  // A bare `...input` passes the CALLER's optional recipientHrId, which is absent whenever a caller
  // identified the person by user id or email. Every guard before this one keyed on module and
  // eventType only, so nothing noticed; this one keys on WHO and fails closed, so an unresolved
  // recipient would silently drop the owner's email on exactly those calls.
  assert.match(
    system,
    /recipientHrId: recipient\.hrId \?\? input\.recipientHrId \?\? null/,
    "basePolicyChannels must be handed the RESOLVED recipient, the same way loadPreferences is",
  );

  // ── 7. The policy row states the intent the guard enforces ─────────────────
  const policy = readFileSync("src/lib/notifications/policy.ts", "utf8");
  const row = /"needs_you\.\*": \{([^}]*)\}/.exec(policy);
  assert.ok(row, "policy.ts must carry a needs_you.* row, or the unknown-module fail-safe decides the channels");
  assert.doesNotMatch(
    row[1],
    /"email"/,
    "email must not be in the module DEFAULT. One email to B-10 is already two deliveries — " +
      "send-phoenix-email.ts mirrors a preview of every email to his Telegram — " +
      "so defaulting to email means three notifications a morning about one board. The weekly send asks " +
      "for it explicitly; the guard is what makes that safe.",
  );
  assert.match(row[1], /telegramAllowed: true/, "the daily digest reaches him on Telegram");

  assert.equal(NEEDS_YOU_EMAIL_HR_ID, "B-10", "the recipient is a hardcoded identity, not a setting an admin screen can widen");
}
