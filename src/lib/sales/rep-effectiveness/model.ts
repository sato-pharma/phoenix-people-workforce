/**
 * The rep effectiveness review — one rep's area, read the way the managers asked for it on Ebtissam
 * Alaa's case (owner, 25 Nov 2026: "audit the conversation of the managers and their requirements and
 * tailor the export to show exactly the data needed", then "the customer count is very important",
 * then "i want to be able to export from system xlsx and pdf").
 *
 * What the managers asked, and the part of this report that answers each:
 *
 *   • "her KPIs" / "KPI achievement versus assigned targets"        → kpis
 *   • "sales performance and target achievement"                     → sales, products
 *   • "her achievement month by month against the history of the same area" → sales (every published month)
 *   • "the number of customers per product per month"                → customers, bricks, pharmacies
 *   • "one order may make sales growth" / "look at the source of sales" → sources, growth
 *
 * PURE. Nothing here reads a database: `server.ts` loads, this file only counts and arranges, so every
 * figure can be pinned by a test with a hand-built month.
 *
 * 🔴 EVERY SALES AND TARGET FIGURE IS THE CLOSING ENGINE'S (the monthly-closing source-of-truth golden
 * rule) — read only for months the rep's line has PUBLISHED. A month that is not published is absent,
 * never a zero.
 *
 * 🔴 ONE PHARMACY IS ONE DISTRIBUTOR CUSTOMER, AND IT BOUGHT WHEN ITS NET UNITS ARE ABOVE ZERO — the rule
 * the Closing Matrix's Pharmacies column and the Customer Count dashboard share
 * (`closing-pharmacy-counts.ts`). This file never counts a buyer any other way.
 *
 * 🔴 UNITS OF DIFFERENT PRODUCTS ARE NEVER ADDED. A product's units stay on its own row; every total
 * across products is VALUE.
 */

import { kpiIndexOf } from "@/lib/crm/kpi-index";
import type { KpiRepRow } from "@/lib/crm/kpis-board";
import { closingAreaOf } from "@/lib/sales/closing-row-area";
import { monthBuyingEntries, type PharmacyCountRow } from "@/lib/sales/closing-pharmacy-counts";
import { classifyRowKind, findSharedCustomerKeys } from "@/lib/sales/sos-pharmacy-actions";

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────

export type EffRep = {
  hrId: string;
  name: string;
  jobTitle: string;
  line: string;
  areaCode: string;
  areaName: string;
  regionName: string | null;
  managerName: string | null;
  hireDate: string | null;
};

/** One product's closing figures in the rep's area for one month. */
export type EffProductMonth = {
  code: string;
  name: string;
  actualUnits: number;
  actualValue: number;
  targetUnits: number | null;
  targetValue: number | null;
};

/** Where one month's sales in the area came from, by value. */
export type EffSources = {
  /** Orders placed directly with the company (`isDirect` rows). */
  direct: number;
  /** A wholesaler's share booked to the area: a customer the closing shares across areas, or the EPDA books. */
  wholesalerShare: number;
  /** Real pharmacies buying through a distributor. */
  pharmacy: number;
  /** Main Stores and rows that carry no customer code. */
  other: number;
};

/** One pharmacy that bought one product in the area in one month. */
export type EffBuyer = {
  /** distributor|client — server-side identity only; never printed. */
  key: string;
  name: string;
  brickName: string;
  product: string;
};

export type EffMonth = {
  month: string;
  /** Who held the seat at the month's end: a name, "Vacant seat", or null when the seat model could not say. */
  holder: string | null;
  /** True when the rep under review held the seat that month. */
  isRepMonth: boolean;
  products: EffProductMonth[];
  sources: EffSources;
  buyers: EffBuyer[];
};

export type EffKpiFigures = {
  /** Null when nothing was planned — no denominator, never a 0%. */
  coveragePct: number | null;
  frequencyPct: number | null;
  /** Account (AM) visits a working day, against 2. */
  amPerDay: number | null;
  /** Doctor (PM) visits a working day, against 10. */
  pmPerDay: number | null;
  amAttainmentPct: number | null;
  pmAttainmentPct: number | null;
  /** The KPIs board's own overall score. */
  overallPct: number | null;
  /** Hired inside the month and worked too little of it to be judged — the board's own rule. */
  justStarted: boolean;
};

