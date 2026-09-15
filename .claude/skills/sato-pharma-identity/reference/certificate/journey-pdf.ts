/**
 * The journey, on paper — as a dashboard rather than as a letter.
 *
 * This is the document that leaves the programme with them. The portal login
 * goes away, the CV needs a number, a manager asks what the internship
 * actually involved — and what answers all three is a file, not a page behind
 * a password.
 *
 * IT IS DRAWN, NOT TYPESET. The first version of this file was a well-set
 * report: rules, headings, a column of sentences. It read like a letter, and a
 * letter is not what somebody attaches to an application or holds up in a
 * closing meeting. So every figure that has a shape now has one — the four
 * weeks as columns, the score as a stacked bar of where it came from, the
 * whole programme as a cumulative step, and every day of it as a cell in a
 * calendar shaded by how busy it was. A reader who never gets past page one
 * still sees the shape of the four weeks.
 *
 * THE IDENTITY SURVIVES THE TRIP, AND SO DOES THE CHART LANGUAGE. Every corner
 * is 90 degrees — there is no pie here and no ring gauge, not because the
 * writer cannot draw one but because a circle is the one shape this design
 * system does not own. Columns, stacks, heat cells and a step line are all
 * rectangles, which is the same argument the portal's own progress bar makes.
 * The palette is globals.css, read off the same hex values, and the only
 * transparency is ink mixed against paper.
 *
 * NOTHING IS INVENTED. Every figure comes from the Journey object, which got
 * it from SQL. There is no sentence in this file that is not assembled from a
 * count — see the header of lib/journey.ts, which explains why that constraint
 * is not negotiable when the output carries two real names on it. A chart is
 * held to the same rule and to one more: it is drawn to scale or not at all.
 * An empty week is an empty column, never a minimum bar that flatters it.
 */

import {
  Pdf,
  measure,
  mix,
  rgb,
  truncate,
  wrapText,
  type RgbColor,
} from "./pdf.ts";
import { SATO_MARK_RATIO, satoMark, type SatoMarkArt } from "./sato-mark.ts";
import { QR_QUIET } from "./qr.ts";
import { drawVerificationQr, verificationCode } from "./verification.ts";
import { addDaysISO } from "./dates.ts";
import {
  dateSpan,
  dayMonth,
  fullDate,
  keyCards,
  orderSummary,
  shortDayMonth,
  ordinalWord,
  tidyPoints,
  weekdayOf,
  type Journey,
  type JourneyDay,
} from "./journey.ts";
import { VISIT_TYPE_LABEL, type VisitType } from "./types.ts";

/* ------------------------------------------------------------ the palette -- */

/* Off globals.css. Named for what they mean there, not for the colour they
   are, so a token that moves in the app moves here too. */
const BRAND = rgb("#0879b8");
const INK = rgb("#111820");
const BODY = rgb("#45515a");
const SOFT = rgb("#69757e");
const FAINT = rgb("#8a959d");
const FRAME = rgb("#ccd6dd");
const LINE = rgb("#dde4e8");
const HAIR = rgb("#e1e7eb");
const CANVAS = rgb("#f2f5f7");
const TINT = rgb("#f3f9fc");
const TINT_LINE = rgb("#b9d8e9");
const WHITE = rgb("#ffffff");
const DANGER = rgb("#b3261e");

/* The two greys that stay legible on the navy field, taken from the dashboard
   card the intern already screenshots. */
const ON_DARK = rgb("#8d9aa4");
const ON_DARK_RULE = rgb("#2b3844");

const ACCENT: Record<string, RgbColor> = {
  brand: BRAND,
  teal: rgb("#0f7a6b"),
  violet: rgb("#5b4bb8"),
  amber: rgb("#8a5a00"),
};

/**
 * The series colours, in order.
 *
 * A stacked bar and the legend beside it must agree, so the colour is taken
 * from the row's position in the channel list rather than from its label —
 * the list is built in one place in journey.ts and a channel that scores
 * nothing is dropped from both at once.
 */
const SERIES: RgbColor[] = [
  BRAND,
  rgb("#0f7a6b"),
  rgb("#5b4bb8"),
  rgb("#8a5a00"),
  rgb("#0f7a52"),
  rgb("#3d4a55"),
];

/** The 10px uppercase label of rule 3, at the size paper wants it. */
const MICRO = { size: 6.8, face: "bold", tracking: 1.15 } as const;

/** The Egyptian working week, which is what the calendar rows are keyed on. */
const WEEKDAYS = [
  "Saturday",
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
];

/* --------------------------------------------------------- the furniture -- */

/** The thick brand rail that opens every screen in the portal. */
function rail(doc: Pdf) {
  doc.rect(0, 0, doc.width, 4.5, BRAND);
}

/** How tall the mark is in the running head, and therefore how wide. */
const MARK_H = 19;

/**
 * The Sato Pharma mark, drawn from the real artwork — or its name set as type.
 *
 * The mark is on every page, which is what a document carrying a company's
 * name next to a person's is expected to do and what the first draft of this
 * one did not: it said "Sato Pharma" in 7.5pt grey at the foot and nowhere
 * else. `ground` is the colour the mark is sitting on, because the artwork is
 * transparent and this writer flattens rather than masks — pass the actual
 * fill under it or the edges come out haloed.
 *
 * The fallback is deliberate and is share-card.ts's: if the artwork cannot be
 * read the document still builds, with the wordmark set as type. Nobody gets
 * told their journey could not be exported because a PNG did not open.
 */
export function satoBadge(
  doc: Pdf,
  art: SatoMarkArt,
  ground: RgbColor,
  ink: RgbColor,
  x: number,
  top: number,
  height: number,
) {
  const image = satoMark(art, ground);
  if (image) {
    doc.image(image, x, top, height * SATO_MARK_RATIO, height);
    return;
  }
  doc.text("SATO PHARMA", x, top + height * 0.68, {
    size: height * 0.44,
    face: "bold",
    tracking: height * 0.1,
    color: ink,
  });
}

/** The programme strap, and the mark on the right of it. */
function strap(doc: Pdf, section: string) {
  const left = section
    ? `FUTURE TALENTS 2026 · ${section.toUpperCase()}`
    : "FUTURE TALENTS 2026";
  doc.text(left, doc.left, 34, { ...MICRO, color: SOFT });
  /* The mark takes the top right corner, so the folio moved to the foot —
     which is where a folio belongs anyway, and saves the head from carrying
     two right-aligned things fighting over the same edge. */
  satoBadge(
    doc,
    "dark",
    WHITE,
    INK,
    doc.right - MARK_H * SATO_MARK_RATIO,
    21,
    MARK_H,
  );
  doc.rule(doc.left, 42, doc.columnWidth, FRAME);
}

/**
 * What every page after the cover carries, whoever started it.
 *
 * The day-by-day section runs over two or three pages and none of them are
 * started by anything that knows what section it is in — room() starts them,
 * in the middle of a list. So the running head is installed on the document
 * once, as a hook, and the section name it prints is whatever openPage() last
 * set. Bare continuation pages were the one thing on the first draft of this
 * document that looked generated.
 */
