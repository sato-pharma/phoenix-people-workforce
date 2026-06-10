// Renders a submitted weekly/monthly plan as an email-safe HTML table (plus a plain-text
// projection) for the {{planTable}} template variable. Inline styles only - they must all
// pass sanitizeEmailTemplateHtml's allowlist (background-color, color, border, padding,
// font-size, text-align, width, border-collapse).

import { bidiIsolate } from "@/emails/bidi";

const MAX_EMAIL_PLAN_ROWS = 40;
// Employee-supplied plan text is unbounded in the DB; cap each cell so one plan cannot
// inflate the approval email past provider limits (Gmail clips at ~102KB).
const MAX_CELL_CHARS = 300;

type PlanTableItem = {
  activity_date: string;
  activity_title: string;
  activity_type: string;
  area: string | null;
  attendees: string | null;
  double_visit_medical_rep_name: string | null;
  end_time: string | null;
  location_text: string | null;
  objective: string | null;
  sort_order: number;
  start_time: string | null;
};

export type PlanEmailTable = {
  html: string;
  text: string;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escape + bidi-isolate a user-supplied cell value, matching the layout layer's
 * escapeAndIsolate pattern: without isolation an embedded U+202E override could visually
 * reorder the surrounding cell text in the approval email (spoofing), and legitimate
 * Arabic content renders better isolated.
 */
function escapeCell(value: string) {
  return bidiIsolate(escapeHtml(value));
}

function clean(value: string | null | undefined) {
  // Strip explicit directional override/isolate characters - the HTML path re-isolates
  // safely via escapeCell, and the text projection has no other defense.
  const trimmed = String(value ?? "").replace(/[‪-‮⁦-⁩]/g, "").trim();
  return trimmed.length > MAX_CELL_CHARS ? `${trimmed.slice(0, MAX_CELL_CHARS).trimEnd()}...` : trimmed;
}

function shortTime(value: string | null) {
  const match = clean(value).match(/^(\d{1,2}:\d{2})/);
  return match ? match[1] : "";
}

function dayLabel(activityDate: string) {
  const date = new Date(`${activityDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return activityDate;
  const weekday = date.toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short" });
  return `${weekday} ${activityDate}`;
}

function timeRange(item: PlanTableItem) {
  const start = shortTime(item.start_time);
  const end = shortTime(item.end_time);
  if (start && end) return `${start} - ${end}`;
  return start || end || "";
}

function locationLabel(item: PlanTableItem) {
  return [clean(item.location_text), clean(item.area)].filter(Boolean).join(" - ");
}

function companions(item: PlanTableItem) {
  const parts = [];
  const doubleVisit = clean(item.double_visit_medical_rep_name);
  if (doubleVisit) parts.push(`Double visit with ${doubleVisit}`);
  const attendees = clean(item.attendees);
  if (attendees) parts.push(`With: ${attendees}`);
  return parts.join(". ");
}

function sortedItems(items: PlanTableItem[]) {
  return [...items].sort((left, right) =>
    left.activity_date.localeCompare(right.activity_date) ||
    left.sort_order - right.sort_order ||
    clean(left.start_time).localeCompare(clean(right.start_time)));
}

const headerCellStyle = "background-color:#0F172A;color:#ffffff;border:1px solid #0F172A;padding:8px 10px;font-size:12px;text-align:left";
const cellStyle = "border:1px solid #E5E7EB;padding:8px 10px;font-size:13px;text-align:left";

/**
 * Build the {{planTable}} variable content from the submitted plan rows. Returns empty
 * strings when the plan has no rows so the token simply disappears from the email.
 */
export function buildPlanEmailTable(items: PlanTableItem[] | null | undefined): PlanEmailTable {
  const rows = sortedItems(items ?? []);
  if (rows.length === 0) return { html: "", text: "" };

  const visible = rows.slice(0, MAX_EMAIL_PLAN_ROWS);
  const hiddenCount = rows.length - visible.length;

  const bodyRows = visible.map((item) => {
    const dateCell = [escapeHtml(dayLabel(item.activity_date)), escapeHtml(timeRange(item))].filter(Boolean).join("<br />");
    const activityCell = [
      `<strong>${escapeCell(clean(item.activity_title) || item.activity_type)}</strong>`,
      clean(item.activity_title) ? escapeHtml(item.activity_type) : "",
    ].filter(Boolean).join("<br />");
    const objectiveCell = [escapeCell(clean(item.objective)), escapeCell(companions(item))]
      .filter(Boolean)
      .join("<br />");
    return [
      "<tr>",
      `<td style="${cellStyle};white-space:nowrap">${dateCell}</td>`,
      `<td style="${cellStyle}">${activityCell}</td>`,
      `<td style="${cellStyle}">${escapeCell(locationLabel(item))}</td>`,
      `<td style="${cellStyle}">${objectiveCell}</td>`,
      "</tr>",
    ].join("");
  }).join("");

  const moreRow = hiddenCount > 0
    ? `<tr><td colspan="4" style="${cellStyle};font-weight:bold">+ ${hiddenCount} more row(s) - open Phoenix to see the full plan.</td></tr>`
    : "";

  const html = [
    '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">',
    "<thead><tr>",
    `<th style="${headerCellStyle}">Date</th>`,
    `<th style="${headerCellStyle}">Activity</th>`,
    `<th style="${headerCellStyle}">Location</th>`,
    `<th style="${headerCellStyle}">Objective</th>`,
    "</tr></thead>",
    `<tbody>${bodyRows}${moreRow}</tbody>`,
    "</table>",
  ].join("");

  const textLines = visible.map((item) => {
    const title = clean(item.activity_title);
    const parts = [
      [dayLabel(item.activity_date), timeRange(item)].filter(Boolean).join(" "),
      title ? `${title} (${item.activity_type})` : item.activity_type,
      locationLabel(item),
      clean(item.objective),
      companions(item),
    ].filter(Boolean);
    return `- ${parts.join(" | ")}`;
  });
  if (hiddenCount > 0) textLines.push(`- ... + ${hiddenCount} more row(s) - open Phoenix to see the full plan.`);

  return { html, text: textLines.join("\n") };
}
