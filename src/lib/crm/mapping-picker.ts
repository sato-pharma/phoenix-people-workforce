/**
 * The Unmapped Agents "Map to" picker — the shape it offers and the filter it runs. Kept free of any
 * server import so the client component can use it, and pure so it is testable without a browser.
 */

/** One person the picker can offer — only what it shows and filters on, never salary or contact data. */
export type CrmMappingEmployeeOption = {
  employmentStatus: string | null;
  fullName: string;
  hireDate: string | null;
  hrId: string;
  jobTitle: string | null;
  lastWorkingDate: string | null;
};

function idKeyOf(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Matches a typed NAME — every word must appear, in any order, case-insensitive, so "farag ahmed"
 * finds "Ahmed Farag Soliman" — or a typed HR ID, case- and dash-insensitive, so "b97", "B-97" and
 * "b-97" all find B-97. An exact HR ID is listed first, so typing a full id always puts that person on
 * top; an id PREFIX only counts once it holds a digit, so typing "b" does not list every B- employee.
 */
export function filterCrmMappingEmployeeOptions(
  options: readonly CrmMappingEmployeeOption[],
  query: string,
  limit = 8,
): CrmMappingEmployeeOption[] {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  const words = text.split(/\s+/);
  const idKey = idKeyOf(text);
  const exact: CrmMappingEmployeeOption[] = [];
  const rest: CrmMappingEmployeeOption[] = [];
  for (const option of options) {
    const optionIdKey = idKeyOf(option.hrId);
    const name = option.fullName.toLowerCase();
    if (idKey && optionIdKey === idKey) {
      exact.push(option);
    } else if (
      (/\d/.test(idKey) && optionIdKey.startsWith(idKey)) ||
      words.every((word) => name.includes(word))
    ) {
      rest.push(option);
    }
  }
  return [...exact, ...rest].slice(0, limit);
}
