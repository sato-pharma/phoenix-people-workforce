// Business Review — the hidden fields a GET filter form must carry so one control does not undo
// another (the window, the line, the chosen metrics, the territory narrowing).
//
// A value may be a single string OR several — the owner exports "multiple regions and multiple areas"
// (2026-09-27), so `region` and `area` can each carry more than one value. Both a hidden-input form
// and a URLSearchParams link need the SAME flattening: one entry per value, repeated under the same
// name, which is exactly what `params.getAll("region")` reads back on the server.

export type HiddenFields = Record<string, string | string[]>;

/** One `[name, value]` pair per value — an array becomes several pairs under the same name. */
export function hiddenEntries(hidden?: HiddenFields): [string, string][] {
  return Object.entries(hidden ?? {}).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((v) => [name, v] as [string, string]),
  );
}
