import { bidiIsolate } from "@/emails/bidi";
import type { PhoenixRole } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import type { CeoApprovalsRange, MarketingCeoApprovalRow } from "@/lib/marketing-requests/ceo-approvals";

// ─────────────────────────────────────────────────────────────────────────────
// The "Approved requests" email — the pure half (owner, 2026-11-08).
//
// The Marketing Manager ticks rows on CEO Approvals, writes a note beside any of them, marks a row
// red (Finance already executed it) or "Finance hold" (its requester must see Finance), and presses
// Send. It replaces the email he wrote by hand every week, so it reads the way that one did:
//
//   To   — Finance: Ahmed El Maraghy and Adel El Sayed.
//   Cc   — every requester in the email, each one's managers up to and including the National
//          Sales Manager (a Pedia District Manager: the Regional AND the National Sales Manager),
//          Dr Anwar, Omar Anwar, and the sender himself.
//   Body — "Dear all", the table (Customer · Requester · Line · Type · Requested value · Notes) as a
//          zebra table in the weekly-plan email's palette, red rows, the thank-you to Finance for
//          the red items, the Finance Hold line, and the sender's signature.
//
// Reads nothing, so every rule here is pinned by tests/marketing-ceo-approvals-email.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

export { APPROVED_REQUESTS_EMAIL_EVENT, APPROVED_REQUESTS_EMAIL_MODULE } from "@/lib/notifications/approved-requests-channel-guard";

/** Who may press Send: the Marketing Manager (owner, 2026-11-08) and the Super Admin. The CEO reads. */
const senderRoles = new Set<PhoenixRole>(["Marketing Manager", "Super Admin"]);

export function canSendMarketingCeoApprovalsEmail(role: string | null | undefined): boolean {
  return Boolean(role) && senderRoles.has(role as PhoenixRole);
}

/** The owner's own words, by person: Finance on the To line. Ahmed El Maraghy, Adel El Sayed. */
export const APPROVED_REQUESTS_TO_HR_IDS = ["B-185", "OF-0002"] as const;
/** Always copied: Dr Anwar (CEO) and Omar Anwar. */
export const APPROVED_REQUESTS_FIXED_CC_HR_IDS = ["AA", "B-10"] as const;
/** The person whose name the red-row thank-you and the Finance Hold line carry. */
export const APPROVED_REQUESTS_FINANCE_CONTACT_HR_ID = "B-185";

/** Limits that keep one press from turning into a mass send or a clipped email. */
export const APPROVED_REQUESTS_MAX_ROWS = 80;
export const APPROVED_REQUESTS_MAX_NOTE_CHARS = 300;
export const APPROVED_REQUESTS_MAX_RECIPIENTS = 60;

export type ApprovedRequestMark = "none" | "executed" | "hold";

export type ApprovedRequestsEmailSelection = {
  mark: ApprovedRequestMark;
  note: string;
  requestId: string;
};

/** What a row starts as before he touches it: red when Finance executed it, hold when it is held. */
export function defaultMarkFor(row: Pick<MarketingCeoApprovalRow, "financeState">): ApprovedRequestMark {
  if (row.financeState === "executed") return "executed";
  if (row.financeState === "held") return "hold";
  return "none";
}

function stripControls(value: string): string {
  // Directional overrides and isolates are removed; the HTML re-isolates each cell itself.
  return value.replace(/[‪-‮⁦-⁩]/g, "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ");
}

export function cleanNote(value: unknown): string {
  return stripControls(String(value ?? "")).replace(/\s+/g, " ").trim().slice(0, APPROVED_REQUESTS_MAX_NOTE_CHARS);
}

function cleanMark(value: unknown): ApprovedRequestMark {
  return value === "executed" || value === "hold" ? value : "none";
}

/**
 * The body a client posts, made safe: known ids only, each once, in the report's order, at most
 * APPROVED_REQUESTS_MAX_ROWS. Throws a sentence a person can act on, never a code.
 */
export function normalizeEmailSelection(
  raw: unknown,
  rowsInRange: readonly MarketingCeoApprovalRow[],
): Array<{ mark: ApprovedRequestMark; note: string; row: MarketingCeoApprovalRow }> {
  const list = Array.isArray(raw) ? raw : [];
  const wanted = new Map<string, { mark: ApprovedRequestMark; note: string }>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const requestId = String((item as { requestId?: unknown }).requestId ?? "").trim();
    if (!requestId || wanted.has(requestId)) continue;
    wanted.set(requestId, {
      mark: cleanMark((item as { mark?: unknown }).mark),
      note: cleanNote((item as { note?: unknown }).note),
    });
  }
  if (wanted.size === 0) throw new Error("Tick at least one request to send.");
  if (wanted.size > APPROVED_REQUESTS_MAX_ROWS) {
    throw new Error(`One email carries at most ${APPROVED_REQUESTS_MAX_ROWS} requests. Untick some and send the rest in a second email.`);
  }
  const picked = rowsInRange
    .filter((row) => wanted.has(row.requestId))
    .map((row) => ({ ...(wanted.get(row.requestId) as { mark: ApprovedRequestMark; note: string }), row }));
  if (picked.length !== wanted.size) {
    throw new Error("Some ticked requests are no longer in this date range. Show the report again and re-send.");
  }
  return picked;
}