export type EffKpiMonth = {
  month: string;
  /** True for the month still running: its figures are to date. */
  toDate: boolean;
  /** True when that month's board could not be read — said, never drawn as zeros. */
  unread: boolean;
  rep: EffKpiFigures | null;
  /** The reps under the same manager, each with the same four measures and the overall score. */
  colleagues: { name: string; area: string | null; figures: EffKpiFigures }[];
};

export type EffUniverse = {
  /** Distributor customers on the Source of Sales customer map in the area's bricks. Null when unread. */
  total: number | null;
  /** brick name → customers on the map there. */
  byBrick: Record<string, number>;
};

// ── Output ───────────────────────────────────────────────────────────────────────────────────────

export type EffSalesMonth = {
  month: string;
  holder: string | null;
  isRepMonth: boolean;
  actualValue: number;
  targetValue: number | null;
  achievementPct: number | null;
  directValue: number;
  /** Achievement with the month's direct orders taken out. Null when there were none or no target. */
  achievementWithoutDirectPct: number | null;
  /** Pharmacies that bought any product that month. */
  pharmaciesBuying: number;
};

export type EffPharmacy = {
  name: string;
  brickName: string;
  /** month → the products' short tags it bought that month. */
  months: Record<string, string[]>;
  monthsBought: number;
  lastMonth: string;
  /** First bought in one of the rep's months, and never in an earlier month on this report. */
  newInRepTime: boolean;
};

export type EffGrowthStep = { label: string; change: number };

export type EffAnswer = { question: string; answer: string; sheet: string };

