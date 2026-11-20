// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MEDICAL COVER STATEMENT: one employee's monthly cost, as a PDF to hand them (owner, 2026-11-21:
// "export PDF for everyone to send it to him … his cost in months … his grade … his TOB … if he has a
// family, his family under him with a total").
//
// WHAT IT SHOWS, AND WHAT IT NEVER SHOWS:
//   * His grade (the plan, A, B or C), what he pays each month, and his grade's table of benefits.
//   * Each family member on their own line beside him, with what each one costs him a month, then a total.
//   * 🔴 NEVER A PERCENTAGE OF THE SPLIT ("ما يظهرلوش برسنتج 30%، يظهر له المبلغ على طول"). The amounts
//     are written as amounts: no "30%", no "70%", no "company pays", no minimum. The only percentages on
//     the paper are the table of benefits' own co-payments, which are what the insurer signed.
//
// THE NUMBERS ARE THE COST TAB'S, NEVER A SECOND RULE. Every amount comes from one `MonthlySplitRow`
// (`buildMonthlySplit`, monthly-split.ts): his own line is `employeeOwnShare` (his share of his own cover,
// the EGP 120 floor already applied), each relative's is their whole month, and every person carries the
// EGP 85 of life insurance. The lines must add back to the row's `employeePays` to the piastre, or no
// paper is made (`CostLetterError`).
//
// 🔴 SUPER ADMIN ONLY, like every amount on this module: the route asserts medical_insurance_invoices
// before it reads anything. It sends nothing; he downloads it and passes it on himself.
//
// Rendered by Chromium in the HR premium identity (SATO-DIS-2026-01), a company paper footed for Sato
// Pharma alone (`PREMIUM_COMPANY_DOCUMENT_BRAND`), like the payslip.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { systemLegalEntity } from "@/config/system-settings";
import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import {
  PREMIUM_COMPANY_DOCUMENT_BRAND,
  PREMIUM_IDENTITY_CSS,
  PREMIUM_LATIN_FONT_STACK,
  premiumMasthead,
  premiumPageChrome,
  premiumSheetCss,
} from "@/lib/hiring-pack/premium-identity";
import { ARABIC_FONT_STACK, escapeHtml } from "@/lib/hiring-pack/render-shared";

import { LIBANO_TABLE_OF_BENEFITS, type BenefitLine, type BenefitText } from "./benefits";
import type { MedicalInsuranceCategory, MedicalInsuranceMemberType } from "./cost";
import { LIFE_INSURANCE_PER_PERSON_MONTHLY, type MonthlySplitPerson, type MonthlySplitRow } from "./monthly-split";

/** A paper that cannot be made truthfully: the route answers with this message, never a PDF. */
export class CostLetterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostLetterError";
  }
}

export type CostLetterPerson = {
  name: string;
  memberType: MedicalInsuranceMemberType;
  plan: MedicalInsuranceCategory;
  /** What this person's medical cover costs the employee a month. */
  medical: number;
  /** The life insurance on this person, a month. */
  life: number;
  /** medical + life. */
  monthly: number;
  /** Set when this person's cover starts later than today. */
  startsOn: string | null;
};

export type CostLetterPolicy = {
  insurer: string;
  policyNumber: string | null;
  startsOn: string;
  endsOn: string;
};

export type CostLetter = {
  employeeName: string;
  hrId: string | null;
  plan: MedicalInsuranceCategory;
  people: CostLetterPerson[];
  /** The employee's own line. */
  own: number;
  /** Every family member's lines together. */
  family: number;
  /** What the employee pays each month, everything included. */
  total: number;
  policy: CostLetterPolicy;
};

const toPiastres = (egp: number) => Math.round(egp * 100);
const toEgp = (piastres: number) => Math.round(piastres) / 100 || 0;

