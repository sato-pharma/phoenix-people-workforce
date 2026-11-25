/**
 * The rep effectiveness review as a house document — the same report as the workbook, for reading and
 * forwarding, in the HR PREMIUM dress (SATO-DIS-2026-01 v1.0, landscape).
 *
 * Redesigned from scratch on the owner's word (25 Nov 2026: "premium from scratch redesign the pdf"), and
 * numbers only ("I don't need all this text. I need numbers"): a cover that states the period and the rep
 * in the two-weight headline, the fact strip, the measure cells and the route of the period's months; then
 * six numbered sections, every grid with the months across.
 *
 * The ink rule holds: lines and type only, the 6% zebra the one filled area, square corners. The rep's own
 * months are marked by ink and a rule over their column, and on the route by a solid diamond — a mark,
 * drawn as a vector polygon, never a filled box.
 */

import { systemLegalEntity } from "@/config/system-settings";
import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import {
  PREMIUM_COMPANY_DOCUMENT_BRAND,
  PREMIUM_IDENTITY_CSS,
  PREMIUM_LATIN_FONT_STACK,
  premiumMasthead,
  premiumPageChrome,
  premiumSheetCss,
} from "@/lib/hiring-pack/premium-identity";
import {
  monthLong,
  monthsBetween,
  monthShort,
  pctOf,
  periodLabel,
  type EffKpiFigures,
  type EffScoreRow,
  type RepEffectivenessReport,
} from "@/lib/sales/rep-effectiveness/model";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Arabic runs isolated one by one, so a mixed name keeps its Latin parts in order. */
function bidi(value: string | null | undefined): string {
  const text = String(value ?? "");
  return text
    .split(/([؀-ۿ][؀-ۿ\s،؛؟-]*)/)
    .filter(Boolean)
    .map((run) => (/^[؀-ۿ]/.test(run) ? `<span dir="rtl" lang="ar">${esc(run.trim())}</span>` : esc(run)))
    .join("");
}

const DASH = "&ndash;";
const money = (v: number | null | undefined) => (v == null ? DASH : Math.round(v).toLocaleString("en-US"));
const pc = (v: number | null | undefined) => (v == null ? DASH : `${v}%`);
const rate = (v: number | null | undefined) => (v == null ? DASH : v.toFixed(1));

const scoreValue = (row: EffScoreRow, v: number | null | undefined) =>
  v == null ? DASH : row.kind === "pct" ? `${v}%` : row.kind === "rate" ? v.toFixed(1) : money(v);

function generatedOn(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" }).format(new Date(iso));
}

