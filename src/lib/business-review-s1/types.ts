// S1 Business Review (Pedia) — dataset types. Mirrors data/pedia-s1.json
// (produced by ingest/build_dataset.py). Read-only module: no DB, no writes.

export type Slice = { sales: number; target: number; ach: number | null };

export type AreaSummary = {
  area: string;
  dm: string;
  /** Sales region this area sits in (Alex-BHR, Cairo, Delta (1)/(2), Giza, UE…).
   * Drives Regional-Manager scoping in the employee portal. */
  region: string;
  vacant: boolean;
  includeOnly: Slice;
  allProducts: Slice;
  hasTarget: boolean;
  ungradeable: boolean;
  hasReturns: boolean;
  products: Record<string, Slice>; // product name -> slice (include products)
  trend: number[]; // 6 monthly include-only sales (Jan..Jun)
};

export type DmSummary = {
  dm: string;
  /** Sales region this DM seat owns — the unit a Regional Manager is scoped to. */
  region: string;
  vacant: boolean;
  areas: string[];
  activeAreas: string[];
  includeOnly: Slice;
  activeIncludeOnly: Slice;
  allProducts: Slice;
  productAch: Record<string, number | null>;
  /** Same rollup as productAch but at family level (product family -> achievement %). */
  familyAch: Record<string, number | null>;
  trend: number[];
  marketingCost: number;
  marketingMonths: number;
  marketingByMonth: Record<string, number>;
  outstationCost: number;
  outstationMonths: number;
  outstationByMonth: Record<string, number>;
  doubleVisits: number;
  visits: number;
  visitsAvgPerMonth: number;
  visitsByMonth: Record<string, number>;
  achByMonth: Record<string, number | null>;
  achByMonthActive: Record<string, number | null>;
  customersTotal: number;
  customersByMonth: Record<string, number>;
};

export type ProductRow = {
  product: string;
  family: string;
  include: boolean;
  byMonth: Record<string, Slice>;
  total: Slice;
};

export type LineSummary = {
  includeOnly: Slice;
  allProducts: Slice;
  withException: { includeOnly: Slice; allProducts: Slice };
  exVacant: { includeOnly: Slice };
  exceptionValue: number;
  quarters: Record<string, { includeOnly: Slice; allProducts: Slice }>;
  byMonth: Record<string, { includeOnly: Slice; allProducts: Slice }>;
  marketingCost: number;
  outstationCost: number;
  visits: number;
  doubleVisits: number;
  visitsAvgPerRepPerMonth: number;
  reps: number;
  customersTotal: number;
  customersByMonth: Record<string, number>;
};

export type MarketingSummary = {
  pediaCost: number;
  byDM: Record<string, { cost: number; requests: number; months: number; byMonth: Record<string, number> }>;
  note: string;
};

export type OutstationSummary = {
  pediaTotal: number;
  rows: number;
  byDM: Record<string, { cost: number; rows: number; months: number; byMonth: Record<string, number> }>;
  monthsCovered: string[];
  components: { travel: number; meeting: number; allowance: number; other: number };
  status: string;
};

export type RepVisit = {
  agentHrId: string;
  name: string;
  hiringDate: string | null;
  visits: number;
  activeMonths: number;
  avgPerMonth: number;
  customers: number;
  dm: string | null;
};

export type VisitsSummary = {
  /** False when this line has no CRM visits/double-visits export at all (not "zero visits"). */
  available: boolean;
  totalDeduped: number;
  rawRowsAcross5: number;
  dropped: number;
  reps: number;
  avgPerRepPerMonth: number;
  byMonth: Record<string, number>;
  customersTotal: number;
  customersByMonth: Record<string, number>;
  byDM: Record<string, { visits: number; avgPerMonth: number; byMonth: Record<string, number> }>;
  repToDmCoverage: number;
  perRep: RepVisit[];
};

export type S1Dataset = {
  meta: {
    line: string;
    period: string;
    currency: string;
    months: string[];
    generatedFrom: string[];
    thresholds: { repFailBelow: number; dsmFailBelow: number };
    rulings: Record<string, string | string[]>;
  };
  line: LineSummary;
  products: ProductRow[];
  dms: DmSummary[];
  areas: AreaSummary[];
  marketing: MarketingSummary;
  outstation: OutstationSummary;
  visits: VisitsSummary;
  doubleVisits: { total: number; byManager: Record<string, number> };
};

/** One line's row in the company comparison table. */
export type CompanyLineRow = {
  id: string;
  label: string;
  allProducts: Slice;
  exVacant: Slice;
  marketingCost: number;
  outstationCost: number;
  visits: number;
  visitsAvailable: boolean;
  doubleVisits: number;
  customersTotal: number;
  dms: number;
  dmsVacant: number;
  areas: number;
  areasVacant: number;
  earners: number;
  repFails: number;
};

/** One DM's row in the cross-line DSM league table (target-less buckets excluded). */
export type CompanyDmRow = {
  dm: string;
  line: string;
  lineId: string;
  vacant: boolean;
  allProducts: Slice;
  marketingCost: number;
  outstationCost: number;
  visitsAvgPerMonth: number;
  customersTotal: number;
  doubleVisits: number;
  visitsAvailable: boolean;
};

/** Cross-line rollup (data/company-s1.json). Achievement is sum(sales)/sum(target),
 * never an average of line percentages; `customersTotal` is a true union of doctor ids
 * across lines, not the sum of the per-line counts. */
export type S1Company = {
  meta: {
    period: string;
    currency: string;
    months: string[];
    lines: string[];
    doctorNote: string;
    generatedFrom: string[];
  };
  total: {
    allProducts: Slice;
    exVacant: Slice;
    marketingCost: number;
    outstationCost: number;
    visits: number;
    doubleVisits: number;
    reps: number;
    customersTotal: number;
    customersByMonth: Record<string, number>;
    customersNaiveSum: number;
    customersOverlap: number;
    areas: number;
    areasVacant: number;
    byMonth: Record<string, Slice>;
  };
  lines: CompanyLineRow[];
  dms: CompanyDmRow[];
};
