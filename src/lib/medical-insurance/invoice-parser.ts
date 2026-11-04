// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reads an insurer's premium statement out of the text of its PDF. Pure, and it uses no model: the file
// is printed by a billing system in one fixed layout, so every figure either matches a pattern or is
// named as unread.
//
// 🔴 A LINE IT CANNOT PLACE GOES IN `problems`, NEVER INTO SILENCE. An invoice read short looks exactly
// like an invoice that adds up. So the file's own printed totals are checked against what was read:
// each member against their member total, the members against the report's total, and each product
// against its own lines. Whatever fails is named on the screen beside the comparison.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { MEDICAL_INSURANCE_PRODUCTS, type MedicalInsuranceProduct } from "./cost";

export type InvoiceCoverType = "MEM" | "SPO" | "CHD";

export type ParsedStatementRow = {
  plan: string;
  coverType: InvoiceCoverType;
  billed: number | null;
  rate: number | null;
  premium: number;
};

export type ParsedProduct = {
  code: MedicalInsuranceProduct;
  label: string;
  rows: ParsedStatementRow[];
  premium: number;
  adjustments: number;
  issueFee: number;
  nominalStamp: number;
  fees: number;
  stamp: number;
  productTotal: number;
  outstanding: number;
  totalDue: number;
};

export type ParsedMemberLine = {
  product: MedicalInsuranceProduct;
  plan: string;
  coverType: InvoiceCoverType;
  dependantCount: number | null;
  volume: number;
  adjustment: number;
  premium: number;
};

export type ParsedInvoiceMember = {
  certificate: string;
  name: string;
  birthDate: string | null;
  lines: ParsedMemberLine[];
  statedTotal: number | null;
};

export type ParsedInvoice = {
  billNumber: string;
  issuedOn: string | null;
  policyNumber: string | null;
  subOffice: string | null;
  periodStart: string;
  periodEnd: string;
  products: ParsedProduct[];
  members: ParsedInvoiceMember[];
  premiumTotal: number;
  feesTotal: number;
  totalDue: number;
  problems: string[];
};

export class InvoiceUnreadableError extends Error {}

const DETAIL_PRODUCT: Record<string, MedicalInsuranceProduct> = {
  ACCDE: "AD",
  ACCPP: "PPDA",
  CMAJO: "CMM",
  LIFE: "GTL",
  PTD: "PTD",
};

const MONEY = String.raw`-?[\d,]*\.?\d+-?`;
const DATE = String.raw`\d\d\/\d\d\/\d{4}`;
const CODES = Object.keys(DETAIL_PRODUCT).join("|");

const DETAIL_TAIL = String.raw`(${CODES}) (\d{3}) (MEM|SPO|CHD)(?: (\d+))? ([\d,]+) (${MONEY}) (${MONEY})$`;
const MEMBER_HEAD = new RegExp(String.raw`^(.*?) ?(${DATE}) ([A-Z]) (\S+) (${DATE}) ${DETAIL_TAIL}`);
const MEMBER_MORE = new RegExp(String.raw`^(?:${DATE} [A-Z] )?${DETAIL_TAIL}`);
const MEMBER_TOTAL = new RegExp(String.raw`^MEMBER TOTAL : (${MONEY}) (${MONEY})$`);
const REPORT_TOTAL = new RegExp(String.raw`^TOTAL DUE : (${MONEY}) (${MONEY})$`);
const PRODUCT_LINE = new RegExp(String.raw`^([A-Z]+) - (.+?) (${DATE}) TO (${DATE})$`);
const STATEMENT_ROW = /^(\d{3}) (MEM|SPO|CHD)\b(.*)$/;
const LOOKS_LIKE_DETAIL = new RegExp(String.raw`\b(${CODES}) +\d{3} +(MEM|SPO|CHD)\b`);