export type RepEffectivenessReport = {
  rep: EffRep;
  generatedAt: string;
  months: string[];
  repMonths: string[];
  products: { code: string; name: string; tag: string }[];
  sales: EffSalesMonth[];
  /** product code → month → the product's closing figures. */
  productSales: Record<string, Record<string, EffProductMonth>>;
  /** product code → month → pharmacies that bought it. */
  customers: Record<string, Record<string, number>>;
  /** Average pharmacies per product a month, over the rep's months. Null when she held no published month. */
  repAveragePerProduct: number | null;
  /** The same average over the months before hers, for the comparison the managers asked for. */
  beforeAveragePerProduct: number | null;
  bricks: { name: string; months: Record<string, number>; onMap: number | null }[];
  pharmacies: EffPharmacy[];
  universe: EffUniverse;
  sources: Record<string, EffSources>;
  /** From the second-last to the last published month: the change, split by where the sales came from. */
  growth: { from: string; to: string; start: number; steps: EffGrowthStep[]; end: number } | null;
  kpis: EffKpiMonth[];
  answers: EffAnswer[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

const EPSILON = 1e-9;
const upper = (value: unknown) => String(value ?? "").trim().toUpperCase();
const NO_BRICK = "No brick on record";
const NO_NAME = "Name not on the invoice";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthLong(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[(m || 1) - 1]} ${year}`;
}

export function monthShort(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[(m || 1) - 1].slice(0, 3)} ${String(year).slice(2)}`;
}

export function pctOf(numerator: number, denominator: number | null | undefined): number | null {
  if (!denominator || Math.abs(denominator) < EPSILON) return null;
  return Math.round((numerator / denominator) * 100);
}

/** "Lacto Advanced 1" → "LA1", "Guamusin" → "G". Unique across the report's products. */
export function productTags(products: readonly { code: string; name: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const product of products) {
    const words = product.name.replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
    const letters = words.filter((word) => !/^\d+$/.test(word)).map((word) => word[0].toUpperCase()).join("");
    const digits = words.filter((word) => /^\d+$/.test(word)).join("");
    let tag = `${letters || product.code.slice(0, 2).toUpperCase()}${digits}`;
    for (let n = 2; used.has(tag); n += 1) tag = `${letters}${digits}${n}`;
    used.add(tag);
    out.set(product.code, tag);
  }
  return out;
}

/**
 * One month of closing rows → what the report needs from them, for ONE area.
 *
 * The rows are the WHOLE line's for the month: who counts as a wholesaler is decided across every area
 * (a customer the closing books in two areas is a wholesaler's share in both), exactly as the Closing
 * Matrix decides it, so the rows must not be cut to the area before they are classified.
 */
export function summariseClosingMonth(rows: readonly PharmacyCountRow[], areaCode: string): { sources: EffSources; buyers: EffBuyer[] } {
  const area = upper(areaCode);
  const shared = findSharedCustomerKeys([{ period: "", rows }]);
  const sources: EffSources = { direct: 0, wholesalerShare: 0, pharmacy: 0, other: 0 };
  const names = new Map<string, string>();
  for (const row of rows) {
    if (closingAreaOf(row) !== area) continue;
    const value = Number(row.salesValue) || 0;
    // A direct order is LEFT OUT of the invoice totals (exclusion "direct") and still counts in the
    // closing's achievement, so it is asked before `includedInClosing` — asked after, it never counted.
    if (row.isDirect) {
      sources.direct += value;
      continue;
    }
    if (row.includedInClosing !== true) continue;
    const kind = classifyRowKind(row, shared);
    if (kind === "pharmacy") sources.pharmacy += value;
    else if (kind === "wholesalerShare") sources.wholesalerShare += value;
    else sources.other += value;
    const key = `${upper(row.distributorCode)}|${upper(row.clientCode)}`;
    if (!names.has(key) && String(row.clientName ?? "").trim()) names.set(key, String(row.clientName).trim());
  }
  const buyers = monthBuyingEntries(rows)
    .filter((entry) => entry.area === area)
    .map((entry) => ({
      key: entry.key,
      name: names.get(entry.key) ?? NO_NAME,
      brickName: entry.brickName || NO_BRICK,
      product: entry.product,
    }));
  return { sources, buyers };
}

/** A KPIs-board row → the five figures the review prints. */
export function kpiFiguresOf(row: KpiRepRow): EffKpiFigures {
  const planned = row.hasMeasurablePlan;
  return {
    coveragePct: planned ? row.coveragePct : null,
    frequencyPct: planned ? row.frequencyPct : null,
    amPerDay: row.noGpsFeed ? null : row.amRate,
    pmPerDay: row.noGpsFeed ? null : row.pmRate,
    amAttainmentPct: row.amAttainmentPct,
    pmAttainmentPct: row.pmAttainmentPct,
    // Scored exactly as the KPIs board's own export scores a rep row (`overallPct` in kpis-board-workbook.ts).
    overallPct: row.justStarted
      ? null
      : kpiIndexOf({
          coveragePct: row.coveragePct,
          frequencyPct: row.frequencyPct,
          hasMeasurablePlan: row.hasMeasurablePlan,
          amAttainmentPct: row.amAttainmentPct,
          pmAttainmentPct: row.pmAttainmentPct,
          hasCallRate: row.hasCallRate,
          noGpsFeed: row.noGpsFeed,
          justStarted: false,
        }).overallPct,
    justStarted: Boolean(row.justStarted),
  };
}

const sumSources = (s: EffSources) => s.direct + s.wholesalerShare + s.pharmacy + s.other;

function fmtMoney(value: number): string {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

// ── The report ───────────────────────────────────────────────────────────────────────────────────

export function buildRepEffectiveness(input: {
  rep: EffRep;
  generatedAt: string;
  months: readonly EffMonth[];
  kpis: readonly EffKpiMonth[];
  universe: EffUniverse;
}): RepEffectivenessReport {
  const months = [...input.months].sort((a, b) => a.month.localeCompare(b.month));
  const monthKeys = months.map((m) => m.month);
  const repMonths = months.filter((m) => m.isRepMonth).map((m) => m.month);

  // Products: every product that sold, had a target, or was bought in any month — ordered by name.
  const productNames = new Map<string, string>();
  for (const m of months) {
    for (const p of m.products) if (!productNames.has(p.code)) productNames.set(p.code, p.name || p.code);
    for (const b of m.buyers) if (!productNames.has(b.product)) productNames.set(b.product, b.product);
  }
  const productList = [...productNames.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
  const tags = productTags(productList);
  const products = productList.map((p) => ({ ...p, tag: tags.get(p.code) ?? p.code }));

  // Sales against target, every published month.
  const productSales: Record<string, Record<string, EffProductMonth>> = {};
  const customers: Record<string, Record<string, number>> = {};
  for (const p of products) {
    productSales[p.code] = {};
    customers[p.code] = {};
  }
  const sources: Record<string, EffSources> = {};
  const sales: EffSalesMonth[] = months.map((m) => {
    for (const p of m.products) productSales[p.code][m.month] = p;
    const perProduct = new Map<string, Set<string>>();
    for (const b of m.buyers) {
      const set = perProduct.get(b.product) ?? new Set<string>();
      set.add(b.key);
      perProduct.set(b.product, set);
    }
    for (const p of products) customers[p.code][m.month] = perProduct.get(p.code)?.size ?? 0;
    const actualValue = m.products.reduce((sum, p) => sum + p.actualValue, 0);
    // The closing spreads the wholesalers' and stores' sales to every area by formula; that share is on
    // no invoice row of the area, so it is what the achievement holds beyond the area's own rows.
    const spread = actualValue - sumSources(m.sources);
    sources[m.month] = { ...m.sources, wholesalerShare: m.sources.wholesalerShare + (Math.abs(spread) >= 1 ? spread : 0) };
    const targets = m.products.map((p) => p.targetValue).filter((v): v is number => v != null);
    const targetValue = targets.length > 0 ? targets.reduce((sum, v) => sum + v, 0) : null;
    const directValue = m.sources.direct;
    return {
      month: m.month,
      holder: m.holder,
      isRepMonth: m.isRepMonth,
      actualValue,
      targetValue,
      achievementPct: pctOf(actualValue, targetValue),
      directValue,
      achievementWithoutDirectPct: directValue > EPSILON ? pctOf(actualValue - directValue, targetValue) : null,
      pharmaciesBuying: new Set(m.buyers.map((b) => b.key)).size,
    };
  });

  const averagePerProduct = (keys: readonly string[]): number | null => {
    if (keys.length === 0 || products.length === 0) return null;
    const sold = products.filter((p) => keys.some((k) => (customers[p.code][k] ?? 0) > 0 || productSales[p.code][k]));
    const base = sold.length > 0 ? sold : products;
    let total = 0;
    for (const p of base) for (const k of keys) total += customers[p.code][k] ?? 0;
    return Math.round((total / (base.length * keys.length)) * 10) / 10;
  };
  const firstRepMonth = repMonths[0] ?? null;
  const beforeMonths = firstRepMonth ? monthKeys.filter((k) => k < firstRepMonth) : [];

  // Bricks: pharmacies buying any product, per brick and month; bricks on the map with no buyer too.
  const brickMonths = new Map<string, Record<string, Set<string>>>();
  for (const m of months) {
    for (const b of m.buyers) {
      const byMonth = brickMonths.get(b.brickName) ?? {};
      (byMonth[m.month] ??= new Set<string>()).add(b.key);
      brickMonths.set(b.brickName, byMonth);
    }
  }
  const brickNames = new Set<string>([...brickMonths.keys(), ...Object.keys(input.universe.byBrick)]);
  const bricks = [...brickNames]
    .map((name) => ({
      name,
      months: Object.fromEntries(monthKeys.map((k) => [k, brickMonths.get(name)?.[k]?.size ?? 0])),
      onMap: input.universe.byBrick[name] ?? null,
    }))
    .sort((a, b) => (b.onMap ?? -1) - (a.onMap ?? -1) || a.name.localeCompare(b.name));

  // Every pharmacy that bought, month by month.
  const pharmacyMap = new Map<string, { name: string; brickName: string; months: Record<string, Set<string>> }>();
  for (const m of months) {
    for (const b of m.buyers) {
      const entry = pharmacyMap.get(b.key) ?? { name: b.name, brickName: b.brickName, months: {} };
      if (entry.name === NO_NAME && b.name !== NO_NAME) entry.name = b.name;
      (entry.months[m.month] ??= new Set<string>()).add(tags.get(b.product) ?? b.product);
      pharmacyMap.set(b.key, entry);
    }
  }
  const tagOrder = products.map((p) => p.tag);
  const repMonthSet = new Set(repMonths);
  const pharmacies: EffPharmacy[] = [...pharmacyMap.values()]
    .map((entry) => {
      const bought = Object.keys(entry.months).sort();
      return {
        name: entry.name,
        brickName: entry.brickName,
        months: Object.fromEntries(
          bought.map((k) => [k, [...entry.months[k]].sort((a, b) => tagOrder.indexOf(a) - tagOrder.indexOf(b))]),
        ),
        monthsBought: bought.length,
        lastMonth: bought[bought.length - 1],
        newInRepTime: bought.length > 0 && repMonthSet.has(bought[0]) && bought[0] !== monthKeys[0],
      };
    })
    .sort((a, b) => b.lastMonth.localeCompare(a.lastMonth) || b.monthsBought - a.monthsBought || a.name.localeCompare(b.name));

  // Growth: second-last to last published month, by source.
  let growth: RepEffectivenessReport["growth"] = null;
  if (months.length >= 2) {
    const prev = months[months.length - 2];
    const last = months[months.length - 1];
    const a = sources[prev.month];
    const b = sources[last.month];
    const start = sales[sales.length - 2].actualValue;
    const end = sales[sales.length - 1].actualValue;
    const steps: EffGrowthStep[] = [
      { label: "Direct orders", change: b.direct - a.direct },
      { label: "Wholesaler and store share, spread to the area by formula", change: b.wholesalerShare - a.wholesalerShare },
      { label: "Pharmacies buying through distributors", change: b.pharmacy - a.pharmacy },
      { label: "Main Stores and rows with no customer code", change: b.other - a.other },
    ];
    // The closing total and the rows' own sum can differ by the closing's allocations; that gap is named, never hidden.
    const explained = steps.reduce((sum, s) => sum + s.change, 0);
    const gap = end - start - explained;
    if (Math.abs(gap) >= 1) steps.push({ label: "Closing allocations not on an invoice row", change: gap });
    growth = { from: prev.month, to: last.month, start, steps, end };
  }

  const report: RepEffectivenessReport = {
    rep: input.rep,
    generatedAt: input.generatedAt,
    months: monthKeys,
    repMonths,
    products,
    sales,
    productSales,
    customers,
    repAveragePerProduct: averagePerProduct(repMonths),
    beforeAveragePerProduct: averagePerProduct(beforeMonths),
    bricks,
    pharmacies,
    universe: input.universe,
    sources,
    growth,
    kpis: [...input.kpis].sort((x, y) => x.month.localeCompare(y.month)),
    answers: [],
  };
  report.answers = buildAnswers(report);
  return report;
}

/** The managers' questions, each with the figure that answers it — facts only, no verdict. */
export function buildAnswers(report: RepEffectivenessReport): EffAnswer[] {
  const out: EffAnswer[] = [];
  const first = report.rep.name.split(/\s+/)[0] || report.rep.name;
  const last = report.sales[report.sales.length - 1] ?? null;
  const repSales = report.sales.filter((s) => s.isRepMonth);

  if (last) {
    const universe = report.universe.total;
    out.push({
      question: "How many customers does the area reach?",
      answer:
        `${last.pharmaciesBuying} pharmacies bought any product in ${monthLong(last.month)}` +
        (universe != null ? `, out of ${universe.toLocaleString("en-US")} distributor customers on the customer map in the area's bricks.` : ".") +
        ` By month: ${report.sales.map((s) => `${monthShort(s.month)} ${s.pharmaciesBuying}`).join(" · ")}.`,
      sheet: "Customers per product",
    });
  }
  if (report.repAveragePerProduct != null) {
    out.push({
      question: "How many customers buy each product a month?",
      answer:
        `${report.repAveragePerProduct} pharmacies per product a month in ${first}'s months` +
        (report.beforeAveragePerProduct != null ? `, against ${report.beforeAveragePerProduct} in the months before.` : ".") +
        ` ${report.products.map((p) => `${p.name}: ${report.repMonths.map((k) => report.customers[p.code][k] ?? 0).join(", ")}`).join(" · ")}.`,
      sheet: "Customers per product",
    });
  }
  if (repSales.length > 0) {
    out.push({
      question: "Sales performance and target achievement",
      answer: repSales
        .map((s) =>
          `${monthLong(s.month)}: ${fmtMoney(s.actualValue)} against ${s.targetValue != null ? fmtMoney(s.targetValue) : "no target set"}` +
          (s.achievementPct != null ? ` (${s.achievementPct}%` + (s.achievementWithoutDirectPct != null ? `, ${s.achievementWithoutDirectPct}% without direct orders)` : ")") : ""),
        )
        .join(" · "),
      sheet: "Sales vs target",
    });
  }
  const history = report.sales.filter((s) => s.achievementPct != null && !s.isRepMonth);
  if (history.length > 0) {
    out.push({
      question: "Achievement against the history of the same area",
      answer: report.sales
        .map((s) => `${monthShort(s.month)} ${s.achievementPct != null ? `${s.achievementPct}%` : "no target"} (${s.isRepMonth ? first : s.holder ?? "seat not recorded"})`)
        .join(" · "),
      sheet: "Area history",
    });
  }
  const directMonths = report.sales.filter((s) => s.directValue > 0);
  if (report.growth || directMonths.length > 0) {
    const g = report.growth;
    out.push({
      question: "Where did the sales come from — can one order make the growth?",
      answer:
        (g
          ? `${monthLong(g.from)} to ${monthLong(g.to)}: ${fmtMoney(g.start)} to ${fmtMoney(g.end)}. ` +
            g.steps.map((s) => `${s.label} ${s.change >= 0 ? "+" : "−"}${fmtMoney(Math.abs(s.change))}`).join(" · ") + ". "
          : "") +
        (directMonths.length > 0
          ? `Direct orders: ${directMonths.map((s) => `${monthShort(s.month)} ${fmtMoney(s.directValue)} (${s.actualValue > 0 ? Math.round((s.directValue / s.actualValue) * 100) : 0}% of the month)`).join(" · ")}.`
          : "No direct order in any published month."),
      sheet: "Where the growth came from",
    });
  }
  const newCount = report.pharmacies.filter((p) => p.newInRepTime).length;
  const repBuyers = report.pharmacies.filter((p) => report.repMonths.some((k) => p.months[k]));
  if (report.repMonths.length > 0) {
    const repeat = repBuyers.filter((p) => report.repMonths.filter((k) => p.months[k]).length >= 2).length;
    out.push({
      question: "Are the customers new, and do they buy again?",
      answer:
        `${repBuyers.length} pharmacies bought in ${first}'s months; ${newCount} of them had not bought in any earlier month on this report` +
        (report.repMonths.length >= 2 ? `, and ${repeat} bought in two or more of ${first}'s months.` : "."),
      sheet: "Pharmacy by month",
    });
  }
  const kpiMonths = report.kpis.filter((k) => !k.unread && k.rep);
  if (kpiMonths.length > 0) {
    const pc = (v: number | null) => (v == null ? "not scored" : `${v}%`);
    out.push({
      question: "KPI achievement versus assigned targets",
      answer: kpiMonths
        .map((k) => {
          const f = k.rep as EffKpiFigures;
          return `${monthLong(k.month)}${k.toDate ? " to date" : ""}: overall ${f.justStarted ? "just started, not judged" : pc(f.overallPct)} · coverage ${pc(f.coveragePct)} (95% floor) · frequency ${pc(f.frequencyPct)} · account visits ${pc(f.amAttainmentPct)} of 2 a day · doctor visits ${pc(f.pmAttainmentPct)} of 10 a day`;
        })
        .join(". "),
      sheet: "KPIs vs target",
    });
  }
  return out;
}

export function reviewFileName(repName: string, months: readonly string[], ext: "xlsx" | "pdf"): string {
  const slug = repName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Rep";
  const span = months.length > 0 ? `${months[0]}-to-${months[months.length - 1]}` : "no-published-month";
  return `${slug}-Effectiveness-Review-${span}.${ext}`;
}

export { sumSources };
