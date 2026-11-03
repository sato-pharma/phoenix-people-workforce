import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import { todayInCairo } from "../src/lib/date-only.ts";
import { ARCHIVE_CHECK_GAP_MS, listInAppNoticeBundleForViewer, type NoticeReadClient } from "../src/lib/notifications/in-app.ts";
import { pushIdentityOf } from "../src/lib/notifications/push-identity.ts";
import {
  PUSH_REGISTRATION_MEMO_MAX_AGE_MS,
  parsePushRegistrationMemo,
  pushRegistrationAlreadyReported,
} from "../src/lib/notifications/push-registration-memo.ts";
import { PERSONAL_BELL_CATEGORIES } from "../src/lib/notifications/recipients.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE SHELL STOPS CHATTERING (owner, 1 Nov 2026: "find the ROOT root cause of the slowness").
 *
 * Every Phoenix page view cost about fifteen Supabase requests before any data arrived, and the
 * open tab kept paying: the pulse every minute (a session read, then three notification_events reads,
 * a notification_user_states read and, for an approver, up to five approval reads), the envelope's
 * whole message list on every mount for one number, a five-read "is a mailbox connected" check for
 * everyone, the push context on every page, a push_subscriptions upsert on every page, and one
 * activity POST per navigation. Each request costs about 450 ms at Supabase's edge on the saturated
 * host for 2-7 ms of SQL (measured 1 Nov 2026, 10:30-11:00 Cairo: 36,104 requests in half an hour),
 * so the NUMBER of requests is the lever.
 *
 * This suite pins the shape that stops it:
 *   1. the bell is ONE RPC after the session (phx_in_app_notices), and falls back to the old reads only
 *      where the function is missing;
 *   2. the pulse carries the envelope's unread count, and the menu draws its badge from it;
 *   3. the approver archive runs after the response, throttled;
 *   4. the shell's render prints the mailbox connection and the push identity into its HTML, so the
 *      browser asks the server for neither;
 *   5. the push registration is reported once a week per browser and person, not once a page;
 *   6. page views go to /api/activity/track in one batch per tab.
 *
 * Files are read inside the run function, never at module load, so a break test sees the edited file.
 */

