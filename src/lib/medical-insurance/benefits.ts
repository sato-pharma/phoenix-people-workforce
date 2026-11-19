// ─────────────────────────────────────────────────────────────────────────────────────────────
// The Libano-Suisse table of benefits for plans A, B and C, taken from the signed and stamped table (renewal
// offer Rev 1.3, 5 November 2026, section 6 "جدول المنافع", pages 7 to 9 of 11). The issued policy 50048950
// (22 November 2026) carries the same table on its pages 31 to 33, line for line. Each line carries the signed
// Arabic beside its English, so a reader can always check the translation against what was signed.
//
// It carries NO COST: the annual limit and the caps are what the insurer covers, never what the company pays.
// So it is shown to both HR seats as well as the Super Admin (owner, 2026-11-17: "You and the HR seats").
// Pure and free of Supabase, so a client component imports it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import type { MedicalInsuranceCategory } from "./cost";

export type BenefitText = { en: string; ar: string };

export type BenefitLine = {
  benefit: BenefitText;
  /** The part of a benefit the line is about, e.g. "Chronic medicines" under "Prescribed medicines". */
  part?: BenefitText;
  coverage: BenefitText;
  /** The member's share as the table prints it ("20%"); null where the table prints none. */
  memberShare: string | null;
};

export type BenefitSection = { key: string; title: BenefitText; lines: BenefitLine[] };

export type PlanBenefits = {
  category: MedicalInsuranceCategory;
  /** The annual limit per person, in Egyptian pounds. */
  annualLimit: number;
  facts: Array<{ label: BenefitText; value: BenefitText }>;
  sections: BenefitSection[];
};

export const TABLE_OF_BENEFITS_SOURCE = "Libano-Suisse table of benefits, policy 50048950 issued 22 November 2026 (the same table as renewal offer Rev 1.3, signed and stamped)";

const egp = (amount: number) => amount.toLocaleString("en-US");

const FULL: BenefitText = { ar: "تغطية كاملة", en: "Fully covered" };
const NOT_COVERED: BenefitText = { ar: "غير مغطى", en: "Not covered" };

type PlanTerms = {
  category: MedicalInsuranceCategory;
  annualLimit: number;
  network: string;
  room: BenefitText;
  outPatientShare: string;
  /** Plans B and C cap chronic medicines; plan A covers them in full. */
  chronicMedicinesCap: number | null;
  /** Plan A only: organ transplant and congenital defects are covered. */
  transplantAndCongenital: boolean;
};