/** One employee's statement, from their row of the monthly split. Throws `CostLetterError` rather than print a figure that is short. */
export function buildCostLetter(row: MonthlySplitRow, policy: CostLetterPolicy): CostLetter {
  const employee = row.employee;
  if (!employee) throw new CostLetterError("This family member's employee is no longer on the register, so there is no one to hand the statement to.");
  const unpriced = [employee, ...row.family].filter((person) => person.monthly === null);
  if (unpriced.length > 0) {
    const names = unpriced.map((person) => person.name).join(", ");
    throw new CostLetterError(`${names} cannot be priced yet (${unpriced[0].unpricedReason ?? "no premium on the rate card"}), so the statement would be short. Fix the record first.`);
  }

  const life = toPiastres(LIFE_INSURANCE_PER_PERSON_MONTHLY);
  const line = (person: MonthlySplitPerson, medicalPiastres: number): CostLetterPerson => ({
    life: toEgp(life),
    medical: toEgp(medicalPiastres),
    memberType: person.memberType,
    monthly: toEgp(medicalPiastres + life),
    name: person.name,
    plan: person.category,
    startsOn: person.startsOn,
  });

  const ownPiastres = toPiastres(row.employeeOwnShare);
  const people = [line(employee, ownPiastres), ...row.family.map((relative) => line(relative, toPiastres(relative.monthly ?? 0)))];
  const totalPiastres = people.reduce((sum, person) => sum + toPiastres(person.monthly), 0);
  if (totalPiastres !== toPiastres(row.employeePays)) {
    throw new CostLetterError(`The statement's lines add to ${toEgp(totalPiastres)} but the Cost tab says ${row.employeePays}; nothing was made.`);
  }

  return {
    employeeName: employee.name,
    family: toEgp(totalPiastres - toPiastres(people[0].monthly)),
    hrId: row.hrId,
    own: people[0].monthly,
    people,
    plan: employee.category,
    policy,
    total: toEgp(totalPiastres),
  };
}

// ── The paper ──────────────────────────────────────────────────────────────────────────────────

const RELATION_WORDS: Record<MedicalInsuranceMemberType, string> = { child: "Child", employee: "You", spouse: "Spouse" };