function code(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

function raw(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** The source of one function: from its declaration to the next top-level declaration. */
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} is found`);
  const rest = source.slice(start + declaration.length);
  const next = rest.search(/\n(?:export )?(?:async )?function |\nexport (?:const|type|interface) |\nconst \w+ = (?:unstable_cache|cache)\(/);
  return next === -1 ? source.slice(start) : source.slice(start, start + declaration.length + next);
}

type Answer = { data: unknown; error: unknown };
type RecordedCall = { table: string; method: string; args: unknown[] };

/**
 * The two doors the bundle read uses, faked: `rpc` answers what the test says, and every `from(...)`
 * chain answers an empty page while recording each call it was asked for.
 */
function fakeClient(rpcAnswer: Answer, tableAnswer: Answer = { data: [], error: null }) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tableCalls: RecordedCall[] = [];
  const builder = (table: string) => {
    const self: object = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") {
            return (resolve: (value: Answer) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(tableAnswer).then(resolve, reject);
          }
          return (...args: unknown[]) => {
            tableCalls.push({ table, method: String(property), args });
            return self;
          };
        },
      },
    );
    return self;
  };
  const client = {
    from(table: string) {
      tableCalls.push({ table, method: "from", args: [] });
      return builder(table);
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return Promise.resolve(rpcAnswer);
    },
  } as unknown as NoticeReadClient;
  return { client, rpcCalls, tableCalls };
}

const REP: AccessContext = { hrId: "PD-0030", loginId: "pd0030", role: "Medical Rep", scope: "self", source: "session" };

export async function runShellChatterTests() {
  // ── 1. The bell is ONE RPC after the session ─────────────────────────────────────────────────
  {
    const { client, rpcCalls, tableCalls } = fakeClient({ data: { events: [], states: [], unread_messages: 3 }, error: null });
    const bundle = await listInAppNoticeBundleForViewer(REP, 8, client);
    assert.deepEqual(bundle, { notices: [], unreadMessages: 3 }, "the bundle is the notices and the envelope's count");
    assert.equal(rpcCalls.length, 1, "HEADLINE: one RPC — the bell used to cost three or four reads on every pulse of every open tab");
    assert.equal(rpcCalls[0].name, "phx_in_app_notices");
    assert.equal(tableCalls.length, 0, "and no PostgREST read beside it");

    const args = rpcCalls[0].args;
    assert.equal(args.p_today, todayInCairo(), "the RPC is fenced at the Cairo day, like the reads it replaces");
    assert.deepEqual(args.p_categories, Array.from(PERSONAL_BELL_CATEGORIES), "the personal-bell category allowlist goes with it");
    assert.equal(args.p_other_kinds, false, "a rep's seat is not the flooded one");
    assert.equal(typeof args.p_limit, "number", "the read limit is the seat's");
    assert.equal(args.p_user_id, "pd0030", "the read states are the session's own");
    assert.equal(args.p_msg_hr_id, "pd-0030", "the envelope is counted for the viewer's own HR id, normalised as the messages list normalises it");
    assert.equal(args.p_login_id, "pd0030", "and the viewer's own login");
  }

  // The messages count is optional: a database that answers null for it leaves the badge to the menu.
  {
    const { client } = fakeClient({ data: { events: [], states: [], unread_messages: null }, error: null });
    const bundle = await listInAppNoticeBundleForViewer(REP, 8, client);
    assert.equal(bundle.unreadMessages, null, "no count is null, never zero — zero would clear a badge that may be lit");
  }

  // A session with no HR id (an admin account): the list finds the employee by the login id, so the
  // statement is asked under that same key, and the badge stays live on every pulse.
  {
    const { client, rpcCalls } = fakeClient({ data: { events: [], states: [], unread_messages: 2 }, error: null });
    const loginOnly = await listInAppNoticeBundleForViewer({ ...REP, hrId: null }, 8, client);
    assert.equal(loginOnly.unreadMessages, 2, "a session with only a login id keeps its live count");
    assert.equal(rpcCalls[0].args.p_msg_hr_id, "pd0030", "asked under the employee key the list resolves from the login id");
    assert.equal(rpcCalls[0].args.p_login_id, "pd0030", "and by the login itself");
  }

  // A session with no login id: the list would read the login from the auth row, and this statement
  // cannot, so it is asked for no count at all. The migration answers null when both ids are blank.
  {
    const { client, rpcCalls } = fakeClient({ data: { events: [], states: [], unread_messages: null }, error: null });
    const hrOnly = await listInAppNoticeBundleForViewer({ ...REP, loginId: null }, 8, client);
    assert.equal(hrOnly.unreadMessages, null, "the menu reads its own count once");
    assert.equal(rpcCalls[0].args.p_msg_hr_id, "", "no HR id is sent, so the statement scans no messages for a count nobody would use");
    assert.equal(rpcCalls[0].args.p_login_id, "", "and no login");
    assert.equal(rpcCalls[0].args.p_hr_id, "pd-0030", "the bell's own read is untouched");
  }

  // ── 1b. A database the migration has not reached: the four reads, exactly as before ──────────
  {
    const { client, rpcCalls, tableCalls } = fakeClient({
      data: null,
      error: { code: "PGRST202", details: null, hint: null, message: "Could not find the function public.phx_in_app_notices(p_categories, …) in the schema cache" },
    });
    const bundle = await listInAppNoticeBundleForViewer(REP, 8, client);
    assert.deepEqual(bundle, { notices: [], unreadMessages: null }, "the fallback has no count to give — the menu fetches its own once");
    assert.equal(rpcCalls.length, 1, "the RPC was tried first");
    const reads = tableCalls.filter((call) => call.method === "from");
    assert.deepEqual(
      reads.map((call) => call.table),
      ["notification_events", "notification_events"],
      "a rep's fallback is the two notification_events reads (own and named); the flooded seat's third read is hers alone",
    );
    assert.equal(tableCalls.filter((call) => call.table === "notification_user_states").length, 0, "no rows, so no state read");

    // The SQL and the fallback must agree on the identity they filter by, or a notice would show on
    // one road and not the other: own notices by the UPPER-CASED id, named notices and states by the
    // normalised id as given (the migration reads `upper(p_hr_id)` and `array[p_hr_id]`).
    const hrId = String(rpcCalls[0].args.p_hr_id);
    const eqOwn = tableCalls.find((call) => call.method === "eq" && call.args[0] === "employee_hr_id");
    const overlaps = tableCalls.find((call) => call.method === "overlaps" && call.args[0] === "recipients");
    assert.ok(eqOwn && overlaps, "both fallback reads are the ones the SQL mirrors");
    assert.equal(eqOwn?.args[1], hrId.toUpperCase(), "own notices: the upper-cased id, as `upper(p_hr_id)`");
    assert.deepEqual(overlaps?.args[1], [hrId], "named notices: the id as given, as `array[p_hr_id]`");
    const fence = tableCalls.filter((call) => call.method === "lte" && call.args[0] === "scheduled_for");
    assert.equal(fence.length, 2, "each fallback read is fenced at today");
    assert.ok(fence.every((call) => call.args[1] === todayInCairo()));
  }

  // Any other failure of the RPC is the bell's failure, raised as before — never silently empty.
  {
    const { client } = fakeClient({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    await assert.rejects(
      () => listInAppNoticeBundleForViewer(REP, 8, client),
      (error: unknown) => (error as { code?: string }).code === "57014",
      "a PostgREST error is a plain object, raised as it came",
    );
  }

  // A viewer with no identity reads nothing and asks nothing.
  {
    const { client, rpcCalls } = fakeClient({ data: {}, error: null });
    const guest: AccessContext = { hrId: null, loginId: null, role: "Employee", scope: "none", source: "guest" };
    assert.deepEqual(await listInAppNoticeBundleForViewer(guest, 8, client), { notices: [], unreadMessages: null });
    assert.equal(rpcCalls.length, 0);
  }

  // ── 1c. The source: the RPC and its fallback, and the migration that defines it ──────────────
  {
    const inApp = code("src/lib/notifications/in-app.ts");
    const bundle = functionBody(inApp, "export async function listInAppNoticeBundleForViewer(");
    assert.match(bundle, /supabase\.rpc\("phx_in_app_notices", \{/, "the bundle asks the one function");
    assert.match(bundle, /if \(rpc\.error && !isMissingRpcError\(rpc\.error\)\) throw rpc\.error;/, "only a MISSING function falls back — any other error is the bell's error");
    assert.doesNotMatch(inApp, /PGRST202/, "the bell asks the one shared rule and keeps no copy of it");
    assert.match(code("src/lib/crm/reads.ts"), /export \{ isMissingRpcError as isMissingCrmRpcError \};/, "the CRM's name for it is one line, never a second rule");
    assert.doesNotMatch(code("src/lib/supabase/errors.ts"), /^import /m, "the rule's file imports nothing, so a reader on the shell's path loads no domain");
    assert.match(bundle, /await legacyNoticeReads\(/, "the fallback is the old reads, kept in one place");
    assert.doesNotMatch(bundle, /await archiveStaleApprovalNotifications\(/, "the approver archive is never awaited on the bell's path again");
    assert.match(bundle, /scheduleStaleApprovalArchive\(/, "it is scheduled after the response instead");
    assert.match(
      functionBody(inApp, "function scheduleStaleApprovalArchive("),
      /afterResponse\("in-app-notices-archive", \(\) => archiveStaleApprovalNotifications\(access, candidates\)\)/,
      "the archive runs through afterResponse, with the rows not already archived",
    );
    assert.equal(ARCHIVE_CHECK_GAP_MS, 2 * 60_000, "and not again for the same viewer and set inside two minutes — a decided notice lingers three minutes at most");

    const migration = raw("supabase/migrations/20261101230000_phx_in_app_notices.sql");
    assert.match(migration, /create or replace function public\.phx_in_app_notices\(/);
    assert.match(migration, /security definer/, "it reads as the definer, like every phx_* function the admin client calls");
    assert.match(migration, /revoke execute on function public\.phx_in_app_notices\([^)]*\) from public, anon, authenticated;/, "nobody but the service role may call it");
    assert.match(migration, /grant execute on function public\.phx_in_app_notices\([^)]*\) to service_role;/);
    assert.match(migration, /order by m\.created_at desc\s*limit 20/, "the envelope's count is capped at the newest twenty — the twenty the menu shows and marks read");
    assert.match(migration, /'unread_messages',\s*case\s*when coalesce\(p_msg_hr_id, ''\) = '' and coalesce\(p_login_id, ''\) = '' then null/, "no identity, no count: null, never zero");
    assert.match(migration, /notify pgrst, 'reload schema';/, "PostgREST learns the new function at once");
  }

  // ── 2. The pulse carries the envelope's count, and the menu draws its badge from it ───────────
  {
    const pulse = code("app/api/auth/pulse/route.ts");
    assert.match(pulse, /const bundle = await listInAppNoticeBundleForViewer\(access\);/, "the pulse reads the bundle");
    assert.match(pulse, /return \{ data: bundle\.notices, success: true, unreadMessages: bundle\.unreadMessages \};/, "and hands the count down beside the notices");
    assert.doesNotMatch(pulse, /listInAppNotificationsForViewer/, "never the notices-only read — that would drop the count");

    const store = code("src/lib/session-pulse-store.ts");
    assert.match(store, /unreadMessages\?: number \| null;/, "the pulse's notices half declares the count");

    const menu = code("src/components/layout/internal-messages-menu.tsx");
    assert.match(menu, /import \{ subscribePulseNotices \} from "@\/lib\/session-pulse-store";/);
    assert.match(menu, /if \(typeof notices\.unreadMessages === "number"\) \{\s*setUnreadCount\(notices\.unreadMessages\);\s*return;\s*\}/, "a number sets the badge and nothing is fetched");
    assert.match(menu, /if \(fetchedOnce\.current\) return;\s*fetchedOnce\.current = true;\s*void loadMessages\(\);/, "no count (the function is missing) fetches the list ONCE, as before");
    assert.doesNotMatch(menu, /window\.setTimeout\(\(\) => void loadMessages\(\), 0\)/, "the mount-time fetch of the whole list is gone");
    assert.match(menu, /loadMessages\(\{ markRead: tab === "internal" \}\)/, "the open panel still re-reads and marks read");
  }

  // ── 3. The shell's HTML carries the mailbox connection and the push identity ──────────────────
  {
    const service = code("src/lib/employee-portal/service.ts");
    // The wave may carry more (the manager's name and the photo joined it the same night); what is pinned
    // is that the mailbox connection is read BESIDE the viewer and the directory, never after them.
    assert.match(
      service,
      /const \[currentUser, directory, mailboxConnected(?:, \w+)*\] = await Promise\.all\(\[\s*resolvePortalCurrentUser\(access\),\s*getEmployeeDirectory\(\),\s*personalMailboxConnected\(access\),/,
      "the portal shell reads the mailbox connection in the SAME wave as the viewer and the directory",
    );
    assert.match(service, /pushHrId: pushIdentityOf\(access\),/, "and prints the push identity it already holds");
    assert.match(service, /mailboxConnected: boolean;[\s\S]*?pushHrId: string \| null;/, "both are part of the shell data every portal page renders");

    const layout = code("src/components/employee-portal/employee-portal-layout.tsx");
    assert.match(layout, /<OneSignalProvider pushHrId=\{data\.pushHrId\} \/>/, "the portal's OneSignal provider is told who this is");
    assert.match(layout, /<EmployeePortalInbox mailboxConnected=\{data\.mailboxConnected\} \/>/, "the portal inbox is told about the mailbox");
    assert.match(layout, /<InternalMessagesMenu embedded isAdminMode=\{false\} mailboxConnected=\{mailboxConnected\} onUnreadChange=\{setMessageUnread\} \/>/);

    const appShell = code("src/components/layout/app-shell.tsx");
    assert.match(
      appShell,
      /const \[\{ layout: personalLayout \}, viewer, mailboxConnected, pushHrId\] = await Promise\.all\(\[[\s\S]*?personalMailboxConnected\(access\),\s*resolvePushIdentity\(access\),\s*\]\);/,
      "the admin shell reads both in its one wave — never a second await",
    );
    assert.match(appShell, /<OneSignalProvider pushHrId=\{pushHrId\} \/>/);
    assert.match(appShell, /mailboxConnected=\{mailboxConnected\}/, "and hands the mailbox state to the top bar");
    const topbar = code("src/components/layout/topbar.tsx");
    assert.match(topbar, /<InternalMessagesMenu isAdminMode=\{isAdminMode\} mailboxConnected=\{mailboxConnected\} \/>/);
    assert.equal((appShell.match(/await Promise\.all\(/g) ?? []).length, 2, "the admin shell still awaits its two waves (the access wave, then the chrome wave) — nothing was added");
    assert.doesNotMatch(appShell, /await personalMailboxConnected\(|await resolvePushIdentity\(/, "neither is awaited on its own — a sequential await would add a round trip to every admin page");
  }

  // ── 3b. The mailbox connection: one small read, remembered five minutes, busted by every write ─
  {
    const service = code("src/lib/personal-mailbox/service.ts");
    const connected = functionBody(service, "export async function personalMailboxConnected(");
    assert.match(connected, /if \(access\.source === "guest" \|\| access\.source === "system"\) return false;/, "a guest or the system has no mailbox");
    assert.match(connected, /return await readConnectionActive\(key, loginId\);/, "the read is the cached one");
    assert.match(connected, /catch \{\s*return false;\s*\}/, "and never throws — an unreadable row answers false");
    const cached = functionBody(service, "const readConnectionActive = unstable_cache(");
    assert.match(cached, /\.select\("status"\)/, "one column");
    assert.match(cached, /\.eq\("owner_key", ownerKey\)\s*\.eq\("owner_login_id", loginId\)/, "one row: the owner's, under the login the connection answers to");
    assert.match(cached, /revalidate: CONNECTION_CACHE_SECONDS, tags: \[PERSONAL_MAILBOX_CONNECTION_CACHE_TAG\]/, "five minutes, under the one tag");
    assert.match(service, /const CONNECTION_CACHE_SECONDS = 300;/);
    for (const [declaration, reason] of [
      ["async function markNeedsReconnect(", "a refused password"],
      ["export async function connectPersonalMailbox(", "a connection"],
      ["export async function connectNewHireMailbox(", "a new hire's connection"],
      ["export async function disconnectPersonalMailbox(", "a disconnection"],
      ["export async function purgeDepartedPersonalMailboxes(", "the departed purge"],
    ] as const) {
      assert.match(functionBody(service, declaration), /invalidatePersonalMailboxConnectionCache\(/, `${reason} busts every shell's memory of the connection`);
    }
    const invalidation = code("src/lib/dashboard/invalidation.ts");
    assert.match(invalidation, /export const PERSONAL_MAILBOX_CONNECTION_CACHE_TAG = "personal-mailbox-connection";/, "a bare string, like every tag in that file");
    assert.match(invalidation, /export function invalidatePersonalMailboxConnectionCache\(reason: string\) \{\s*try \{\s*revalidateTag\(PERSONAL_MAILBOX_CONNECTION_CACHE_TAG, \{ expire: 0 \}\);/, "expired at once, never stale-while-revalidate");

    const hook = code("src/hooks/use-personal-mailbox-alerts.ts");
    assert.match(hook, /enabled\?: boolean;/, "the hook takes what the shell knows");
    assert.match(hook, /const armed = armedByPage \|\| enabled !== false;/, "false means: ask nothing, unless this page connected a mailbox");
    assert.match(hook, /if \(!armed\) return;\s*let stopped = false;/, "the polling effect does not start unarmed");
    assert.match(hook, /const onChanged = \(\) => \{\s*setArmedByPage\(true\);/, "a connection made on this page arms the check for the rest of the page's life");
    assert.match(hook, /\}, \[armed, generation\]\);/, "and re-arms the effect");
    const menu = code("src/components/layout/internal-messages-menu.tsx");
    assert.match(menu, /usePersonalMailboxAlerts\(\{ canOpenEmail, enabled: mailboxConnected, onOpenEmail: openEmail \}\)/, "the envelope hands the hook the shell's answer");
  }

  // ── 4. The push identity: one rule, the same on the server and in the route the phone keeps ───
  {
    assert.equal(pushIdentityOf({ hrId: " pd-0030 ", seatView: null, testPersona: null }), "PD-0030", "upper-cased and trimmed, the form pushes are addressed to");
    assert.equal(pushIdentityOf({ hrId: "PD-0030", seatView: null, testPersona: { loginId: "test.rep" } as never }), null, "a test login gets no identity — its device must never move onto the mirrored person");
    assert.equal(pushIdentityOf({ hrId: "B-10", seatView: { seatId: "SEAT" } as never, testPersona: null }), null, "View as Seat gets none — the owner's device never moves onto the person he is viewing");
    assert.equal(pushIdentityOf({ hrId: null, seatView: null, testPersona: null }), null);
    // A blank id answers "": the provider's `if (identity)` already treats it as nobody to log in as.
    assert.equal(pushIdentityOf({ hrId: "   ", seatView: null, testPersona: null }), "", "a blank id is nobody to log in as");

    const route = code("app/api/notifications/push/context/route.ts");
    assert.match(route, /const hrId = pushIdentityOf\(access\);/, "the context route answers through the ONE rule");
    assert.doesNotMatch(route, /isReadOnlyViewer|toUpperCase/, "and keeps no copy of it");

    const provider = code("src/components/notifications/onesignal-provider.tsx");
    assert.match(provider, /export function OneSignalProvider\(\{ pushHrId \}: \{ pushHrId\?: string \| null \} = \{\}\)/, "the provider takes the identity from the shell");
    const shellSaid = provider.indexOf("if (pushHrId !== undefined) {");
    const fetchContext = provider.indexOf('fetch("/api/notifications/push/context"');
    assert.ok(shellSaid !== -1 && fetchContext > shellSaid, "when the shell said who this is, the context route is not fetched; a mount without the prop fetches it as before");
    assert.match(provider, /reportsSubscription = shouldReportPushSubscription\(true, \{ data: \{ hrId: pushHrId \} \}\);/, "the no-identity rule (a test account never registers) is applied to the shell's answer too");
    assert.match(provider, /if \(identity\) await OneSignal\.login\(identity\);/);
  }

  // ── 5. The push registration is reported once a week per browser and person, not once a page ─
  {
    const now = Date.UTC(2026, 10, 1, 12);
    const memo = { id: "sub-1", optedIn: true, at: now - 60_000 };
    assert.equal(pushRegistrationAlreadyReported(memo, { id: "sub-1", optedIn: true }, now), true, "same subscription, same opt-in, a minute old: skip the mount report");
    assert.equal(pushRegistrationAlreadyReported(memo, { id: "sub-1", optedIn: false }, now), false, "an opt-out is reported");
    assert.equal(pushRegistrationAlreadyReported(memo, { id: "sub-2", optedIn: true }, now), false, "a new subscription id is reported");
    assert.equal(pushRegistrationAlreadyReported(memo, { id: null, optedIn: true }, now), false, "no subscription id: nothing to skip");
    assert.equal(pushRegistrationAlreadyReported(null, { id: "sub-1", optedIn: true }, now), false, "no memo: report");
    assert.equal(
      pushRegistrationAlreadyReported({ ...memo, at: now - PUSH_REGISTRATION_MEMO_MAX_AGE_MS }, { id: "sub-1", optedIn: true }, now),
      false,
      "a week old is reported again, so push_subscriptions never goes stale for longer",
    );
    assert.equal(pushRegistrationAlreadyReported({ ...memo, at: now + 60_000 }, { id: "sub-1", optedIn: true }, now), false, "a memo from the future (a clock put back) is not trusted");
    assert.deepEqual(parsePushRegistrationMemo(JSON.stringify(memo)), memo, "a memo round-trips");
    assert.equal(parsePushRegistrationMemo("not json"), null);
    assert.equal(parsePushRegistrationMemo(JSON.stringify({ id: "", optedIn: true, at: now })), null, "an empty id is not a memo");
    assert.equal(parsePushRegistrationMemo(JSON.stringify({ id: "sub-1", optedIn: "yes", at: now })), null);
    assert.equal(parsePushRegistrationMemo(null), null);

    const provider = code("src/components/notifications/onesignal-provider.tsx");
    assert.match(provider, /if \(response\.ok\) writeRegistrationMemo\(memoKey, \{ at: Date\.now\(\), id: subscriptionId, optedIn \}\);/, "only a report the server accepted rewrites the memo");
    assert.ok(
      provider.indexOf('fetch("/api/notifications/push/register"') < provider.indexOf("writeRegistrationMemo(memoKey,"),
      "the memo is written after the request, never before it",
    );
    assert.match(provider, /if \(!alreadyReported\) \{\s*reportSubscriptionState\(OneSignal\.User\.PushSubscription\.optedIn, OneSignal\.User\.PushSubscription\.id, memoKey\);/, "the mount report is skipped while the memo says the same thing");
    assert.match(provider, /addEventListener\("change", \(event\) => \{\s*reportSubscriptionState\(event\.current\.optedIn, event\.current\.id, memoKey\);/, "a change is always reported — the memo is never consulted for it");
    const storage = code("src/lib/browser-storage/owner-scoped.ts");
    assert.match(storage, /export const PUSH_REGISTRATION_MEMO_KEY_BASE = "phoenix\.push\.registration\.v1";/);
  }

  // ── 5b. The interview calendar's two reads wait for the role ─────────────────────────────────
  {
    const page = code("app/employee-portals/interview-calendar/page.tsx");
    const refused = page.indexOf("if (!role) {");
    assert.ok(refused > 0 && page.indexOf("interviewCalendarAbilities(access)") > refused, "a viewer the calendar is not shared with never starts the abilities read");
    assert.ok(page.indexOf("mayRequestInterviews(access)") > refused, "nor the request read");
  }

  // ── 6. Page views go to /api/activity/track in one batch per tab ─────────────────────────────
  {
    const tracker = code("src/components/activity/activity-tracker.tsx");
    const pageViews = code("src/lib/activity/page-view-queue.ts");
    const route = code("app/api/activity/track/route.ts");
    assert.doesNotMatch(pageViews, /^import /m, "the queue is a leaf, so the sign-out can call it directly");
    assert.doesNotMatch(tracker, /fetch\(/, "the tracker sends nothing itself");
    const routeLimit = /const MAX_EVENTS_PER_REQUEST = (\d+);/.exec(route);
    const trackerLimit = /export const ACTIVITY_BATCH_LIMIT = (\d+);/.exec(pageViews);
    assert.ok(routeLimit && trackerLimit, "both sides name their batch limit");
    assert.equal(trackerLimit?.[1], routeLimit?.[1], "a full queue is exactly what the route accepts in one request — never a dropped tail");
    assert.match(pageViews, /export const ACTIVITY_FLUSH_INTERVAL_MS = 30_000;/, "one request per tab every thirty seconds");
    assert.match(pageViews, /body: JSON\.stringify\(\{ events \}\),\s*keepalive: true,/, "the batch is the route's `events` array, sent keepalive so a closing tab still delivers it");
    assert.equal((pageViews.match(/fetch\(ENDPOINT/g) ?? []).length, 1, "ONE fetch in the file — the one that sends a batch");
    const queueFn = functionBody(pageViews, "function queueActivityBeacon(");
    assert.doesNotMatch(queueFn, /fetch\(/, "queueing a page view sends nothing by itself");
    assert.match(queueFn, /if \(queue\.length >= ACTIVITY_BATCH_LIMIT\) \{\s*flushActivityQueue\(\);\s*return;\s*\}/, "a full queue goes at once");
    assert.match(queueFn, /flushTimer = window\.setTimeout\(\(\) => \{\s*flushTimer = null;\s*flushActivityQueue\(\);\s*\}, ACTIVITY_FLUSH_INTERVAL_MS\);/, "otherwise the first entry starts the thirty-second clock");
    assert.match(pageViews, /queue\.push\(\{ path, enteredAt: enteredAtIso, durationMs: Math\.round\(durationMs\) \}\)/, "each entry carries its own enteredAt, so the server records the true time however long it waited");
    const flush = functionBody(pageViews, "function flushActivityQueue(");
    assert.match(flush, /while \(queue\.length > 0\) sending\.push\(sendBatch\(queue\.splice\(0, ACTIVITY_BATCH_LIMIT\)\)\);/, "a flush sends everything, in route-sized batches");
    assert.match(tracker, /function flush\(\) \{[\s\S]*?flushActivityQueue\(\);\s*\}/, "hiding or leaving the tab flushes the queue — a hidden tab may never get its tick");
    assert.match(tracker, /window\.addEventListener\("pagehide", flush\);/);
    assert.match(route, /const events = extractEvents\(body\)\.slice\(0, MAX_EVENTS_PER_REQUEST\);/, "the route already reads the array");
  }
}