function planBenefits(terms: PlanTerms): PlanBenefits {
  const { annualLimit, category, chronicMedicinesCap, outPatientShare, transplantAndCongenital } = terms;

  const prescribed: BenefitText = { ar: "الأدوية الموصوفة", en: "Prescribed medicines" };
  const medicines: BenefitLine[] =
    chronicMedicinesCap === null
      ? [{ benefit: prescribed, coverage: FULL, memberShare: "20%" }]
      : [
          { benefit: prescribed, coverage: FULL, memberShare: "20%", part: { ar: "الأدوية العادية", en: "Regular medicines" } },
          {
            benefit: prescribed,
            coverage: { ar: `مغطاه حتى ${egp(chronicMedicinesCap)} جنيه`, en: `Covered up to EGP ${egp(chronicMedicinesCap)}` },
            memberShare: "20%",
            part: { ar: "الأدوية المزمنة", en: "Chronic medicines" },
          },
        ];

  const preExisting: BenefitText = { ar: "الأمراض المزمنة والسابقة على تاريخ التعاقد", en: "Chronic and pre-existing conditions (from before the contract date)" };
  const preExistingLines: BenefitLine[] =
    chronicMedicinesCap === null
      ? [{ benefit: preExisting, coverage: { ar: `مغطاه بحد أقصى ${egp(annualLimit)} جنيه للفرد`, en: `Covered up to EGP ${egp(annualLimit)} per person` }, memberShare: "0%" }]
      : [
          {
            benefit: preExisting,
            coverage: {
              ar: `مغطاه حتى الحد الأقصى (ماعدا الأدوية المزمنة مغطاه حتى ${egp(chronicMedicinesCap)} جنيه للفرد)`,
              en: `Covered up to the annual limit (except chronic medicines, covered up to EGP ${egp(chronicMedicinesCap)} per person)`,
            },
            memberShare: "0%",
            part: { ar: "للمشتركين القدامى", en: "Existing members" },
          },
          {
            benefit: preExisting,
            coverage: { ar: `مغطاه حتى ${egp(chronicMedicinesCap)} جنيه للفرد`, en: `Covered up to EGP ${egp(chronicMedicinesCap)} per person` },
            memberShare: "0%",
            part: { ar: "للمشتركين الجدد", en: "New members" },
          },
        ];

  const pregnancy: BenefitText = { ar: "الحمل والولادة", en: "Pregnancy and childbirth" };

  return {
    annualLimit,
    category,
    facts: [
      { label: { ar: "النطاق الجغرافي للتغطية الطبية", en: "Where cover applies" }, value: { ar: "داخل جمهورية مصر العربية", en: "Inside the Arab Republic of Egypt" } },
      { label: { ar: "الحد الأقصى للتغطية الطبية للفرد سنويا", en: "Annual limit per person" }, value: { ar: egp(annualLimit), en: `EGP ${egp(annualLimit)}` } },
      { label: { ar: "الشبكة الطبية", en: "Medical network" }, value: { ar: terms.network, en: terms.network } },
      { label: { ar: "درجة الإقامة", en: "Hospital room" }, value: terms.room },
      { label: { ar: "نوع الخدمة الطبية", en: "Type of service" }, value: { ar: "خدمة مباشرة", en: "Direct service (the insurer pays the provider)" } },
    ],
    sections: [
      {
        key: "in-patient",
        lines: [
          { benefit: { ar: "تغطية العلاج الداخلي بالمستشفيات", en: "In-patient treatment in hospital" }, coverage: FULL, memberShare: "0%" },
          { benefit: { ar: "النقل بسيارة الإسعاف", en: "Ambulance transport" }, coverage: FULL, memberShare: "0%" },
          {
            benefit: { ar: "الخطر السلبي للحروب", en: "Passive war risk" },
            coverage: {
              ar: "مغطى حتى 34,000 جنيه مصري أو للحد الأقصى للتغطية إذا كانت أقل من 34,000 جنيه مصري",
              en: "Covered up to EGP 34,000, or up to the annual limit if that is less than EGP 34,000",
            },
            memberShare: "0%",
          },
        ],
        title: { ar: "العلاج الداخلي بالمستشفيات", en: "In-patient benefits" },
      },
      {
        key: "out-patient",
        lines: [
          { benefit: { ar: "زيارات الطبيب", en: "Doctor visits" }, coverage: FULL, memberShare: outPatientShare },
          ...medicines,
          { benefit: { ar: "التحاليل - الأشعة", en: "Lab tests and radiology" }, coverage: FULL, memberShare: outPatientShare },
          { benefit: { ar: "العلاج الطبيعي", en: "Physiotherapy" }, coverage: FULL, memberShare: outPatientShare },
        ],
        title: { ar: "العلاج في العيادات الخارجية", en: "Out-patient benefits" },
      },
      {
        key: "additional",
        lines: [
          ...preExistingLines,
          {
            benefit: { ar: "الأسنان", en: "Dental" },
            coverage: {
              ar: "بحد أقصى 1,000 جنيه: خلع بسيط وجراحي - حشو عادي - علاج لثة - أشعة X - علاج جذور - أدوية أسنان - تركيبات",
              en: "Up to EGP 1,000: simple and surgical extraction, ordinary fillings, gum treatment, X-rays, root canal treatment, dental medicines, dentures and crowns",
            },
            memberShare: "20%",
          },
          { benefit: { ar: "البصريات", en: "Optical" }, coverage: NOT_COVERED, memberShare: "0%" },
          { benefit: { ar: "التهاب الكبد الوبائي (B&C)", en: "Hepatitis B and C" }, coverage: FULL, memberShare: "0%" },
          { benefit: { ar: "التركيبات والدعامات", en: "Implants and stents" }, coverage: FULL, memberShare: "0%" },
          { benefit: { ar: "عملية زراعة الأعضاء (تكلفة الجراحة فقط)", en: "Organ transplant (the surgery only)" }, coverage: transplantAndCongenital ? FULL : NOT_COVERED, memberShare: "0%" },
          { benefit: { ar: "العيوب الخلقية", en: "Congenital defects" }, coverage: transplantAndCongenital ? FULL : NOT_COVERED, memberShare: "0%" },
          { benefit: pregnancy, coverage: NOT_COVERED, memberShare: "0%", part: { ar: "ولادة قيصرية", en: "Caesarean delivery" } },
          { benefit: pregnancy, coverage: NOT_COVERED, memberShare: "0%", part: { ar: "ولادة طبيعية", en: "Natural delivery" } },
          { benefit: pregnancy, coverage: NOT_COVERED, memberShare: "0%", part: { ar: "إجهاض قانوني", en: "Legal abortion" } },
        ],
        title: { ar: "تغطيات إضافية", en: "Additional benefits" },
      },
      {
        key: "reimbursement",
        lines: [
          {
            benefit: { ar: "جميع الخدمات", en: "All services" },
            coverage: { ar: "جميع الخدمات مغطاه 80% بحسب أسعار التعاقد مع مستشفى كليوباترا", en: "Covered at 80% of the prices agreed with Cleopatra Hospital" },
            memberShare: null,
          },
          {
            benefit: { ar: "كشف الطبيب", en: "Doctor consultation" },
            coverage: { ar: "كشف الطبيب مغطى 80% بحد أقصى 250 جنيه مصري للزيارة", en: "Covered at 80%, up to EGP 250 a visit" },
            memberShare: null,
          },
          {
            benefit: { ar: "دورة الاسترداد النقدي", en: "Cash refund time" },
            coverage: { ar: "15 يوم عمل", en: "15 working days" },
            memberShare: null,
            part: { ar: "العلاج الداخلي بالمستشفى", en: "In-patient treatment" },
          },
          {
            benefit: { ar: "دورة الاسترداد النقدي", en: "Cash refund time" },
            coverage: { ar: "10 يوم عمل", en: "10 working days" },
            memberShare: null,
            part: { ar: "العلاج الخارجي", en: "Out-patient treatment" },
          },
        ],
        title: { ar: "العلاج خارج الشبكة الطبية", en: "Treatment outside the network (reimbursement)" },
      },
    ],
  };
}

export const LIBANO_TABLE_OF_BENEFITS: Record<MedicalInsuranceCategory, PlanBenefits> = {
  A: planBenefits({
    annualLimit: 150_000,
    category: "A",
    chronicMedicinesCap: null,
    network: "Full Network-004",
    outPatientShare: "10%",
    room: { ar: "غرفة مفردة", en: "Single room" },
    transplantAndCongenital: true,
  }),
  B: planBenefits({
    annualLimit: 75_000,
    category: "B",
    chronicMedicinesCap: 50_000,
    network: "Full Network-003",
    outPatientShare: "25%",
    room: { ar: "غرفة مزدوجة", en: "Shared room" },
    transplantAndCongenital: false,
  }),
  C: planBenefits({
    annualLimit: 50_000,
    category: "C",
    chronicMedicinesCap: 25_000,
    network: "Full Network-003",
    outPatientShare: "25%",
    room: { ar: "غرفة مزدوجة", en: "Shared room" },
    transplantAndCongenital: false,
  }),
};
