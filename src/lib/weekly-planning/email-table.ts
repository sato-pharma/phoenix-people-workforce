// Renders a submitted weekly/monthly plan as an email-safe HTML table (plus a plain-text
// projection) for the {{planTable}} template variable. Inline styles only - they must all
// pass sanitizeEmailTemplateHtml's allowlist (background-color, color, border, padding,
// font-size, font-style, font-weight, letter-spacing, line-height, text-align, width,
// border-collapse). No display/border-radius/box-shadow/text-transform/vertical-align -
// those aren't in the allowlist and get silently stripped.

import { bidiIsolate } from "@/emails/bidi";
import { planSlotLabel } from "@/lib/weekly-planning/calendar";

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

function dayLabel(activityDate: string) {
  const date = new Date(`${activityDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return activityDate;
  const weekday = date.toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short" });
  return `${weekday} ${activityDate}`;
}

/**
 * Weekly plans only ever schedule the fixed 09:00-13:00 / 13:00-17:00 half-day slots
 * (see AM_PM_SLOTS in weekly-planning/service.ts), so the email shows the slot name
 * rather than the raw times - matching how the in-app planning calendar already
 * labels them (planSlotLabel). Blank times (e.g. a full-day National Vacation entry)
 * render nothing, same as before.
 */
function timeSlotLabel(item: PlanTableItem) {
  const label = planSlotLabel(item.start_time, item.end_time);
  return label === "Full day" ? "" : label;
}

function isHalfDaySlot(label: string) {
  return label === "AM" || label === "PM";
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

// Palette mirrors the phoenix-email-layout brand (navy header, orange accent) within the
// tight inline-style allowlist sanitizeEmailTemplateHtml enforces on this table.
const NAVY = "#0F172A";
const BORDER = "#E2E8F0";
const MUTED = "#64748B";
const ROW_ALT_BG = "#F8FAFC";
const AM_CHIP_BG = "#0F172A";
const PM_CHIP_BG = "#EA580C";

const headerCellStyle = `background-color:${NAVY};color:#ffffff;border:1px solid ${NAVY};padding:10px 12px;font-size:12px;font-weight:bold;letter-spacing:0.3px;text-align:left`;
const secondaryTextStyle = `color:${MUTED};font-size:11px`;
const chipStyle = "color:#ffffff;padding:2px 8px;font-size:11px;font-weight:bold;letter-spacing:0.3px";

function cellStyle(rowIndex: number) {
  const bg = rowIndex % 2 === 1 ? `background-color:${ROW_ALT_BG};` : "";
  return `${bg}border:1px solid ${BORDER};padding:10px 12px;font-size:13px;text-align:left;color:${NAVY};line-height:1.5`;
}

/**
 * Bold primary + muted secondary line, dropping the secondary line when it's blank or
 * just repeats the primary. Takes RAW (pre-escape) text and escapes internally - deciding
 * blank/duplicate on already-escaped+bidi-isolated text would always read as "present"
 * since bidiIsolate wraps even "" in invisible FSI/PDI marks.
 */
function stackedCell(primaryRaw: string, secondaryRaw: string) {
  const primary = primaryRaw.trim();
  const secondary = secondaryRaw.trim();
  const showSecondary = Boolean(secondary) && secondary.toLowerCase() !== primary.toLowerCase();
  return [
    primary ? `<strong>${escapeCell(primary)}</strong>` : "",
    showSecondary ? `<span style="${secondaryTextStyle}">${escapeCell(secondary)}</span>` : "",
  ].filter(Boolean).join("<br />");
}

/**
 * Build the {{planTable}} variable content from the submitted plan rows. Returns empty
 * strings when the plan has no rows so the token simply disappears from the email.
 */
export function buildPlanEmailTable(items: PlanTableItem[] | null | undefined): PlanEmailTable {
  const rows = sortedItems(items ?? []);
  if (rows.length === 0) return { html: "", text: "" };

  const visible = rows.slice(0, MAX_EMAIL_PLAN_ROWS);
  const hiddenCount = rows.length - visible.length;

  const bodyRows = visible.map((item, index) => {
    const style = cellStyle(index);
    const slot = timeSlotLabel(item);
    const slotHtml = isHalfDaySlot(slot)
      ? `<span style="${chipStyle};background-color:${slot === "AM" ? AM_CHIP_BG : PM_CHIP_BG}">${slot}</span>`
      : slot
        ? `<span style="${secondaryTextStyle}">${escapeHtml(slot)}</span>`
        : "";
    const dateCell = [`<strong>${escapeHtml(dayLabel(item.activity_date))}</strong>`, slotHtml].filter(Boolean).join("<br />");
    const activityCell = stackedCell(clean(item.activity_title) || item.activity_type, clean(item.activity_type));
    const locationCell = stackedCell(clean(item.location_text), clean(item.area));
    const objectiveRaw = clean(item.objective);
    const companionsRaw = companions(item);
    const objectiveCell = [
      objectiveRaw ? escapeCell(objectiveRaw) : "",
      companionsRaw ? `<span style="${secondaryTextStyle}">${escapeCell(companionsRaw)}</span>` : "",
    ].filter(Boolean).join("<br />");
    return [
      "<tr>",
      `<td style="${style}">${dateCell}</td>`,
      `<td style="${style}">${activityCell}</td>`,
      `<td style="${style}">${locationCell}</td>`,
      `<td style="${style}">${objectiveCell}</td>`,
      "</tr>",
    ].join("");
  }).join("");

  const moreRow = hiddenCount > 0
    ? `<tr><td colspan="4" style="border:1px solid ${BORDER};padding:10px 12px;font-size:12px;font-style:italic;text-align:center;color:${MUTED}">+ ${hiddenCount} more row(s) - open Phoenix to see the full plan.</td></tr>`
    : "";

  const html = [
    `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;border:1px solid ${NAVY}">`,
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
    const activityLabel = title && title.toLowerCase() !== item.activity_type.toLowerCase()
      ? `${title} (${item.activity_type})`
      : title || item.activity_type;
    const parts = [
      [dayLabel(item.activity_date), timeSlotLabel(item)].filter(Boolean).join(" "),
      activityLabel,
      locationLabel(item),
      clean(item.objective),
      companions(item),
    ].filter(Boolean);
    return `- ${parts.join(" | ")}`;
  });
  if (hiddenCount > 0) textLines.push(`- ... + ${hiddenCount} more row(s) - open Phoenix to see the full plan.`);

  return { html, text: textLines.join("\n") };
}