function dayLong(iso: string | null): string {
  if (!iso) return "Not recorded";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** A diamond marker as a four-point polygon — never a transformed square (the identity's print rule). */
function diamond(kind: "solid" | "open" | "faint", size = 3.4): string {
  const c = HOUSE_COLORS;
  const h = size / 2;
  const fill = kind === "solid" ? c.deep : "#FFFFFF";
  const stroke = kind === "faint" ? c.hair : c.deep;
  return `<svg class="dia" width="${size}mm" height="${size}mm" viewBox="0 0 ${size} ${size}" aria-hidden="true"><polygon points="${h},0.2 ${size - 0.2},${h} ${h},${size - 0.2} 0.2,${h}" fill="${fill}" stroke="${stroke}" stroke-width="0.26"/></svg>`;
}

const SECTIONS = [
  { n: "01", key: "Scorecard", title: "The scorecard" },
  { n: "02", key: "KPIs", title: "KPIs beside the district colleagues" },
  { n: "03", key: "Customers", title: "Customers per product per month" },
  { n: "04", key: "Sales", title: "Sales against target, product by product" },
  { n: "05", key: "History", title: "Before and during the rep's months" },
  { n: "06", key: "Pharmacies", title: "Every pharmacy that bought" },
] as const;

function kpiCells(f: EffKpiFigures | null, strong: boolean): string {
  if (!f) return `<td class="num muted" colspan="7">${DASH}</td>`;
  const s = strong ? " strong" : "";
  return [
    `<td class="num${s}">${pc(f.coveragePct)}</td>`,
    `<td class="num${s}">${pc(f.frequencyPct)}</td>`,
    `<td class="num${s}">${rate(f.amPerDay)}</td>`,
    `<td class="num muted">${pc(f.amAttainmentPct)}</td>`,
    `<td class="num${s}">${rate(f.pmPerDay)}</td>`,
    `<td class="num muted">${pc(f.pmAttainmentPct)}</td>`,
    `<td class="num strong deep">${f.justStarted ? "New" : pc(f.overallPct)}</td>`,
  ].join("");
}

export function buildRepEffectivenessDocument(report: RepEffectivenessReport): string {
  const rep = report.rep;
  const span = periodLabel(report.period);
  const on = generatedOn(report.generatedAt);
  const isRep = (m: string) => report.repMonths.includes(m);
  const months = report.months;
  const mine = (m: string) => (isRep(m) ? " mine" : "");
  const monthHead = (m: string) => `<th class="num${mine(m)}">${esc(monthShort(m))}</th>`;
  const monthCols = (count: number) => Array.from({ length: count }, () => "<col>").join("");

  const masthead = (cover: boolean) =>
    premiumMasthead({
      compact: cover,
      slim: !cover,
      legalNameAr: systemLegalEntity.legalNameAr,
      legalNameEn: systemLegalEntity.legalNameEn,
      orientation: "landscape",
      subtitles: [{ lang: "en", text: cover ? `Sales Force Effectiveness · ${span}` : `${rep.name} · ${rep.areaName} · ${span}` }],
      title: "Effectiveness Review",
      titleLang: "en",
    });
  const chrome = premiumPageChrome({
    brand: PREMIUM_COMPANY_DOCUMENT_BRAND,
    department: `Sales Force Effectiveness · read ${on}, Cairo time`,
    orientation: "landscape",
  });

  const head = (index: number) => {
    const s = SECTIONS[index];
    return `<header class="sec">
    <p class="sec__n">${s.n}</p>
    <div class="sec__t"><p class="micro">${esc(s.key)} &middot; ${bidi(rep.name)}</p><h2 class="sec__h">${esc(s.title)}</h2></div>
  </header>
  <div class="tick"><i></i><i></i><i></i></div>`;
  };

  // ── The cover ──────────────────────────────────────────────────────────────────────────────────
  const sales = report.sales;
  const latest = sales[sales.length - 1] ?? null;
  const kpiLatest = [...report.kpis].reverse().find((k) => !k.unread && k.rep && !k.rep.justStarted && k.rep.overallPct != null) ?? null;
  const directTotal = sales.reduce((sum, s) => sum + s.directValue, 0);

  const measures: { k: string; v: string; s: string }[] = [
    { k: "Achievement", v: pc(latest?.achievementPct), s: latest ? esc(monthLong(latest.month)) : "No published month" },
    { k: "Sales (EGP)", v: money(latest?.actualValue), s: latest ? `Target ${money(latest.targetValue)}` : DASH },
    {
      k: "Without direct orders",
      v: pc(latest ? (latest.directValue > 0 ? latest.achievementWithoutDirectPct : latest.achievementPct) : null),
      s: latest ? `Direct ${money(latest.directValue)}` : DASH,
    },
    { k: "Pharmacies buying", v: latest ? String(latest.pharmaciesBuying) : DASH, s: `Of ${report.universe.total == null ? DASH : report.universe.total.toLocaleString("en-US")} on the map` },
    {
      k: "Overall KPI",
      v: pc(kpiLatest?.rep?.overallPct),
      s: kpiLatest ? `${esc(monthLong(kpiLatest.month))}${kpiLatest.toDate ? " to date" : ""}` : "No KPI month",
    },
    { k: "Direct orders (EGP)", v: money(directTotal), s: `${months.length} published month${months.length === 1 ? "" : "s"}` },
  ];

  const facts: [string, string][] = [
    ["Area", `${esc(rep.areaName)}${rep.regionName ? ` &middot; ${esc(rep.regionName)}` : ""}`],
    ["Line", esc(rep.line)],
    ["Job title", esc(rep.jobTitle)],
    ["Manager", esc(rep.managerName ?? "Not recorded")],
    ["Hired", esc(dayLong(rep.hireDate))],
  ];

  const bySales = new Map(sales.map((s) => [s.month, s]));
  const routeMonths = report.period.from && report.period.to ? monthsBetween(report.period.from, report.period.to) : months;
  const route = routeMonths
    .map((m) => {
      const s = bySales.get(m);
      const kind = !s ? "faint" : isRep(m) ? "solid" : "open";
      return `<div class="route__m route__m--${kind}">
      <p class="route__mon">${esc(monthShort(m))}</p>
      ${diamond(kind)}
      <p class="route__v">${s ? pc(s.achievementPct) : DASH}</p>
      <p class="route__s">${s ? money(s.actualValue) : "&nbsp;"}</p>
    </div>`;
    })
    .join("");

  const contents = SECTIONS.map((s) => `<li><span class="toc__n">${s.n}</span><span class="toc__t">${esc(s.title)}</span></li>`).join("");

  const cover = `
<section class="page cover">
  ${masthead(true)}
  <div class="hero">
    <div class="hero__l">
      <p class="eyebrow">${diamond("solid", 2)}<span>Effectiveness review</span></p>
      <h1 class="h1"><span class="h1__light">${esc(span)}</span><span class="h1__bold">${bidi(rep.name)}</span></h1>
      <div class="tick"><i></i><i></i><i></i></div>
    </div>
    <ol class="toc">${contents}</ol>
  </div>
  <div class="facts">${facts.map(([k, v]) => `<div class="fact"><p class="micro">${k}</p><p class="fact__v">${v}</p></div>`).join("")}</div>
  <div class="measures">${measures.map((m) => `<div class="measure"><p class="micro">${m.k}</p><p class="measure__v">${m.v}</p><p class="measure__s">${m.s}</p></div>`).join("")}</div>
  <div class="route-block">
    <p class="micro route-block__k">The period &middot; achievement and sales (EGP)</p>
    <div class="route" style="grid-template-columns: repeat(${Math.max(routeMonths.length, 1)}, 1fr)">${route}</div>
    <p class="key">${diamond("solid", 2.2)}<span>The rep's months</span>${diamond("open", 2.2)}<span>Before the rep</span>${diamond("faint", 2.2)}<span>Not published</span></p>
  </div>
  ${chrome}
</section>`;

  // ── 01 · The scorecard ─────────────────────────────────────────────────────────────────────────
  const sc = report.scorecard;
  const scoreTable = (rows: EffScoreRow[], cols: string[], targetHead: string, marked: (m: string) => boolean, toDate: string | null = null) => `
  <table class="tbl grid score">
    <colgroup><col style="width:24%">${monthCols(cols.length)}<col style="width:10%"></colgroup>
    <thead><tr><th></th>${cols.map((m) => `<th class="num${marked(m) ? " mine" : ""}">${esc(monthShort(m))}${m === toDate ? '<span class="todate">to date</span>' : ""}</th>`).join("")}<th class="num">${targetHead}</th></tr></thead>
    <tbody>${rows
      .map(
        (row, i) =>
          `<tr${rows[i + 1]?.group ? ' class="cut"' : ""}><td class="${row.strong ? "strong deep" : ""}">${esc(row.label)}</td>${cols
            .map((m) => `<td class="num${marked(m) ? " mine" : ""}${row.strong ? " strong big" : ""}">${scoreValue(row, row.values[m])}</td>`)
            .join("")}<td class="num muted">${row.target == null ? "" : scoreValue(row, row.target)}</td></tr>`,
      )
      .join("")}</tbody>
  </table>`;
  const scorePage = `
<section class="page">
  ${masthead(false)}
  ${head(0)}
  <p class="micro sub">The area, by published month</p>
  ${months.length ? scoreTable(sc.closing, sc.months, "On the map", isRep) : `<p class="none">No published month in the period.</p>`}
  <p class="micro sub">KPIs, the rep's months</p>
  ${sc.kpiMonths.length ? scoreTable(sc.kpi, sc.kpiMonths, "Target", () => true, sc.kpiToDate) : `<p class="none">No KPI month in the period on or after the hiring date.</p>`}
</section>`;

  // ── 02 · KPIs beside the colleagues ────────────────────────────────────────────────────────────
  const kpiBody = report.kpis
    .map((k) => {
      const own = `<tr class="own"><td class="strong deep">${esc(monthShort(k.month))}${k.toDate ? '<span class="todate">to date</span>' : ""}</td><td class="strong">${bidi(rep.name)}</td>${kpiCells(k.unread ? null : k.rep, true)}</tr>`;
      const others = k.colleagues
        .map((c) => `<tr><td></td><td>${bidi(c.name)}${c.area ? `<span class="area">${bidi(c.area)}</span>` : ""}</td>${kpiCells(c.figures, false)}</tr>`)
        .join("");
      return own + others;
    })
    .join("");
  const kpiPage = `
<section class="page">
  ${masthead(false)}
  ${head(1)}
  <table class="tbl kpi">
    <colgroup><col style="width:8%"><col style="width:26%"><col><col><col><col><col><col><col></colgroup>
    <thead><tr><th>Month</th><th>Rep</th><th class="num">Coverage</th><th class="num">Frequency</th><th class="num">Account visits a day</th><th class="num">vs 2</th><th class="num">Doctor visits a day</th><th class="num">vs 10</th><th class="num">Overall</th></tr></thead>
    <tbody><tr class="target"><td>Target</td><td></td><td class="num">95%</td><td class="num">100%</td><td class="num">2.0</td><td class="num">100%</td><td class="num">10.0</td><td class="num">100%</td><td class="num">100%</td></tr>${
      kpiBody || `<tr><td colspan="9" class="muted">No KPI month in the period on or after the hiring date.</td></tr>`
    }</tbody>
  </table>
</section>`;

  // ── 03 · Customers per product, and by brick ───────────────────────────────────────────────────
  const average = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);
  const customersPage = `
<section class="page">
  ${masthead(false)}
  ${head(2)}
  <table class="tbl grid">
    <colgroup><col style="width:24%">${monthCols(months.length)}<col style="width:10%"></colgroup>
    <thead><tr><th>Product</th>${months.map(monthHead).join("")}<th class="num">Average</th></tr></thead>
    <tbody>${report.products
      .map((p) => {
        const vals = months.map((m) => report.customers[p.code]?.[m] ?? 0);
        return `<tr><td class="strong deep">${esc(p.name)}</td>${months.map((m, i) => `<td class="num${mine(m)}">${vals[i] || DASH}</td>`).join("")}<td class="num muted">${average(vals) ?? DASH}</td></tr>`;
      })
      .join("")}</tbody>
    <tfoot><tr><td>Any product</td>${sales.map((s) => `<td class="num${mine(s.month)}">${s.pharmaciesBuying}</td>`).join("")}<td class="num">${
      average(sales.map((s) => s.pharmaciesBuying)) ?? DASH
    }</td></tr></tfoot>
  </table>
  <p class="micro sub">Pharmacies buying any product, by brick</p>
  <table class="tbl grid">
    <colgroup><col style="width:24%">${monthCols(months.length)}<col style="width:10%"></colgroup>
    <thead><tr><th>Brick</th>${months.map(monthHead).join("")}<th class="num">On the map</th></tr></thead>
    <tbody>${report.bricks
      .map((b) => `<tr><td class="strong">${bidi(b.name)}</td>${months.map((m) => `<td class="num${mine(m)}">${b.months[m] || DASH}</td>`).join("")}<td class="num muted">${b.onMap == null ? DASH : b.onMap.toLocaleString("en-US")}</td></tr>`)
      .join("")}</tbody>
    <tfoot><tr><td>The area</td>${sales.map((s) => `<td class="num${mine(s.month)}">${s.pharmaciesBuying}</td>`).join("")}<td class="num">${
      report.universe.total == null ? DASH : report.universe.total.toLocaleString("en-US")
    }</td></tr></tfoot>
  </table>
</section>`;

  // ── 04 · Sales against target, product by product — units per product only, never added ─────
  const productRows = report.products
    .map((p, pi) => {
      const cell = (m: string) => report.productSales[p.code]?.[m];
      const named = `<tr${pi > 0 ? ' class="cut-top"' : ""}><td class="strong deep">${esc(p.name)}</td>${months.map((m) => `<td class="num${mine(m)} strong">${money(cell(m)?.actualUnits)}</td>`).join("")}</tr>`;
      const target = `<tr><td class="lbl">Units target</td>${months.map((m) => `<td class="num${mine(m)} muted">${money(cell(m)?.targetUnits)}</td>`).join("")}</tr>`;
      const achieved = `<tr><td class="lbl">Value achievement</td>${months
        .map((m) => {
          const c = cell(m);
          return `<td class="num${mine(m)} deep">${pc(c?.targetValue ? pctOf(c.actualValue, c.targetValue) : null)}</td>`;
        })
        .join("")}</tr>`;
      return named + target + achieved;
    })
    .join("");
  const salesPage = `
<section class="page">
  ${masthead(false)}
  ${head(3)}
  <table class="tbl grid prod">
    <colgroup><col style="width:24%">${monthCols(months.length)}</colgroup>
    <thead><tr><th>Product &middot; units sold</th>${months.map(monthHead).join("")}</tr></thead>
    <tbody>${productRows}</tbody>
    <tfoot>
      <tr><td>Sales (EGP)</td>${sales.map((s) => `<td class="num${mine(s.month)}">${money(s.actualValue)}</td>`).join("")}</tr>
      <tr class="foot2"><td>Target (EGP)</td>${sales.map((s) => `<td class="num${mine(s.month)}">${money(s.targetValue)}</td>`).join("")}</tr>
      <tr class="foot2"><td>Achievement</td>${sales.map((s) => `<td class="num${mine(s.month)}">${pc(s.achievementPct)}</td>`).join("")}</tr>
    </tfoot>
  </table>
</section>`;

  // ── 05 · Before and during the rep's months ────────────────────────────────────────────────────
  const src = (m: string) => report.sources[m];
  const historyRows: { label: string; pick: (m: string) => string; strong?: boolean }[] = [
    { label: "Sales (EGP)", pick: (m) => money(bySales.get(m)?.actualValue), strong: true },
    { label: "Achievement", pick: (m) => pc(bySales.get(m)?.achievementPct), strong: true },
    { label: "Direct orders (EGP)", pick: (m) => money(bySales.get(m)?.directValue) },
    { label: "Pharmacy sales (EGP)", pick: (m) => money(src(m)?.pharmacy) },
    { label: "Wholesaler and store share (EGP)", pick: (m) => money(src(m)?.wholesalerShare) },
    { label: "Main Stores and other (EGP)", pick: (m) => money(src(m)?.other) },
    { label: "Pharmacies buying", pick: (m) => String(bySales.get(m)?.pharmaciesBuying ?? DASH), strong: true },
  ];
  const g = report.growth;
  const growthBlock = g
    ? `<div class="bridge">
    <p class="micro sub">Where the change from ${esc(monthShort(g.from))} to ${esc(monthShort(g.to))} came from (EGP)</p>
    <table class="tbl">
      <colgroup><col style="width:58%"><col style="width:24%"><col style="width:18%"></colgroup>
      <thead><tr><th></th><th class="num">EGP</th><th class="num">Share</th></tr></thead>
      <tbody><tr><td class="strong deep">${esc(monthShort(g.from))} closing</td><td class="num strong">${money(g.start)}</td><td></td></tr>
      ${g.steps
        .map(
          (s) =>
            `<tr><td>${esc(s.label)}</td><td class="num">${s.change >= 0 ? "+" : "&minus;"}${money(Math.abs(s.change))}</td><td class="num muted">${pc(Math.abs(g.end - g.start) >= 1 ? pctOf(s.change, g.end - g.start) : null)}</td></tr>`,
        )
        .join("")}</tbody>
      <tfoot><tr><td>${esc(monthShort(g.to))} closing</td><td class="num">${money(g.end)}</td><td></td></tr></tfoot>
    </table>
  </div>`
    : "";
  const avgCell = (k: string, v: number | null) =>
    `<div class="measure"><p class="micro">${k}</p><p class="measure__v">${v == null ? DASH : String(v)}</p><p class="measure__s">Pharmacies per product a month</p></div>`;
  const historyPage = `
<section class="page">
  ${masthead(false)}
  ${head(4)}
  <table class="tbl grid">
    <colgroup><col style="width:24%">${monthCols(months.length)}</colgroup>
    <thead><tr><th>Seat held by</th>${months.map(monthHead).join("")}</tr></thead>
    <tbody><tr class="holder"><td class="muted">At the month's end</td>${months.map((m) => `<td class="num${mine(m)}">${bidi(bySales.get(m)?.holder ?? "Not recorded")}</td>`).join("")}</tr>
    ${historyRows
      .map((r) => `<tr><td class="${r.strong ? "strong deep" : ""}">${esc(r.label)}</td>${months.map((m) => `<td class="num${mine(m)}${r.strong ? " strong" : ""}">${r.pick(m)}</td>`).join("")}</tr>`)
      .join("")}</tbody>
  </table>
  <div class="split">
    <div class="measures measures--two">${avgCell("Before the rep", report.beforeAveragePerProduct)}${avgCell("The rep's months", report.repAveragePerProduct)}</div>
    ${growthBlock}
  </div>
</section>`;

  // ── 06 · Every pharmacy that bought ────────────────────────────────────────────────────────────
  const legend = report.products.map((p) => `<span><b>${esc(p.tag)}</b> ${esc(p.name)}</span>`).join("");
  const pharmacyPage = `
<section class="page">
  ${masthead(false)}
  ${head(5)}
  <p class="legend">${legend}</p>
  <table class="tbl grid pharm">
    <colgroup><col style="width:24%"><col style="width:13%">${monthCols(months.length)}<col style="width:6%"><col style="width:5%"></colgroup>
    <thead><tr><th>Pharmacy</th><th>Brick</th>${months.map(monthHead).join("")}<th class="num">Months</th><th class="num">New</th></tr></thead>
    <tbody>${report.pharmacies
      .map(
        (p) =>
          `<tr><td>${bidi(p.name)}</td><td class="muted">${bidi(p.brickName)}</td>${months
            .map((m) => `<td class="num${mine(m)}${p.months[m] ? " strong" : ""}">${p.months[m] ? esc(p.months[m].join(" ")) : ""}</td>`)
            .join("")}<td class="num strong">${p.monthsBought}</td><td class="num strong deep">${p.newInRepTime ? "New" : ""}</td></tr>`,
      )
      .join("")}</tbody>
    <tfoot><tr><td>Pharmacies buying that month</td><td></td>${sales.map((s) => `<td class="num${mine(s.month)}">${s.pharmaciesBuying}</td>`).join("")}<td class="num">${report.pharmacies.length}</td><td class="num">${
      report.pharmacies.filter((p) => p.newInRepTime).length
    }</td></tr></tfoot>
  </table>
</section>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Effectiveness Review — ${esc(rep.name)} — ${esc(span)}</title>
<style>${documentCss()}</style></head>
<body>${cover}${scorePage}${kpiPage}${customersPage}${salesPage}${historyPage}${pharmacyPage}</body></html>`;
}

function documentCss(): string {
  const c = HOUSE_COLORS;
  const display = `"Segoe UI Variable Display", "Segoe UI", "Noto Sans", sans-serif`;
  return `
${premiumSheetCss(".page", "landscape")}
${PREMIUM_IDENTITY_CSS}
* { box-sizing: border-box; border-radius: 0 !important; }
html, body { margin: 0; padding: 0; }
body { font-family: ${PREMIUM_LATIN_FONT_STACK}; color: ${c.body}; font-size: 7.8pt; line-height: 1.34; font-variant-numeric: tabular-nums; }
p { margin: 0; }
.page { page-break-after: always; }
.page:last-child { page-break-after: auto; }
.strong { font-weight: 700; }
.deep { color: ${c.deep}; }
.muted { color: ${c.muted}; }
.micro { font-size: 6.4pt; font-weight: 700; text-transform: uppercase; letter-spacing: 1.4pt; color: ${c.blue}; }
.dia { display: block; flex: none; }

/* the tick: three rules in a row */
.tick { display: flex; align-items: center; gap: 1.2mm; margin: 2mm 0 0; }
.tick i { display: block; border-top: 1.2pt solid ${c.blue}; width: 14mm; }
.tick i + i { border-top: .8pt solid ${c.light}; width: 3mm; }
.tick i + i + i { border-top: .6pt solid ${c.hair}; width: 1.2mm; }

/* the cover */
.cover { display: flex; flex-direction: column; height: 209mm; }
.hero { display: grid; grid-template-columns: 1fr 82mm; column-gap: 12mm; align-items: end; margin-top: 9mm; }
.eyebrow { display: flex; align-items: center; gap: 2mm; font-size: 7pt; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6pt; color: ${c.blue}; }
.eyebrow::after { content: ""; flex: 1 1 auto; border-top: .5pt solid ${c.hair}; }
.h1 { margin: 2.6mm 0 0; font-family: ${display}; color: ${c.deep}; line-height: 1.02; }
.h1__light { display: block; font-size: 23pt; font-weight: 300; letter-spacing: -.4pt; }
.h1__bold { display: block; margin-top: 1.2mm; font-size: 46pt; font-weight: 700; letter-spacing: -1.2pt; }
.toc { list-style: none; margin: 0; padding: 0; border-top: .7pt solid ${c.deep}; }
.toc li { display: flex; align-items: baseline; gap: 3mm; padding: 1.4mm 0; border-bottom: .4pt solid ${c.hair}; }
.toc__n { width: 10mm; font-family: ${display}; font-size: 14pt; font-weight: 300; color: transparent; -webkit-text-stroke: .5pt ${c.light}; line-height: 1; }
.toc__t { font-size: 7.6pt; font-weight: 600; color: ${c.deep}; }

.facts { display: grid; grid-template-columns: 1.5fr 1fr 1.4fr 1.3fr 1fr; margin-top: 10mm; border-top: .7pt solid ${c.deep}; }
.fact { padding: 1.4mm 2.2mm 1.6mm; border-right: .4pt solid ${c.hair}; border-bottom: .4pt solid ${c.hair}; }
.fact:first-child { padding-left: 0; }
.fact:last-child { border-right: 0; }
.fact__v { margin-top: .6mm; font-size: 8.8pt; font-weight: 600; color: ${c.ink}; }

.measures { display: grid; grid-template-columns: repeat(6, 1fr); column-gap: 5mm; margin-top: 9mm; }
.measure { border-top: .7pt solid ${c.deep}; padding-top: 1.6mm; }
.measure__v { margin-top: 1.6mm; font-family: ${display}; font-size: 28pt; font-weight: 700; letter-spacing: -.6pt; line-height: 1; color: ${c.deep}; }
.measure__s { margin-top: 1.2mm; font-size: 7pt; color: ${c.muted}; }

.route-block { margin-top: auto; padding-bottom: 2mm; }
.route-block__k { display: flex; align-items: center; gap: 3mm; }
.route-block__k::after { content: ""; flex: 1 1 auto; border-top: .5pt solid ${c.hair}; }
.route { position: relative; display: grid; margin-top: 2.4mm; }
.route::before { content: ""; position: absolute; left: 0; right: 0; top: 6.3mm; border-top: .5pt solid ${c.hair}; }
.route__m { position: relative; display: flex; flex-direction: column; align-items: center; text-align: center; }
.route__mon { height: 4.6mm; font-size: 6.6pt; font-weight: 700; text-transform: uppercase; letter-spacing: 1pt; color: ${c.muted}; }
.route__m--solid .route__mon { color: ${c.deep}; }
.route__v { margin-top: 1.8mm; font-family: ${display}; font-size: 16pt; font-weight: 700; color: ${c.deep}; line-height: 1; }
.route__m--open .route__v { font-weight: 400; }
.route__m--faint .route__v { color: ${c.hair}; font-weight: 400; }
.route__s { margin-top: 1mm; font-size: 7pt; color: ${c.muted}; }
.key { display: flex; align-items: center; gap: 1.4mm; margin-top: 3.2mm; font-size: 6.6pt; color: ${c.muted}; }
.key span { margin-right: 4mm; }

/* a section head: the outline numeral beside its title */
.sec { display: flex; align-items: flex-end; gap: 4mm; margin-top: 3.4mm; }
.sec__n { font-family: ${display}; font-size: 34pt; font-weight: 200; line-height: .86; color: transparent; -webkit-text-stroke: .6pt ${c.light}; }
.sec__t { padding-bottom: .4mm; }
.sec__h { margin: .8mm 0 0; font-family: ${display}; font-size: 16pt; font-weight: 700; letter-spacing: -.3pt; line-height: 1.05; color: ${c.deep}; }
.sec + .tick { margin-bottom: 3.6mm; }
.sub { display: flex; align-items: center; gap: 3mm; margin: 4.2mm 0 1.4mm; break-after: avoid; }
.sub::after { content: ""; flex: 1 1 auto; border-top: .5pt solid ${c.hair}; }
.tick + .sub { margin-top: 0; }
.none { padding: 2mm 0; color: ${c.muted}; border-top: .7pt solid ${c.deep}; }

/* tables */
.tbl { width: 100%; table-layout: fixed; border-collapse: collapse; }
.tbl th { text-align: left; font-size: 6.4pt; font-weight: 700; text-transform: uppercase; letter-spacing: .8pt; color: ${c.blue}; border-top: .7pt solid ${c.deep}; border-bottom: .5pt solid ${c.hair}; padding: 1.4mm 1.4mm 1.1mm; vertical-align: bottom; }
.tbl td { padding: .85mm 1.4mm; vertical-align: top; border-bottom: .4pt solid ${c.hair}; overflow-wrap: anywhere; }
.tbl tbody tr:nth-child(odd) td { background: ${c.tint}; }
.tbl tr { break-inside: avoid; }
.tbl thead { display: table-header-group; }
.tbl .num, .tbl th.num { text-align: right; }
.tbl tfoot { display: table-row-group; }
.tbl tfoot td { padding: 1.3mm 1.4mm; border-top: .7pt solid ${c.deep}; border-bottom: none; font-weight: 700; color: ${c.deep}; }
.tbl tfoot tr.foot2 td { border-top: .4pt solid ${c.hair}; font-weight: 600; }
.tbl .todate { display: block; font-size: 6pt; font-weight: 400; letter-spacing: 0; text-transform: none; color: ${c.muted}; }
.grid th.mine { color: ${c.deep}; border-top: 1.8pt solid ${c.deep}; }
.grid td.mine { color: ${c.ink}; }
.grid td.mine.strong, .grid td.mine.deep { color: ${c.deep}; }
.grid tfoot td.mine { color: ${c.deep}; }
.score td.big { font-size: 9pt; }
.score tr.cut td { border-bottom: .9pt solid ${c.deep}; }
.kpi tr.own td { font-size: 8.4pt; border-top: .7pt solid ${c.deep}; }
.kpi tr.own td:first-child { border-left: 1.2pt solid ${c.blue}; padding-left: 2mm; }
.kpi tr.target td { color: ${c.muted}; font-size: 7pt; }
.kpi td { padding-top: .7mm; padding-bottom: .7mm; }
.kpi .area { margin-left: 2mm; font-size: 6.4pt; color: ${c.muted}; }
.prod tr.cut-top td { border-top: .7pt solid ${c.deep}; }
.prod .lbl { padding-left: 4mm; color: ${c.muted}; }
.holder td { font-size: 7pt; }

.split { display: grid; grid-template-columns: 70mm 1fr; column-gap: 12mm; align-items: start; margin-top: 3mm; }
.measures--two { grid-template-columns: 1fr 1fr; margin-top: 4.2mm; }
.legend { display: flex; flex-wrap: wrap; gap: 1mm 5mm; margin: 0 0 2mm; font-size: 7pt; color: ${c.muted}; }
.legend b { color: ${c.deep}; }
.pharm td { font-size: 7.2pt; }
`;
}
