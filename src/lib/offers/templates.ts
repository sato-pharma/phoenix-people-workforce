export const offerTemplateKeys = [
  "regional_sales_manager",
  "district_sales_manager",
  "medical_sales_representative",
  "senior_medical_sales_representative",
] as const;

export type OfferTemplateKey = (typeof offerTemplateKeys)[number];

export type OfferTemplate = {
  basicSalary: number;
  costOfLivingAllowance: number;
  defaultReportingTo: string;
  defaultScope: string;
  internalTransportationAllowance?: number;
  label: string;
  monthlyPackage: number;
  regionalTravelExpenses?: number;
  transportationAllowance?: number;
  value: OfferTemplateKey;
};

export const offerTemplates: OfferTemplate[] = [
  {
    // Adjusted Net = Gross - CoL - Fuel
    // RSM: 45000 - 3500 - 12450 - 5000 = 24050. 70% of 24050 = 16835.
    basicSalary: 16835,
    costOfLivingAllowance: 3500,
    defaultReportingTo: "Head of Pharmaceutical Sales",
    defaultScope: "Regional sales performance, strategic execution, and team leadership",
    internalTransportationAllowance: 12450,
    label: "Regional Sales Manager",
    monthlyPackage: 45000,
    regionalTravelExpenses: 5000,
    value: "regional_sales_manager",
  },
  {
    // DSM: 34000 - 3500 - 9150 = 21350. 70% of 21350 = 14945.
    basicSalary: 14945,
    costOfLivingAllowance: 3500,
    defaultReportingTo: "National Sales Manager",
    defaultScope: "Sales performance, commercial strategy execution, and field team management",
    internalTransportationAllowance: 9150,
    label: "District Sales Manager",
    monthlyPackage: 34000,
    value: "district_sales_manager",
  },
  {
    // MR: 16000 - 2500 - 4050 = 9450. 70% of 9450 = 6615.
    basicSalary: 6615,
    costOfLivingAllowance: 2500,
    defaultReportingTo: "District Sales Manager",
    defaultScope: "Assigned territory management, sales targets, and healthcare professional relationships",
    label: "Medical Sales Representative",
    monthlyPackage: 16000,
    transportationAllowance: 4050,
    value: "medical_sales_representative",
  },
  {
    // Senior MR: 20000 - 2500 - 5250 = 12250. 70% of 12250 = 8575.
    basicSalary: 8575,
    costOfLivingAllowance: 2500,
    defaultReportingTo: "District Sales Manager",
    defaultScope: "Assigned territory management, sales targets, and healthcare professional relationships",
    label: "Senior Medical Sales Representative",
    monthlyPackage: 20000,
    transportationAllowance: 5250,
    value: "senior_medical_sales_representative",
  },
];

export function getOfferTemplate(value: string | null | undefined) {
  return offerTemplates.find((template) => template.value === value) ?? null;
}
