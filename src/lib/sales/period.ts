export type SalesPeriod = {
  month: number;
  year: number;
};

const monthAliases = new Map<string, number>([
  ["jan", 1],
  ["january", 1],
  ["feb", 2],
  ["february", 2],
  ["mar", 3],
  ["march", 3],
  ["apr", 4],
  ["april", 4],
  ["may", 5],
  ["jun", 6],
  ["june", 6],
  ["jul", 7],
  ["july", 7],
  ["aug", 8],
  ["august", 8],
  ["sep", 9],
  ["sept", 9],
  ["september", 9],
  ["oct", 10],
  ["october", 10],
  ["nov", 11],
  ["november", 11],
  ["dec", 12],
  ["december", 12],
]);

const monthNamePattern =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

function validSalesPeriod(month: number, year: number): SalesPeriod | null {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  return { month, year };
}

function monthNumberFromName(value: string) {
  const normalized = value.trim().toLowerCase();
  return monthAliases.get(normalized.slice(0, 3)) ?? monthAliases.get(normalized) ?? null;
}

export function salesPeriodLabel(period: SalesPeriod) {
  return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

export function salesPeriodsMatch(left: SalesPeriod, right: SalesPeriod) {
  return left.month === right.month && left.year === right.year;
}

export function extractSalesPeriodFromFileName(fileName: string): SalesPeriod | null {
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const text = baseName.toLowerCase();

  const namedMonthMatches = Array.from(text.matchAll(new RegExp(`\\b(${monthNamePattern})\\b`, "gi")));
  const yearMatches = Array.from(text.matchAll(/\b(20\d{2})\b/g));

  if (namedMonthMatches.length === 1 && yearMatches.length > 0) {
    const month = monthNumberFromName(namedMonthMatches[0][1]);
    const nearestYear = yearMatches
      .map((match) => ({
        index: match.index ?? 0,
        year: Number(match[1]),
      }))
      .sort((left, right) => {
        const monthIndex = namedMonthMatches[0].index ?? 0;
        return Math.abs(left.index - monthIndex) - Math.abs(right.index - monthIndex);
      })[0];

    if (month && nearestYear) return validSalesPeriod(month, nearestYear.year);
  }

  const numericPatterns = [
    {
      monthIndex: 2,
      regex: /(?:^|[^\d])(20\d{2})[\s_.-]+(0?[1-9]|1[0-2])(?:[^\d]|$)/,
      yearIndex: 1,
    },
    {
      monthIndex: 1,
      regex: /(?:^|[^\d])(0?[1-9]|1[0-2])[\s_.-]+(20\d{2})(?:[^\d]|$)/,
      yearIndex: 2,
    },
  ];

  for (const pattern of numericPatterns) {
    const match = pattern.regex.exec(text);
    if (!match) continue;
    const month = Number(match[pattern.monthIndex]);
    const year = Number(match[pattern.yearIndex]);
    const period = validSalesPeriod(month, year);
    if (period) return period;
  }

  return null;
}