function installFurniture(doc: Pdf, section: { name: string }) {
  doc.onPage = (page) => {
    rail(page);
    strap(page, section.name);
    /* The foot: programme on the left, folio on the right, hairline over both.
       It no longer repeats "Sato Pharma" in type, because the mark is now in
       the head of this same page and saying it twice is what a template does
       rather than what a designer does. */
    page.rule(page.left, page.height - 44, page.columnWidth, HAIR);
    page.text("Future Talents Program 2026", page.left, page.height - 32, {
      size: 7.5,
      color: FAINT,
    });
    page.text(`Page ${page.pageCount}`, page.left, page.height - 32, {
      size: 7.5,
      color: FAINT,
      align: "right",
      width: page.columnWidth,
    });
    page.y = page.top + 10;
  };
}

/** A page that is not the cover: furniture, title, standfirst. */
function openPage(
  doc: Pdf,
  section: { name: string },
  title: string,
  standfirst: string,
) {
  // Set before the page is started, so the hook prints this section's name.
  section.name = title;
  doc.page();
  doc.y = 82;
  doc.text(title, doc.left, doc.y, { size: 22, face: "bold", color: INK });
  doc.y += 17;
  doc.y = doc.paragraph(standfirst, doc.left, doc.y, doc.columnWidth - 60, {
    size: 10,
    color: SOFT,
    leading: 15,
  });
  doc.y += 16;
}

/** A section heading: the rule, then the label under it. */
function section(doc: Pdf, label: string, right?: string) {
  doc.room(54);
  doc.rule(doc.left, doc.y, doc.columnWidth, INK, 1.5);
  doc.y += 13;
  doc.text(label.toUpperCase(), doc.left, doc.y, { ...MICRO, color: INK });
  if (right) {
    doc.text(right.toUpperCase(), doc.left, doc.y, {
      ...MICRO,
      color: FAINT,
      align: "right",
      width: doc.columnWidth,
    });
  }
  doc.y += 16;
}

/** The grey line that says how to read the thing under it. */
function note(doc: Pdf, text: string) {
  doc.y = doc.paragraph(text, doc.left, doc.y + 4, doc.columnWidth - 40, {
    size: 8.2,
    color: FAINT,
    leading: 11.5,
  });
  doc.y += 6;
}

/** A filled label with text in it. Returns the width it took. */
function chip(
  doc: Pdf,
  x: number,
  y: number,
  text: string,
  fill: RgbColor,
  color: RgbColor,
  size = 9,
): number {
  const w = measure(text, size, "bold") + 12;
  doc.rect(x, y, w, size + 8, fill);
  doc.text(text, x + 6, y + size + 1.5, { size, face: "bold", color });
  return w;
}

/* -------------------------------------------------------------- the parts -- */

/**
 * A grid of figures in hairline cells.
 *
 * The cell backgrounds are painted first and the rules drawn over them,
 * because a 1pt gap between white boxes reads as a seam rather than as a rule.
 */
function statGrid(
  doc: Pdf,
  cells: { label: string; value: string; sub?: string }[],
  columns = 4,
) {
  if (cells.length === 0) return;
  const rows = Math.ceil(cells.length / columns);
  const cellW = doc.columnWidth / columns;
  const cellH = 56;
  const height = rows * cellH;

  doc.room(height + 8);
  const top = doc.y;
  doc.rect(doc.left, top, doc.columnWidth, height, WHITE);

  cells.forEach((cell, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = doc.left + col * cellW;
    const y = top + row * cellH;

    doc.text(cell.label.toUpperCase(), x + 10, y + 16, {
      ...MICRO,
      color: SOFT,
    });
    doc.text(truncate(cell.value, cellW - 20, 19, "bold"), x + 10, y + 39, {
      size: 19,
      face: "bold",
      color: INK,
    });
    if (cell.sub) {
      doc.text(truncate(cell.sub, cellW - 20, 7), x + 10, y + 49, {
        size: 7,
        color: FAINT,
      });
    }
    if (col > 0) doc.rect(x, y, 0.7, cellH, LINE);
    if (row > 0) doc.rect(x, y, cellW, 0.7, LINE);
  });

  // The frame last, so it sits over the internal rules rather than beside them.
  doc.rect(doc.left, top, doc.columnWidth, 0.9, FRAME);
  doc.rect(doc.left, top + height - 0.9, doc.columnWidth, 0.9, FRAME);
  doc.rect(doc.left, top, 0.9, height, FRAME);
  doc.rect(doc.right - 0.9, top, 0.9, height, FRAME);
  doc.y = top + height;
}

/**
 * A column chart, drawn to scale.
 *
 * The track behind each column is what makes an empty week legible: without
 * it a week worth nothing is a blank space that reads as a missing column
 * rather than as a zero. The column itself is never given a minimum height
 * for looks — a week worth 0.4 points draws as a sliver, because that is what
 * it was.
 */
function columnChart(
  doc: Pdf,
  x: number,
  y: number,
  w: number,
  h: number,
  bars: { label: string; sub?: string; value: number; color: RgbColor }[],
  format: (value: number) => string = tidyPoints,
) {
  if (bars.length === 0) return;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const slot = w / bars.length;
  const barW = Math.min(84, slot - 30);
  const plotTop = y + 16;
  const base = y + h;
  const plot = base - plotTop;

  bars.forEach((bar, index) => {
    const cx = x + index * slot + (slot - barW) / 2;
    doc.rect(cx, plotTop, barW, plot, mix(CANVAS, WHITE, 0.3));
    const height = (plot * Math.max(0, bar.value)) / max;
    if (height > 0) doc.rect(cx, base - height, barW, height, bar.color);
    doc.text(format(bar.value), cx, base - height - 6, {
      size: 11.5,
      face: "bold",
      color: INK,
      align: "center",
      width: barW,
    });
  });

  doc.rule(x, base, w, INK, 1.2);

  bars.forEach((bar, index) => {
    const cx = x + index * slot;
    doc.text(bar.label.toUpperCase(), cx, base + 14, {
      ...MICRO,
      color: INK,
      align: "center",
      width: slot,
    });
    if (bar.sub) {
      doc.text(truncate(bar.sub, slot - 10, 7.4), cx, base + 25, {
        size: 7.4,
        color: SOFT,
        align: "center",
        width: slot,
      });
    }
  });
}

/**
 * One bar, divided by where the points came from.
 *
 * Negative rows — a deduction the coordinator made — are left out of the bar
 * and kept in the legend beside it, with a line saying so. A stack cannot
 * draw a negative segment without lying about the total, and quietly dropping
 * the row instead would be the worse lie of the two.
 */
function stackedBar(
  doc: Pdf,
  x: number,
  y: number,
  w: number,
  h: number,
  parts: { value: number; color: RgbColor }[],
) {
  const total = parts.reduce((sum, p) => sum + Math.max(0, p.value), 0);
  doc.rect(x, y, w, h, CANVAS);
  if (total <= 0) return;

  let cursor = x;
  parts.forEach((part) => {
    const segment = (w * Math.max(0, part.value)) / total;
    if (segment <= 0) return;
    doc.rect(cursor, y, segment, h, part.color);
    cursor += segment;
    // A hairline of paper between segments, so two dark colours never merge.
    if (cursor < x + w - 0.5) doc.rect(cursor - 0.9, y, 0.9, h, WHITE);
  });
}

/**
 * The cumulative score, one step per day.
 *
 * A step rather than a smooth line because points land on the day they were
 * earned and nothing accrues overnight — a diagonal between two days would be
 * drawing a rate nobody worked at. It is also the only chart here that shows
 * the quiet stretches, which appear as flats.
 */