/** "1,234.50" and the billing system's "1,234.50-", to a number. Null when it is neither. */
export function parseInvoiceAmount(raw: string): number | null {
  const text = raw.trim();
  const negative = text.startsWith("-") || text.endsWith("-");
  const value = Number(text.replace(/[-,]/g, ""));
  if (!text || !Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function amount(raw: string): number {
  return parseInvoiceAmount(raw) ?? 0;
}

function isoDate(raw: string): string {
  const [day, month, year] = raw.split("/");
  return `${year}-${month}-${day}`;
}

const cents = (value: number) => Math.round(value * 100);
const sumEgp = (values: number[]) => values.reduce((sum, value) => sum + cents(value), 0) / 100;
const sameEgp = (a: number, b: number) => cents(a) === cents(b);
const egp = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

function emptyProduct(code: MedicalInsuranceProduct, label: string): ParsedProduct {
  return { adjustments: 0, code, fees: 0, issueFee: 0, label, nominalStamp: 0, outstanding: 0, premium: 0, productTotal: 0, rows: [], stamp: 0, totalDue: 0 };
}

function readStatementRow(plan: string, coverType: InvoiceCoverType, tail: string): ParsedStatementRow | null {
  const tokens = tail.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const premium = parseInvoiceAmount(tokens[tokens.length - 1]);
  if (premium === null) return null;
  const middle = tokens.slice(0, -1);
  // A rate is the only figure in the middle with a decimal point. The last whole number is the billed
  // count: the columns before it are previous, added and ended cover, blank whenever they are nil.
  const rateToken = middle.find((token) => token.includes("."));
  const counts = middle.filter((token) => /^\d+$/.test(token));
  return {
    billed: counts.length > 0 ? Number(counts[counts.length - 1]) : null,
    coverType,
    plan,
    premium,
    rate: rateToken ? parseInvoiceAmount(rateToken) : null,
  };
}

export function parseMedicalInsuranceInvoice(text: string): ParsedInvoice {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);

  let section: "none" | "statement" | "detail" = "none";
  let product: ParsedProduct | null = null;
  let member: ParsedInvoiceMember | null = null;
  let reportTotal: number | null = null;
  let periodStart = "";
  let periodEnd = "";

  const products: ParsedProduct[] = [];
  const members: ParsedInvoiceMember[] = [];
  const problems: string[] = [];

  const billNumber = /\b[0-9A-Z]{5}-[0-9A-Z]{4}-\d{2}-\d{2}-\d{3}\b/.exec(text)?.[0] ?? "";
  const issued = new RegExp(String.raw`ISSUE DATE : (${DATE})`).exec(text)?.[1] ?? null;
  const policyNumber = /POLICY NUMBER ?: ?(\d+)/.exec(text)?.[1] ?? null;
  const subOffice = /SUBOFFICE ?: ?(\d+)/.exec(text)?.[1] ?? null;

  const take = (pattern: RegExp, line: string): number | null => {
    const match = pattern.exec(line);
    return match ? amount(match[1]) : null;
  };

  for (const line of lines) {
    if (line === "PREMIUM STATEMENT") {
      section = "statement";
      continue;
    }
    if (line === "PREMIUM DETAIL REPORT") {
      section = "detail";
      continue;
    }
    if (section === "none") continue;
    if (/^\*+ END OF REPORT \*+$/.test(line)) {
      section = "none";
      continue;
    }

    if (section === "statement") {
      const productLine = PRODUCT_LINE.exec(line);
      if (productLine) {
        const [, code, label, from, to] = productLine;
        periodStart ||= isoDate(from);
        periodEnd ||= isoDate(to);
        if ((MEDICAL_INSURANCE_PRODUCTS as readonly string[]).includes(code)) {
          product = emptyProduct(code as MedicalInsuranceProduct, label);
          products.push(product);
        } else {
          product = null;
          problems.push(`A product this module does not know is on the invoice: ${code} (${label}). It is not in any total below.`);
        }
        continue;
      }
      if (!product) continue;

      const row = STATEMENT_ROW.exec(line);
      if (row) {
        const read = readStatementRow(row[1], row[2] as InvoiceCoverType, row[3]);
        if (read) product.rows.push(read);
        else problems.push(`A row of ${product.label} could not be read: "${line}"`);
        continue;
      }

      const money = new RegExp(String.raw`(${MONEY})$`);
      const figure = (prefix: RegExp) => (prefix.test(line) ? take(money, line) : null);
      let value: number | null;
      if ((value = figure(/^PREMIUM :/)) !== null) product.premium = value;
      else if ((value = figure(/^ADJUSTMENTS :/)) !== null) product.adjustments = value;
      else if ((value = figure(/^ISSUE FEE :/)) !== null) product.issueFee = value;
      else if ((value = figure(/^NOMINAL STAMP DUTY TAX ON :/)) !== null) product.nominalStamp = value;
      else if ((value = figure(/^SUPERVISORY & SERVICE FEES/)) !== null) product.fees = value;
      else if ((value = figure(/^PROPORTIONAL STAMP DUTY :/)) !== null) product.stamp = value;
      else if ((value = figure(/^PRODUCT TOTAL EGP/)) !== null) product.productTotal = value;
      else if ((value = figure(/^OUTSTANDING BALANCE EGP/)) !== null) product.outstanding = value;
      else if ((value = figure(/^TOTAL DUE FOR PRODUCT EGP/)) !== null) product.totalDue = value;
      continue;
    }

    // Detail report.
    const totalLine = MEMBER_TOTAL.exec(line);
    if (totalLine) {
      if (member) member.statedTotal = amount(totalLine[2]);
      else problems.push(`A member total with no member above it: "${line}"`);
      continue;
    }
    const reportLine = REPORT_TOTAL.exec(line);
    if (reportLine) {
      reportTotal = amount(reportLine[2]);
      continue;
    }

    const head = MEMBER_HEAD.exec(line);
    const more = head ? null : MEMBER_MORE.exec(line);
    if (head) {
      const [, name, , , certificate, birth, code, plan, cover, count, volume, adjustment, premium] = head;
      // The report reprints a member's heading when their lines cross a page, so one certificate can
      // head several blocks. They are one person: read as two, each half fails its own member total.
      const known = members.find((entry) => entry.certificate === certificate);
      member = known ?? { birthDate: isoDate(birth), certificate, lines: [], name: name.trim(), statedTotal: null };
      if (!known) members.push(member);
      member.lines.push({
        adjustment: amount(adjustment),
        coverType: cover as InvoiceCoverType,
        dependantCount: count ? Number(count) : null,
        plan,
        premium: amount(premium),
        product: DETAIL_PRODUCT[code],
        volume: amount(volume),
      });
    } else if (more) {
      const [, code, plan, cover, count, volume, adjustment, premium] = more;
      if (!member) {
        problems.push(`A premium line with no member above it: "${line}"`);
        continue;
      }
      member.lines.push({
        adjustment: amount(adjustment),
        coverType: cover as InvoiceCoverType,
        dependantCount: count ? Number(count) : null,
        plan,
        premium: amount(premium),
        product: DETAIL_PRODUCT[code],
        volume: amount(volume),
      });
    } else if (LOOKS_LIKE_DETAIL.test(line)) {
      problems.push(`A premium line could not be read: "${line}"`);
    }
  }

  if (!billNumber || products.length === 0) {
    throw new InvoiceUnreadableError(
      "This file does not read as an insurer's premium statement: no bill number or no product section was found. Nothing was saved.",
    );
  }
  if (members.length === 0) {
    problems.push("The member detail report was not found, so this invoice cannot be compared person by person.");
  }

  for (const entry of members) {
    const read = sumEgp(entry.lines.map((row) => row.premium + row.adjustment));
    if (entry.statedTotal === null) {
      problems.push(`Certificate ${entry.certificate}, ${entry.name}: the invoice prints no member total to check against.`);
    } else if (!sameEgp(read, entry.statedTotal)) {
      problems.push(`Certificate ${entry.certificate}, ${entry.name}: the lines read add to ${egp(read)} and the invoice prints ${egp(entry.statedTotal)}.`);
    }
  }

  const memberPremium = (code: MedicalInsuranceProduct) =>
    sumEgp(members.flatMap((entry) => entry.lines.filter((row) => row.product === code).map((row) => row.premium + row.adjustment)));

  for (const entry of products) {
    const rows = sumEgp(entry.rows.map((row) => row.premium));
    if (!sameEgp(rows, entry.premium)) {
      problems.push(`${entry.label}: the rows add to ${egp(rows)} and the invoice prints a premium of ${egp(entry.premium)}.`);
    }
    const charged = sumEgp([entry.premium, entry.adjustments, entry.issueFee, entry.nominalStamp, entry.fees, entry.stamp]);
    if (!sameEgp(charged, entry.productTotal)) {
      problems.push(`${entry.label}: premium and fees add to ${egp(charged)} and the invoice prints a product total of ${egp(entry.productTotal)}.`);
    }
    if (!sameEgp(sumEgp([entry.productTotal, entry.outstanding]), entry.totalDue)) {
      problems.push(`${entry.label}: the product total and the outstanding balance do not add to the ${egp(entry.totalDue)} due.`);
    }
    if (members.length > 0) {
      const detail = memberPremium(entry.code);
      const billed = sumEgp([entry.premium, entry.adjustments]);
      if (!sameEgp(detail, billed)) {
        problems.push(`${entry.label}: the member detail adds to ${egp(detail)} and the statement bills ${egp(billed)}.`);
      }
    }
  }

  const premiumTotal = sumEgp(products.map((entry) => entry.premium + entry.adjustments));
  if (reportTotal !== null && !sameEgp(reportTotal, premiumTotal)) {
    problems.push(`The detail report totals ${egp(reportTotal)} and the statement's premiums add to ${egp(premiumTotal)}.`);
  } else if (reportTotal === null && members.length > 0) {
    problems.push("The detail report's own total was not found, so it could not be checked.");
  }

  const totalDue = sumEgp(products.map((entry) => entry.totalDue));

  return {
    billNumber,
    feesTotal: sumEgp([totalDue, -premiumTotal]),
    issuedOn: issued ? isoDate(issued) : null,
    members,
    periodEnd,
    periodStart,
    policyNumber,
    premiumTotal,
    problems,
    products,
    subOffice,
    totalDue,
  };
}

/** Each member's billed premium per product. */
export function billedByProduct(member: ParsedInvoiceMember): Record<MedicalInsuranceProduct, number> {
  const totals: Record<MedicalInsuranceProduct, number> = { AD: 0, CMM: 0, GTL: 0, PPDA: 0, PTD: 0 };
  for (const line of member.lines) totals[line.product] = (cents(totals[line.product]) + cents(line.premium + line.adjustment)) / 100;
  return totals;
}
