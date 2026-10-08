import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PRIVATE_CALENDAR_DISPUTE_MESSAGE_MAX_LENGTH,
  resolveDisputeThreadActor,
} from "../src/lib/private-calendar/dispute-messages.ts";
import { resolveConversationAudience } from "../src/lib/conversations/notify.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A Private Calendar review request is a CONVERSATION, not two one-shot statements.
//
// Before this, an employee pressing "Request review" on a day typed one claim, the Super Admin typed
// one decision note, and there was no way to ask "which manager confirmed it?" before deciding — so
// the only way to resolve an unclear request was to reject it and wait for a second one.
//
// The four properties this pins, because each one wrong reintroduces a specific defect:
//   1. The audience is narrow. The employee who raised it, or a Super Admin — NOT everybody holding
//      `attendance:read`, which is most of the management chain. The route's matrix permission is
//      only a door; resolveDisputeThreadActor is the gate.
//   2. Every reply is delivered on email + in-app + Telegram + push, through the ONE shared
//      addressing rule in conversations/notify.ts, with the message id as its per-message key — a
//      thread whose second message is deduplicated onto the first is silent, which is indistinguishable
//      from nobody having replied.
//   3. The opening claim is not copied into the replies table. One stored copy of what the employee
//      wrote, rendered as the thread's first line.
//   4. Both surfaces mount the SAME thread component, so the employee and the reviewer cannot end up
//      disagreeing about who said what.
// ─────────────────────────────────────────────────────────────────────────────

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