function momentum(doc: Pdf, x: number, y: number, w: number, h: number, journey: Journey) {
  const days = journey.days;
  const axisW = 34;
  /* A gutter on the right, because the last point of a cumulative chart is
     always ON the last day and the marker drawn over it is 8pt wide. Without
     it half that marker hangs outside the plot and into the page margin. */
  const endGutter = 6;
  const plotX = x + axisW;
  const plotW = w - axisW - endGutter;
  const base = y + h;

  let running = 0;
  const totals = days.map((day) => {
    running += day.points;
    return Math.round(running * 100) / 100;
  });
  const max = Math.max(1, ...totals);
  const atX = (index: number) =>
    plotX + (plotW * index) / Math.max(1, days.length - 1);
  const atY = (value: number) => base - (h * Math.max(0, value)) / max;

  // The horizontal grid, and its figures out in the left margin.
  for (let i = 0; i <= 3; i++) {
    const value = (max * i) / 3;
    const gy = atY(value);
    doc.rule(plotX, gy, plotW, i === 0 ? LINE : HAIR);
    doc.text(tidyPoints(Math.round(value)), x, gy + 2.5, {
      size: 7,
      color: FAINT,
      align: "right",
      width: axisW - 8,
    });
  }

  // The step itself, as a filled area with the line drawn over its edge.
  const path: [number, number][] = [[plotX, base]];
  totals.forEach((value, index) => {
    path.push([atX(index), atY(index === 0 ? 0 : totals[index - 1])]);
    path.push([atX(index), atY(value)]);
  });
  path.push([atX(days.length - 1), base]);
  doc.polygon(path, mix(BRAND, WHITE, 0.87));
  doc.polyline(path.slice(1, path.length - 1), BRAND, 1.3);

  // Where each week started, labelled on the chart rather than under it.
  for (const chapter of journey.chapters) {
    const index = days.findIndex((day) => day.date === chapter.from);
    if (index <= 0) continue;
    doc.vrule(atX(index), y, h, mix(FRAME, WHITE, 0.35));
    doc.text(`W${chapter.weekNo}`, atX(index) + 4, y + 8, {
      ...MICRO,
      size: 6,
      color: FAINT,
    });
  }

  /* The end of the line, called out, because it is the number the rest of the
     page is about.

     It hangs BELOW the marker rather than above it, and that is not a taste
     decision: a cumulative total only ever climbs, so the last point is always
     the maximum, which is always the top of the plot. Setting the label above
     it put the baseline 8pt off the top of the chart every single time, into
     the section's own strap. Above is kept for the one case that can reach the
     end without touching the ceiling — a journey that scored nothing, where
     the line never leaves the floor. */
  const lastX = atX(days.length - 1);
  const lastY = atY(totals[totals.length - 1] ?? 0);
  doc.rect(lastX - 4, lastY - 4, 8, 8, INK);
  const label = tidyPoints(totals[totals.length - 1] ?? 0);
  const above = lastY - 10 > y;
  doc.text(label, lastX - 9 - measure(label, 10, "bold"), above ? lastY - 8 : lastY + 15, {
    size: 10,
    face: "bold",
    color: INK,
  });

  doc.rule(plotX, base, plotW, INK, 1.2);
  doc.text(shortDayMonth(days[0]?.date ?? journey.span.start), plotX, base + 13, {
    size: 7.4,
    color: SOFT,
  });
  doc.text(
    shortDayMonth(days[days.length - 1]?.date ?? journey.span.end),
    plotX,
    base + 13,
    { size: 7.4, color: SOFT, align: "right", width: plotW },
  );
}

/** Five strengths of one ink, which is the whole of the heatmap's language. */
function heatOf(visits: number): { fill: RgbColor; dark: boolean } {
  if (visits <= 0) return { fill: mix(CANVAS, WHITE, 0.25), dark: false };
  if (visits <= 2) return { fill: mix(WHITE, BRAND, 0.22), dark: false };
  if (visits <= 4) return { fill: mix(WHITE, BRAND, 0.45), dark: false };
  if (visits <= 6) return { fill: mix(WHITE, BRAND, 0.72), dark: true };
  return { fill: BRAND, dark: true };
}

/**
 * Which programme week each calendar row is labelled with — and which rows are
 * labelled with nothing at all.
 *
 * A calendar row is a Saturday-to-Friday week and a programme week is seven
 * days from whenever the programme started, so the two only line up by
 * accident. A row is labelled with the programme week MOST of its days belong
 * to; taking the first day's instead labels a row by a Saturday that is the
 * tail of the week before it, which is how this once read "W1, W1, W2, W3"
 * down a four-week programme.
 *
 * 🔴 AND A WEEK IS NAMED ONCE, ON THE FIRST ROW IT DOMINATES. A four-week
 * programme that starts on a Sunday spills across FIVE Saturday rows, the last
 * holding a single day — so the honest majority answer for that row is W4, the
 * same as the row above it, and the column read "W1 W2 W3 W4 W4". The repeat
 * carries no information and a reader takes it for a mistake. The label marks
 * where a week BEGINS; the row's own date underneath is what identifies it.
 */
export function calendarRowWeeks(
  days: readonly { date: string; weekNo: number | null }[],
): { rowStart: string; label: number | null }[] {
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;
  if (!first || !last) return [];

  let rowStart = first;
  while (weekdayOf(rowStart) !== "Saturday") rowStart = addDaysISO(rowStart, -1);

  const rows: { rowStart: string; label: number | null }[] = [];
  let named: number | null = null;
  while (rowStart <= last) {
    const tally = new Map<number, number>();
    const rowEnd = addDaysISO(rowStart, 7);
    for (const day of days) {
      if (day.date < rowStart || day.date >= rowEnd) continue;
      if (day.weekNo == null) continue;
      tally.set(day.weekNo, (tally.get(day.weekNo) ?? 0) + 1);
    }
    const week = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    rows.push({ rowStart, label: week != null && week !== named ? week : null });
    if (week != null) named = week;
    rowStart = rowEnd;
  }
  return rows;
}

/**
 * Every day of the programme as a cell, in calendar weeks.
 *
 * Rows are real calendar weeks starting on Saturday rather than the
 * programme's own week numbering, because a calendar that does not line its
 * weekends up in a column is not a calendar. Days either side of the
 * programme are drawn as empty outlines: the shape of the month is the point,
 * and dropping them would move a Tuesday into a Saturday column.
 */