export function costLetterMoney(value: number): string {
  return `EGP ${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function longDay(key: string): string {
  const date = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return key;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC", year: "numeric" }).format(date);
}

/** The file name the PDF is saved under: the person's name, never their HR number alone. */
export function costLetterFileName(letter: Pick<CostLetter, "employeeName">): string {
  const slug = letter.employeeName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Employee";
  return `${slug}-Medical-Cover-Statement.pdf`;
}

/** English first, the signed Arabic beneath it — the Benefits tab's own reading order. */
function both(text: BenefitText, strong = false): string {
  const english = `<span class="en${strong ? " en--b" : ""}">${escapeHtml(text.en)}</span>`;
  // A figure or a name the table writes the same in both ("75,000", "Full Network-003") is printed once.
  return text.ar.trim() === text.en.trim() || !/[؀-ۿ]/.test(text.ar) ? english : `${english}<span class="ar" dir="rtl" lang="ar">${escapeHtml(text.ar)}</span>`;
}

function benefitName(line: BenefitLine): string {
  return both(line.benefit, true) + (line.part ? `<span class="part">${both(line.part)}</span>` : "");
}

function masthead(letter: CostLetter, slim: boolean): string {
  return premiumMasthead({
    compact: !slim,
    legalNameAr: systemLegalEntity.legalNameAr,
    legalNameEn: systemLegalEntity.legalNameEn,
    slim,
    subtitles: [
      { lang: "en", text: letter.employeeName },
      { lang: "en", text: `${letter.policy.insurer} · ${longDay(letter.policy.startsOn)} to ${longDay(letter.policy.endsOn)}` },
    ],
    title: slim ? `Table of Benefits · Grade ${letter.plan}` : "Medical Cover Statement",
    titleLang: "en",
  });
}

export function renderCostLetterHtml(letter: CostLetter, preparedOn: string): string {
  const benefits = LIBANO_TABLE_OF_BENEFITS[letter.plan];
  const hasFamily = letter.people.length > 1;
  const chrome = premiumPageChrome({ brand: PREMIUM_COMPANY_DOCUMENT_BRAND, department: "Human Resources · Medical Cover Statement" });
  const policyWords = letter.policy.policyNumber ? `Policy ${escapeHtml(letter.policy.policyNumber)}` : "Group policy";

  const rows = letter.people
    .map((person) => {
      const from = person.startsOn ? `<span class="sub">Cover from ${escapeHtml(longDay(person.startsOn))}</span>` : "";
      return `<tr>
        <td><strong>${escapeHtml(person.name)}</strong>${from}</td>
        <td>${RELATION_WORDS[person.memberType]}</td>
        <td class="mid">${person.plan}</td>
        <td class="num">${costLetterMoney(person.medical)}</td>
        <td class="num">${costLetterMoney(person.life)}</td>
        <td class="num"><strong>${costLetterMoney(person.monthly)}</strong></td>
      </tr>`;
    })
    .join("");

  const familyStrip = hasFamily
    ? `<div class="cell"><p class="k">Your family, a month</p><p class="v">${costLetterMoney(letter.family)}</p></div>`
    : "";

  const facts = benefits.facts
    .map((fact) => `<div class="fact"><p class="k">${escapeHtml(fact.label.en)}</p><p class="v">${both(fact.value)}</p></div>`)
    .join("");

  const sections = benefits.sections
    .map(
      (section) => `<h2 class="pm-shead sh">${escapeHtml(section.title.en)} <span class="sh-ar" dir="rtl" lang="ar">${escapeHtml(section.title.ar)}</span></h2>
      <table class="tob">
        <colgroup><col style="width:36%"><col style="width:50%"><col style="width:14%"></colgroup>
        <thead><tr><th>Benefit</th><th>Cover</th><th class="mid">Co-payment</th></tr></thead>
        <tbody>${section.lines
          .map((line) => `<tr><td>${benefitName(line)}</td><td>${both(line.coverage)}</td><td class="mid">${line.memberShare ? escapeHtml(line.memberShare) : "&mdash;"}</td></tr>`)
          .join("")}</tbody>
      </table>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Medical Cover Statement — ${escapeHtml(letter.employeeName)}</title>
<style>${letterCss()}</style></head>
<body>
<section class="page">
  ${masthead(letter, false)}
  <p class="eyebrow pm-shead">Prepared for you on ${escapeHtml(preparedOn)}</p>
  <h1 class="h1"><span class="h1__l">Your medical cover,</span><span class="h1__b">${escapeHtml(letter.employeeName)}</span></h1>
  <div class="tick"><i></i><i></i><i></i></div>
  <p class="lead">You are covered under ${escapeHtml(systemLegalEntity.legalNameEn)}'s group medical policy with ${escapeHtml(letter.policy.insurer)}. This statement shows your grade, the amount you pay each month${hasFamily ? " for you and your family" : ""}, and the benefits your grade gives you.</p>

  <div class="strip">
    <div class="cell"><p class="k">Your grade</p><p class="v v--grade">${letter.plan}</p></div>
    <div class="cell"><p class="k">You, a month</p><p class="v">${costLetterMoney(letter.own)}</p></div>
    ${familyStrip}
    <div class="cell cell--total"><p class="k">Total, a month</p><p class="v">${costLetterMoney(letter.total)}</p></div>
  </div>

  <h2 class="pm-shead sh">What you pay each month</h2>
  <table class="pay">
    <colgroup><col style="width:33%"><col style="width:11%"><col style="width:9%"><col style="width:17%"><col style="width:13%"><col style="width:17%"></colgroup>
    <thead><tr><th>Covered</th><th>As</th><th class="mid">Grade</th><th class="num">Medical cover</th><th class="num">Life insurance</th><th class="num">A month</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="5">Total you pay each month</td><td class="num">${costLetterMoney(letter.total)}</td></tr></tfoot>
  </table>

  <h2 class="pm-shead sh">Grade ${letter.plan} at a glance</h2>
  <div class="facts">${facts}</div>

  <div class="callout">
    <p><strong>${policyWords}</strong> with ${escapeHtml(letter.policy.insurer)}, from ${escapeHtml(longDay(letter.policy.startsOn))} to ${escapeHtml(longDay(letter.policy.endsOn))}. Your full table of benefits follows, in English with the signed Arabic beneath each line.</p>
    <p>Questions about your cover or this statement go to Human Resources at Head Office.</p>
  </div>
  ${chrome}
</section>
<section class="page">
  ${masthead(letter, true)}
  ${sections}
</section>
</body></html>`;
}

function letterCss(): string {
  const c = HOUSE_COLORS;
  return `
${premiumSheetCss(".page")}
${PREMIUM_IDENTITY_CSS}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: ${PREMIUM_LATIN_FONT_STACK}; color: ${c.body}; font-size: 9pt; line-height: 1.45; }
.page { page-break-after: always; }
.page:last-child { page-break-after: auto; }
[lang="ar"] { font-family: ${ARABIC_FONT_STACK}; letter-spacing: 0; }

