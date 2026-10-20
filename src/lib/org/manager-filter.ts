/**
 * "FILTER BY MANAGER" — one rule for every report that offers it.
 *
 * Owner, 2026-10-20: "when you filter by manager you find no manager … every single role that is
 * applicable to appear in a module — find it and show it." The filters it describes all did the
 * same two things: their options were the distinct `managerName` of the rows on screen, and a row
 * matched only when `row.managerName === selected`. So choosing a district manager listed his reps
 * but never his own row, and choosing a National or Regional Sales Manager listed his district
 * managers and not one medical rep beneath them — the manager could be picked and never found.
 *
 * Here, choosing a manager keeps:
 *   - the manager's OWN row, and
 *   - every row anywhere beneath him — direct reports, their reports, and so on down the chain.
 * And the option list carries every manager on the chain above the rows on screen, so a National
 * Sales Manager can be chosen even on a list where nobody reports to him directly.
 *
 * The chain is read from the rows themselves (`name → manager name`). Name-based on purpose: the
 * reports that use it carry names on every row and HR ids on only some. Pure and side-effect free,
 * so it is safe in a client component and unit-tested in tests/manager-filter.test.ts.
 */

export type ManagerChainRow = {
  employeeName?: string | null;
  managerName?: string | null;
  /**
   * The managers above `managerName`, nearest first, when the caller knows them (from the
   * directory). They complete the chain for a manager who has no row of his own on the list — a
   * reps-only report still reaches the National Sales Manager through them.
   */
  managersAbove?: readonly (string | null | undefined)[] | null;
};

/** `employee name → manager name`, from every row that carries both. */
export type ManagerChain = ReadonlyMap<string, string>;

function clean(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

export function buildManagerChain(rows: Iterable<ManagerChainRow>): Map<string, string> {
  const list = [...rows];
  const chain = new Map<string, string>();
  for (const row of list) {
    const employee = clean(row.employeeName);
    const manager = clean(row.managerName);
    if (!employee || !manager || employee === manager) continue;
    if (!chain.has(employee)) chain.set(employee, manager);
  }
  // Second pass, so a manager's OWN row always wins over a link read off somebody else's chain.
  for (const row of list) {
    let below = clean(row.managerName);
    for (const raw of row.managersAbove ?? []) {
      const above = clean(raw);
      if (!below || !above || below === above) break;
      if (!chain.has(below)) chain.set(below, above);
      below = above;
    }
  }
  return chain;
}

/** Every manager above `name`, nearest first. Stops on a loop. */
export function managersAbove(name: string | null | undefined, chain: ManagerChain): string[] {
  const above: string[] = [];
  const seen = new Set<string>();
  let current = clean(name);
  if (current) seen.add(current);
  while (current) {
    const next = chain.get(current);
    if (!next || seen.has(next)) break;
    above.push(next);
    seen.add(next);
    current = next;
  }
  return above;
}

/**
 * Does this row belong under the chosen manager? True for the manager's own row, for a direct
 * report, and for anybody further down the chain.
 */
export function matchesManagerFilter(
  row: ManagerChainRow,
  selectedManager: string,
  chain: ManagerChain,
): boolean {
  const selected = clean(selectedManager);
  if (!selected) return true;
  if (clean(row.employeeName) === selected) return true;
  const manager = clean(row.managerName);
  if (!manager) return false;
  if (manager === selected) return true;
  return managersAbove(manager, chain).includes(selected);
}

/**
 * The manager options for a list of rows: every direct manager on screen plus every manager above
 * them on the chain, sorted by name.
 */
export function managerFilterOptions(rows: Iterable<ManagerChainRow>, chain: ManagerChain): string[] {
  const options = new Set<string>();
  for (const row of rows) {
    const manager = clean(row.managerName);
    if (!manager) continue;
    options.add(manager);
    for (const above of managersAbove(manager, chain)) options.add(above);
  }
  return [...options].sort((left, right) => left.localeCompare(right));
}

export type ManagerIdRow = {
  hrId: string | null | undefined;
  managerHrId?: string | null;
  managerName?: string | null;
};

/**
 * For a caller that holds the employee directory rather than a list of rows: every employee's
 * managers ABOVE his direct manager, nearest first, walked by HR id (so a nickname or a renamed
 * seat cannot break the chain). The direct manager is not repeated — the row already carries him.
 * `keyOf` is the caller's own HR-id comparison (for example `canonicalHrIdKey`); a loop stops.
 */
export function buildManagersAboveByHrId(
  rows: Iterable<ManagerIdRow>,
  keyOf: (hrId: string | null | undefined) => string | null = (hrId) => clean(hrId)?.toUpperCase() ?? null,
): Map<string, string[]> {
  const byKey = new Map<string, ManagerIdRow>();
  for (const row of rows) {
    const key = keyOf(row.hrId);
    if (key && !byKey.has(key)) byKey.set(key, row);
  }
  const result = new Map<string, string[]>();
  for (const [key, row] of byKey) {
    const above: string[] = [];
    const seen = new Set<string>([key]);
    const managerKey = keyOf(row.managerHrId);
    if (managerKey) seen.add(managerKey);
    let manager = managerKey ? byKey.get(managerKey) : undefined;
    while (manager) {
      const nextKey = keyOf(manager.managerHrId);
      if (!nextKey || seen.has(nextKey)) break;
      seen.add(nextKey);
      const name = clean(manager.managerName);
      if (name) above.push(name);
      manager = byKey.get(nextKey);
    }
    result.set(key, above);
  }
  return result;
}