function calendar(doc: Pdf, x: number, y: number, journey: Journey): number {
  const byDate = new Map(journey.days.map((day) => [day.date, day]));
  const first = journey.days[0]?.date ?? journey.span.start;
  const last = journey.days[journey.days.length - 1]?.date ?? journey.span.end;

  // Back up to the Saturday on or before the first day.
  let rowStart = first;
  while (weekdayOf(rowStart) !== "Saturday") rowStart = addDaysISO(rowStart, -1);

  const cellW = 62;
  const cellH = 36;
  const gap = 3;
  const gridX = x + 40;

  WEEKDAYS.forEach((day, index) => {
    doc.text(day.slice(0, 3).toUpperCase(), gridX + index * (cellW + gap), y, {
      ...MICRO,
      size: 6.2,
      color: FAINT,
      align: "center",
      width: cellW,
    });
  });

  // Which row says which week — and which say nothing. See calendarRowWeeks().
  const rowWeeks = calendarRowWeeks(journey.days);

  let top = y + 8;
  let rowIndex = 0;
  while (rowStart <= last) {
    const week = rowWeeks[rowIndex]?.label ?? null;
    rowIndex += 1;
    doc.text(week == null ? "" : `W${week}`, x, top + 22, {
      ...MICRO,
      color: SOFT,
    });
    doc.text(shortDayMonth(rowStart), x, top + 32, { size: 6.2, color: FAINT });

    for (let i = 0; i < 7; i++) {
      const date = addDaysISO(rowStart, i);
      const cx = gridX + i * (cellW + gap);
      const day = byDate.get(date);

      if (!day) {
        doc.rect(cx, top, cellW, cellH, WHITE);
        doc.rect(cx, top, cellW, 0.6, HAIR);
        doc.rect(cx, top + cellH - 0.6, cellW, 0.6, HAIR);
        doc.rect(cx, top, 0.6, cellH, HAIR);
        doc.rect(cx + cellW - 0.6, top, 0.6, cellH, HAIR);
        continue;
      }

      const visits = day.visits.length;
      const heat = heatOf(visits);
      doc.rect(cx, top, cellW, cellH, heat.fill);
      doc.text(String(Number(date.slice(8))), cx + 6, top + 11, {
        ...MICRO,
        size: 6,
        color: heat.dark ? mix(WHITE, BRAND, 0.35) : FAINT,
      });
      if (visits > 0) {
        doc.text(String(visits), cx + 6, top + 28, {
          size: 14,
          face: "bold",
          color: heat.dark ? WHITE : INK,
        });
        doc.text("calls", cx + 9 + measure(String(visits), 14, "bold"), top + 28, {
          size: 6.4,
          color: heat.dark ? mix(WHITE, BRAND, 0.25) : SOFT,
        });
      }
      // The bar along the foot of a day they finished top of their line.
      if (day.toppedLine) {
        doc.rect(cx, top + cellH - 3, cellW, 3, heat.dark ? WHITE : INK);
      }
    }

    top += cellH + gap;
    rowStart = addDaysISO(rowStart, 7);
  }

  // The key, under the grid.
  const legendY = top + 8;
  doc.text("QUIET", x, legendY + 11, { ...MICRO, size: 6, color: FAINT });
  let lx = x + 34;
  for (const [count, label] of [
    [0, "0"],
    [1, "1–2"],
    [3, "3–4"],
    [5, "5–6"],
    [8, "7+"],
  ] as [number, string][]) {
    doc.rect(lx, legendY, 30, 14, heatOf(count).fill);
    doc.text(label, lx, legendY + 24, {
      size: 6.6,
      color: FAINT,
      align: "center",
      width: 30,
    });
    lx += 34;
  }
  doc.text("BUSY", lx - 4, legendY + 11, { ...MICRO, size: 6, color: FAINT });
  doc.text(
    "A bar along the foot of a day means you finished top of your line on it.",
    lx + 34,
    legendY + 11,
    { size: 7.4, color: FAINT },
  );

  return legendY + 30;
}

/** A week's daily calls as a row of small columns. */
function sparkline(
  doc: Pdf,
  x: number,
  y: number,
  w: number,
  h: number,
  days: JourneyDay[],
  color: RgbColor,
) {
  if (days.length === 0) return;
  const max = Math.max(1, ...days.map((day) => day.visits.length));
  const slot = w / days.length;
  const barW = Math.max(3, slot - 3);
  days.forEach((day, index) => {
    const cx = x + index * slot;
    doc.rect(cx, y, barW, h, mix(CANVAS, WHITE, 0.3));
    const height = (h * day.visits.length) / max;
    if (height > 0) doc.rect(cx, y + h - height, barW, height, color);
  });
  doc.rule(x, y + h, w, mix(FRAME, WHITE, 0.2));
}

/* ------------------------------------------------------------- the cover -- */

function cover(doc: Pdf, journey: Journey) {
  const { identity, span, totals, points, standing } = journey;
  const heroH = 324;

  doc.rect(0, 0, doc.width, heroH, INK);
  rail(doc);

  /* The mark leads the cover, white out of the navy, at two and a half times
     the size it takes in the running head — this is the page somebody sees
     first and the only one where the company's name outranks the section's.
     Flattened against INK, which is the hero fill drawn immediately above. */
  satoBadge(doc, "reverse", INK, WHITE, doc.left, 26, 26);
  doc.text("FUTURE TALENTS 2026 · FIELD JOURNEY", doc.left, 36, {
    ...MICRO,
    color: ON_DARK,
    align: "right",
    width: doc.columnWidth,
  });
  doc.text(identity.submissionId, doc.left, 48, {
    ...MICRO,
    color: ON_DARK,
    align: "right",
    width: doc.columnWidth,
  });
  doc.rule(doc.left, 62, doc.columnWidth, ON_DARK_RULE);

  /* The name at the size the acceptance letter sets it, stepped down rather
     than truncated when it is long: this is the one string on the document
     that must never be cut, because it is the person it is about. */
  let nameSize = 34;
  while (
    nameSize > 17 &&
    measure(identity.fullName, nameSize, "bold") > doc.columnWidth
  ) {
    nameSize -= 1;
  }
  doc.text(identity.fullName, doc.left, 112, {
    size: nameSize,
    face: "bold",
    color: WHITE,
  });

  const where = [
    identity.line ? `${identity.line} line` : null,
    identity.area,
    identity.mentor ? `with ${identity.mentor}` : null,
  ].filter(Boolean) as string[];
  doc.text(where.join("   ·   "), doc.left, 134, { size: 10, color: ON_DARK });
  doc.text(dateSpan(span.start, span.end), doc.left, 150, {
    size: 10,
    color: ON_DARK,
  });

  // ----------------------------------------------------------- the score --
  doc.rule(doc.left, 176, doc.columnWidth, ON_DARK_RULE);

  doc.text("FINAL SCORE", doc.left, 200, { ...MICRO, color: ON_DARK });
  const score = tidyPoints(points.final);
  doc.text(score, doc.left - 3, 252, { size: 62, face: "bold", color: WHITE });
  if (points.target > 0) {
    doc.text(
      `of ${points.target}`,
      doc.left + 6 + measure(score, 62, "bold"),
      252,
      { size: 11, color: ON_DARK },
    );
  }

  if (points.target > 0) {
    /* The bar is clamped and the label is not. Somebody who finished at 140%
       of target should read 140% — clamping the number as well as the bar
       would quietly take the best thing on the page off it. */
    const pct = Math.round((points.final / points.target) * 100);
    const barW = 236;
    doc.rect(doc.left, 268, barW, 6, ON_DARK_RULE);
    doc.rect(doc.left, 268, (barW * Math.min(100, Math.max(0, pct))) / 100, 6, BRAND);
    doc.text(`${pct}% OF TARGET`, doc.left, 290, { ...MICRO, color: ON_DARK });
  }

  // The two rankings, in their own cell on the right of the hero.
  if (standing?.scored) {
    const cellX = doc.left + 300;
    doc.vrule(cellX - 26, 190, 108, ON_DARK_RULE);
    if (standing.linePlace > 0 && identity.line) {
      doc.text(`IN THE ${identity.line.toUpperCase()} LINE`, cellX, 200, {
        ...MICRO,
        color: ON_DARK,
      });
      doc.text(ordinalWord(standing.linePlace), cellX, 240, {
        size: 34,
        face: "bold",
        color: WHITE,
      });
      doc.text(
        `of ${standing.lineSize}`,
        cellX + 8 + measure(ordinalWord(standing.linePlace), 34, "bold"),
        240,
        { size: 10, color: ON_DARK },
      );
    }
    if (standing.place > 0) {
      doc.text(
        `${ordinalWord(standing.place)} of ${standing.of} across the programme`,
        cellX,
        270,
        { size: 9.5, color: ON_DARK },
      );
    }
  }

  // -------------------------------------------------- the opening sentence --
  const lines = wrapText(journey.opening, doc.columnWidth - 34, 11);
  const bandH = lines.length * 17 + 34;
  doc.rect(0, heroH, doc.width, bandH, TINT);
  doc.rect(0, heroH, doc.width, 1, TINT_LINE);
  doc.rect(0, heroH + bandH - 1, doc.width, 1, TINT_LINE);
  doc.rect(doc.left - 16, heroH + 16, 3, bandH - 32, BRAND);
  let by = heroH + 30;
  for (const line of lines) {
    doc.text(line, doc.left, by, { size: 11, color: BODY });
    by += 17;
  }

  doc.y = heroH + bandH + 26;

  // ---------------------------------------------------------- the figures --
  section(doc, "The four weeks, in numbers", dateSpan(span.start, span.end));

  statGrid(doc, [
    {
      label: "Field calls",
      value: String(totals.visits),
      sub: `${totals.perActiveDay} per day out`,
    },
    {
      label: "Days out",
      value: String(totals.daysActive),
      sub: `of ${totals.days} in the programme`,
    },
    {
      label: "Places & people",
      value: String(totals.contacts),
      sub: "pharmacies and clinicians",
    },
    {
      label: "Products detailed",
      value: String(totals.products),
      sub: "across every call",
    },
    {
      label: "Sessions",
      value: String(totals.sessions),
      sub: `${totals.sessionMinutes} minutes`,
    },
    {
      label: "Assessments",
      value: totals.quizMarks ?? String(totals.quizzes),
      sub: totals.quizMarks ? "marks" : "papers sat",
    },
    {
      label: "Top of the line",
      value: String(totals.daysTopped),
      sub: totals.daysTopped === 1 ? "day" : "days",
    },
    totals.orders > 0
      ? {
          label: "Orders",
          value: String(totals.orders),
          sub: "collected in the field",
        }
      : {
          label: "Longest run",
          value: String(totals.longestStreak?.days ?? 0),
          sub: totals.longestStreak
            ? `${shortDayMonth(totals.longestStreak.from)} to ${shortDayMonth(totals.longestStreak.to)}`
            : "days out in a row",
        },
  ]);

  doc.y += 24;

  // ------------------------------------------------------- the milestones --
  if (journey.milestones.length > 0) {
    section(doc, "Milestones");
    for (const milestone of journey.milestones) {
      doc.room(20);
      doc.rect(doc.left, doc.y + 1, 3, 12, BRAND);
      doc.text(milestone.label, doc.left + 11, doc.y + 10, {
        size: 9.5,
        face: "bold",
        color: INK,
      });
      doc.text(truncate(milestone.detail, 230, 9), doc.left + 160, doc.y + 10, {
        size: 9,
        color: BODY,
      });
      if (milestone.date) {
        doc.text(dayMonth(milestone.date), doc.right, doc.y + 10, {
          size: 9,
          color: SOFT,
          align: "right",
          width: 0,
        });
      }
      doc.y += 18;
      doc.rule(doc.left, doc.y, doc.columnWidth, HAIR);
    }
  }
}

