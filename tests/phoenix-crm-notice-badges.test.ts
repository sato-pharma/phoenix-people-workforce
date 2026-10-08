import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  groupUnreadByModule,
  newBadgeText,
  phoenixCrmModuleOfNotice,
  phoenixCrmNoticePulses,
  PHOENIX_CRM_NOTICE_STRIP_LIMIT,
  PHOENIX_CRM_NOTICES_THAT_NEVER_PULSE,
  type PhoenixCrmUnreadNotice,
} from "../src/lib/phoenix-crm/notice-badge-rules.ts";

/**
 * Phoenix CRM — the pulsing "new" badges (owner, 2026-10-08: "show pumping badges beside the thing that
 * has a notification. I want the people to be alerted").
 *
 * What this pins, without a database:
 *   1. a notice marks the module its own link opens — `?tab=` (every sender) and `/field-crm/<slug>`
 *      (the reminder) — and a link anywhere else marks nothing;
 *   2. the feeds never pulse, and the number is capped at 99+;
 *   3. the strip is newest-first and bounded, while the badge counts every one;
 *   4. the screens draw it, and it is cleared from a MOUNTED page, never from a server render (a link
 *      prefetch renders the page on the server with nobody looking);
 *   5. the clearing route is declared, session-guarded and CSRF-checked, and writes only the caller's rows.
 */

const notice = (id: string, eventType: string, actionUrl: string | null, createdAt: string): PhoenixCrmUnreadNotice => ({
  actionUrl,
  createdAt,
  eventType,
  id,
  title: `notice ${id}`,
});

