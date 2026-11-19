// Approvals WhatsApp — the Super Admin's screen for the third company number (owner, 19 Nov 2026).
//
// Pins the six things the owner's brief named: the webhook hands the third number's traffic to the new store; ticks land
// by wamid; free text waits on the 24-hour window; pasted numbers are normalised and deduplicated; every route checks the
// Super Admin role itself; and Meta's TIER_250 refuses a batch over the day's limit.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { splitApprovalsLineDelivery } from "../src/lib/approvals/urgent-whatsapp-rules.ts";
import {
  APPROVALS_REPLY_WINDOW_MS,
  APPROVALS_TIER_LIMIT,
  approvalsReplyWindow,
  canUseApprovalsWhatsApp,
  dedupeRecipients,
  normaliseApprovalsPhone,
  parsePastedNumbers,
  tier250Check,
} from "../src/lib/approvals-whatsapp/rules.ts";
import { reportOutcome } from "../src/lib/approvals-whatsapp/store.ts";
import { APPROVALS_INBOX_SURFACE, deliveryTickCount, RECRUITMENT_INBOX_SURFACE } from "../src/components/whatsapp-inbox/inbox-format.ts";
import { APPROVALS_WHATSAPP_STORE, RECRUITMENT_INBOX_STORE } from "../src/lib/whatsapp-inbox/record.ts";
import { parseInboxDelivery } from "../src/lib/whatsapp-inbox/webhook-parse.ts";

const THIRD = "1500950553091663";
const RECRUITMENT = "1319071451278873";
const MIGRATION = "supabase/migrations/20261119141357_approvals_whatsapp_module.sql";
const ROUTES_DIR = "app/api/admin/approvals-whatsapp";

function change(phoneNumberId: string, value: Record<string, unknown>) {
  return { field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "201040631155", phone_number_id: phoneNumberId }, ...value } };
}

function delivery(...changes: unknown[]) {
  return { entry: [{ changes, id: "2265574670642375" }], object: "whatsapp_business_account" };
}

// ── 1. The webhook splits the third number into the new store ──