/* ------------------------------------------------------- how it was built -- */

function scoreboard(doc: Pdf, journey: Journey, head: { name: string }) {
  openPage(
    doc,
    head,
    "How the score was built",
    "Every point below was worked out by the portal, on the day it was earned. This page is the same arithmetic, drawn.",
  );

  // ------------------------------------------------------ week by week --
  section(doc, "Points by week", "to scale");
  columnChart(
    doc,
    doc.left,
    doc.y,
    doc.columnWidth,
    126,
    journey.chapters.map((chapter) => ({
      label: `Week ${chapter.weekNo}`,
      sub: `${chapter.visits} ${chapter.visits === 1 ? "call" : "calls"} · ${chapter.daysActive} out`,
      value: chapter.points,
      color: ACCENT[chapter.accent] ?? BRAND,
    })),
  );
  doc.y += 126 + 48;

  // ----------------------------------------------------- where it came from --
  const channels = journey.points.byChannel;
  if (channels.length > 0) {
    const rows = channels.map((channel, index) => ({
      ...channel,
      color: SERIES[index % SERIES.length],
    }));
    const positive = rows.reduce((sum, row) => sum + Math.max(0, row.points), 0);

    section(doc, "Where the points came from", `${channels.length} sources`);
    stackedBar(
      doc,
      doc.left,
      doc.y,
      doc.columnWidth,
      26,
      rows.map((row) => ({ value: row.points, color: row.color })),
    );
    doc.y += 26 + 18;

    for (const row of rows) {
      doc.room(22);
      doc.rect(doc.left, doc.y + 1, 10, 10, row.color);
      doc.text(row.label, doc.left + 18, doc.y + 10, {
        size: 9.5,
        face: "bold",
        color: INK,
      });
      doc.text(truncate(row.detail, 210, 8.5), doc.left + 150, doc.y + 10, {
        size: 8.5,
        color: SOFT,
      });
      const share =
        positive > 0 && row.points > 0
          ? `${Math.round((row.points / positive) * 100)}%`
          : "—";
      doc.text(share, doc.right - 62, doc.y + 10, {
        ...MICRO,
        color: FAINT,
        align: "right",
        width: 0,
      });
      doc.text(tidyPoints(row.points), doc.right, doc.y + 10, {
        size: 10.5,
        face: "bold",
        color: row.points < 0 ? DANGER : INK,
        align: "right",
        width: 0,
      });
      doc.y += 18;
      doc.rule(doc.left, doc.y, doc.columnWidth, HAIR);
    }

    doc.y += 8;
    /* THE ROWS ABOVE ARE THE FINAL SCORE, NOT THE FIELD SCORE, and this line
       said otherwise until 12 Sep 2026. `byChannel` is the five ledger
       channels PLUS the social row, so a list that visibly came to 249.82 sat
       under a rule reading "FIELD TOTAL 227.82" — short by exactly the
       LinkedIn term, with the percentages beside it already worked out
       against the larger number. It is the breakdown-does-not-reach-the-
       headline bug that v_point_ledger exists to prevent, printed on the one
       document that leaves the programme. Named as the cover names it, so
       somebody holding page one against page two reads one number twice. */
    doc.text("FINAL SCORE", doc.left, doc.y + 11, { ...MICRO, color: INK });
    doc.text(tidyPoints(journey.points.final), doc.right, doc.y + 12, {
      size: 13,
      face: "bold",
      color: INK,
      align: "right",
      width: 0,
    });
    doc.y += 20;
    doc.rule(doc.left, doc.y, doc.columnWidth, INK, 1.2);
    doc.y += 6;

    if (rows.some((row) => row.points < 0)) {
      note(
        doc,
        "A deduction cannot be drawn as part of a bar, so it is left out of the one above and shown in full in the list.",
      );
    }
    doc.y += 14;
  }

  // ---------------------------------------------------------- the momentum --
  section(doc, "How the score accumulated", "every day, in order");
  momentum(doc, doc.left, doc.y, doc.columnWidth, 132, journey);
  doc.y += 132 + 22;
  note(
    doc,
    /* It has to say which total this is. The line adds up the points that
       landed on a DAY, which is the field score — the LinkedIn points belong
       to the whole programme and there is no day to file them under. So the
       figure at the end of it is smaller than the one on the cover, and a
       reader who is not told why has found an error rather than a chart. */
    "The line only ever climbs, and it is flat on the days nothing was logged. Each vertical rule is the start of a programme week. It totals the points earned on a day, so it ends at the field score rather than the final one.",
  );
}

