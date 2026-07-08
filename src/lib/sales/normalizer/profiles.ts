import type { DistributorProfile } from "@/lib/sales/normalizer/types";

// Code-defined raw-distributor profiles. Each profile says which raw column holds what, for the
// distributor's own untouched export. Headers are ALIGNED to the unified Headers Mapping sheet — the
// REQUIRED fields (brick-lookup key, product NAME, qty, and date where the channel is dated) use the
// single CANONICAL header from that sheet, so strict validation rejects any renamed/missing required
// column ("no deviation"). productNameColumns/productCodeColumns drive name-first resolution; the
// legacy productColumns mirror = [...code, ...name] (kept for other consumers).
//
// NOTE for owner: a few headers were realigned to the Headers Mapping and drifted aliases on REQUIRED
// fields were dropped (so a deviating sheet is rejected). Confirm the real exports use these exact
// headers — notably MEC date = "شهر" (was "تاريخ المستند"); SF/SF-T qty="qty" (dropped "SOLDQTY") and
// product name="ITEMNAME" (dropped "OLDITEM"); IS/IS-S/IS-T qty="Quantity" (dropped "Total Quantity")
// and customer="Client Code" (dropped "Main Customer Code"); PS-T product name="Item Description"
// (dropped "Material"/"Short Description"); CP is brick-name-keyed (no customer code).
//
// territoryColumns confirmed by the owner 2026-07-07 for every distributor: this is the brick/area
// text the sheet itself carries, and resolveBrick() now tries it BEFORE the stored customer→brick map
// (see resolvers.ts). Customer code is the fallback for rows where the territory text is blank or not
// yet a known alias — never the other way around.