.eyebrow { margin: 6mm 0 0; color: ${c.blue}; font-size: 7pt; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6pt; }
.h1 { margin: 2.4mm 0 0; color: ${c.deep}; line-height: 1.05; }
.h1__l { display: block; font-size: 22pt; font-weight: 300; letter-spacing: -.5pt; }
.h1__b { display: block; margin-top: 1mm; font-size: 30pt; font-weight: 700; letter-spacing: -1pt; }
.tick { display: flex; gap: 1.2mm; margin: 3.6mm 0 3.2mm; }
.tick i { display: block; border-top: 1.2pt solid ${c.blue}; width: 14mm; }
.tick i + i { border-top-color: ${c.light}; width: 3mm; }
.tick i + i + i { border-top-color: ${c.hair}; width: 1.2mm; }
.lead { margin: 0; max-width: 160mm; font-size: 10.6pt; line-height: 1.55; }

.strip { display: flex; margin-top: 6mm; border-top: .7pt solid ${c.deep}; border-bottom: .4pt solid ${c.hair}; }
.cell { flex: 1 1 0; padding: 2.6mm 3.2mm 2.8mm; }
.cell + .cell { border-left: .4pt solid ${c.hair}; }
.cell--total { border-left: .7pt solid ${c.deep} !important; }
.k { margin: 0; color: ${c.blue}; font-size: 6.6pt; font-weight: 700; text-transform: uppercase; letter-spacing: 1.4pt; }
.v { margin: 1.4mm 0 0; color: ${c.ink}; font-size: 13pt; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.2pt; }
.v--grade { color: ${c.deep}; font-size: 20pt; line-height: 1; font-weight: 300; }
.cell--total .v { color: ${c.deep}; }

.sh { margin: 7mm 0 2.2mm; color: ${c.deep}; font-size: 7.4pt; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6pt; }
.sh-ar { font-size: 8.4pt; text-transform: none; color: ${c.blue}; font-weight: 600; }

table { width: 100%; table-layout: fixed; border-collapse: collapse; }
th { text-align: left; color: ${c.deep}; font-size: 6.6pt; font-weight: 700; text-transform: uppercase; letter-spacing: 1pt;
     border-top: .7pt solid ${c.deep}; border-bottom: .4pt solid ${c.hair}; padding: 1.8mm 2mm; }
td { padding: 2mm; vertical-align: top; border-bottom: .4pt solid ${c.hair}; word-wrap: break-word; overflow-wrap: anywhere; }
tbody tr:nth-child(even) td { background: ${c.tint}; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.mid { text-align: center; }
.sub { display: block; margin-top: .6mm; color: ${c.muted}; font-size: 7.4pt; }
.pay td { font-size: 9pt; }
.pay tfoot td { border-top: .7pt solid ${c.deep}; border-bottom: .4pt solid ${c.hair}; color: ${c.deep}; font-weight: 700; font-size: 9.6pt; padding: 2.4mm 2mm; }

.facts { display: grid; grid-template-columns: repeat(3, 1fr); border-top: .7pt solid ${c.deep}; }
.fact { padding: 2mm 2.4mm 2.2mm 0; border-bottom: .4pt solid ${c.hair}; }
.fact .v { font-size: 9pt; font-weight: 600; letter-spacing: 0; }
.fact .ar { margin-top: .4mm; font-weight: 400; }

.callout { margin-top: 6mm; border-left: 1.2pt solid ${c.blue}; padding: .4mm 0 .4mm 4mm; }
.callout p { margin: 0 0 1.6mm; font-size: 8.6pt; }
.callout p:last-child { margin-bottom: 0; color: ${c.muted}; }

.en { display: block; }
.en--b { font-weight: 700; color: ${c.ink}; }
.ar { display: block; margin-top: .5mm; color: ${c.muted}; font-size: 8pt; line-height: 1.45; }
.part { display: block; margin-top: 1.2mm; padding-left: 2.4mm; border-left: .6pt solid ${c.hair}; }
.tob { page-break-inside: auto; }
.tob tr { page-break-inside: avoid; }
.tob td { font-size: 8pt; padding: 1.6mm 2mm; }
.pm-band + .sh { margin-top: 5mm; }
`;
}
