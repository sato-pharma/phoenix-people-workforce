import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

function code(path: string) {
  const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Six people sat "pending" on 2026-10-04 and the only invitation button on the Telegram admin page
 * emailed every eligible employee (108 that day). One person's invitation is its own action, and it
 * can never widen into the mass send: exactly the one person, a limit of 1, no `force`.
 */
export function runTelegramInviteOnePersonTests() {
  const route = code("app/api/admin/notifications/telegram/route.ts");
  const panel = code("src/components/admin/telegram-admin-control-center.tsx");

  // ── The route ─────────────────────────────────────────────────────────────────
  const start = route.indexOf('body?.action === "send_invitation")');
  assert.ok(start > 0, "the per-person action must be handled on the telegram route");
  const end = route.indexOf('body?.action === "send_invitations"', start);
  assert.ok(end > start, "and it must sit before the mass campaign, as its own block");
  const block = route.slice(start, end);

  assert.match(block, /refuseUnlessSuperAdmin\(\s*access\.role/, "emailing a person is Super Admin only, like the campaign it narrows");
  assert.match(block, /if \(!userId\) \{[\s\S]{0,160}status: 400/, "no person named means a 400, never a fall-through to a wider send");
  assert.match(block, /runTelegramOnboardingCampaign\(\{ access, limit: 1, userIds: \[userId\] \}\)/, "exactly one person, a limit of 1");
  assert.doesNotMatch(block, /force/, "never `force`: an already-connected person is skipped, not re-emailed");
  assert.doesNotMatch(block, /userIds: body|body\?\.userIds|body\.userIds/, "the audience is the one userId, never a caller-supplied list");

  // The mass campaign refuses an empty selection instead of reading it as "everybody".
  const bulk = route.slice(end, end + 1500);
  assert.match(
    bulk,
    /Array\.isArray\(body\?\.userIds\) && body\.userIds\.length === 0\) \{[\s\S]{0,200}status: 400/,
    "an empty userIds list used to email every eligible employee; it must now be refused",
  );
  assert.ok(
    bulk.indexOf("body.userIds.length === 0") < bulk.indexOf("runTelegramOnboardingCampaign("),
    "and the refusal comes before the send",
  );

  // ── The panel ─────────────────────────────────────────────────────────────────
  assert.match(panel, /connection\.status !== "connected" \?/, "the button is offered only to people who are not connected");
  assert.match(panel, /Email \{inviteOne\.name\} a connect link\? This sends real email\./, "pressing it asks first, naming the person and saying it sends real email");
  assert.match(panel, /JSON\.stringify\(\{ action: "send_invitation", userId: person\.userId \}\)/, "the row sends ONE person's id to the per-person action");
  assert.doesNotMatch(
    panel.slice(panel.indexOf("async function sendOneInvitation"), panel.indexOf("const lastTestLabel")),
    /send_invitations/,
    "the row's send never calls the mass action",
  );
  assert.match(panel, /result\?\.status === "sent"[\s\S]{0,120}setNotice[\s\S]{0,160}else setError/, "a skip or a failure is an error line, never a green 'processed'");
  assert.match(panel, /disabled=\{!canGovern \|\| Boolean\(busy\)\}[^>]*onClick=\{\(\) => setInviteOne\(/, "the button is disabled for anyone who is not Super Admin, so a 403 never reads as a broken deploy");
  assert.equal(/rounded border[^"]*"[^>]*Email invitation/.test(panel), false, "the new controls keep square edges");
}