export function runPrivateCalendarReviewRequestThreadTests() {
  // ── 1 · The audience gate ───────────────────────────────────────────────────────────────────────
  (function theGateIsOwnerOrSuperAdmin() {
    const owner = resolveDisputeThreadActor({ employeeHrId: "AI-0013", hrId: "ai-0013", role: "Employee" });
    assert.equal(owner.isAdmin, false, "the employee who raised it is not an admin on his own thread");
    assert.equal(owner.hrId, "ai-0013");

    const admin = resolveDisputeThreadActor({ employeeHrId: "AI-0013", hrId: "B-10", role: "Super Admin" });
    assert.equal(admin.isAdmin, true, "a Super Admin is marked as the reviewing side");

    // The whole point: holding attendance:read is not standing in this conversation.
    for (const role of ["District Manager", "Regional Manager", "National Sales Manager", "HR Operations", "CEO"]) {
      assert.throws(
        () => resolveDisputeThreadActor({ employeeHrId: "AI-0013", hrId: "AI-0099", role }),
        /Forbidden/,
        `${role} must not reach a colleague's review-request conversation`,
      );
    }

    // An unlinked profile is refused rather than written as a blank author.
    assert.throws(
      () => resolveDisputeThreadActor({ employeeHrId: "AI-0013", hrId: null, role: "Super Admin" }),
      /not linked/,
      "an admin with no HR id on his session cannot author a reply",
    );
  })();

  // ── 2 · Delivery goes through the one shared notifier, on all four channels ─────────────────────
  (function everyReplyIsDeliveredFourWays() {
    const service = read("src/lib/private-calendar/dispute-messages.ts");
    assert.match(
      service,
      /import \{ notifyConversationMessage \} from "@\/lib\/conversations\/notify";/,
      "replies are delivered by the shared conversation notifier, never a private copy of the addressing rule",
    );
    assert.match(service, /messageKey: message\.id/, "the message id is the per-message key, so a second reply is not deduplicated onto the first");
    assert.match(service, /submitterHrId: dispute\.employee_hr_id/, "the thread belongs to the employee who raised it — he is the email's To");

    // The channel list itself lives in the shared notifier. Assert it there, so this test fails if
    // somebody narrows Telegram or email out from under every conversation in the system.
    const notify = read("src/lib/conversations/notify.ts");
    assert.match(
      notify,
      /\["in_app", "email", "telegram", "push"\]/,
      "the primary recipient of a conversation message is told in-app, by email, on Telegram and by push",
    );

    // The employee lands on his own calendar; the reviewer lands in the hub. One notification, two
    // destinations, resolved per role at read time.
    assert.match(service, /actionUrl: "\/employee-portals\/private-calendar"/, "the employee's link lands on his calendar");
    assert.match(
      service,
      /roleHrefs: \{ "Super Admin": "\/admin\/private-calendar-disputes" \}/,
      "the Super Admin's link lands on the Calendar Disputes inbox",
    );

    // The addressing itself, asserted on the shared pure function: the owner is the To, the author is
    // copied, and nobody is addressed twice.
    const audience = resolveConversationAudience({
      authorHrId: "B-10",
      participantHrIds: ["AI-0013", "B-10"],
      submitterHrId: "AI-0013",
    });
    assert.deepEqual(audience.notifyKeys, ["AI-0013"], "the employee who raised it is the primary recipient");
    assert.deepEqual(audience.ccKeys, ["B-10"], "the Super Admin who replied is copied");
  })();

  // ── 3 · One stored copy of the opening claim, and a bounded body ────────────────────────────────
  (function theClaimIsNotDuplicated() {
    const migration = read("supabase/migrations/20261007164500_private_calendar_dispute_messages.sql");
    assert.match(migration, /create table if not exists public\.private_calendar_dispute_messages/);
    assert.match(
      migration,
      /references public\.private_calendar_data_disputes \(id\) on delete cascade/,
      "a reply belongs to its request and cannot outlive it",
    );
    assert.match(migration, /enable row level security/, "service-role only, like the request table — the browser never reads it directly");
    assert.doesNotMatch(migration, /\bauthor_name\b/, "the author's NAME is resolved from employees at read time, never frozen into the row");

    const service = read("src/lib/private-calendar/dispute-messages.ts");
    // One stored copy of what the employee wrote: the insert writes exactly the four columns the row
    // has, and nothing resembling the claim. Sliced by index rather than matched with a dot-all regex,
    // which this repo's TS target does not allow.
    const insertStart = service.indexOf(".insert({");
    assert.notEqual(insertStart, -1, "the replies service inserts a row");
    const insertBlock = service.slice(insertStart, service.indexOf("})", insertStart));
    // `body` is written in shorthand, so the column name alone is what every one of them has in common.
    for (const column of ["author_hr_id", "author_is_admin", "body", "dispute_id"]) {
      assert.ok(insertBlock.includes(column), `the insert writes ${column}`);
    }
    assert.ok(
      !insertBlock.includes("claim"),
      "the request's own claim is never copied into the replies table",
    );
    assert.equal(PRIVATE_CALENDAR_DISPUTE_MESSAGE_MAX_LENGTH, 2000, "a reply is bounded before it reaches the database");
    const emptyGuard = service.indexOf(
      'if (!body && images.length === 0) throw new Error("Write something before sending.");',
    );
    assert.notEqual(emptyGuard, -1, "a reply with neither words nor pictures is refused");
    assert.ok(emptyGuard < insertStart, "…and refused before any DB call");
    assert.match(
      service,
      /body = picturesOnlyBody\(images\.length\)/,
      "a picture-only reply is stored with a stand-in body, never an empty one",
    );
  })();

  // ── 4 · Both surfaces mount the same thread ────────────────────────────────────────────────────
  (function oneThreadTwoSurfaces() {
    const thread = read("src/components/private-calendar/review-request-thread.tsx");
    assert.match(thread, /request\.claimText/, "the thread renders the opening claim as its first line");
    assert.match(
      thread,
      /request\.status !== "pending_review"/,
      "a decided request shows the decision as the last word and closes the reply box",
    );

    for (const [surface, file] of [
      ["the employee's calendar", "src/components/employee-portal/private-calendar.tsx"],
      ["the reviewer's Calendar Disputes inbox", "src/components/admin/private-calendar-disputes-workspace.tsx"],
    ] as const) {
      const source = read(file);
      assert.match(
        source,
        /import \{ PrivateCalendarReviewRequestThread \} from "@\/components\/private-calendar\/review-request-thread";/,
        `${surface} mounts the shared thread component`,
      );
      assert.match(source, /<PrivateCalendarReviewRequestThread/, `${surface} actually renders it`);
    }

    // The employee's own calendar only — never a manager paging through somebody else's day.
    const calendar = read("src/components/employee-portal/private-calendar.tsx");
    assert.match(
      calendar,
      /canActOnOwnDay && selectedDayReviewRequests\.length > 0/,
      "the thread is shown on the viewer's OWN calendar only, the same gate as Request review itself",
    );

    // The route is declared, or the required validate job goes red — and both verbs are CSRF-guarded.
    const registry = read("src/lib/security/access-registry.ts");
    assert.match(
      registry,
      /pattern: "\/api\/private-calendar\/disputes\/:id\/messages"/,
      "the thread route is declared in the access registry",
    );
    const route = read("app/api/private-calendar/disputes/[id]/messages/route.ts");
    assert.match(route, /assertSameOriginMutation\(request\)/, "the POST is CSRF-guarded");
  })();
}