function testTheWebhookKeepsTheThirdNumberApart() {
  const mixed = delivery(
    change(THIRD, {
      contacts: [{ profile: { name: "An approver" }, wa_id: "201012345678" }],
      messages: [{ from: "201012345678", id: "wamid.reply", text: { body: "تم" }, timestamp: "1763550000", type: "text" }],
      statuses: [{ id: "wamid.out", recipient_id: "201012345678", status: "read", timestamp: "1763550100" }],
    }),
    change(RECRUITMENT, {
      contacts: [{ profile: { name: "An applicant" }, wa_id: "201112345678" }],
      messages: [{ from: "201112345678", id: "wamid.cv", text: { body: "my CV" }, timestamp: "1763550000", type: "text" }],
    }),
  );
  const split = splitApprovalsLineDelivery(mixed, THIRD);

  assert.ok(split.approvalsPayload, "the third number's traffic is handed on, not thrown away");
  const kept = parseInboxDelivery(split.approvalsPayload);
  assert.deepEqual(kept.messages.map((message) => message.wamid), ["wamid.reply"], "the approver's reply reaches the Approvals WhatsApp store");
  assert.equal(kept.messages[0]?.phoneNumberId, THIRD, "filed against the approvals number");
  assert.deepEqual(kept.statuses.map((status) => [status.wamid, status.status]), [["wamid.out", "read"]], "and so does the read tick");

  const rest = parseInboxDelivery(split.payload);
  assert.deepEqual(rest.messages.map((message) => message.wamid), ["wamid.cv"], "the applicant still reaches the recruitment side, and only the applicant");
  assert.equal(rest.statuses.length, 0, "the approvals tick never reaches the WhatsApp Inbox");

  const none = delivery(change(RECRUITMENT, { messages: [{ from: "201112345678", id: "wamid.x", text: { body: "hi" }, timestamp: "1", type: "text" }] }));
  assert.equal(splitApprovalsLineDelivery(none, THIRD).approvalsPayload, null, "nothing on the third number: nothing handed on");
  assert.equal(splitApprovalsLineDelivery(mixed, null).approvalsPayload, null, "with the number unset, nothing is taken out");

  const webhook = stripComments(readFileSync("app/api/webhooks/whatsapp/route.ts", "utf8"));
  const split1 = webhook.indexOf("splitApprovalsLineDelivery(payload");
  const store = webhook.indexOf("recordInboxDelivery(approvalsLine.approvalsPayload, APPROVALS_WHATSAPP_STORE)");
  assert.ok(store > split1 && split1 > 0, "the webhook files the third number's traffic in the approvals store, after splitting it out");
  assert.ok(store < webhook.indexOf("recordInboxDelivery(payload)"), "before the recruitment inbox reads the rest");
  assert.ok(webhook.includes("applyApprovalsLineStatuses(approvalsLine.statuses)"), "the reminders' own ledger still gets its ticks");
  assert.match(webhook.slice(store, store + 400), /\.catch\(/u, "a failure to store never throws: the webhook still answers 200");

  assert.notEqual(APPROVALS_WHATSAPP_STORE.messagesTable, RECRUITMENT_INBOX_STORE.messagesTable, "separate tables, never the recruitment inbox's");
  assert.notEqual(APPROVALS_WHATSAPP_STORE.conversationsTable, RECRUITMENT_INBOX_STORE.conversationsTable);
}

// ── 2. Ticks by wamid, and every send from the line lands in the new store ──

function testTicksLandByWamid() {
  const sql = stripSqlComments(readFileSync(MIGRATION, "utf8"));
  const fn = sql.slice(sql.indexOf(`function public.${APPROVALS_WHATSAPP_STORE.applyStatusFunction}(`));
  assert.ok(fn.length < sql.length, "the migration creates the approvals tick function the store calls");
  assert.match(fn.slice(0, fn.indexOf("$$;", fn.indexOf("$$") + 2)), /where m\.wamid = p_wamid/u, "a tick finds its message by wamid");
  for (const table of ["lists", "list_members", "broadcasts", "broadcast_recipients", "conversations", "messages"]) {
    assert.ok(sql.includes(`alter table public.approvals_whatsapp_${table} enable row level security;`), `RLS on approvals_whatsapp_${table}`);
    assert.ok(sql.includes(`revoke all on table public.approvals_whatsapp_${table} from public, anon, authenticated;`), `no client grant on ${table}`);
    assert.ok(sql.includes(`grant all on table public.approvals_whatsapp_${table} to service_role;`), `service role only on ${table}`);
  }

  const sender = stripComments(readFileSync("src/lib/recruitment/inbound/whatsapp-interactive.ts", "utf8"));
  const body = sender.slice(sender.indexOf("async function postToGraph"), sender.indexOf("async function sendToGraph"));
  const guard = body.indexOf("if (isApprovalsLine(phoneNumberId))");
  assert.ok(guard > 0, "the shared sender knows the third number");
  const branch = body.slice(guard, body.indexOf("return result;", guard));
  assert.ok(branch.includes("APPROVALS_WHATSAPP_STORE"), "every send from the line, the reminders included, is filed in the approvals store");
  assert.ok(guard < body.indexOf("recordOutboundMessage("), "and leaves before the recruitment outbound report");

  assert.equal(deliveryTickCount("sent"), 1, "one grey tick");
  assert.equal(deliveryTickCount("delivered"), 2, "two grey ticks");
  assert.equal(deliveryTickCount("read"), 2, "two ticks, blue on this screen");
  assert.equal(deliveryTickCount("failed"), 0);
  assert.equal(APPROVALS_INBOX_SURFACE.blueReadTicks, true);
  assert.equal(APPROVALS_INBOX_SURFACE.linking, false, "no candidate linking on the approvals number");
  assert.equal(APPROVALS_INBOX_SURFACE.saveToCandidate, false);
  assert.equal(APPROVALS_INBOX_SURFACE.apiBase, "/api/admin/approvals-whatsapp");
  assert.notEqual(RECRUITMENT_INBOX_SURFACE.apiBase, APPROVALS_INBOX_SURFACE.apiBase, "one set of components, two surfaces");

  assert.equal(reportOutcome({ messageStatus: "read", recipientStatus: "accepted", repliedAt: "2026-11-19T12:00:00Z" }), "replied", "a reply beats a read");
  assert.equal(reportOutcome({ messageStatus: "read", recipientStatus: "accepted", repliedAt: null }), "read");
  assert.equal(reportOutcome({ messageStatus: "delivered", recipientStatus: "accepted", repliedAt: null }), "delivered");
  assert.equal(reportOutcome({ messageStatus: "accepted", recipientStatus: "accepted", repliedAt: null }), "sent");
  assert.equal(reportOutcome({ messageStatus: "failed", recipientStatus: "accepted", repliedAt: null }), "failed", "a later failure shows as failed");
  assert.equal(reportOutcome({ messageStatus: null, recipientStatus: "failed", repliedAt: null }), "failed");
  assert.equal(reportOutcome({ messageStatus: null, recipientStatus: "pending", repliedAt: null }), "pending");
}

// ── 3. The 24-hour gate ──

function testTheReplyWindow() {
  const now = Date.parse("2026-11-19T12:00:00Z");
  const open = approvalsReplyWindow(new Date(now - 23 * 60 * 60 * 1000).toISOString(), now);
  assert.equal(open.open, true, "23 hours after their last message: free text may go");
  assert.equal(open.closesAt, new Date(now + 60 * 60 * 1000).toISOString(), "and the screen knows when it closes");
  assert.equal(approvalsReplyWindow(new Date(now - APPROVALS_REPLY_WINDOW_MS).toISOString(), now).open, false, "at exactly 24 hours it is closed");
  assert.equal(approvalsReplyWindow(new Date(now - 25 * 60 * 60 * 1000).toISOString(), now).open, false);
  assert.deepEqual(approvalsReplyWindow(null, now), { closesAt: null, open: false }, "someone who never wrote: templates only");
  assert.equal(approvalsReplyWindow("not a date", now).open, false);

  const send = stripComments(readFileSync("src/lib/approvals-whatsapp/send.ts", "utf8"));
  for (const fn of ["export async function sendApprovalsText", "export async function sendApprovalsMedia"]) {
    const start = send.indexOf(fn);
    assert.ok(start > 0, `${fn} exists`);
    const fnBody = send.slice(start, send.indexOf("\nexport ", start + 10));
    const gate = fnBody.indexOf("if (!approvalsReplyWindow(chat.lastInboundAt).open) throw");
    assert.ok(gate > 0, `${fn} checks the 24-hour window`);
    assert.ok(gate < fnBody.indexOf("sendWhatsAppPayload("), `${fn} checks it before anything goes to Meta`);
  }
}

// ── 4. Phone normalisation and dedupe ──

function testPhoneNumbers() {
  for (const spelling of ["01040631155", "1040631155", "+20 10 4063 1155", "0020 104 063 1155", "201040631155", "(010) 4063-1155"]) {
    assert.equal(normaliseApprovalsPhone(spelling), "201040631155", `${spelling} → 201040631155`);
  }
  assert.equal(normaliseApprovalsPhone("0223456789"), null, "a Cairo landline cannot hold WhatsApp");
  assert.equal(normaliseApprovalsPhone("20223456789"), null, "nor with the country code");
  assert.equal(normaliseApprovalsPhone("0104063115"), null, "a digit short");
  assert.equal(normaliseApprovalsPhone("447700900123"), "447700900123", "a foreign mobile with its country code is kept");
  assert.equal(normaliseApprovalsPhone(""), null);
  assert.equal(normaliseApprovalsPhone(null), null);

  const pasted = parsePastedNumbers("01040631155\n+20 10 4063 1155, 01112345678; 12345\n\n0223456789\n01200000000", ["201200000000"]);
  assert.deepEqual(pasted.valid, ["201040631155", "201112345678"], "valid and new, in the order pasted");
  assert.deepEqual(pasted.duplicates, ["201040631155", "201200000000"], "a repeat in the paste, and one already chosen, are shown and skipped");
  assert.deepEqual(pasted.invalid.map((item) => item.text), ["12345", "0223456789"], "the unusable ones are shown as pasted");

  const deduped = dedupeRecipients([
    { displayName: "Omar", employeeHrId: "B-10", waId: "201040631155" },
    { displayName: null, employeeHrId: null, waId: "201040631155" },
    { displayName: null, employeeHrId: null, waId: "201112345678" },
  ]);
  assert.deepEqual(deduped.recipients.map((recipient) => recipient.displayName), ["Omar", null], "one row per number, the employee row kept first");
  assert.equal(deduped.duplicates.length, 1);
}

// ── 5. The Super Admin gate, on every route ──

type Role = Parameters<typeof canUseApprovalsWhatsApp>[0];

function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...routeFiles(path));
    else if (entry.name === "route.ts") found.push(path.replace(/\\/g, "/"));
  }
  return found.sort();
}

