/**
 * The rep effectiveness review as a house document — the same report as the workbook, for reading and
 * forwarding, in the HR PREMIUM dress (SATO-DIS-2026-01 v1.0, landscape, like the Field Activity report).
 *
 * The ink rule holds: lines and type only, the 6% zebra the one filled area, square corners. The rep's
 * own months are marked by ink and a rule over their column, never by a fill.
 */

import { systemLegalEntity } from "@/config/system-settings";
import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import {
  PREMIUM_COMPANY_DOCUMENT_BRAND,
  PREMIUM_IDENTITY_CSS,
  premiumMasthead,
  premiumPageChrome,
  premiumSheetCss,
} from "@/lib/hiring-pack/premium-identity";
import { monthLong, monthShort, pctOf, type EffKpiFigures, type EffScoreRow, type RepEffectivenessReport } from "@/lib/sales/rep-effectiveness/model";

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
const units = money;
const pc = (v: number | null | undefined) => (v == null ? DASH : `${v}%`);

const scoreValue = (row: EffScoreRow, v: number | null | undefined) =>
  v == null ? DASH : row.kind === "pct" ? `${v}%` : row.kind === "rate" ? v.toFixed(1) : money(v);

function generatedOn(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" }).format(new Date(iso));
}

function kpiTds(f: EffKpiFigures | null): string {
  if (!f) return `<td class="num" colspan="7">The KPIs board could not be read for this month.</td>`;
  return [
    pc(f.coveragePct),
    pc(f.frequencyPct),
    f.amPerDay == null ? DASH : f.amPerDay.toFixed(1),
    pc(f.amAttainmentPct),
    f.pmPerDay == null ? DASH : f.pmPerDay.toFixed(1),
    pc(f.pmAttainmentPct),
    f.justStarted ? "Just started" : pc(f.overallPct),
  ]
    .map((v, i) => `<td class="num${i === 6 ? " strong" : ""}">${v}</td>`)
    .join("");
}