/* ------------------------------------------------------------ the rhythm -- */

function rhythm(doc: Pdf, journey: Journey, head: { name: string }) {
  openPage(
    doc,
    head,
    "Every day at a glance",
    "The whole programme on one grid: a cell for every day, shaded by how many calls were logged on it.",
  );

  section(doc, "The calendar", `${journey.totals.daysActive} days out`);
  doc.y = calendar(doc, doc.left, doc.y + 4, journey) + 24;

  // ----------------------------------------------------- the working week --
  const weekdays = WEEKDAYS.map((name) => {
    const all = journey.days.filter((day) => day.weekday === name);
    return {
      label: name.slice(0, 3),
      sub: `${all.filter((day) => day.visits.length > 0).length} of ${all.length} out`,
      value: all.reduce((sum, day) => sum + day.visits.length, 0),
      /* Friday in grey: it is the one day of the Egyptian week the programme
         does not expect anybody in the field, so an empty column under it is
         not the same fact as an empty column under a Tuesday. */
      color: name === "Friday" ? mix(INK, WHITE, 0.62) : BRAND,
    };
  });
  section(doc, "Which days you worked", "calls by weekday");
  columnChart(doc, doc.left, doc.y, doc.columnWidth, 96, weekdays, (value) =>
    String(Math.round(value)),
  );
  doc.y += 96 + 48;

  // ------------------------------------------------------------- the mix --
  const types = (["pharmacy", "doctor", "polyclinic", "hospital", "other"] as VisitType[])
    .map((type, index) => ({
      type,
      label: VISIT_TYPE_LABEL[type],
      value: journey.totals.byType[type] ?? 0,
      color: SERIES[index % SERIES.length],
    }))
    .filter((row) => row.value > 0);

  if (types.length > 0) {
    section(doc, "Who you called on", `${journey.totals.visits} calls`);
    stackedBar(doc, doc.left, doc.y, doc.columnWidth, 24, types);
    doc.y += 24 + 16;

    const cellW = doc.columnWidth / Math.max(1, types.length);
    types.forEach((row, index) => {
      const x = doc.left + index * cellW;
      doc.rect(x, doc.y, 10, 10, row.color);
      doc.text(row.label.toUpperCase(), x + 16, doc.y + 9, {
        ...MICRO,
        color: INK,
      });
      doc.text(
        `${row.value} · ${Math.round((row.value / Math.max(1, journey.totals.visits)) * 100)}%`,
        x + 16,
        doc.y + 22,
        { size: 9, color: SOFT },
      );
    });
    doc.y += 34;
  }

  // --------------------------------------------------------- the best day --
  const best = journey.totals.bestDay;
  if (best) {
    doc.room(70);
    doc.rect(doc.left, doc.y, doc.columnWidth, 58, CANVAS);
    doc.rect(doc.left, doc.y, 3, 58, BRAND);
    doc.text("BUSIEST DAY", doc.left + 18, doc.y + 20, {
      ...MICRO,
      color: SOFT,
    });
    doc.text(fullDate(best.date), doc.left + 18, doc.y + 42, {
      size: 15,
      face: "bold",
      color: INK,
    });
    doc.text(String(best.visits), doc.right - 90, doc.y + 42, {
      size: 26,
      face: "bold",
      color: BRAND,
      align: "right",
      width: 0,
    });
    doc.text("CALLS", doc.right - 82, doc.y + 42, { ...MICRO, color: SOFT });
    doc.y += 58;
  }
}

/* ---------------------------------------------------------- the chapters -- */

function chapters(doc: Pdf, journey: Journey, head: { name: string }) {
  openPage(
    doc,
    head,
    "The four weeks",
    "Each week of the programme had its own brief. This is what happened in each of them.",
  );

  for (const chapter of journey.chapters) {
    doc.room(150);
    const accent = ACCENT[chapter.accent] ?? BRAND;
    const top = doc.y;

    // The header band: the week's own colour, carrying its number and dates.
    doc.rect(doc.left, top, doc.columnWidth, 26, accent);
    doc.text(`WEEK ${chapter.weekNo}`, doc.left + 12, top + 17, {
      ...MICRO,
      color: WHITE,
    });
    doc.text(
      `${dayMonth(chapter.from)} – ${dayMonth(chapter.to)}`,
      doc.right - 12,
      top + 17,
      { ...MICRO, color: mix(WHITE, accent, 0.3), align: "right", width: 0 },
    );

    doc.text(
      truncate(chapter.title, doc.columnWidth - 130, 15, "bold"),
      doc.left,
      top + 48,
      { size: 15, face: "bold", color: INK },
    );

    // The week's daily calls, as a sparkline in the corner of its own card.
    sparkline(doc, doc.right - 112, top + 34, 112, 18, chapter.days, accent);
    doc.text(
      `${chapter.visits} ${chapter.visits === 1 ? "call" : "calls"}`,
      doc.right,
      top + 64,
      { ...MICRO, size: 6.2, color: FAINT, align: "right", width: 0 },
    );

    let y = top + 62;
    if (chapter.subtitle) {
      y = doc.paragraph(chapter.subtitle, doc.left, y, doc.columnWidth - 130, {
        size: 9.5,
        face: "italic",
        color: SOFT,
        leading: 13,
      });
      y += 2;
    }

    y = doc.paragraph(chapter.narrative, doc.left, y + 6, doc.columnWidth, {
      size: 10.5,
      color: BODY,
      leading: 15.5,
    });

    // The week's three figures, on one rule.
    y += 4;
    doc.rule(doc.left, y, doc.columnWidth, HAIR);
    y += 16;
    let x = doc.left;
    for (const [value, label] of [
      [String(chapter.visits), chapter.visits === 1 ? "call" : "calls"],
      [
        String(chapter.daysActive),
        chapter.daysActive === 1 ? "day out" : "days out",
      ],
      [tidyPoints(chapter.points), "points"],
    ]) {
      doc.text(value, x, y, { size: 13, face: "bold", color: INK });
      doc.text(label.toUpperCase(), x + measure(value, 13, "bold") + 6, y, {
        ...MICRO,
        color: SOFT,
      });
      x += 122;
    }

    doc.y = y + 26;
  }
}

/* --------------------------------------------------------- the day spine -- */

/**
 * Every day, in order, with the quiet ones left in.
 *
 * A timeline that drops the empty days reads as a shorter and busier
 * internship than the one that happened. They are drawn as a hairline with the
 * date on it and nothing else, which is honest and takes fifteen points.
 */