function testTheSuperAdminGate() {
  assert.equal(canUseApprovalsWhatsApp({ role: "Super Admin", source: "session" } as Role), true);
  for (const role of ["CEO", "HR Manager", "HR Operations", "Talent Acquisition", "Medical Rep", "District Manager"]) {
    assert.equal(canUseApprovalsWhatsApp({ role, source: "session" } as Role), false, `${role} is refused`);
  }
  assert.equal(canUseApprovalsWhatsApp({ role: "Super Admin", source: "guest" } as Role), false, "a guest is refused whatever role it claims");
  assert.equal(canUseApprovalsWhatsApp(null), false);
  assert.equal(canUseApprovalsWhatsApp(undefined), false);

  const routes = routeFiles(ROUTES_DIR);
  assert.equal(routes.length, 12, `the twelve routes are all here (${routes.join(", ")})`);
  let handlers = 0;
  for (const file of routes) {
    const source = stripComments(readFileSync(file, "utf8"));
    assert.ok(!/assertPermission\(|hasPermission\(/u.test(source), `${file}: a role check, never a permission-matrix grant`);
    const chunks = source.split(/(?=export async function (?:GET|POST|PUT|PATCH|DELETE)\b)/u).slice(1);
    assert.ok(chunks.length > 0, `${file} exports a handler`);
    for (const chunk of chunks) {
      handlers += 1;
      const name = `${file} ${/export async function (\w+)/u.exec(chunk)?.[1]}`;
      const resolve = chunk.indexOf("resolveAccessContext(request)");
      const gate = chunk.indexOf("approvalsWhatsAppForbidden(access)");
      const refuse = chunk.indexOf("if (forbidden) return forbidden;");
      assert.ok(resolve > 0 && gate > resolve && refuse > gate, `${name} resolves the caller and refuses anyone but the Super Admin`);
      const before = chunk.slice(0, refuse);
      const awaits = before.match(/\bawait\b[^;]*/gu) ?? [];
      assert.deepEqual(
        awaits.filter((line) => !line.includes("resolveAccessContext(request)")),
        [],
        `${name} reads and writes nothing before the role is checked`,
      );
    }
  }
  assert.ok(handlers >= 18, `every handler was checked (${handlers})`);

  const helper = stripComments(readFileSync(`${ROUTES_DIR}/_lib/http.ts`, "utf8"));
  assert.match(helper, /if \(canUseApprovalsWhatsApp\(access\)\) return null;\s*return approvalsProblem\([^)]*, 403\);/u, "the helper answers 403 to everyone else");

  const page = stripComments(readFileSync("app/(admin)/admin/approvals-whatsapp/page.tsx", "utf8"));
  assert.ok(page.indexOf("if (!canUseApprovalsWhatsApp(access)) redirect(") < page.indexOf("listApprovalsConversations("), "the page checks the role before it reads a chat");

  const nav = stripComments(readFileSync("src/config/system-navigation.ts", "utf8"));
  const row = nav.slice(nav.indexOf('href: "/admin/approvals-whatsapp"'), nav.indexOf('href: "/admin/approvals-whatsapp"') + 400);
  assert.match(row, /roles: \["Super Admin"\]/u, "the sidebar entry is the Super Admin's alone");
}

// ── 6. TIER_250 ──

function testTheDailyLimit() {
  assert.equal(APPROVALS_TIER_LIMIT, 250, "the line is on Meta's TIER_250");
  const today = Array.from({ length: 200 }, (_, index) => `2010${String(index).padStart(8, "0")}`);
  const fits = tier250Check({ batch: Array.from({ length: 50 }, (_, index) => `2011${String(index).padStart(8, "0")}`), contactedToday: today });
  assert.equal(fits.allowed, true, "200 today plus 50 new is exactly 250");
  assert.equal(fits.remaining, 50);

  const over = tier250Check({ batch: Array.from({ length: 51 }, (_, index) => `2011${String(index).padStart(8, "0")}`), contactedToday: today });
  assert.equal(over.allowed, false, "one over is refused");
  assert.equal(over.overBy, 1);

  const repeat = tier250Check({ batch: [...today.slice(0, 100), ...Array.from({ length: 50 }, (_, index) => `2011${String(index).padStart(8, "0")}`)], contactedToday: today });
  assert.equal(repeat.allowed, true, "someone already messaged today costs nothing more");
  assert.equal(repeat.alreadyCounted, 100);
  assert.equal(tier250Check({ batch: ["201040631155"], contactedToday: Array.from({ length: 250 }, (_, index) => `2012${index}`) }).allowed, false, "a full day refuses even one");

  const send = stripComments(readFileSync("src/lib/approvals-whatsapp/send.ts", "utf8"));
  const create = send.slice(send.indexOf("export async function createApprovalsBroadcast"), send.indexOf("export async function resumeApprovalsBroadcast"));
  const refusal = create.indexOf("if (!plan.tier.allowed)");
  assert.ok(refusal > 0, "a batch over the day's limit is refused");
  assert.match(create.slice(refusal, refusal + 120), /throw new /u, "refused whole, never half sent");
  assert.ok(refusal < create.indexOf(".insert("), "before a single recipient row is written");
}

export async function runApprovalsWhatsAppTests() {
  testTheWebhookKeepsTheThirdNumberApart();
  testTicksLandByWamid();
  testTheReplyWindow();
  testPhoneNumbers();
  testTheSuperAdminGate();
  testTheDailyLimit();
}
