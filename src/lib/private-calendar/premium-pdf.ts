// THE PRIVATE CALENDAR AS A REAL CALENDAR — the PDF export in the HR premium identity.
//
// The owner, 2026-11-13: "premium polish the sheet, I want it to be exported as a real calendar".
// The PDF used to be one table row per day, cut to a character count. It is now what the screen
// is: the month as a grid of weeks, each day showing what happened on it, then the same days
// written out in full on the pages after it, every visit on its own line.
//
// THE DRESS IS THE INTERVIEW CALENDAR'S (src/lib/recruitment/interview-calendar-export.ts), the
// one landscape calendar that already wears the HR premium identity: the compact premium masthead,
// the house blues, the frame, the watermark and the running foot, the ink rule (rules and type only,
// the 6% zebra the one fill). Kinds are told apart by the RULE down an entry's leading edge, solid,
// double, dashed or dotted, never by a filled colour.
//
// RENDERED BY CHROMIUM, like every premium paper, so Arabic names (a doctor, a pharmacy, a brick)
// print shaped and in order. The pdf-lib table in export.ts stays as the fallback when Chromium
// cannot run: the export must never fail for want of a browser.
//
// It renders exactly the items and exceptions the workspace carries and holds no filter rule of its
// own (see the note at the top of export.ts).

import { systemLegalEntity } from "@/config/system-settings";
import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import { inlineLocalAssets } from "@/lib/hiring-pack/paper-artwork";
import { stampPremiumPageNumbers } from "@/lib/hiring-pack/paper-pdf";
import { PREMIUM_IDENTITY_CSS, premiumMasthead, premiumPageChrome, premiumSheetCss } from "@/lib/hiring-pack/premium-identity";
import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import { withChromiumPage } from "@/lib/pdf/chromium";
import {
  isPrivateCalendarVisitKind,
  privateCalendarActivityKindLabels,
  privateCalendarItemKind,
  type PrivateCalendarActivityKind,
} from "@/lib/private-calendar/activity-kinds";
import type {
  PrivateCalendarEmployeeOption,
  PrivateCalendarException,
  PrivateCalendarItem,
  PrivateCalendarWorkspace,
} from "@/lib/private-calendar/logic";
import { privateCalendarItemOccursOn } from "@/lib/private-calendar/logic";

/**
 * THE SCREEN'S COLOUR RULE, ON PAPER (owner, 2026-11-13: "take the same colors rule"). One colour per
 * kind of day, exactly the screen's `kindTones` in src/components/employee-portal/private-calendar.tsx:
 * a 3px leading rule in the kind's colour over its own pale ground, a visit coloured by who went. The
 * plan alone is dashed on white, because it is an intention, not a record. `tailwind` names the screen's
 * colour; `tests/private-calendar.test.ts` holds the two together, so the paper cannot drift from it.
 */
export const PRIVATE_CALENDAR_PDF_KIND_TONES: Record<
  PrivateCalendarActivityKind,
  { accent: string; dashed?: boolean; tailwind: string; tint: string }
> = {
  attendance: { accent: "#059669", tailwind: "emerald-600", tint: "#ECFDF5" },
  vacation: { accent: "#0EA5E9", tailwind: "sky-500", tint: "#F0F9FF" },
  excuse: { accent: "#F59E0B", tailwind: "amber-500", tint: "#FFFBEB" },
  holiday: { accent: "#7C3AED", tailwind: "violet-600", tint: "#F5F3FF" },
  plan: { accent: "#78716C", dashed: true, tailwind: "stone-500", tint: "#FFFFFF" },
  single_regular: { accent: "#1D4ED8", tailwind: "blue-700", tint: "#EFF6FF" },
  double_regular: { accent: "#A21CAF", tailwind: "fuchsia-700", tint: "#FDF4FF" },
  chain_regular: { accent: "#0F766E", tailwind: "teal-700", tint: "#F0FDFA" },
  other_crm: { accent: "#64748B", tailwind: "slate-500", tint: "#F1F5F9" },
  outstation: { accent: "#0E7490", tailwind: "cyan-700", tint: "#ECFEFF" },
  interview: { accent: "#262626", tailwind: "neutral-800", tint: "#F5F5F5" },
  correction: { accent: "#4D7C0F", tailwind: "lime-700", tint: "#F7FEE7" },
};