function timeline(doc: Pdf, journey: Journey, head: { name: string }) {
  openPage(
    doc,
    head,
    "Day by day",
    `Every day of the programme, from ${fullDate(journey.span.start)} to ${fullDate(journey.span.end)}. Days with nothing logged are left in, because they are part of the record too.`,
  );

  let currentWeek: number | null = null;

  for (const day of journey.days) {
    const chapter = journey.chapters.find((c) => c.weekNo === day.weekNo);
    const accent = ACCENT[chapter?.accent ?? "brand"] ?? BRAND;

    if (day.weekNo !== currentWeek) {
      currentWeek = day.weekNo;
      doc.room(76);
      doc.y += 12;
      doc.rect(doc.left, doc.y, doc.columnWidth, 22, accent);
      doc.text(
        `WEEK ${day.weekNo ?? "—"}${chapter ? ` · ${chapter.title.toUpperCase()}` : ""}`,
        doc.left + 10,
        doc.y + 15,
        { ...MICRO, color: WHITE },
      );
      if (chapter) {
        doc.text(
          `${chapter.visits} CALLS · ${tidyPoints(chapter.points)} POINTS`,
          doc.right - 10,
          doc.y + 15,
          {
            ...MICRO,
            color: mix(WHITE, accent, 0.3),
            align: "right",
            width: 0,
          },
        );
      }
      doc.y += 32;
    }

    drawDay(doc, day, accent);
  }
}

/**
 * One row of the spine.
 *
 * A quiet day is a SHORTER row and not merely an emptier one — 15 points
 * against 34 — which is what makes a fortnight of weekends read as a pause
 * rather than as half the document. It also drops its weekday, because at 15
 * points there is no second line to put one on: drawing it anyway is what put
 * "MON" through the middle of the next day's date the first time this ran.
 */
function drawDay(doc: Pdf, day: JourneyDay, accent: RgbColor) {
  const textX = doc.left + 12;
  const textW = doc.right - textX;
  const lines = day.quiet ? [] : wrapText(day.headline, textW, 9.5, "regular");
  const height = day.quiet ? 15 : 22 + lines.length * 13 + 6;

  doc.room(height + 4);
  const top = doc.y;

  if (day.quiet) {
    doc.rect(doc.left, top + 7, 3, 1, mix(FRAME, WHITE, 0.2));
    doc.text(shortDayMonth(day.date), textX, top + 10, {
      size: 8.5,
      color: FAINT,
    });
    doc.rule(textX + 48, top + 7, doc.right - textX - 48, mix(HAIR, WHITE, 0.4));
    doc.y = top + height;
    return;
  }

  // The week's colour down the edge of every working day, so the weeks read
  // as bands rather than as a list somebody has to count.
  doc.rect(doc.left, top, 3, height - 6, day.toppedLine ? accent : mix(accent, WHITE, 0.55));

  doc.text(shortDayMonth(day.date).toUpperCase(), textX, top + 12, {
    size: 9,
    face: "bold",
    color: INK,
  });
  doc.text(
    day.weekday.slice(0, 3).toUpperCase(),
    textX + measure(shortDayMonth(day.date).toUpperCase(), 9, "bold") + 7,
    top + 12,
    { ...MICRO, size: 6.2, color: FAINT },
  );

  // One square per call, which is the day's shape at a glance.
  if (day.visits.length > 0) {
    const shown = Math.min(10, day.visits.length);
    let sx = textX + 92;
    for (let i = 0; i < shown; i++) {
      doc.rect(sx, top + 5.5, 5, 7, accent);
      sx += 7;
    }
    if (day.visits.length > shown) {
      doc.text(`+${day.visits.length - shown}`, sx + 2, top + 12, {
        ...MICRO,
        size: 6,
        color: SOFT,
      });
    }
  }

  if (day.toppedLine) {
    chip(doc, textX + 176, top + 3, "TOP OF THE LINE", accent, WHITE, 6.2);
  }

  if (day.points !== 0) {
    const label = `${day.points > 0 ? "+" : ""}${tidyPoints(day.points)}`;
    doc.text(label, doc.right, top + 12, {
      size: 10.5,
      face: "bold",
      color: day.points > 0 ? INK : DANGER,
      align: "right",
      width: 0,
    });
  }

  let y = top + 26;
  for (const line of lines) {
    doc.text(line, textX, y, { size: 9.5, color: BODY });
    y += 13;
  }

  doc.y = top + height;
  doc.rule(doc.left, doc.y - 3, doc.columnWidth, mix(HAIR, WHITE, 0.3));
}

/* ------------------------------------------------------------ the ending -- */