export const RAW_DISTRIBUTOR_PROFILES: DistributorProfile[] = [
  {
    distributorCode: "PS",
    distributorName: "overseas",
    productCodeColumns: ["Mat. Code"],
    productNameColumns: ["Mat. Desc."],
    productColumns: ["Mat. Code", "Mat. Desc."],
    qtyColumns: ["Qty"],
    valueColumns: ["Value"],
    valueSource: "recompute",
    dateColumns: ["Invoice Date"],
    dateFormat: "day-first",
    customerCodeColumns: ["Customer"],
    customerNameColumns: ["Customer Name"],
    customerAddressColumns: ["Customer Address"],
    territoryColumns: ["Sal. Dist. Desc."],
    discountColumns: ["Discount%"],
    fingerprintColumns: ["Mat. Code", "Mat. Desc.", "Invoice Date"],
  },
  {
    distributorCode: "IS",
    distributorName: "Ibn sina",
    productCodeColumns: ["Item Code"],
    productNameColumns: ["Item Name"],
    productColumns: ["Item Code", "Item Name"],
    qtyColumns: ["Quantity"],
    valueColumns: ["Net"],
    valueSource: "recompute",
    dateColumns: ["Date"],
    dateFormat: "day-first",
    customerCodeColumns: ["Client Code"],
    customerNameColumns: ["Client Name"],
    customerAddressColumns: ["Address_En", "Address_Ar"],
    territoryColumns: ["Brick Name"],
    discountColumns: ["Discount%"],
    fingerprintColumns: ["Item Code", "Client Code", "Quantity"],
  },
  {
    distributorCode: "IS-S",
    distributorName: "Ibn Sina-Sato",
    productCodeColumns: ["Item Code"],
    productNameColumns: ["Item Name"],
    productColumns: ["Item Code", "Item Name"],
    qtyColumns: ["Quantity"],
    valueColumns: ["Net"],
    valueSource: "recompute",
    dateColumns: ["Date"],
    dateFormat: "day-first",
    customerCodeColumns: ["Client Code"],
    customerNameColumns: ["Client Name"],
    customerAddressColumns: ["Address_En", "Address_Ar"],
    territoryColumns: ["Brick Name"],
    discountColumns: ["Discount%"],
    fingerprintColumns: ["Item Code", "Client Code"],
  },
  {
    distributorCode: "SF",
    distributorName: "sofico",
    productCodeColumns: ["ITEMIDE"],
    productNameColumns: ["ITEMNAME"],
    productColumns: ["ITEMIDE", "ITEMNAME"],
    qtyColumns: ["qty"],
    valueColumns: ["TOTALVALUE"],
    valueSource: "recompute",
    dateColumns: ["BILLINGDATE"],
    dateFormat: "day-first",
    customerCodeColumns: ["ORDERACCOUNT"],
    customerNameColumns: ["CUSTOMERNAME0013"],
    customerAddressColumns: ["ADDRESSSHIP"],
    territoryColumns: ["bricks"],
    discountColumns: ["Discount%"],
    fingerprintColumns: ["ITEMIDE", "BILLINGDATE", "ORDERACCOUNT"],
  },
  {
    distributorCode: "EG",
    distributorName: "EGD",
    productCodeColumns: ["ITEM_CODE"],
    productNameColumns: ["ITEM_NAME"],
    productColumns: ["ITEM_CODE", "ITEM_NAME"],
    qtyColumns: ["QTY_INVOICE"],
    valueColumns: ["TOTAL_VALUE_INVOICE"],
    valueSource: "recompute",
    dateColumns: ["INVOICE_DATE"],
    dateFormat: "day-first",
    customerCodeColumns: ["CUSTOMER_CODE"],
    customerNameColumns: ["CUSTOMER_NAME"],
    customerAddressColumns: ["CUSTOMER_ADDRESS"],
    territoryColumns: ["MRKZ_N"],
    discountColumns: ["Discount%"],
    fingerprintColumns: ["ITEM_CODE", "QTY_INVOICE", "INVOICE_DATE"],
  },
  {
    distributorCode: "EP",
    distributorName: "epda",
    productCodeColumns: ["ProductSerial"],
    productNameColumns: ["ProductName"],
    productColumns: ["ProductSerial", "ProductName"],
    qtyColumns: ["SalesOrReturnQty"],
    valueColumns: ["LineValue"],
    valueSource: "recompute",
    dateColumns: ["Transdate"],
    dateFormat: "day-first",
    customerCodeColumns: ["AccountSerial"],
    customerNameColumns: ["AccountName"],
    customerAddressColumns: ["Address"],
    territoryColumns: ["TerritoryName"],
    discountColumns: ["Discount%"],
    fingerprintColumns: ["ProductSerial", "SalesOrReturnQty", "AccountSerial"],
  },
  {
    // EPDA-BULK (ساتو قطاع الجملة — SATO's own wholesale ERP export). RAW sheet: product resolved from
    // the alias dictionary by class_code/class_name (name-first, like the other distributors); geography
    // resolved from cust_name (territory-text alias) FIRST, falling back to the customer→brick map by
    // cust_code when cust_name doesn't resolve; value RECOMPUTED (no value column). Free goods
    // (is_bonus=1) are skipped. Sales only — no returns.
    // NOTE: dates are US-style MONTH-FIRST (M/D/YYYY, e.g. 5/31/2026 = 31 May) — unlike every other
    // (day-first) Egyptian distributor — so dateFormat is pinned to "month-first".
    distributorCode: "EP-BK",
    distributorName: "EPDA-BULK",
    productCodeColumns: ["class_code"],
    productNameColumns: ["class_name"],
    productColumns: ["class_code", "class_name"],
    qtyColumns: ["qnt"],
    valueColumns: [],
    valueSource: "recompute",
    dateColumns: ["inv_date"],
    dateFormat: "month-first",
    customerCodeColumns: ["cust_code"],
    customerNameColumns: ["cust_name"],
    customerAddressColumns: ["cust_address"],
    territoryColumns: ["cust_name"],
    bonusColumns: ["is_bonus"],
    fingerprintColumns: ["class_code", "cust_code", "qnt"],
  },
  {
    // EPDA-Pharmacies (ساتو قطاع الصيدليات — SATO's own pharmacies/retail ERP export). BYTE-IDENTICAL
    // layout to EPDA-BULK (EP-BK): same SATO ERP columns, month-first dates (M/D/YYYY), sales only,
    // free goods (is_bonus=1) skipped, value recomputed, products via the alias dictionary, geography
    // resolved from cust_name FIRST, falling back to the customer→brick map (cust_code). A SEPARATE
    // code so wholesale vs pharmacy sales stay split. Because the headers are identical to EP-BK the
    // two can't be auto-distinguished — the operator picks the right sector from the dropdown
    // (recognition then runs against the picked profile).
    distributorCode: "EP-PHS",
    distributorName: "EPDA-Pharmacies",
    productCodeColumns: ["class_code"],
    productNameColumns: ["class_name"],
    productColumns: ["class_code", "class_name"],
    qtyColumns: ["qnt"],
    valueColumns: [],
    valueSource: "recompute",
    dateColumns: ["inv_date"],
    dateFormat: "month-first",
    customerCodeColumns: ["cust_code"],
    customerNameColumns: ["cust_name"],
    customerAddressColumns: ["cust_address"],
    territoryColumns: ["cust_name"],
    bonusColumns: ["is_bonus"],
    fingerprintColumns: ["class_code", "cust_code", "qnt"],
  },
  {
    distributorCode: "MC",
    distributorName: "mec",
    // Headers Mapping: item code = "دالصنف", item name = "إسم الصنف", date = "شهر".
    productCodeColumns: ["دالصنف"],
    productNameColumns: ["إسم الصنف"],
    productColumns: ["دالصنف", "إسم الصنف"],
    qtyColumns: ["الكمية"],
    valueColumns: ["الصافى"],
    valueSource: "recompute",
    dateColumns: ["شهر"],
    dateFormat: "day-first",
    customerCodeColumns: ["كود"],
    customerNameColumns: ["العميل"],
    customerAddressColumns: ["address"],
    territoryColumns: ["المنطقة"],
    discountColumns: ["خصم"],
    fingerprintColumns: ["دالصنف", "شهر", "الكمية"],
  },
  {
    distributorCode: "RM",
    distributorName: "ramco",
    productCodeColumns: ["ك.صنف"],
    productNameColumns: ["صنف"],
    productColumns: ["ك.صنف", "صنف"],
    qtyColumns: ["صافى كمية"],
    valueColumns: ["صافى البيع"],
    valueSource: "recompute",
    dateColumns: ["تاريخ"],
    // RM uses real Excel Date objects — dateFormat is a safety net for any text-date rows.
    dateFormat: "day-first",
    customerCodeColumns: ["كود"],
    customerNameColumns: ["عميل"],
    customerAddressColumns: ["عنوان"],
    territoryColumns: ["منطقة"],
    discountColumns: ["خصم%"],
    fingerprintColumns: ["ك.صنف", "صافى كمية", "تاريخ"],
  },
  {
    // ChemiPharm pivot: brick keyed by the AREA NAME ("Area name A"), product NAME = "Attribute",
    // units = "Value". No customer code and no date column (period comes from the upload picker).
    distributorCode: "CP",
    distributorName: "chimipharm",
    productCodeColumns: [],
    productNameColumns: ["Attribute"],
    productColumns: ["Attribute"],
    qtyColumns: ["Value"],
    valueColumns: [],
    valueSource: "recompute",
    dateColumns: [],
    territoryColumns: ["Area name A"],
    discountColumns: ["Discount%"],
    fingerprintColumns: ["Area name A", "Attribute"],
  },
  {
    // EGD Branch (hospital/transfer export). Product identity is the English NAME; code kept as fallback.
    // Every row MUST have TO_COMPANY_ENTITY_CODE — a blank is a hard data error, not a summary row.
    // Date is NOT required: some months' export carries a "CARD_DATE" column, others (from 2026-06)
    // carry none at all — like CP, EG-BR's period comes from the upload picker either way, so a sheet
    // with or without CARD_DATE is recognized the same (an extra CARD_DATE column is simply ignored).
    distributorCode: "EG-BR",
    distributorName: "EGD Branch",
    productCodeColumns: ["ITEM_CODE"],
    productNameColumns: ["ITEM_NAME_ENG"],
    productColumns: ["ITEM_CODE", "ITEM_NAME_ENG"],
    qtyColumns: ["QTY"],
    valueColumns: ["VALUE"],
    valueSource: "recompute",
    dateColumns: [],
    customerCodeColumns: ["TO_COMPANY_ENTITY_CODE"],
    customerNameColumns: ["TO_COMPANY_ENTITY_NAME"],
    customerAddressColumns: ["TO_COMPANY_ENTITY_NAME3"],
    territoryColumns: ["FROM_COMPANY_ENTITY_NAME"],
    discountColumns: ["Discount%"],
    blankCustomerBehavior: "error",
    fingerprintColumns: ["TO_COMPANY_ENTITY_CODE", "CARD_DATE", "ITEM_NAME_ENG"],
  },
  {
    // Ibn Sina Tender: same raw layout as IS.
    distributorCode: "IS-T",
    distributorName: "Ibn Sina Tender",
    productCodeColumns: ["Item Code"],
    productNameColumns: ["Item Name"],
    productColumns: ["Item Code", "Item Name"],
    qtyColumns: ["Quantity"],
    valueColumns: ["Net"],
    valueSource: "recompute",
    dateColumns: ["Date"],
    dateFormat: "day-first",
    customerCodeColumns: ["Client Code"],
    customerNameColumns: ["Client Name"],
    customerAddressColumns: ["Address_En", "Address_Ar"],
    territoryColumns: ["Brick Name"],
    discountColumns: ["Discount%"],
    fingerprintColumns: ["Item Code", "Client Code", "Quantity"],
  },
  {
    // Overseas Tender: SAP-style export. Headers Mapping: product NAME = "Item Description" (no code col).
    distributorCode: "PS-T",
    distributorName: "Overseas Tender",
    productCodeColumns: [],
    productNameColumns: ["Item Description"],
    productColumns: ["Item Description"],
    qtyColumns: ["Sales\\Returns Qty"],
    valueColumns: ["Sales\\Returns Value"],
    valueSource: "recompute",
    dateColumns: ["Delivery Date"],
    dateFormat: "day-first",
    customerCodeColumns: ["Ship-To"],
    customerNameColumns: ["Ship-to party"],
    customerAddressColumns: ["address"],
    territoryColumns: ["Ship-to party"],
    discountColumns: ["Discount%"],
    fingerprintColumns: ["Item Description", "Ship-To", "Delivery Date"],
  },
  {
    // Ramco Tender: same raw Arabic layout as RM.
    distributorCode: "RM-T",
    distributorName: "Ramco Tender",
    productCodeColumns: ["ك.صنف"],
    productNameColumns: ["صنف"],
    productColumns: ["ك.صنف", "صنف"],
    qtyColumns: ["صافى كمية"],
    valueColumns: ["صافى البيع"],
    valueSource: "recompute",
    dateColumns: ["تاريخ"],
    dateFormat: "day-first",
    customerCodeColumns: ["كود"],
    customerNameColumns: ["عميل"],
    customerAddressColumns: ["عنوان"],
    territoryColumns: ["منطقة"],
    discountColumns: ["خصم%"],
    fingerprintColumns: ["ك.صنف", "صافى كمية", "تاريخ"],
  },
  {
    // Sofico Tender: same raw layout as SF.
    distributorCode: "SF-T",
    distributorName: "Sofico Tender",
    productCodeColumns: ["ITEMIDE"],
    productNameColumns: ["ITEMNAME"],
    productColumns: ["ITEMIDE", "ITEMNAME"],
    qtyColumns: ["qty"],
    valueColumns: ["TOTALVALUE"],
    valueSource: "recompute",
    dateColumns: ["BILLINGDATE"],
    dateFormat: "day-first",
    customerCodeColumns: ["ORDERACCOUNT"],
    customerNameColumns: ["CUSTOMERNAME0013"],
    customerAddressColumns: ["CUSTOMERNAME00133"],
    territoryColumns: ["ADDRESSSHIP"],
    discountColumns: ["Discount%"],
    fingerprintColumns: ["ITEMIDE", "BILLINGDATE", "ORDERACCOUNT"],
  },
  {
    // EGD Hospital (مركز تموين مستشفيات): EGD-style hospital/tender export.
    distributorCode: "EG-HOS",
    distributorName: "EGD Hospital",
    productCodeColumns: ["ITEM_CODE"],
    productNameColumns: ["ITEM_NAME"],
    productColumns: ["ITEM_CODE", "ITEM_NAME"],
    qtyColumns: ["QTY_INVOICE"],
    valueColumns: ["TOTAL_VALUE_INVOICE"],
    valueSource: "recompute",
    dateColumns: ["INVOICE_DATE"],
    dateFormat: "day-first",
    customerCodeColumns: ["CUSTOMER_CODE"],
    customerNameColumns: ["CUSTOMER_NAME"],
    customerAddressColumns: ["CUSTOMER_NAME3"],
    territoryColumns: ["MRKZ_N"],
    discountColumns: ["Discount%"],
    fingerprintColumns: ["ITEM_CODE", "QTY_INVOICE", "INVOICE_DATE"],
  },
];

const BY_CODE = new Map(RAW_DISTRIBUTOR_PROFILES.map((p) => [p.distributorCode.toUpperCase(), p]));

export function rawProfileForDistributor(distributorCode: string): DistributorProfile | null {
  return BY_CODE.get(String(distributorCode ?? "").trim().toUpperCase()) ?? null;
}