/** No Activity Recorded wears its own red on the screen (`noActivitySwatch`, red-700); a warning, orange. */
const FINDING_TONES = { danger: "#B91C1C", info: HOUSE_COLORS.muted, warning: "#EA580C" } as const;

function kindToneCss(): string {
  return (Object.entries(PRIVATE_CALENDAR_PDF_KIND_TONES) as Array<[PrivateCalendarActivityKind, (typeof PRIVATE_CALENDAR_PDF_KIND_TONES)[PrivateCalendarActivityKind]]>)
    .map(([kind, tone]) => `.en--${kind} { border-inline-start: .9mm ${tone.dashed ? "dashed" : "solid"} ${tone.accent}; background: ${tone.tint};${tone.dashed ? " outline: .3pt dashed #D6D3D1; outline-offset: -.3pt;" : ""} }`)
    .join("\n  ");
}

/** The order the legend lists the kinds in: who went first, then everything else. */
const KIND_ORDER: PrivateCalendarActivityKind[] = [
  "single_regular",
  "double_regular",
  "chain_regular",
  "other_crm",
  "attendance",
  "vacation",
  "excuse",
  "holiday",
  "outstation",
  "plan",
  "interview",
  "correction",
];

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function monthLabelOf(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en", { month: "long", timeZone: "UTC", year: "numeric" });
}

function weekdayOf(date: string, style: "long" | "short"): string {
  return new Intl.DateTimeFormat("en", { timeZone: "UTC", weekday: style }).format(new Date(`${date}T00:00:00Z`));
}

function dayLabelOf(date: string): string {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

function stampOf(date: Date): string {
  return date.toLocaleString("en-GB", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    year: "numeric",
  });
}

function countsLine(item: Pick<PrivateCalendarItem, "visitCounts">): string {
  const counts = item.visitCounts;
  if (!counts) return "";
  return `AM ${counts.am} · PM ${counts.pm} · PH ${counts.pharmacies}`;
}

/** What a day's cell says about one entry: a short name for it, and its visit split when it has one. */
export function privateCalendarCellEntry(item: PrivateCalendarItem): { kind: PrivateCalendarActivityKind; lines: string[] } {
  const kind = privateCalendarItemKind(item);
  const title = clean(item.title);
  if (isPrivateCalendarVisitKind(kind)) {
    const counts = countsLine(item);
    const who = kind === "single_regular" ? "Single visit" : title.replace(/^With\b/, kind === "double_regular" ? "Double with" : "Chain with");
    return { kind, lines: [who, counts].filter(Boolean) };
  }
  if (kind === "other_crm") {
    return { kind, lines: [privateCalendarOtherActivityText(title) || privateCalendarActivityKindLabels.other_crm] };
  }
  const label = privateCalendarActivityKindLabels[kind];
  return { kind, lines: [title && title !== label ? title : label] };
}

type CalendarPerson = Pick<PrivateCalendarEmployeeOption, "fullName" | "hrId" | "jobTitle" | "lineName" | "managerName">;

function belongsTo(person: CalendarPerson | null, entry: { employeeHrId: string | null }): boolean {
  if (!person) return true;
  return !entry.employeeHrId || entry.employeeHrId.toLowerCase() === person.hrId.toLowerCase();
}

function itemsOn(workspace: PrivateCalendarWorkspace, date: string, person: CalendarPerson | null): PrivateCalendarItem[] {
  return workspace.items.filter((item) => privateCalendarItemOccursOn(item, date) && belongsTo(person, item));
}

function exceptionsOn(workspace: PrivateCalendarWorkspace, date: string, person: CalendarPerson | null): PrivateCalendarException[] {
  return workspace.exceptions.filter((exception) => exception.date === date && belongsTo(person, exception));
}

function monthDates(workspace: PrivateCalendarWorkspace): string[] {
  const dates = new Set<string>();
  for (const cell of workspace.weeks.flat()) {
    if (cell.inMonth && cell.date) dates.add(cell.date);
  }
  return Array.from(dates).sort();
}

