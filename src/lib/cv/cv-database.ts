import * as XLSX from "xlsx";

export const cvDatabaseHeaders = [
  "Name",
  "Date of sending CV",
  "Medical Sales Exp?",
  "From",
  "To",
  "Duration",
  "Companies",
  "CV Name",
] as const;

export type CvDatabaseHeader = (typeof cvDatabaseHeaders)[number];
export type CvExperienceStatus = "experienced" | "fresh" | "unknown";

export type CvDatabaseRow = {
  companies: string;
  companyList: string[];
  cvName: string;
  dateOfSendingCv: string;
  duration: string;
  durationMonths: number | null;
  from: string;
  medicalSalesExp: string;
  name: string;
  rowNumber: number;
  status: CvExperienceStatus;
  to: string;
};

export type CvDatabaseParseResult = {
  fileName: string;
  missingHeaders: CvDatabaseHeader[];
  rows: CvDatabaseRow[];
  warnings: string[];
};

export type CvDatabaseSummary = {
  averageExperienceMonths: number;
  candidates: number;
  companies: number;
  experienced: number;
  fresh: number;
  unknown: number;
};

const headerAliases: Record<CvDatabaseHeader, string[]> = {
  Name: ["name", "candidate name", "full name", "applicant"],
  "Date of sending CV": [
    "date of sending cv",
    "cv sending date",
    "date sent",
    "sent date",
    "received date",
    "cv received date",
    "submission date",
  ],
  "Medical Sales Exp?": [
    "medical sales exp?",
    "medical sales exp",
    "medical sales experience",
    "medical sales",
    "sales exp?",
    "sales exp",
  ],
  From: ["from", "start", "start date", "date from"],
  To: ["to", "end", "end date", "date to"],
  Duration: ["duration", "experience duration", "exp duration", "years of experience"],
  Companies: ["companies", "company", "previous companies", "worked companies"],
  "CV Name": ["cv name", "cv file", "cv filename", "file name", "resume name"],
};