// ── Subject and wording ─────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th"}`;
}

/** "8th Nov" — the year only when the two ends of the range are in different years. */
function dayLabel(day: string, withYear: boolean): string {
  const [year, month, date] = day.split("-").map(Number);
  return `${ordinal(date)} ${MONTHS[month - 1]}${withYear ? ` ${year}` : ""}`;
}

export function approvedRequestsRangeLabel(range: CeoApprovalsRange): string {
  const withYear = range.from.slice(0, 4) !== range.to.slice(0, 4);
  if (range.from === range.to) return dayLabel(range.from, withYear);
  return `${dayLabel(range.from, withYear)} to ${dayLabel(range.to, withYear)}`;
}

/** The owner's words: "approved requests" and the period he filtered on. */
export function approvedRequestsSubject(range: CeoApprovalsRange): string {
  return `Approved requests ${approvedRequestsRangeLabel(range)}`;
}

function rangeDays(range: CeoApprovalsRange): number {
  return Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** His own opening for a week; a longer range names its dates instead of calling itself a week. */
export function approvedRequestsIntro(range: CeoApprovalsRange): string {
  return rangeDays(range) <= 8
    ? "Please find below this week's transfers"
    : `Please find below the transfers approved from ${approvedRequestsRangeLabel(range)}`;
}

// ── Recipients ──────────────────────────────────────────────────────────────

export type ApprovedRequestsPerson = {
  email: string | null;
  hrId: string;
  isActive: boolean;
  jobTitle: string | null;
  managerHrId: string | null;
  name: string;
};

const NATIONAL_SALES_MANAGER = /national sales manager/i;
const CHAIN_MAX_HOPS = 5;

/**
 * A requester's managers, walked upward and stopping AFTER the National Sales Manager: a Pedia
 * District Manager gives the Regional and the National Sales Manager, an Anti Infective or CNS one
 * gives the National Sales Manager. The CEO ends the walk without being added (he is copied anyway).
 */
export function managersUpToNationalSalesManager(
  requesterHrId: string,
  people: ReadonlyMap<string, ApprovedRequestsPerson>,
): ApprovedRequestsPerson[] {
  const chain: ApprovedRequestsPerson[] = [];
  const seen = new Set<string>([canonicalHrIdKey(requesterHrId) ?? ""]);
  let current = people.get(canonicalHrIdKey(requesterHrId) ?? "");
  for (let hop = 0; hop < CHAIN_MAX_HOPS && current?.managerHrId; hop += 1) {
    const key = canonicalHrIdKey(current.managerHrId) ?? "";
    if (!key || seen.has(key)) break;
    seen.add(key);
    const manager = people.get(key);
    if (!manager || String(manager.jobTitle ?? "").trim().toUpperCase() === "CEO") break;
    chain.push(manager);
    if (NATIONAL_SALES_MANAGER.test(String(manager.jobTitle ?? ""))) break;
    current = manager;
  }
  return chain;
}

export type ApprovedRequestsRecipient = { email: string; hrId: string; name: string };

export type ApprovedRequestsRecipients = {
  cc: ApprovedRequestsRecipient[];
  to: ApprovedRequestsRecipient[];
  /** Everyone reached, sender excluded — the in-app and Telegram audience. */
  notifyHrIds: string[];
  warnings: string[];
};

/**
 * To and Cc, each person once (To wins over Cc), in the order a reader expects: Finance, then the
 * requesters and their managers, then Dr Anwar and Omar Anwar, then the sender. A person who has
 * left or has no work email is named in `warnings` rather than silently dropped.
 */
export function resolveApprovedRequestsRecipients(input: {
  people: ReadonlyMap<string, ApprovedRequestsPerson>;
  requesterHrIds: readonly string[];
  senderHrId: string | null;
}): ApprovedRequestsRecipients {
  const warnings: string[] = [];
  const placed = new Set<string>();
  const to: ApprovedRequestsRecipient[] = [];
  const cc: ApprovedRequestsRecipient[] = [];
  const notify = new Set<string>();
  const senderKey = canonicalHrIdKey(input.senderHrId) ?? "";

  function place(hrId: string, list: ApprovedRequestsRecipient[], why: string) {
    const key = canonicalHrIdKey(hrId) ?? "";
    if (!key || placed.has(key)) return;
    placed.add(key);
    const person = input.people.get(key);
    if (!person) {
      warnings.push(`${why} (${hrId}) is not in the employee directory, so they are not on this email.`);
      return;
    }
    if (!person.isActive) {
      warnings.push(`${person.name} (${why}) is no longer active, so they are not on this email.`);
      return;
    }
    const email = String(person.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      warnings.push(`${person.name} (${why}) has no work email on file, so they are not on this email.`);
      return;
    }
    list.push({ email, hrId: person.hrId, name: person.name });
    if (key !== senderKey) notify.add(person.hrId);
  }

  for (const hrId of APPROVED_REQUESTS_TO_HR_IDS) place(hrId, to, "Finance");
  for (const requester of input.requesterHrIds) {
    place(requester, cc, "requester");
    for (const manager of managersUpToNationalSalesManager(requester, input.people)) place(manager.hrId, cc, "requester's manager");
  }
  for (const hrId of APPROVED_REQUESTS_FIXED_CC_HR_IDS) place(hrId, cc, "always copied");
  if (input.senderHrId) place(input.senderHrId, cc, "sender");

  return { cc, notifyHrIds: Array.from(notify), to, warnings };
}

// ── The email itself ────────────────────────────────────────────────────────

export type ApprovedRequestsEmailRow = {
  customerName: string;
  estimatedCost: number;
  lineName: string;
  mark: ApprovedRequestMark;
  note: string;
  requestType: string;
  requesterName: string;
};

export type ApprovedRequestsEmailContent = {
  financeContactName: string;
  holdNames: string[];
  range: CeoApprovalsRange;
  rows: ApprovedRequestsEmailRow[];
  senderName: string;
  senderTitle: string | null;
};

/** The requesters to send to Finance about a hold, each once, in table order. */
export function financeHoldNames(rows: readonly ApprovedRequestsEmailRow[]): string[] {
  return Array.from(new Set(rows.filter((row) => row.mark === "hold").map((row) => row.requesterName)));
}

const money = (value: number): string => Math.round(value).toLocaleString("en-US");

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cell(value: string): string {
  return bidiIsolate(escapeHtml(stripControls(value)));
}

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

// The weekly-plan email's palette (src/lib/weekly-planning/email-table.ts): navy header, slate
// zebra, hairline borders, plus the red his own email uses for the rows Finance already executed.
const NAVY = "#0F172A";
const BORDER = "#E2E8F0";
const ROW_ALT_BG = "#F8FAFC";
const RED = "#B91C1C";
const FONT = "font-family:Segoe UI,Arial,Helvetica,sans-serif";

const headerCell = `background-color:${NAVY};color:#ffffff;border:1px solid ${NAVY};padding:10px 12px;font-size:12px;font-weight:bold;letter-spacing:0.3px;text-align:left`;

function bodyCell(index: number, red: boolean, extra = ""): string {
  const bg = index % 2 === 1 ? `background-color:${ROW_ALT_BG};` : "background-color:#ffffff;";
  return `${bg}border:1px solid ${BORDER};padding:9px 12px;font-size:13px;line-height:1.5;color:${red ? RED : NAVY};${extra}`;
}

function tableHtml(rows: readonly ApprovedRequestsEmailRow[]): string {
  const head = ["Customer", "Requester", "Line", "Type", "Requested value (EGP)", "Notes"]
    .map((label, index) => `<th style="${headerCell}${index === 4 ? ";text-align:right" : ""}">${label}</th>`)
    .join("");
  const body = rows
    .map((row, index) => {
      const red = row.mark === "executed";
      const arabic = ARABIC.test(row.customerName);
      const customer = `<td dir="${arabic ? "rtl" : "ltr"}" style="${bodyCell(index, red, `text-align:${arabic ? "right" : "left"};font-weight:600`)}">${cell(row.customerName)}</td>`;
      return [
        "<tr>",
        customer,
        `<td style="${bodyCell(index, red)}">${cell(row.requesterName)}</td>`,
        `<td style="${bodyCell(index, red)}">${cell(row.lineName)}</td>`,
        `<td dir="auto" style="${bodyCell(index, red)}">${cell(row.requestType)}</td>`,
        `<td style="${bodyCell(index, red, "text-align:right;font-weight:bold;white-space:nowrap")}">${money(row.estimatedCost)}</td>`,
        `<td dir="auto" style="${bodyCell(index, red)}">${cell(row.note)}</td>`,
        "</tr>",
      ].join("");
    })
    .join("");
  const total = rows.reduce((sum, row) => sum + row.estimatedCost, 0);
  const totalRow = `<tr><td colspan="4" style="border:1px solid ${NAVY};border-top:2px solid ${NAVY};padding:9px 12px;font-size:13px;font-weight:bold;color:${NAVY};background-color:#F1F5F9">Total · ${rows.length} request${rows.length === 1 ? "" : "s"}</td><td style="border:1px solid ${NAVY};border-top:2px solid ${NAVY};padding:9px 12px;font-size:13px;font-weight:bold;color:${NAVY};background-color:#F1F5F9;text-align:right;white-space:nowrap">${money(total)}</td><td style="border:1px solid ${NAVY};border-top:2px solid ${NAVY};background-color:#F1F5F9"></td></tr>`;
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;width:100%;max-width:900px;${FONT}"><thead><tr>${head}</tr></thead><tbody>${body}${totalRow}</tbody></table>`;
}

function paragraph(html: string, extra = ""): string {
  return `<p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:${NAVY};${FONT};${extra}">${html}</p>`;
}

export function renderApprovedRequestsEmail(content: ApprovedRequestsEmailContent): { html: string; text: string } {
  const anyRed = content.rows.some((row) => row.mark === "executed");
  const finance = escapeHtml(content.financeContactName);
  const parts = [
    paragraph("Dear all,<br />" + escapeHtml(approvedRequestsIntro(content.range))),
    tableHtml(content.rows),
    `<div style="height:16px;line-height:16px">&nbsp;</div>`,
  ];
  if (anyRed) parts.push(paragraph(`<strong>@${finance}</strong>, thanks for executing the items in <span style="color:${RED};font-weight:bold">red</span>.`));
  if (content.holdNames.length > 0) {
    const names = content.holdNames.map((name) => `<strong>@${escapeHtml(name)}</strong>`).join(" · ");
    parts.push(paragraph(`${names}<br />Thanks to contact Mr. ${finance} to clear your Finance Hold.`));
  }
  const signature = [
    `<strong>${escapeHtml(content.senderName)}</strong>`,
    content.senderTitle ? escapeHtml(content.senderTitle) : null,
    "Sato Pharma",
  ]
    .filter(Boolean)
    .join("<br />");
  parts.push(paragraph("Best Regards,", "margin-top:8px"));
  parts.push(paragraph(signature));
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background-color:#ffffff;${FONT}">${parts.join("")}</body></html>`;

  const lines = [
    "Dear all,",
    approvedRequestsIntro(content.range),
    "",
    ...content.rows.map((row) =>
      [
        row.customerName,
        row.requesterName,
        row.lineName,
        row.requestType,
        `EGP ${money(row.estimatedCost)}`,
        row.note,
        row.mark === "executed" ? "(executed, in red)" : "",
      ]
        .filter(Boolean)
        .join(" | "),
    ),
    `Total: ${content.rows.length} request${content.rows.length === 1 ? "" : "s"}, EGP ${money(content.rows.reduce((sum, row) => sum + row.estimatedCost, 0))}`,
    "",
  ];
  if (anyRed) lines.push(`@${content.financeContactName}, thanks for executing the items in red.`, "");
  if (content.holdNames.length > 0) {
    lines.push(`${content.holdNames.map((name) => `@${name}`).join(" · ")}`, `Thanks to contact Mr. ${content.financeContactName} to clear your Finance Hold.`, "");
  }
  lines.push("Best Regards,", content.senderName, ...(content.senderTitle ? [content.senderTitle] : []), "Sato Pharma");
  return { html, text: lines.join("\n") };
}

/** The in-app and Telegram notice: who sent it, the totals, and the rows themselves (first 15). */
export function approvedRequestsNoticeMessage(content: ApprovedRequestsEmailContent): string {
  const total = content.rows.reduce((sum, row) => sum + row.estimatedCost, 0);
  const shown = content.rows.slice(0, 15).map((row) => {
    const note = row.note ? ` · ${row.note}` : "";
    const flag = row.mark === "executed" ? " · executed" : row.mark === "hold" ? " · Finance hold" : "";
    return `• ${row.customerName} — ${row.requesterName} — EGP ${money(row.estimatedCost)}${flag}${note}`;
  });
  const more = content.rows.length > shown.length ? [`and ${content.rows.length - shown.length} more in the email.`] : [];
  return [
    `${content.senderName} sent the approved requests for ${approvedRequestsRangeLabel(content.range)}: ${content.rows.length} request${content.rows.length === 1 ? "" : "s"}, EGP ${money(total)}.`,
    ...shown,
    ...more,
  ].join("\n");
}