/** The month's key figures: every visit AM · PM · Pharmacies apart, and how many days each kind covers. */
function keyFigures(workspace: PrivateCalendarWorkspace, person: CalendarPerson | null) {
  const dates = monthDates(workspace);
  const visits = { am: 0, pharmacies: 0, pm: 0 };
  const daysByKind = new Map<PrivateCalendarActivityKind, number>();
  let review = 0;
  for (const date of dates) {
    const items = itemsOn(workspace, date, person);
    const kinds = new Set<PrivateCalendarActivityKind>();
    for (const item of items) {
      const kind = privateCalendarItemKind(item);
      kinds.add(kind);
      if (isPrivateCalendarVisitKind(kind) && item.visitCounts && item.startDate === date) {
        visits.am += item.visitCounts.am;
        visits.pm += item.visitCounts.pm;
        visits.pharmacies += item.visitCounts.pharmacies;
      }
    }
    for (const kind of kinds) daysByKind.set(kind, (daysByKind.get(kind) ?? 0) + 1);
    review += exceptionsOn(workspace, date, person).filter((exception) => exception.severity === "danger" || exception.severity === "warning").length;
  }
  const fieldDays = dates.filter((date) => itemsOn(workspace, date, person).some((item) => isPrivateCalendarVisitKind(privateCalendarItemKind(item)))).length;
  return { daysByKind, fieldDays, review, visits };
}

function figureCell(label: string, value: string | number, note = ""): string {
  return `<div class="fig"><span class="fig__l">${escapeHtml(label)}</span><b class="fig__v">${escapeHtml(String(value))}</b>${note ? `<span class="fig__n">${escapeHtml(note)}</span>` : ""}</div>`;
}

function figuresStrip(workspace: PrivateCalendarWorkspace, person: CalendarPerson | null): string {
  const figures = keyFigures(workspace, person);
  const cells = [
    figureCell("AM visits", figures.visits.am),
    figureCell("PM visits", figures.visits.pm),
    figureCell("Pharmacies", figures.visits.pharmacies),
    figureCell("Days in the field", figures.fieldDays),
    ...KIND_ORDER.filter((kind) => !isPrivateCalendarVisitKind(kind) && (figures.daysByKind.get(kind) ?? 0) > 0).map((kind) =>
      figureCell(privateCalendarActivityKindLabels[kind], figures.daysByKind.get(kind) ?? 0, "days")),
    figureCell("To review", figures.review, figures.review === 1 ? "finding" : "findings"),
  ];
  return `<section class="figs">${cells.join("")}</section>`;
}

function entryHtml(item: PrivateCalendarItem): string {
  const entry = privateCalendarCellEntry(item);
  const [first, ...rest] = entry.lines;
  return `<span class="en en--${entry.kind}"><b>${escapeHtml(first ?? "")}</b>${rest
    .map((line) => `<span class="en__s">${escapeHtml(line)}</span>`)
    .join("")}</span>`;
}

function flagHtml(exception: PrivateCalendarException): string {
  return `<span class="flag flag--${exception.severity}"><i></i>${escapeHtml(clean(exception.title))}</span>`;
}

/** Today's date in Cairo, as YYYY-MM-DD — a day after it has not happened yet, so it says nothing. */
function cairoDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: PHOENIX_BUSINESS_TIME_ZONE, year: "numeric" }).format(date);
}