export function runPhoenixCrmNoticeBadgeTests() {
  // ── 1. Which module a notice opens ────────────────────────────────────────────────────────────
  {
    const portal = "/employee-portals/field-crm";
    assert.equal(phoenixCrmModuleOfNotice(`${portal}?tab=plan`), "plan");
    assert.equal(phoenixCrmModuleOfNotice(`${portal}?tab=team`), "team");
    assert.equal(phoenixCrmModuleOfNotice(`${portal}?tab=list`), "list");
    assert.equal(phoenixCrmModuleOfNotice(`${portal}?tab=visits`), "visits");
    assert.equal(phoenixCrmModuleOfNotice(`${portal}?tab=reports&section=exceptions`), "reports", "a section rides along without hiding the module");
    assert.equal(phoenixCrmModuleOfNotice(`${portal}/plan`), "plan", "the plan reminder writes the module's own path");
    assert.equal(phoenixCrmModuleOfNotice(`${portal}/directory`), "doctors", "the Directory's slug is not its key");
    assert.equal(phoenixCrmModuleOfNotice(`${portal}?tab=nonsense`), null, "an unknown tab marks nothing");
    assert.equal(phoenixCrmModuleOfNotice(`${portal}`), null, "the chooser itself is no module");
    assert.equal(phoenixCrmModuleOfNotice("/admin/field-crm/validation-reviews"), null, "the Super Admin's own page is not a rep-app module");
    assert.equal(phoenixCrmModuleOfNotice("/admin/crm#phoenix-team-starts"), null);
    assert.equal(phoenixCrmModuleOfNotice(null), null);
    assert.equal(phoenixCrmModuleOfNotice(""), null);
    assert.equal(phoenixCrmModuleOfNotice("/somewhere/else?tab=plan"), null, "only the portal's Phoenix CRM address counts");
  }

  // ── 2. The feeds never pulse; the number is capped ────────────────────────────────────────────
  {
    assert.deepEqual(
      [...PHOENIX_CRM_NOTICES_THAT_NEVER_PULSE].sort(),
      ["activity_mirror", "crm_daily_digest", "crm_fraud_scan", "crm_visit_rollup"],
      "exactly the four reading-material feeds stay quiet",
    );
    for (const feed of PHOENIX_CRM_NOTICES_THAT_NEVER_PULSE) assert.equal(phoenixCrmNoticePulses(feed), false, `${feed} never pulses`);
    for (const eventType of ["plan_waiting", "plan_approved", "plan_returned", "unplanned_visit_waiting", "request_approved", "plan_edit_moved_on"]) {
      assert.equal(phoenixCrmNoticePulses(eventType), true, `${eventType} pulses`);
    }
    assert.equal(newBadgeText(1), "1 new");
    assert.equal(newBadgeText(99), "99 new");
    assert.equal(newBadgeText(100), "99+ new");
  }

  // ── 3. Grouping: newest first, the strip bounded, the badge counting every one ────────────────
  {
    const rows: PhoenixCrmUnreadNotice[] = [
      notice("a", "plan_approved", "/employee-portals/field-crm?tab=plan", "2026-10-08T10:00:00Z"),
      notice("b", "plan_returned", "/employee-portals/field-crm?tab=plan", "2026-10-08T12:00:00Z"),
      notice("c", "activity_mirror", "/employee-portals/field-crm?tab=team", "2026-10-08T13:00:00Z"),
      notice("d", "plan_waiting", "/employee-portals/field-crm?tab=team", "2026-10-08T11:00:00Z"),
      notice("e", "validation_review_waiting", "/admin/field-crm/validation-reviews", "2026-10-08T09:00:00Z"),
    ];
    const grouped = groupUnreadByModule(rows);
    assert.equal(grouped.plan?.count, 2);
    assert.deepEqual(grouped.plan?.notices.map((entry) => entry.id), ["b", "a"], "newest first");
    assert.equal(grouped.team?.count, 1, "the activity mirror did not make Team pulse");
    assert.deepEqual(grouped.team?.notices.map((entry) => entry.id), ["d"]);
    assert.equal(Object.keys(grouped).length, 2, "the admin-page notice marks no rep-app module");

    const many = Array.from({ length: PHOENIX_CRM_NOTICE_STRIP_LIMIT + 3 }, (_, index) =>
      notice(`n${index}`, "unplanned_visit_waiting", "/employee-portals/field-crm?tab=team", `2026-10-08T10:${String(index).padStart(2, "0")}:00Z`),
    );
    const big = groupUnreadByModule(many).team;
    assert.equal(big?.count, PHOENIX_CRM_NOTICE_STRIP_LIMIT + 3, "the badge counts every unread notice");
    assert.equal(big?.notices.length, PHOENIX_CRM_NOTICE_STRIP_LIMIT, "the strip names only the newest few");
    assert.deepEqual(groupUnreadByModule([]), {}, "nothing unread, nothing pulses");
  }

  // ── 4. The screens draw it; clearing is a mounted page's job ─────────────────────────────────
  {
    const chooser = readFileSync("src/components/phoenix-crm/module-chooser.tsx", "utf8");
    assert.match(chooser, /<PhoenixCrmNewBadge count=\{unread\?\.\[module\.key\]\?\.count \?\? 0\} \/>/, "every card carries the pulsing mark beside its name");
    assert.match(chooser, /unread: PhoenixCrmUnreadByModule \| null;/, "and a failed read is null, drawn as no mark rather than as 'nothing new'");

    const badge = readFileSync("src/components/phoenix-crm/new-badge.tsx", "utf8");
    assert.match(badge, /motion-safe:animate-ping/, "it pulses, and only for a reader who has not asked for less motion");
    assert.doesNotMatch(badge, /rounded-(full|md|lg|xl|sm)\b|rounded\b(?!-none)/, "square edges only (the module's golden rule)");
    assert.equal(/"use client"/.test(badge), false, "the badge ships no script");

    const seen = readFileSync("src/components/phoenix-crm/notices-seen.tsx", "utf8");
    assert.match(seen, /^"use client";/, "clearing is a client effect");
    assert.match(seen, /useEffect\(/, "…run on mount");
    assert.match(seen, /\/api\/phoenix-crm\/notices\/seen/);

    const modulePage = readFileSync("app/employee-portals/field-crm/[module]/page.tsx", "utf8");
    assert.match(modulePage, /<PhoenixCrmNewNotices entry=\{unread\?\.\[moduleKey\]\} \/>/, "the module page names what is new");
    assert.match(modulePage, /<PhoenixCrmNoticesSeen moduleKey=\{moduleKey\} pending=\{/, "and clears it from the mounted page");
    assert.doesNotMatch(modulePage, /markPhoenixCrmModuleNoticesRead/, "🔴 never from the server render — a link prefetch renders it with nobody looking");
    const chooserPage = readFileSync("app/employee-portals/field-crm/page.tsx", "utf8");
    assert.doesNotMatch(chooserPage, /markPhoenixCrmModuleNoticesRead/, "and the chooser only shows the pulse, it never clears one");
  }

  // ── 5. The clearing route ────────────────────────────────────────────────────────────────────
  {
    assert.ok(existsSync("app/api/phoenix-crm/notices/seen/route.ts"));
    const route = readFileSync("app/api/phoenix-crm/notices/seen/route.ts", "utf8");
    assert.match(route, /assertSameOriginMutation\(request\)/, "CSRF-checked");
    assert.match(route, /assertPermission\(access, "phoenix_crm", "read"\)/, "session-guarded");
    assert.match(route, /isPhoenixCrmModuleKey\(moduleKey\)/, "the body names a module, validated against the closed list");
    assert.doesNotMatch(route, /hrId|hr_id|notificationId/, "no person and no notice id in the body — nothing to forge");

    const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
    assert.match(registry, /pattern: "\/api\/phoenix-crm\/notices\/seen"[^\n]*csrfRequired: true/, "declared in the access registry, CSRF required");

    // The notification tables are the notifications module's, not Phoenix CRM's (its boundary test
    // forbids reading them from its server folder), so the reading and the marking live there.
    const reader = readFileSync("src/lib/notifications/unread.ts", "utf8");
    assert.match(reader, /viewerIdentity\(access\)/, "the identity comes from the session");
    assert.match(reader, /testNoticeVisibleToViewer\(identity\.testLoginId, row\)/, "a test-world notice pulses only for the test login it was written for");
    assert.match(reader, /read_at \|\| state\.archived_at/, "a read or archived notice never pulses");
    assert.match(reader, /canViewerSeeNotification\(/, "and a row not addressed to him is dropped after the query, fail-closed");
    const server = readFileSync("src/lib/phoenix-crm/server/unread-notices.ts", "utf8");
    assert.doesNotMatch(server, /\.from\(/, "Phoenix CRM's server folder reads no notification table itself");
    assert.match(server, /return null;/, "a failed read answers null, not an empty result");
    assert.match(server, /phoenixCrmNoticePulses\(row\.eventType\)/, "the feeds are dropped before anything is counted");
  }
}