function ending(doc: Pdf, journey: Journey, head: { name: string }) {
  // Named before room() decides, because room() is what starts the last page.
  head.name = "The finish";
  // The closing block through to the colophon, which must not be split.
  doc.room(440);
  doc.y += 22;

  const lines = wrapText(journey.closing, doc.columnWidth - 44, 15, "bold");
  const height = lines.length * 21 + 46;
  doc.rect(doc.left, doc.y, doc.columnWidth, height, INK);
  doc.rect(doc.left, doc.y, 4, height, BRAND);
  let y = doc.y + 34;
  for (const line of lines) {
    doc.text(line, doc.left + 24, y, { size: 15, face: "bold", color: WHITE });
    y += 21;
  }
  doc.y += height + 18;

  /* The rank, under the block rather than inside it, and both of them — see
     closingRankFor(). It is set at figure size in the body grey, which is
     enough to be read and not enough to be the last thing this page is
     about. */
  if (journey.closingRank) {
    doc.text(journey.closingRank, doc.left, doc.y + 9, {
      size: 9.5,
      color: BODY,
    });
    doc.y += 16;
  }
  /* And that it is over. Without this the day list simply stopped, which reads
     as a file that was cut off rather than a programme that finished. */
  if (journey.closingNote) {
    doc.text(journey.closingNote, doc.left, doc.y + 9, {
      size: 9.5,
      color: FAINT,
    });
    doc.y += 16;
  }
  doc.y += 6;

  /* The key cards the document is finally about, on one rule — the same ones
     the certificate carries, from the one function both read (owner, 13 Sep
     2026). The closing sentence above already has the score and the calls. */
  const figures = keyCards(journey);
  doc.rule(doc.left, doc.y, doc.columnWidth, INK, 1.2);
  doc.y += 24;
  /* Spaced by what each card holds rather than in equal slots. Equal slots
     held three short labels; at five, a fifth of the column is narrower than
     SESSION ATTENDANCE, which ran straight into the card beside it. So each
     card is as wide as its figure or its label, whichever is wider, the
     column's remaining width is shared evenly between them, and the last card
     ends on the column's right edge. */
  const cardWidths = figures.map(([value, label]) =>
    Math.max(
      measure(value, 22, "bold"),
      measure(label.toUpperCase(), MICRO.size, MICRO.face, MICRO.tracking),
    ),
  );
  const used = cardWidths.reduce((n, w) => n + w, 0);
  const gap = figures.length > 1 ? (doc.columnWidth - used) / (figures.length - 1) : 0;
  let x = doc.left;
  figures.forEach(([value, label], index) => {
    doc.text(value, x, doc.y, { size: 22, face: "bold", color: INK });
    doc.text(label.toUpperCase(), x, doc.y + 13, { ...MICRO, color: SOFT });
    x += cardWidths[index] + gap;
  });
  doc.y += 30;
  /* Every order and what became of it, under the cards (owner, 13 Sep 2026).
     The approved card says only what counted; this line says what was sent
     in. Nothing prints for somebody with no orders at all. */
  const orders = orderSummary(journey);
  if (orders) {
    doc.text(orders, doc.left, doc.y + 4, { size: 9.5, color: BODY });
    doc.y += 18;
  }

  /* Where the document came from, at the foot of it.
     Not a certificate and carefully not worded as one — nobody signed this and
     it is not awarded. It says which programme, which record and which day the
     figures were read on, which is what somebody attaching it to an
     application actually needs it to say. */
  const ledgerTop = doc.y;
  doc.rule(doc.left, ledgerTop, doc.columnWidth, HAIR);
  doc.y += 18;
  /* "Read on" was true while the story ended on today's date. Now that the
     span is clamped to the programme's last day, the date is the day the
     programme closed and says so — a document opened in December is not a
     document read in December. */
  const provenance: [string, string][] = [
    ["Programme", journey.identity.programmeName],
    ["Record", journey.identity.submissionId],
    [journey.span.closed ? "Closed on" : "Read on", fullDate(journey.span.end)],
  ];
  /* A ledger of four cells between two hairlines (owner, 13 Sep 2026: "premium
     polish this part"). The first version set the notes beside the code, under
     the values with eleven points between them, so the block read as a row of
     labels that ran into a paragraph. Now the record is a table and the notes
     are a note about it: three cells of label and value, the verification code
     as the fourth under its own "SCAN TO VERIFY" — the certificate's label, on
     the baseline PROGRAMME and RECORD share — hairline dividers inset from the
     rules the way the figures strip on the certificate carries them, and the
     notes full width under the closing rule.

     Label and code are both flush right: the label is twice the code's width,
     so centring one over the other pushes the label past the margin or pulls
     the code off it. The code hangs its quiet zone from the label's foot, as on
     the certificate, and the closing rule sits as far under the code as the
     labels' cap line sits under the opening one, so the ledger has the same air
     at both ends. 40pt is the certificate's, and a phone has to read both off
     the same printer. */
  const QR_SIDE = 40;
  const CELL_PAD = 14;
  /* The code carries the random id and the page beside it prints the FTP
     number: the intern keeps their own number, and a scan never exposes it. */
  const code = verificationCode(journey.identity.verificationId);
  const verifyLabel = "SCAN TO VERIFY";
  doc.text(verifyLabel, doc.left, doc.y, {
    ...MICRO,
    color: FAINT,
    align: "right",
    width: doc.columnWidth,
  });
  const qrTop = doc.y + MICRO.size * 0.25 + (QR_QUIET * QR_SIDE) / code.size;
  drawVerificationQr(doc, code, doc.left + doc.columnWidth - QR_SIDE, qrTop, QR_SIDE);
  const capAir = doc.y - MICRO.size * 0.72 - ledgerTop;
  const ledgerFoot = qrTop + QR_SIDE + capAir;
  const codeCell =
    doc.left +
    doc.columnWidth -
    measure(verifyLabel, MICRO.size, MICRO.face, MICRO.tracking) -
    CELL_PAD;
  /* Three equal cells in what the code's column leaves: the cards above can be
     four or five across, and three rows spaced on that would bunch left. */
  const cell = (codeCell - doc.left) / provenance.length;
  const dividerTop = ledgerTop + capAir;
  provenance.forEach(([label, value], index) => {
    const px = doc.left + cell * index + (index ? CELL_PAD : 0);
    doc.text(label.toUpperCase(), px, doc.y, { ...MICRO, color: FAINT });
    doc.text(truncate(value, cell - 2 * CELL_PAD, 10, "bold"), px, doc.y + 16, {
      size: 10,
      face: "bold",
      color: INK,
    });
    if (index) doc.vrule(doc.left + cell * index, dividerTop, ledgerFoot - capAir - dividerTop, HAIR);
  });
  doc.vrule(codeCell, dividerTop, ledgerFoot - capAir - dividerTop, HAIR);
  doc.rule(doc.left, ledgerFoot, doc.columnWidth, HAIR);
  doc.y = ledgerFoot + 20;
  doc.y = doc.paragraph(
    /* 🔴 NOT "written by hand". Points a coordinator adds or deducts are a
       channel of their own on the scoreboard, labelled "By hand" — so the
       closing line said nothing was written by hand two pages under a row of
       points that were. Both sentences were true and the document still
       contradicted itself, because the same three words were doing two jobs.
       What this line actually claims is about the arithmetic: no figure was
       re-counted to make the page. So it says that instead. */
    "Every figure in this document was taken from the Future Talents portal, where it was worked out on the day it was earned.",
    doc.left,
    doc.y,
    doc.columnWidth,
    { size: 8.5, color: FAINT, leading: 12.5 },
  );
  /* A line of its own. Run on at full width, the pair broke after "None of
     it", which strands the start of the second sentence at the end of the
     first line. */
  doc.y = doc.paragraph("None of it was re-counted to make this page.", doc.left, doc.y, doc.columnWidth, {
    size: 8.5,
    color: FAINT,
    leading: 12.5,
  });
  /* And, once the programme is over, which day this particular copy came off —
     see issuedNote(). It is the only line in the document that differs between
     two exports of the same closed record, which is precisely its job. */
  if (journey.issuedNote) {
    doc.y = doc.paragraph(
      journey.issuedNote,
      doc.left,
      doc.y + 4,
      doc.columnWidth,
      { size: 8.5, color: FAINT, leading: 12.5 },
    );
  }

  /* The colophon, and it is the last thing on the document on purpose.
     Light is a weight Helvetica does not have and nothing here is embedded —
     the fourteen faces every reader carries are regular, bold and oblique — so
     "light" is made the way a typesetter made it before there were weights to
     choose: small, letterspaced, and set in the faintest grey on the palette.
     Centred under a hairline, which is what stops it reading as a footnote to
     the sentence above it.

     The three verbs are the credit itself and were chosen rather than drafted:
     designed, orchestrated, delivered — one for the thinking, one for the
     running of it and one for the finishing, with no noun in front of them,
     because "programme" would collide with the "Future Talents Program 2026"
     set two lines below in the foot. */
  doc.y += 22;
  doc.rule(doc.left + doc.columnWidth / 3, doc.y, doc.columnWidth / 3, HAIR);
  doc.y += 18;
  doc.text(
    "Designed, orchestrated and delivered by Omar Anwar Gawish",
    doc.left,
    doc.y,
    {
      size: 8,
      color: FAINT,
      tracking: 0.5,
      align: "center",
      width: doc.columnWidth,
    },
  );
}

/* --------------------------------------------------------------- the API -- */

/** A filename that sorts and says whose it is. */
export function journeyFilename(journey: Journey): string {
  const name = journey.identity.fullName
    .normalize("NFD")
    // The combining marks NFD just split off, so "Réda" files as "reda".
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `ftp2026-journey-${name || journey.identity.submissionId}.pdf`;
}

/** Build the whole document and hand back its bytes. */
export function renderJourneyPdf(journey: Journey): Uint8Array {
  const doc = new Pdf({
    margin: 42,
    marginTop: 60,
    marginBottom: 56,
    info: {
      title: `${journey.identity.fullName} — Field journey`,
      author: journey.identity.fullName,
      subject: `${journey.identity.programmeName}, ${dateSpan(journey.span.start, journey.span.end)}`,
      creator: "Sato Pharma · Future Talents Field",
    },
  });

  doc.page();
  cover(doc, journey);

  /* The cover draws its own furniture over a navy field; every page after it
     gets the running head from the hook instead, including the ones room()
     starts in the middle of the day list. */
  const head = { name: "" };
  installFurniture(doc, head);

  scoreboard(doc, journey, head);
  rhythm(doc, journey, head);
  chapters(doc, journey, head);
  timeline(doc, journey, head);
  ending(doc, journey, head);

  return doc.bytes();
}