function monthGrid(workspace: PrivateCalendarWorkspace, person: CalendarPerson | null, today: string): string {
  const weeks = workspace.weeks.filter((week) => week.some((cell) => cell.inMonth && cell.date));
  const columns = weeks[0]?.length ?? 7;
  const headers = Array.from({ length: columns }, (_, index) => {
    const dated = weeks.map((week) => week[index]).find((cell) => cell?.inMonth && cell.date);
    return dated?.date ? weekdayOf(dated.date, "long") : "";
  });
  const rows = weeks
    .map((week) => `<tr>${week
      .map((cell) => {
        if (!cell.inMonth || !cell.date) return `<td class="off"></td>`;
        const items = itemsOn(workspace, cell.date, person);
        const flags = exceptionsOn(workspace, cell.date, person);
        const empty = items.length === 0 && flags.length === 0;
        const body = empty
          ? (cell.date <= today ? `<span class="none">Nothing recorded</span>` : "")
          : `${items.map(entryHtml).join("")}${flags.map(flagHtml).join("")}`;
        return `<td><span class="dn">${Number(cell.date.slice(8, 10))}</span>${body}</td>`;
      })
      .join("")}</tr>`)
    .join("");
  return `<table class="grid grid--w${weeks.length}">
  <colgroup>${headers.map(() => `<col style="width:${(100 / columns).toFixed(4)}%">`).join("")}</colgroup>
  <thead><tr>${headers.map((day) => `<th>${escapeHtml(day)}</th>`).join("")}</tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function legend(workspace: PrivateCalendarWorkspace): string {
  const present = new Set(workspace.items.map((item) => privateCalendarItemKind(item)));
  const kinds = KIND_ORDER.filter((kind) => present.has(kind));
  if (kinds.length === 0 && workspace.exceptions.length === 0) return "";
  return `<div class="legend">${kinds
    .map((kind) => `<span class="en en--${kind}"><b>${escapeHtml(privateCalendarActivityKindLabels[kind])}</b></span>`)
    .join("")}${workspace.exceptions.length > 0 ? `<span class="flag"><i></i>Finding to review</span>` : ""}<span class="legend__n">AM · PM · PH: visits counted AM, PM and Pharmacies apart</span></div>`;
}

/**
 * Every line an entry carries, once each. An entry with detail lines (a visit day: one full line per
 * visit) prints those; one without prints its tile's lines instead. Printing both listed every visit
 * twice, once short and once in full. The title and the visit split it already shows are not repeated.
 */
export function privateCalendarDetailLines(item: PrivateCalendarItem): string[] {
  const title = clean(item.title);
  const seen = new Set<string>([title.toLowerCase(), countsLine(item).toLowerCase()]);
  const source = item.detailLines.some((line) => clean(line)) ? item.detailLines : (item.chipLines ?? []).slice(1);
  const out: string[] = [];
  for (const raw of source) {
    const line = clean(raw);
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    out.push(line);
  }
  return out;
}

/** "Training 1 · Meeting 2" → "Training · Meeting × 2": a single activity is named, never counted as 1. */
export function privateCalendarOtherActivityText(title: string): string {
  const text = clean(title).replace(/^Other CRM activity:\s*/i, "");
  return text
    .split(" · ")
    .map((part) => {
      const match = /^(.*\S)\s+(\d+)$/.exec(part.trim());
      if (!match) return part.trim();
      return match[2] === "1" ? match[1] : `${match[1]} × ${match[2]}`;
    })
    .filter(Boolean)
    .join(" · ");
}

function dayByDay(workspace: PrivateCalendarWorkspace, people: Array<CalendarPerson | null>, showPerson: boolean): string {
  const dates = monthDates(workspace);
  const rows: string[] = [];
  let zebra = false;
  for (const person of people) {
    for (const date of dates) {
      const items = itemsOn(workspace, date, person);
      const flags = exceptionsOn(workspace, date, person);
      if (items.length === 0 && flags.length === 0) continue;
      zebra = !zebra;
      const dateCell = `<td class="dd"><b>${escapeHtml(weekdayOf(date, "short"))}</b> ${escapeHtml(dayLabelOf(date))}</td>`;
      const personCell = showPerson ? `<td>${escapeHtml(person?.fullName ?? "")}</td>` : "";
      for (const item of items) {
        const entry = privateCalendarCellEntry(item);
        rows.push(`<tr class="${zebra ? "z" : ""}">${dateCell}${personCell}
          <td><span class="en en--${entry.kind}"><b>${escapeHtml(privateCalendarActivityKindLabels[entry.kind])}</b></span></td>
          <td><b class="wt">${escapeHtml(entry.kind === "other_crm" ? privateCalendarOtherActivityText(item.title) : clean(item.title))}</b>${item.status ? `<span class="st">${escapeHtml(clean(item.status))}</span>` : ""}</td>
          <td class="det">${item.description ? `<span class="src">${escapeHtml(clean(item.description))}</span>` : ""}${privateCalendarDetailLines(item)
            .filter((line) => line.toLowerCase() !== clean(item.description).toLowerCase())
            .map((line) => `<span>${escapeHtml(line)}</span>`)
            .join("")}</td>
        </tr>`);
      }
      for (const flag of flags) {
        rows.push(`<tr class="${zebra ? "z" : ""}">${dateCell}${personCell}
          <td>${flagHtml({ ...flag, title: flag.severity === "info" ? "Note" : "Finding" })}</td>
          <td><b class="wt">${escapeHtml(clean(flag.title))}</b></td>
          <td class="det"><span>${escapeHtml(clean(flag.description))}</span></td>
        </tr>`);
      }
    }
  }
  if (rows.length === 0) return `<p class="empty">Nothing is recorded this month.</p>`;
  const widths = showPerson ? [9, 14, 11, 20, 46] : [9, 12, 22, 57];
  return `<table class="list">
  <colgroup>${widths.map((width) => `<col style="width:${width}%">`).join("")}</colgroup>
  <thead><tr><th>Day</th>${showPerson ? "<th>Employee</th>" : ""}<th>Kind</th><th>What happened</th><th>Detail</th></tr></thead>
  <tbody>${rows.join("")}</tbody>
</table>`;
}

function teamTable(workspace: PrivateCalendarWorkspace, people: CalendarPerson[]): string {
  const rows = people.map((person) => {
    const figures = keyFigures(workspace, person);
    return `<tr><td><b class="wt">${escapeHtml(person.fullName)}</b>${person.jobTitle ? `<span class="st">${escapeHtml(person.jobTitle)}</span>` : ""}</td>
      <td class="num">${figures.visits.am}</td><td class="num">${figures.visits.pm}</td><td class="num">${figures.visits.pharmacies}</td>
      <td class="num">${figures.fieldDays}</td><td class="num">${figures.review}</td></tr>`;
  });
  return `<table class="list team">
  <colgroup><col style="width:40%"><col style="width:12%"><col style="width:12%"><col style="width:12%"><col style="width:12%"><col style="width:12%"></colgroup>
  <thead><tr><th>Employee</th><th class="num">AM visits</th><th class="num">PM visits</th><th class="num">Pharmacies</th><th class="num">Days in the field</th><th class="num">To review</th></tr></thead>
  <tbody>${rows.join("")}</tbody>
</table>`;
}

const CALENDAR_CSS = `
  :root {
    --deep: ${HOUSE_COLORS.deep};
    --blue: ${HOUSE_COLORS.blue};
    --light: ${HOUSE_COLORS.light};
    --tint: ${HOUSE_COLORS.tint};
    --hair: ${HOUSE_COLORS.hair};
    --muted: ${HOUSE_COLORS.muted};
    --body: ${HOUSE_COLORS.body};
  }
  ${premiumSheetCss(".cal", "landscape")}
  ${PREMIUM_IDENTITY_CSS}
  * { box-sizing: border-box; border-radius: 0 !important; }
  body { margin: 0; color: var(--body); font-family: "Segoe UI", "Noto Sans", "Noto Sans Arabic", Tahoma, Arial, sans-serif; font-size: 7.4pt; line-height: 1.25; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { padding: .8mm 1.3mm; text-align: start; vertical-align: top; overflow-wrap: anywhere; }

  .who { display: grid; grid-template-columns: repeat(4, 1fr); margin-top: 2.2mm; border-top: .7pt solid var(--deep); border-bottom: .4pt solid var(--hair); }
  .who div { padding: 1mm 1.6mm; border-inline-start: .4pt solid var(--hair); }
  .who div:first-child { border-inline-start: 0; padding-inline-start: 0; }
  .who span, .fig__l, .fig__n { display: block; color: var(--blue); font-size: 5.8pt; font-weight: 700; letter-spacing: 1.2pt; text-transform: uppercase; }
  .who b { display: block; color: var(--body); font-size: 8.6pt; font-weight: 600; }

  .figs { display: flex; margin-top: 1.6mm; border-bottom: .4pt solid var(--hair); }
  .fig { flex: 1 1 0; padding: .9mm 1.6mm 1.1mm; border-inline-start: .4pt solid var(--hair); }
  .fig:first-child { border-inline-start: 0; padding-inline-start: 0; }
  .fig__v { display: block; margin-top: .3mm; color: var(--deep); font-size: 13pt; font-weight: 700; line-height: 1.05; letter-spacing: -.3pt; }
  .fig__n { color: var(--muted); font-weight: 600; letter-spacing: .6pt; }

  .grid { margin-top: 2.2mm; border-top: .7pt solid var(--deep); }
  .grid th { padding: 1mm 1.4mm; color: var(--deep); font-size: 6.4pt; font-weight: 700; letter-spacing: 1.3pt; text-transform: uppercase; border-bottom: .5pt solid var(--hair); border-inline-start: .4pt solid var(--hair); }
  .grid th:first-child, .grid td:first-child { border-inline-start: 0; }
  .grid td { border-bottom: .4pt solid var(--hair); border-inline-start: .4pt solid var(--hair); padding: .8mm 1.4mm 1mm; }
  /* The weeks share the page: four, five or six rows fill what the masthead and the figures leave. */
  .grid--w4 td { height: 29mm; } .grid--w5 td { height: 23mm; } .grid--w6 td { height: 19mm; }
  /* A day outside the month is left blank — the ink rule allows the 6% zebra and no other fill. */
  .grid td.off { border-bottom-color: transparent; }
  .dn { display: block; margin-bottom: .6mm; color: transparent; -webkit-text-stroke: .5pt var(--light); font-size: 15pt; font-weight: 300; line-height: 1; letter-spacing: -.4pt; }
  .none { display: block; color: var(--muted); font-size: 6.2pt; font-style: italic; }

  .en { display: block; margin: 0 0 .6mm; padding: .45mm 1.2mm .5mm 1.3mm; line-height: 1.2; }
  .en:last-child { margin-bottom: 0; }
  .en b { display: block; color: #1E293B; font-size: 6.6pt; font-weight: 700; }
  .en__s { display: block; color: #475569; font-size: 6.2pt; font-weight: 600; letter-spacing: .2pt; }
  ${kindToneCss()}

  .flag { display: flex; align-items: center; gap: 1.2mm; margin-top: .7mm; color: ${FINDING_TONES.danger}; font-size: 6.4pt; font-weight: 700; }
  .flag i { flex: 0 0 auto; width: 1.6mm; height: 1.6mm; background: ${FINDING_TONES.danger}; transform: rotate(45deg); }
  .flag--warning { color: ${FINDING_TONES.warning}; }
  .flag--warning i { background: ${FINDING_TONES.warning}; }
  .flag--info { color: ${FINDING_TONES.info}; font-weight: 600; }
  .flag--info i { background: transparent; border: .7pt solid ${FINDING_TONES.info}; }

  .legend { display: flex; flex-wrap: wrap; align-items: center; gap: 1mm 4mm; margin-top: 1.6mm; }
  .legend .en, .legend .flag { margin: 0; }
  .legend__n { margin-inline-start: auto; color: var(--muted); font-size: 6.2pt; }

  h2 { margin: 0 0 1.4mm; color: var(--deep); font-size: 10.5pt; font-weight: 700; break-after: avoid; }
  .page2 { break-before: page; }
  .list { border-top: .7pt solid var(--deep); }
  .list thead th { color: var(--deep); font-size: 6.4pt; font-weight: 700; letter-spacing: 1.2pt; text-transform: uppercase; border-bottom: .5pt solid var(--hair); }
  .list td { border-bottom: .4pt solid var(--hair); }
  .list tr.z td { background: var(--tint); }
  .list .dd { color: var(--deep); white-space: nowrap; }
  .list .dd b { font-weight: 700; }
  .list .en { margin: 0; }
  .wt { display: block; color: var(--body); font-size: 7.4pt; font-weight: 700; }
  .st { display: block; color: var(--muted); font-size: 6.4pt; text-transform: capitalize; }
  .det span { display: block; }
  .det .src { color: var(--muted); font-size: 6.4pt; font-style: italic; }
  .det span + span { margin-top: .3mm; }
  .num { text-align: end; font-variant-numeric: tabular-nums; }
  .team td.num { color: var(--deep); font-size: 9pt; font-weight: 700; }
  thead { display: table-header-group; }
  .empty { margin: 4mm 0; padding: 3mm; border: .5pt solid var(--hair); color: var(--muted); text-align: center; }
`;

export function buildPrivateCalendarPremiumHtml(workspace: PrivateCalendarWorkspace, generatedAt: Date = new Date()): string {
  const monthLabel = monthLabelOf(workspace.year, workspace.month);
  const team = workspace.viewMode === "team" && workspace.teamSummary.length > 1;
  const people: CalendarPerson[] = team
    ? [...workspace.teamSummary].sort((a, b) => a.fullName.localeCompare(b.fullName))
    : [workspace.selectedEmployee];
  const person = workspace.selectedEmployee;
  const subject = team ? `Team of ${people.length}` : person.fullName;
  const generated = `generated ${stampOf(generatedAt)} (Cairo)`;

  const whoBlock = team
    ? ""
    : `<section class="who">
    <div><span>Employee</span><b>${escapeHtml(person.fullName)}</b></div>
    <div><span>Job title</span><b>${escapeHtml(person.jobTitle ?? "Not set")}</b></div>
    <div><span>Line</span><b>${escapeHtml(person.lineName ?? "Not set")}</b></div>
    <div><span>Manager</span><b>${escapeHtml(person.managerName ?? "Not set")}</b></div>
  </section>`;

  const firstPage = team
    ? `${figuresStrip(workspace, null)}
<h2 class="pm-shead" style="margin-top:3mm">The team this month</h2>
${teamTable(workspace, people)}`
    : `${whoBlock}
${figuresStrip(workspace, person)}
${monthGrid(workspace, person, cairoDateKey(generatedAt))}
${legend(workspace)}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(`Private Calendar — ${subject} — ${monthLabel}`)}</title>
<style>${CALENDAR_CSS}</style></head>
<body>
<main class="cal">
${premiumMasthead({
  compact: true,
  legalNameAr: systemLegalEntity.legalNameAr,
  legalNameEn: systemLegalEntity.legalNameEn,
  orientation: "landscape",
  subtitles: [{ lang: "en", text: `${monthLabel} · ${subject} · ${generated}` }],
  title: "Private Calendar",
  titleLang: "en",
})}
${firstPage}
<section class="page2">
<h2 class="pm-shead">Day by day</h2>
${dayByDay(workspace, team ? people : [person], team)}
</section>
${premiumPageChrome({ department: `Private Calendar · ${monthLabel}`, orientation: "landscape" })}
</main>
</body></html>`;
}

/** The premium calendar as PDF bytes. Throws `ChromiumUnavailableError` when no browser can run. */
export async function renderPrivateCalendarPremiumPdf(workspace: PrivateCalendarWorkspace, generatedAt: Date = new Date()): Promise<Uint8Array> {
  // `setContent` gives the page no origin, so the chrome's `/brand/...` images are inlined first. A
  // calendar is not a filed record: a mark that cannot be read falls back to its alt text, exactly as
  // the interview calendar treats it.
  const { html } = inlineLocalAssets(buildPrivateCalendarPremiumHtml(workspace, generatedAt));
  return withChromiumPage(async (page) => {
    await page.setContent(html, { timeout: 30_000, waitUntil: "domcontentloaded" });
    await page.emulateMediaType("print");
    await page.evaluate(
      "(async () => { try { await document.fonts.ready; } catch {} "
        + "await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))); })()",
    );
    // The premium sheet prints edge to edge, so "N / M" is written into the foot after layout and
    // the foot's diamond steps aside for it — the same two steps as the interview calendar.
    await page.evaluate("document.documentElement.setAttribute('data-pm-numbered', '')");
    const bytes = await page.pdf({
      format: "A4",
      landscape: true,
      margin: { bottom: "0", left: "0", right: "0", top: "0" },
      preferCSSPageSize: true,
      printBackground: true,
      timeout: 30_000,
    });
    return stampPremiumPageNumbers(bytes);
  });
}