function compact(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function text(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function splitCompanies(value: string) {
  return value
    .split(/[;,|/\n]+/g)
    .map((company) => company.trim())
    .filter(Boolean);
}

function truthyExperience(value: string) {
  const normalized = value.toLowerCase();
  return /^(yes|y|true|experienced|exp|1)$/i.test(normalized) || normalized.includes("experience") || normalized.includes("خبر");
}

function falsyExperience(value: string) {
  const normalized = value.toLowerCase();
  return /^(no|n|false|fresh|0)$/i.test(normalized) || normalized.includes("fresh") || normalized.includes("بدون") || normalized.includes("لا");
}

export function parseCvDate(value: string) {
  const raw = text(value);
  if (!raw) return "";
  if (/^(present|current|now|till now|حتى الآن)$/i.test(raw)) return "Present";

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;

  return parsed.toISOString().slice(0, 10);
}

function dateForMath(value: string) {
  if (!value) return null;
  if (value === "Present") return new Date();

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function monthsBetween(from: string, to: string) {
  const start = dateForMath(from);
  const end = dateForMath(to || "Present");

  if (!start || !end || end < start) return null;

  const years = end.getFullYear() - start.getFullYear();
  const months = end.getMonth() - start.getMonth();
  const dayAdjustment = end.getDate() >= start.getDate() ? 0 : -1;

  return Math.max(0, years * 12 + months + dayAdjustment);
}

export function durationMonthsFromText(value: string) {
  const raw = text(value).toLowerCase();
  if (!raw) return null;

  let months = 0;
  let matched = false;
  const yearMatches = raw.matchAll(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|y\b|سنة|سنين|سنوات)/gi);
  for (const match of yearMatches) {
    matched = true;
    months += Math.round(Number(match[1]) * 12);
  }

  const monthMatches = raw.matchAll(/(\d+(?:\.\d+)?)\s*(?:months?|mos?|m\b|شهر|شهور)/gi);
  for (const match of monthMatches) {
    matched = true;
    months += Math.round(Number(match[1]));
  }

  if (matched) return months;

  const plainNumber = Number(raw.replace(/,/g, ""));
  return Number.isFinite(plainNumber) ? Math.round(plainNumber) : null;
}

export function formatDurationMonths(months: number | null) {
  if (months === null) return "";
  if (months < 12) return `${months} month${months === 1 ? "" : "s"}`;

  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest > 0
    ? `${years} year${years === 1 ? "" : "s"} ${rest} month${rest === 1 ? "" : "s"}`
    : `${years} year${years === 1 ? "" : "s"}`;
}

export function classifyCvExperience(input: {
  companies: string;
  durationMonths: number | null;
  from: string;
  medicalSalesExp: string;
}) {
  if (truthyExperience(input.medicalSalesExp)) return "experienced" as const;
  if (falsyExperience(input.medicalSalesExp)) return "fresh" as const;
  if ((input.durationMonths ?? 0) > 0 || Boolean(input.from) || Boolean(input.companies)) return "experienced" as const;
  return "unknown" as const;
}

function headerIndexMap(headerRow: unknown[]) {
  const normalizedCells = headerRow.map((cell) => compact(text(cell)));
  const result = new Map<CvDatabaseHeader, number>();

  for (const header of cvDatabaseHeaders) {
    const aliases = [header, ...headerAliases[header]].map((alias) => compact(alias));
    const index = normalizedCells.findIndex((cell) => aliases.includes(cell));
    if (index >= 0) result.set(header, index);
  }

  return result;
}

function findHeaderRow(matrix: unknown[][]) {
  type HeaderRowCandidate = { index: number; map: Map<CvDatabaseHeader, number> };
  let best: HeaderRowCandidate | null = null;

  for (let index = 0; index < Math.min(matrix.length, 10); index += 1) {
    const row = matrix[index] ?? [];
    const map = headerIndexMap(row);
    if (!best || map.size > best.map.size) {
      best = { index, map };
    }
  }

  if (!best) return null;
  return best.map.size >= 3 ? best : null;
}

function cell(row: unknown[], map: Map<CvDatabaseHeader, number>, header: CvDatabaseHeader) {
  const index = map.get(header);
  return index === undefined ? "" : text(row[index]);
}

function hasAnyValue(row: unknown[]) {
  return row.some((value) => text(value));
}

export function parseCvDatabaseWorkbook(buffer: ArrayBuffer, fileName = "uploaded workbook"): CvDatabaseParseResult {
  const workbook = XLSX.read(buffer, {
    cellDates: true,
    type: "array",
  });
  const sheetName = workbook.SheetNames[0];

  if (!sheetName) {
    throw new Error("CV workbook has no readable sheets.");
  }

  const worksheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    blankrows: false,
    defval: "",
    header: 1,
    raw: false,
  });
  const headerRow = findHeaderRow(matrix);

  if (!headerRow) {
    throw new Error(`CV workbook headers were not found. Required columns include: ${cvDatabaseHeaders.join(", ")}.`);
  }

  const missingHeaders = cvDatabaseHeaders.filter((header) => !headerRow.map.has(header));
  const warnings = missingHeaders.length > 0
    ? [`Missing optional columns: ${missingHeaders.join(", ")}. Visible rows were still imported from the columns found.`]
    : [];

  const rows = matrix
    .slice(headerRow.index + 1)
    .map((row, index): CvDatabaseRow | null => {
      const rowNumber = headerRow.index + index + 2;
      if (!hasAnyValue(row)) return null;

      const from = parseCvDate(cell(row, headerRow.map, "From"));
      const to = parseCvDate(cell(row, headerRow.map, "To"));
      const dateOfSendingCv = parseCvDate(cell(row, headerRow.map, "Date of sending CV"));
      const duration = cell(row, headerRow.map, "Duration");
      const durationMonths = durationMonthsFromText(duration) ?? monthsBetween(from, to);
      const companies = cell(row, headerRow.map, "Companies");
      const medicalSalesExp = cell(row, headerRow.map, "Medical Sales Exp?");

      return {
        companies,
        companyList: splitCompanies(companies),
        cvName: cell(row, headerRow.map, "CV Name"),
        dateOfSendingCv,
        duration: duration || formatDurationMonths(durationMonths),
        durationMonths,
        from,
        medicalSalesExp,
        name: cell(row, headerRow.map, "Name"),
        rowNumber,
        status: classifyCvExperience({
          companies,
          durationMonths,
          from,
          medicalSalesExp,
        }),
        to,
      };
    })
    .filter((row): row is CvDatabaseRow => Boolean(row));

  return {
    fileName,
    missingHeaders,
    rows,
    warnings,
  };
}

export function summarizeCvDatabase(rows: CvDatabaseRow[]): CvDatabaseSummary {
  const experiencedRows = rows.filter((row) => row.status === "experienced");
  const experienceMonths = experiencedRows
    .map((row) => row.durationMonths)
    .filter((value): value is number => typeof value === "number");
  const companies = new Set(rows.flatMap((row) => row.companyList.map((company) => compact(company))).filter(Boolean));

  return {
    averageExperienceMonths: experienceMonths.length > 0
      ? Math.round(experienceMonths.reduce((sum, value) => sum + value, 0) / experienceMonths.length)
      : 0,
    candidates: rows.length,
    companies: companies.size,
    experienced: experiencedRows.length,
    fresh: rows.filter((row) => row.status === "fresh").length,
    unknown: rows.filter((row) => row.status === "unknown").length,
  };
}

export function rowsForCvWorkbook(rows: CvDatabaseRow[]) {
  return rows.map((row) => ({
    Name: row.name,
    "Date of sending CV": row.dateOfSendingCv,
    "Medical Sales Exp?": row.status === "experienced" ? "Yes" : row.status === "fresh" ? "No" : row.medicalSalesExp,
    From: row.from,
    To: row.to,
    Duration: row.duration || formatDurationMonths(row.durationMonths),
    Companies: row.companies,
    "CV Name": row.cvName,
  }));
}
