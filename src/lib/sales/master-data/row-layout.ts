import type { DisplayLookup, MasterColumn, MasterDefinition } from "@/lib/sales/master-data/definitions";

// How the Database Mapping rows table fits the screen: by MERGING columns (fits-the-screen rule),
// never by shrinking type or scrolling sideways.
//
// - The locked columns (key and display name) are never edited in a row, so they ride together in
//   one identity cell.
// - Each parent lookup sits under the code column it resolves from, following a lookup chain
//   (a brick's Area Name resolves via Area Code, itself a lookup via Block Code).
// - Active and Updated share one Status cell, beside the Actions cell.
//
// Every master is therefore at most five columns, whose percentage widths total 100.

export type MasterRowLayout = {
  fields: MasterColumn[];
  identity: MasterColumn[];
  lookupsByHost: Map<string, DisplayLookup[]>;
  /** Percent widths, in render order: identity, each field, Status, Actions. Total 100. */
  widths: number[];
};

export function lookupHost(def: MasterDefinition, lookup: DisplayLookup): string {
  let via = lookup.viaCodeColumn;
  for (let hop = 0; hop <= def.displayLookups.length; hop += 1) {
    if (def.columns.some((column) => column.key === via)) return via;
    const next = def.displayLookups.find((candidate) => candidate.key === via);
    if (!next) break;
    via = next.viaCodeColumn;
  }
  return def.columns[0]?.key ?? via;
}

export function masterRowLayout(def: MasterDefinition): MasterRowLayout {
  const locked = def.columns.filter((column) => column.locked);
  const identity = locked.length > 0 ? locked : def.columns.slice(0, 1);
  const identityKeys = new Set(identity.map((column) => column.key));
  const fields = def.columns.filter((column) => !identityKeys.has(column.key));
  const lookupsByHost = new Map<string, DisplayLookup[]>();
  for (const lookup of def.displayLookups) {
    const host = lookupHost(def, lookup);
    lookupsByHost.set(host, [...(lookupsByHost.get(host) ?? []), lookup]);
  }
  const statusWidth = 14;
  const actionsWidth = 20;
  const identityWidth = fields.length > 0 ? 26 : 100 - statusWidth - actionsWidth;
  const fieldWidth = fields.length > 0 ? (100 - identityWidth - statusWidth - actionsWidth) / fields.length : 0;
  const widths = [identityWidth, ...fields.map(() => fieldWidth), statusWidth, actionsWidth];
  return { fields, identity, lookupsByHost, widths };
}
