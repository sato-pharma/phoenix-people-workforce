// Renders a submitted weekly/monthly plan as an email-safe HTML table (plus a plain-text
// projection) for the {{planTable}} template variable. Inline styles only - they must all
// pass sanitizeEmailTemplateHtml's allowlist (background-color, color, border, padding,
// font-size, font-style, font-weight, letter-spacing, line-height, text-align, width,
// border-collapse). No display/border-radius/box-shadow/text-transform/vertical-align -
// those aren't in the allowlist and get silently stripped.

import { bidiIsolate } from "@/emails/bidi";
import { utcDate } from "@/lib/format/cairo-datetime";
import { activityDisplayLabel, planSlotLabel } from "@/lib/weekly-planning/calendar";
import type { EmployeePlanActivityType } from "@/lib/weekly-planning/plan-v1";

const MAX_EMAIL_PLAN_ROWS = 40;
// Employee-supplied plan text is unbounded in the DB (no length is enforced when a plan is saved),
// and Gmail clips a message at about 102KB. So there are two safety limits, and NEITHER cuts a
// sentence short in the middle of normal use:
//   - one cell may hold up to 2,000 characters (a long paragraph; ordinary notes are a line or
//     two). Past that the cell ends at a word and says, in words, that the rest is in Phoenix.
//   - the table as a whole stops adding rows once their text passes 40,000 characters, and the
//     "more rows" line says how many were left out. A row is shown whole or not at all.
// Neither limit ever writes an ellipsis: three dots tell the reader nothing, a sentence does.
const MAX_CELL_CHARS = 2000;
const MAX_TABLE_TEXT_CHARS = 40000;
const CELL_CONTINUES_NOTE = " (the rest is in Phoenix)";

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
  if (trimmed.length <= MAX_CELL_CHARS) return trimmed;
  const head = trimmed.slice(0, MAX_CELL_CHARS);
  const lastSpace = head.lastIndexOf(" ");
  // End on a whole word when there is one in the last stretch, so the note never follows half a word.
  const atWord = lastSpace > MAX_CELL_CHARS - 80 ? head.slice(0, lastSpace) : head;
  return `${atWord.trimEnd()}${CELL_CONTINUES_NOTE}`;
}

function dayLabel(activityDate: string) {
  const date = new Date(`${activityDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return activityDate;
  const weekday = date.toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short" });
  // `activity_date` is a DATE-ONLY value, so UTC is what keeps the calendar day from shifting.
  return `${weekday} ${utcDate(activityDate)}`;
}

/**
 * What the activity cell says, in the words the planner and the calendar use.
 *
 * `primary` is the display label (a Field day is a "Single Visit", a coaching day is "Coaching"),
 * not the stored title and type printed side by side — that read "Single Visit / Field" and
 * "Coaching / Other". `secondary` is the activity type only when it adds something: it is dropped
 * when it repeats the label, and "Other" is dropped always because it names nothing.
 */
function activityLabels(item: PlanTableItem) {
  const type = item.activity_type as EmployeePlanActivityType;
  const primary = activityDisplayLabel(type, clean(item.activity_title));
  const typeLabel = type === "Other" ? "" : activityDisplayLabel(type);
  const secondary = typeLabel.toLowerCase() === primary.toLowerCase() ? "" : typeLabel;
  return { primary, secondary };
}

function moreRowsText(hiddenCount: number) {
  return `${hiddenCount} more ${hiddenCount === 1 ? "row is" : "rows are"} not shown here. Open Phoenix to see the full plan.`;
}

/** Rows to show: as many as fit both limits, always at least one, in the order they were given. */
function visibleRowsFor(rows: PlanTableItem[]) {
  const visible: PlanTableItem[] = [];
  let used = 0;
  for (const item of rows) {
    if (visible.length >= MAX_EMAIL_PLAN_ROWS) break;
    const weight = [
      item.activity_title,
      item.activity_type,
      item.location_text,
      item.area,
      item.objective,
      item.attendees,
      item.double_visit_medical_rep_name,
    ].reduce((total, field) => total + clean(field).length, 0);
    if (visible.length > 0 && used + weight > MAX_TABLE_TEXT_CHARS) break;
    visible.push(item);
    used += weight;
  }
  return visible;
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

  const visible = visibleRowsFor(rows);
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
    const labels = activityLabels(item);
    const activityCell = stackedCell(labels.primary, labels.secondary);
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
    ? `<tr><td colspan="4" style="border:1px solid ${BORDER};padding:10px 12px;font-size:12px;font-style:italic;text-align:center;color:${MUTED}">${escapeHtml(moreRowsText(hiddenCount))}</td></tr>`
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
    const labels = activityLabels(item);
    const activityLabel = labels.secondary ? `${labels.primary} (${labels.secondary})` : labels.primary;
    const parts = [
      [dayLabel(item.activity_date), timeSlotLabel(item)].filter(Boolean).join(" "),
      activityLabel,
      locationLabel(item),
      clean(item.objective),
      companions(item),
    ].filter(Boolean);
    return `- ${parts.join(" | ")}`;
  });
  if (hiddenCount > 0) textLines.push(`- ${moreRowsText(hiddenCount)}`);

  return { html, text: textLines.join("\n") };
}
