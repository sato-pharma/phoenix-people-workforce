// Employee 360 — the index list's "Manager" filter.
//
// Owner, 2026-10-20: "when you filter by manager you find no manager … every single role that is
// applicable to appear in a module — find it and show it." The filter offered only the distinct
// direct manager of the cards on the open tab and matched `managerName === selected`, so on the
// Medical Reps tab a Regional or National Sales Manager was never offered, and choosing a District
// Manager's own manager found none of the reps beneath him.
//
// This is the shared rule in src/lib/org/manager-filter.ts, fed with a chain that reaches past the
// cards on screen: each list item carries `managersAbove`, the managers above its direct manager,
// walked by HR id over the whole employee directory on the server (list-items.ts). So the chain
// still reaches the National Sales Manager when a link in it is not a card the viewer may open.
//
// Pure and dependency-free (manager-filter.ts imports nothing), because the list is a client
// component. Pinned by tests/employee-360-portal-browse.test.ts (the list's own test).

import {
  buildManagerChain,
  managerFilterOptions,
  matchesManagerFilter,
  type ManagerChain,
  type ManagerChainRow,
} from "@/lib/org/manager-filter";

/** The three fields of a list item the filter reads. */
export type Employee360ManagerFilterItem = {
  displayName: string;
  managerName: string | null;
  /** Managers above `managerName`, nearest first. */
  managersAbove?: readonly string[] | null;
};

function chainRowOf(item: Employee360ManagerFilterItem): ManagerChainRow {
  return { employeeName: item.displayName, managerName: item.managerName };
}

/**
 * `name → manager name` for every link the items know about: each card's own link, and every link
 * of the chain above its direct manager. Built from ALL the items, not one tab, so a District
 * Manager on his own tab still links the reps on the Medical Reps tab to his Regional Manager.
 */
export function buildEmployee360ManagerChain(items: Iterable<Employee360ManagerFilterItem>): Map<string, string> {
  const links: ManagerChainRow[] = [];
  for (const item of items) {
    const path = [item.displayName, item.managerName, ...(item.managersAbove ?? [])];
    for (let index = 0; index + 1 < path.length; index += 1) {
      const employeeName = path[index];
      const managerName = path[index + 1];
      if (!employeeName || !managerName) break;
      links.push({ employeeName, managerName });
    }
  }
  return buildManagerChain(links);
}

/** The Manager options for one tab: every direct manager on it and every manager above them. */
export function employee360ManagerOptions(
  inTab: Iterable<Employee360ManagerFilterItem>,
  chain: ManagerChain,
): string[] {
  return managerFilterOptions(Array.from(inTab, chainRowOf), chain);
}

/** Does this card belong under the chosen manager — his own card, or anyone beneath him. */
export function matchesEmployee360Manager(
  item: Employee360ManagerFilterItem,
  selectedManager: string,
  chain: ManagerChain,
): boolean {
  return matchesManagerFilter(chainRowOf(item), selectedManager, chain);
}