export function buildRepEffectivenessDocument(report: RepEffectivenessReport): string {
  const rep = report.rep;
  const span = report.months.length ? `${monthLong(report.months[0])} to ${monthLong(report.months[report.months.length - 1])}` : "No published month";
  const on = generatedOn(report.generatedAt);
  const isRep = (m: string) => report.repMonths.includes(m);
  const mh = (m: string) => `<th class="num${isRep(m) ? " mine" : ""}">${esc(monthShort(m))}</th>`;
  const md = (m: string, v: string, strong = false) => `<td class="num${isRep(m) ? " mine" : ""}${strong ? " strong" : ""}">${v}</td>`;

  const masthead = (slim: boolean) =>
    premiumMasthead({
      compact: !slim,
      slim,
      legalNameAr: systemLegalEntity.legalNameAr,
      legalNameEn: systemLegalEntity.legalNameEn,
      orientation: "landscape",
      subtitles: [
        { lang: "en", text: `${rep.name} · ${rep.jobTitle} · ${rep.line} · ${rep.areaName}` },
        { lang: "en", text: span },
      ],
      title: "Effectiveness Review",
      titleLang: "en",
    });
  const chrome = premiumPageChrome({
    brand: PREMIUM_COMPANY_DOCUMENT_BRAND,
    department: `Sales Force Effectiveness · read from the live system on ${on}, Cairo time`,
    orientation: "landscape",
  });

  const facts = [
    ["Area", `${esc(rep.areaName)}${rep.regionName ? ` &middot; ${esc(rep.regionName)}` : ""}`],
    ["Line", esc(rep.line)],
    ["Manager", esc(rep.managerName ?? "Not recorded")],
    ["Hiring date", esc(rep.hireDate ?? "Not recorded")],
    ["Rep's months in the seat", esc(report.repMonths.length ? report.repMonths.map(monthShort).join(", ") : "None of the published months")],
  ];

  const sc = report.scorecard;
  // Every KPI month is the rep's own, so the KPI grid rules every column; the closing grid rules hers only.
  const scoreTable = (rows: EffScoreRow[], months: string[], targetHead: string, mine: (m: string) => boolean, toDate: string | null = null) => `
  <table class="tbl grid score">
    <colgroup><col style="width:30%">${months.map(() => "<col>").join("")}<col style="width:11%"></colgroup>
    <thead><tr><th></th>${months.map((m) => `<th class="num${mine(m) ? " mine" : ""}">${esc(monthShort(m))}${m === toDate ? ' <span class="todate">to date</span>' : ""}</th>`).join("")}<th class="num">${targetHead}</th></tr></thead>
    <tbody>${rows
      .map(
        (row, i) =>
          `<tr${rows[i + 1]?.group ? ' class="cut"' : ""}><td class="${row.strong ? "strong deep" : ""}">${esc(row.label)}</td>${months
            .map((m) => `<td class="num${mine(m) ? " mine" : ""}${row.strong ? " strong" : ""}">${scoreValue(row, row.values[m])}</td>`)
            .join("")}<td class="num thin">${row.target == null ? "" : scoreValue(row, row.target)}</td></tr>`,
      )
      .join("")}</tbody>
  </table>`;

  const cover = `
<section class="page">
  ${masthead(false)}
  <div class="facts">${facts.map(([k, v]) => `<div class="fact"><p class="fact__k">${k}</p><p class="fact__v">${v}</p></div>`).join("")}</div>
  <h2 class="h2">The area, month by month</h2>
  ${scoreTable(sc.closing, sc.months, "On the map", isRep)}
  <h2 class="h2">KPIs</h2>
  ${scoreTable(sc.kpi, sc.kpiMonths, "Target", () => true, sc.kpiToDate)}
  ${chrome}
</section>`;

  const kpiRows = report.kpis
    .map((k) => {
      const own = `<tr class="own"><td class="strong deep">${esc(monthLong(k.month))}${k.toDate ? ' <span class="thin">to date</span>' : ""}</td><td class="strong">${esc(rep.name)}</td>${kpiTds(k.unread ? null : k.rep)}</tr>`;
      const others = k.colleagues.map((c) => `<tr><td></td><td>${esc(c.name)}${c.area ? ` <span class="thin">${esc(c.area)}</span>` : ""}</td>${kpiTds(c.figures)}</tr>`).join("");
      return own + others;
    })
    .join("");
  const kpiPage = `
<section class="page">
  ${masthead(true)}
  <h1 class="title">KPIs against their targets</h1>
  <table class="tbl">
    <colgroup><col style="width:15%"><col style="width:27%"><col><col><col><col><col><col><col></colgroup>
    <thead><tr><th>Month</th><th>Rep</th><th class="num">Coverage</th><th class="num">Frequency</th><th class="num">Account visits a day</th><th class="num">vs 2</th><th class="num">Doctor visits a day</th><th class="num">vs 10</th><th class="num">Overall</th></tr></thead>
    <tbody><tr class="target"><td>Target</td><td></td><td class="num">95%</td><td class="num">100%</td><td class="num">2.0</td><td class="num">100%</td><td class="num">10.0</td><td class="num">100%</td><td class="num">100%</td></tr>${kpiRows || `<tr><td colspan="9">No KPI month falls on or after the rep's hiring date.</td></tr>`}</tbody>
  </table>
</section>`;

  const g = report.growth;
  const growthBlock = g
    ? `<h2 class="h2">Where the change from ${esc(monthLong(g.from))} to ${esc(monthLong(g.to))} came from</h2>
  <table class="tbl tbl--narrow">
    <colgroup><col style="width:62%"><col style="width:20%"><col style="width:18%"></colgroup>
    <thead><tr><th>Step</th><th class="num">EGP</th><th class="num">Share of the change</th></tr></thead>
    <tbody><tr><td class="strong">${esc(monthLong(g.from))} closing</td><td class="num strong">${money(g.start)}</td><td></td></tr>
    ${g.steps.map((s) => `<tr><td>${esc(s.label)}</td><td class="num">${s.change >= 0 ? "+" : "&minus;"}${money(Math.abs(s.change))}</td><td class="num">${pc(Math.abs(g.end - g.start) >= 1 ? pctOf(s.change, g.end - g.start) : null)}</td></tr>`).join("")}</tbody>
    <tfoot><tr><td>${esc(monthLong(g.to))} closing</td><td class="num">${money(g.end)}</td><td></td></tr></tfoot>
  </table>`
    : "";
  const historyPage = `
<section class="page">
  ${masthead(true)}
  <h1 class="title">The area, month by month</h1>
  <table class="tbl">
    <colgroup><col style="width:11%"><col style="width:17%"><col><col><col><col><col><col><col><col></colgroup>
    <thead><tr><th>Month</th><th>Seat held by</th><th class="num">Sales</th><th class="num">Target</th><th class="num">Achievement</th><th class="num">Direct orders</th><th class="num">Without direct</th><th class="num">Pharmacy sales</th><th class="num">Wholesaler share</th><th class="num">Pharmacies buying</th></tr></thead>
    <tbody>${report.sales
      .map((s) => {
        const src = report.sources[s.month];
        return `<tr${isRep(s.month) ? ' class="own"' : ""}><td class="strong deep">${esc(monthLong(s.month))}</td><td>${bidi(s.holder ?? "Not recorded")}</td><td class="num strong">${money(s.actualValue)}</td><td class="num">${s.targetValue == null ? "No target set" : money(s.targetValue)}</td><td class="num strong">${pc(s.achievementPct)}</td><td class="num">${money(s.directValue)}</td><td class="num">${pc(s.achievementWithoutDirectPct)}</td><td class="num">${money(src?.pharmacy)}</td><td class="num">${money(src?.wholesalerShare)}</td><td class="num strong">${s.pharmaciesBuying}</td></tr>`;
      })
      .join("")}</tbody>
  </table>
  ${growthBlock}
</section>`;

  const customersPage = `
<section class="page">
  ${masthead(true)}
  <h1 class="title">Customers per product per month</h1>
  <table class="tbl grid">
    <colgroup><col style="width:20%">${report.months.map(() => "<col>").join("")}</colgroup>
    <thead><tr><th>Product</th>${report.months.map(mh).join("")}</tr></thead>
    <tbody>${report.products.map((p) => `<tr><td class="strong deep">${esc(p.name)}</td>${report.months.map((m) => md(m, String(report.customers[p.code]?.[m] || DASH))).join("")}</tr>`).join("")}</tbody>
    <tfoot><tr><td>Any product</td>${report.sales.map((s) => md(s.month, String(s.pharmaciesBuying), true)).join("")}</tr></tfoot>
  </table>
  <h2 class="h2">Pharmacies buying any product, by brick</h2>
  <table class="tbl grid">
    <colgroup><col style="width:20%">${report.months.map(() => "<col>").join("")}<col style="width:9%"></colgroup>
    <thead><tr><th>Brick</th>${report.months.map(mh).join("")}<th class="num">On the map</th></tr></thead>
    <tbody>${report.bricks.map((b) => `<tr><td class="strong">${bidi(b.name)}</td>${report.months.map((m) => md(m, b.months[m] ? String(b.months[m]) : DASH)).join("")}<td class="num thin">${b.onMap == null ? DASH : b.onMap.toLocaleString("en-US")}</td></tr>`).join("")}</tbody>
  </table>
</section>`;

  const salesRows = [...report.sales]
    .reverse()
    .map((s) => {
      const lines = report.products
        .map((p) => {
          const c = report.productSales[p.code]?.[s.month];
          if (!c) return "";
          return `<tr><td>${esc(monthLong(s.month))}</td><td class="strong">${esc(p.name)}</td><td class="num">${units(c.actualUnits)}</td><td class="num">${units(c.targetUnits)}</td><td class="num">${pc(c.targetUnits ? pctOf(c.actualUnits, c.targetUnits) : null)}</td><td class="num">${money(c.actualValue)}</td><td class="num">${money(c.targetValue)}</td><td class="num strong">${pc(c.targetValue ? pctOf(c.actualValue, c.targetValue) : null)}</td></tr>`;
        })
        .join("");
      return `${lines}<tr class="sum"><td class="strong deep">${esc(monthLong(s.month))}</td><td class="strong">All products (value)</td><td></td><td></td><td></td><td class="num strong">${money(s.actualValue)}</td><td class="num strong">${money(s.targetValue)}</td><td class="num strong">${pc(s.achievementPct)}</td></tr>`;
    })
    .join("");
  const salesPage = `
<section class="page">
  ${masthead(true)}
  <h1 class="title">Sales against target, product by product</h1>
  <table class="tbl">
    <colgroup><col style="width:13%"><col style="width:21%"><col><col><col><col><col><col></colgroup>
    <thead><tr><th>Month</th><th>Product</th><th class="num">Units sold</th><th class="num">Units target</th><th class="num">Units</th><th class="num">Value sold (EGP)</th><th class="num">Value target (EGP)</th><th class="num">Value</th></tr></thead>
    <tbody>${salesRows}</tbody>
  </table>
</section>`;

  const legend = report.products.map((p) => `<strong>${esc(p.tag)}</strong> ${esc(p.name)}`).join(" &middot; ");
  const pharmacyPage = `
<section class="page">
  ${masthead(true)}
  <h1 class="title">Every pharmacy that bought, month by month</h1>
  <p class="lede">${legend}</p>
  <table class="tbl grid">
    <colgroup><col style="width:21%"><col style="width:11%">${report.months.map(() => "<col>").join("")}<col style="width:6%"><col style="width:5%"></colgroup>
    <thead><tr><th>Pharmacy</th><th>Brick</th>${report.months.map(mh).join("")}<th class="num">Months</th><th class="num">New</th></tr></thead>
    <tbody>${report.pharmacies.map((p) => `<tr><td>${bidi(p.name)}</td><td class="thin">${bidi(p.brickName)}</td>${report.months.map((m) => md(m, p.months[m] ? esc(p.months[m].join(" ")) : "", Boolean(p.months[m]))).join("")}<td class="num strong">${p.monthsBought}</td><td class="num strong deep">${p.newInRepTime ? "New" : ""}</td></tr>`).join("")}</tbody>
    <tfoot><tr><td>Pharmacies buying that month</td><td></td>${report.sales.map((s) => md(s.month, String(s.pharmaciesBuying), true)).join("")}<td class="num">${report.pharmacies.length}</td><td class="num">${report.pharmacies.filter((p) => p.newInRepTime).length}</td></tr></tfoot>
  </table>
</section>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Effectiveness Review — ${esc(rep.name)} — ${esc(span)}</title>
<style>${documentCss()}</style></head>
<body>${cover}${kpiPage}${historyPage}${customersPage}${salesPage}${pharmacyPage}</body></html>`;
}

function documentCss(): string {
  const c = HOUSE_COLORS;
  return `
${premiumSheetCss(".page", "landscape")}
${PREMIUM_IDENTITY_CSS}
* { box-sizing: border-box; border-radius: 0 !important; }
html, body { margin: 0; padding: 0; }
body { font-family: "Segoe UI", "Noto Sans", "Helvetica Neue", Arial, sans-serif; color: ${c.body}; font-size: 8pt; line-height: 1.34; }
.page { page-break-after: always; }
.page:last-child { page-break-after: auto; }
.pm-band + .title, .pm-band + .facts { margin-top: 2.6mm; }
.title { margin: 2.4mm 0 1.2mm; font-size: 14.5pt; font-weight: 700; color: ${c.deep}; letter-spacing: -.01em; }
.lede { margin: 0 0 3mm; font-size: 8.6pt; max-width: 230mm; }
.h2 { display: flex; align-items: center; gap: 3mm; margin: 4mm 0 1.4mm; font-size: 7.6pt; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: ${c.deep}; break-after: avoid; }
.h2::after { content: ""; flex: 1 1 auto; border-top: .5pt solid ${c.hair}; }
.thin { color: ${c.muted}; font-weight: 400; font-size: 7.2pt; }
.strong { font-weight: 700; }
.deep { color: ${c.deep}; }
.facts { display: grid; grid-template-columns: repeat(5, 1fr); border-top: .7pt solid ${c.deep}; margin-bottom: 3mm; }
.fact { border-right: .4pt solid ${c.hair}; border-bottom: .4pt solid ${c.hair}; padding: 1.2mm 2mm; }
.fact:last-child { border-right: 0; }
.fact__k { margin: 0 0 .6mm; font-size: 6.4pt; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; color: ${c.blue}; }
.fact__v { margin: 0; font-size: 8.6pt; font-weight: 600; }
.tbl { width: 100%; table-layout: fixed; border-collapse: collapse; }
.tbl--narrow { width: 60%; }
.tbl th { text-align: left; font-size: 6.6pt; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: ${c.deep}; border-top: .7pt solid ${c.deep}; border-bottom: .5pt solid ${c.hair}; padding: 1.4mm 1.2mm; vertical-align: bottom; }
.tbl td { padding: .8mm 1.2mm; vertical-align: top; border-bottom: .4pt solid ${c.hair}; word-wrap: break-word; }
.tbl tbody tr:nth-child(odd) td { background: ${c.tint}; }
.tbl tr { break-inside: avoid; }
.tbl thead { display: table-header-group; }
.tbl .num, .tbl th.num { text-align: right; }
.tbl tfoot td { padding: 1.4mm 1.2mm; border-top: .7pt solid ${c.deep}; border-bottom: none; font-weight: 700; color: ${c.deep}; }
.tbl tr.own td:first-child { border-left: 1.2pt solid ${c.blue}; }
.tbl tr.target td { color: ${c.muted}; font-size: 7pt; }
.tbl tr.sum td { border-top: .6pt solid ${c.deep}; }
.grid th.mine { color: ${c.blue}; border-top: 1.6pt solid ${c.blue}; }
.grid td.mine { color: ${c.deep}; }
.score tr.cut td { border-bottom: .9pt solid ${c.deep}; }
.score .todate { display: block; font-weight: 400; letter-spacing: .4pt; text-transform: none; color: ${c.muted}; }
`;
}
