/**
 * The list-check board's shape and its sums. No I/O, so the money and the counts can be pinned by a test.
 *
 * 🔴 The money is the estimated cost of approved requests, never sales: the Monthly Closing stays the only
 * sales truth. A customer on two lines counts once in a state's customers, and each request's cost lands
 * on one row only, so no sum here can count a pound twice.
 */

import type { ListCheckState } from "@/lib/marketing-requests/crm-list-check-rules";

export type ListCheckBoardObjection = { date: string; label: string; note: string | null };

export type ListCheckBoardRow = {
  approvedCost: number;
  approvedRequests: number;
  checkId: string;
  customerId: string;
  customerName: string;
  customerPhotoUrl: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  doctorPhotoUrl: string | null;
  /** Is this customer's place further from the doctor's than his 500 m? A flag, never a block. */
  far: boolean;
  /** The earliest pay date among the approved requests: the visits after it are "after the money". */
  firstPayDate: string | null;
  lastVisitDate: string | null;
  /** Null for a reader outside the managers' objection audience as well as for a doctor with none. */
  latestObjection: ListCheckBoardObjection | null;
  leftListAt: string | null;
  lineName: string | null;
  listAreaName: string | null;
  listType: string | null;
  looksLikeNursery: boolean;
  marketingAreaName: string | null;
  matchedCrmCustomerId: string | null;
  matchedName: string | null;
  metresApart: number | null;
  /** An unsure row no person has answered: the Check queue. */
  open: boolean;
  reason: string;
  repNames: string[];
  requesterNames: string[];
  state: ListCheckState;
  stateLabel: string;
  /** Null where no visit could follow: no match, or no approved request with a pay date. */
  visitsSincePay: number | null;
};

export type ListCheckStateCard = {
  approvedCost: number;
  customers: number;
  label: string;
  state: ListCheckState;
};

export type ListCheckBreakdownRow = {
  approvedCost: number;
  /** Approved money whose customer is not confirmed on a rep's list. */
  approvedCostOffList: number;
  customers: number;
  name: string;
  onListCustomers: number;
};

export type ListCheckBoard = {
  byArea: ListCheckBreakdownRow[];
  byLine: ListCheckBreakdownRow[];
  byRequester: ListCheckBreakdownRow[];
  canDecide: boolean;
  cards: ListCheckStateCard[];
  generatedAtIso: string;
  rows: ListCheckBoardRow[];
  showObjections: boolean;
  totals: { approvedCost: number; approvedCostOffList: number; customers: number; onListCustomers: number; openChecks: number };
};

const NO_LINE = "No line recorded";
const NO_AREA = "No area read";

type Tally = { approvedCost: number; approvedCostOffList: number; customers: Set<string>; onList: Set<string> };

function tallyInto(map: Map<string, Tally>, name: string, row: ListCheckBoardRow, cost: number) {
  const tally = map.get(name) ?? { approvedCost: 0, approvedCostOffList: 0, customers: new Set<string>(), onList: new Set<string>() };
  tally.approvedCost += cost;
  if (row.state !== "on_list") tally.approvedCostOffList += cost;
  tally.customers.add(row.customerId);
  if (row.state === "on_list") tally.onList.add(row.customerId);
  map.set(name, tally);
}

/** The most money first, then by name, so the place to look is at the top and two runs read the same. */
function finishBreakdown(map: Map<string, Tally>): ListCheckBreakdownRow[] {
  return [...map.entries()]
    .map(([name, tally]) => ({
      approvedCost: Math.round(tally.approvedCost),
      approvedCostOffList: Math.round(tally.approvedCostOffList),
      customers: tally.customers.size,
      name,
      onListCustomers: tally.onList.size,
    }))
    .sort((left, right) => right.approvedCost - left.approvedCost || left.name.localeCompare(right.name));
}

/** One request's share of a row, for the by-requester sums: who raised how much on this customer. */
export type ListCheckRequesterShare = { checkId: string; cost: number; requesterName: string };

export function buildListCheckBoard(input: {
  canDecide: boolean;
  generatedAtIso: string;
  labels: Readonly<Record<ListCheckState, string>>;
  order: readonly ListCheckState[];
  requesterShares: readonly ListCheckRequesterShare[];
  rows: readonly ListCheckBoardRow[];
  showObjections: boolean;
}): ListCheckBoard {
  const { rows } = input;
  const cards: ListCheckStateCard[] = input.order.map((state) => {
    const inState = rows.filter((row) => row.state === state);
    return {
      approvedCost: Math.round(inState.reduce((sum, row) => sum + row.approvedCost, 0)),
      customers: new Set(inState.map((row) => row.customerId)).size,
      label: input.labels[state],
      state,
    };
  });

  const byLine = new Map<string, Tally>();
  const byArea = new Map<string, Tally>();
  for (const row of rows) {
    tallyInto(byLine, row.lineName ?? NO_LINE, row, row.approvedCost);
    tallyInto(byArea, row.marketingAreaName ?? NO_AREA, row, row.approvedCost);
  }
  const byRequester = new Map<string, Tally>();
  const rowById = new Map(rows.map((row) => [row.checkId, row]));
  for (const share of input.requesterShares) {
    const row = rowById.get(share.checkId);
    if (row) tallyInto(byRequester, share.requesterName, row, share.cost);
  }

  const approvedCost = rows.reduce((sum, row) => sum + row.approvedCost, 0);
  const approvedCostOffList = rows.reduce((sum, row) => sum + (row.state === "on_list" ? 0 : row.approvedCost), 0);
  const rank = new Map(input.order.map((state, index) => [state, index]));
  return {
    byArea: finishBreakdown(byArea),
    byLine: finishBreakdown(byLine),
    byRequester: finishBreakdown(byRequester),
    canDecide: input.canDecide,
    cards,
    generatedAtIso: input.generatedAtIso,
    rows: [...rows].sort(
      (left, right) =>
        (rank.get(left.state) ?? input.order.length) - (rank.get(right.state) ?? input.order.length) ||
        right.approvedCost - left.approvedCost ||
        left.customerName.localeCompare(right.customerName),
    ),
    showObjections: input.showObjections,
    totals: {
      approvedCost: Math.round(approvedCost),
      approvedCostOffList: Math.round(approvedCostOffList),
      customers: new Set(rows.map((row) => row.customerId)).size,
      onListCustomers: new Set(rows.filter((row) => row.state === "on_list").map((row) => row.customerId)).size,
      openChecks: rows.filter((row) => row.open).length,
    },
  };
}

/** Which row of a customer a request's money lands on: its own line's, else the customer's first. */
export function checkForRequest<T extends { lineId: number | null }>(checks: readonly T[], lineId: number | null): T | null {
  return checks.find((check) => check.lineId === lineId) ?? checks[0] ?? null;
}

/** The newest objection a doctor actually raised. A pure helper so "None" can never reach the board. */
export function latestRaisedObjection(
  visits: ReadonlyArray<{ objection: unknown; objectionNote: string | null; visitDate: string }>,
  describe: (value: unknown) => string | null,
): ListCheckBoardObjection | null {
  let latest: ListCheckBoardObjection | null = null;
  for (const visit of visits) {
    const label = describe(visit.objection);
    if (!label) continue;
    if (!latest || visit.visitDate > latest.date) latest = { date: visit.visitDate, label, note: visit.objectionNote };
  }
  return latest;
}
