// Sales Operations Module — the distributor dictionary.
//
// This is the code form of the unified "Headers Mapping" sheet: one entry per distributor row.
// Columns A–I are the raw headers to pull; column J/K are name/code; column L is the brick lookup.
// Only the lookup keys + qty are mandatory; optional columns (name/address/product code) are kept
// where the sheet provides them (display + product fallback) and omitted otherwise.
//
// Rules baked in here (see types.ts): product is resolved NAME-first (code is fallback only);
// brick is resolved per `brickLookup`; value = qty × factory price (no discount, bonus excluded).

import type { DistributorTemplate } from "@/lib/sales-operations/types";

export const DISTRIBUTOR_TEMPLATES: DistributorTemplate[] = [
  {
    code: "PS",
    name: "Overseas",
    brickLookup: "customer-code",
    customerCodeHeaders: ["Customer"],
    customerNameHeaders: ["Customer Name"],
    customerAddressHeaders: ["Customer Address"],
    productNameHeaders: ["Mat. Desc."],
    productCodeHeaders: ["Mat. Code"],
    qtyHeaders: ["Qty"],
    dateHeaders: ["Invoice Date"],
    dateFormat: "day-first",
    fingerprintHeaders: ["Mat. Code", "Sal. District", "Customer"],
    hasDateColumn: true,
  },
  {
    // ChemiPharm — pivot export. NO customer code: brick is looked up FROM the brick/area NAME.
    // NO product code: product resolved by NAME only. NO date: period from the upload picker.
    code: "CP",
    name: "ChemiPharm",
    brickLookup: "brick-name",
    brickNameHeaders: ["Area name A"],
    productNameHeaders: ["Attribute"],
    qtyHeaders: ["Value"],
    fingerprintHeaders: ["Area name A", "Attribute"],
    regionOnly: true, // "Area name A" resolves to an AREA, so CP rows have no brick by design
    hasDateColumn: false,
  },
  {
    code: "EG",
    name: "EGD",
    brickLookup: "customer-code",
    customerCodeHeaders: ["CUSTOMER_CODE"],
    customerNameHeaders: ["CUSTOMER_NAME"],
    customerAddressHeaders: ["CUSTOMER_ADDRESS"],
    productNameHeaders: ["ITEM_NAME"],
    productCodeHeaders: ["ITEM_CODE"],
    qtyHeaders: ["QTY_INVOICE"],
    dateHeaders: ["INVOICE_DATE"],
    dateFormat: "day-first",
    fingerprintHeaders: ["CUSTOMER_CODE", "ITEM_CODE", "QTY_INVOICE"],
    hasDateColumn: true,
  },
  {
    // EGD Branch — entity-transfer layout. Product NAME only (codes are opaque here).
    // A blank customer code is a HARD data error (routed to exceptions), not a skip.
    code: "EG-BR",
    name: "EGD Branch",
    brickLookup: "customer-code",
    customerCodeHeaders: ["TO_COMPANY_ENTITY_CODE"],
    customerNameHeaders: ["TO_COMPANY_ENTITY_NAME"],
    productNameHeaders: ["ITEM_NAME_ENG"],
    qtyHeaders: ["QTY"],
    dateHeaders: ["CARD_DATE"],
    dateFormat: "day-first",
    blankCustomerBehavior: "error",
    fingerprintHeaders: ["TO_COMPANY_ENTITY_CODE", "FROM_COMPANY_ENTITY_CODE", "ITEM_NAME_ENG"],
    hasDateColumn: true,
  },
  {
    // EPDA — single template (owner decision: do not split into Pharmacies/Bulk).
    code: "EP",
    name: "EPDA",
    brickLookup: "customer-code",
    customerCodeHeaders: ["AccountSerial"],
    customerNameHeaders: ["AccountName"],
    customerAddressHeaders: ["Address"],
    productNameHeaders: ["ProductName"],
    productCodeHeaders: ["ProductSerial"],
    qtyHeaders: ["SalesOrReturnQty"],
    dateHeaders: ["Transdate"],
    dateFormat: "day-first",
    fingerprintHeaders: ["AccountSerial", "ProductSerial", "SalesOrReturnQty"],
    hasDateColumn: true,
  },
  {
    code: "IS",
    name: "Ibnsina",
    brickLookup: "customer-code",
    customerCodeHeaders: ["Client Code"],
    customerNameHeaders: ["Client Name"],
    customerAddressHeaders: ["Address_En"],
    productNameHeaders: ["Item Name"],
    productCodeHeaders: ["Item Code"],
    qtyHeaders: ["Quantity"],
    dateHeaders: ["Date"],
    dateFormat: "day-first",
    fingerprintHeaders: ["Client Code", "Item Code", "Quantity"],
    hasDateColumn: true,
  },
  {
    // MEC — Arabic headers. Date column is "شهر" per the sheet (the old template's
    // "تاريخ المستند" is kept as a secondary fallback for real files that use it).
    code: "MC",
    name: "MEC",
    brickLookup: "customer-code",
    customerCodeHeaders: ["كود"],
    customerNameHeaders: ["العميل"],
    customerAddressHeaders: ["address"],
    productNameHeaders: ["إسم الصنف"],
    productCodeHeaders: ["دالصنف", "كود الصنف"],
    qtyHeaders: ["الكمية"],
    dateHeaders: ["شهر", "تاريخ المستند"],
    dateFormat: "day-first",
    fingerprintHeaders: ["كود", "دالصنف", "الكمية"],
    hasDateColumn: true,
  },
  {
    code: "IS-S",
    name: "Ibnsina Sato",
    brickLookup: "customer-code",
    customerCodeHeaders: ["Client Code"],
    customerNameHeaders: ["Client Name"],
    customerAddressHeaders: ["Address_En"],
    productNameHeaders: ["Item Name"],
    productCodeHeaders: ["Item Code"],
    qtyHeaders: ["Quantity"],
    dateHeaders: ["Date"],
    dateFormat: "day-first",
    fingerprintHeaders: ["Client Code", "Item Code", "Brick Name"],
    hasDateColumn: true,
  },
  {
    code: "RM",
    name: "Ramco",
    brickLookup: "customer-code",
    customerCodeHeaders: ["كود"],
    customerNameHeaders: ["عميل"],
    customerAddressHeaders: ["عنوان"],
    productNameHeaders: ["صنف"],
    productCodeHeaders: ["ك.صنف"],
    qtyHeaders: ["صافى كمية"],
    dateHeaders: ["تاريخ"],
    dateFormat: "day-first",
    fingerprintHeaders: ["ك.صنف", "صافى كمية", "تاريخ"],
    hasDateColumn: true,
  },
  {
    code: "SF",
    name: "sofico",
    brickLookup: "customer-code",
    customerCodeHeaders: ["ORDERACCOUNT"],
    customerNameHeaders: ["CUSTOMERNAME0013", "CUSTOMERNAME"],
    customerAddressHeaders: ["ADDRESSSHIP"],
    productNameHeaders: ["ITEMNAME"],
    productCodeHeaders: ["ITEMIDE", "OLDITEM"],
    qtyHeaders: ["qty"],
    dateHeaders: ["BILLINGDATE"],
    dateFormat: "day-first",
    fingerprintHeaders: ["ORDERACCOUNT", "ITEMIDE", "BILLINGDATE"],
    hasDateColumn: true,
  },
  {
    code: "IS-T",
    name: "Ibnsina Tender",
    brickLookup: "customer-code",
    customerCodeHeaders: ["Client Code"],
    customerNameHeaders: ["Client Name"],
    customerAddressHeaders: ["Address_En"],
    productNameHeaders: ["Item Name"],
    productCodeHeaders: ["Item Code"],
    qtyHeaders: ["Quantity"],
    dateHeaders: ["Date"],
    dateFormat: "day-first",
    fingerprintHeaders: ["Client Code", "Item Code", "Quantity"],
    hasDateColumn: true,
  },
  {
    // Overseas Tender — SAP delivery layout. NO product code in the sheet: product by NAME.
    code: "PS-T",
    name: "Overseas Tender",
    brickLookup: "customer-code",
    customerCodeHeaders: ["Ship-To"],
    customerNameHeaders: ["Ship-to party"],
    customerAddressHeaders: ["address"],
    productNameHeaders: ["Item Description", "Short Description"],
    qtyHeaders: ["Sales\\Returns Qty"],
    dateHeaders: ["Delivery Date"],
    dateFormat: "day-first",
    fingerprintHeaders: ["Ship-To", "Delivery Date", "Item Description"],
    hasDateColumn: true,
  },
  {
    code: "RM-T",
    name: "Ramco Tender",
    brickLookup: "customer-code",
    customerCodeHeaders: ["كود"],
    customerNameHeaders: ["عميل"],
    customerAddressHeaders: ["عنوان"],
    productNameHeaders: ["صنف"],
    productCodeHeaders: ["ك.صنف"],
    qtyHeaders: ["صافى كمية"],
    dateHeaders: ["تاريخ"],
    dateFormat: "day-first",
    fingerprintHeaders: ["ك.صنف", "صافى كمية", "تاريخ"],
    hasDateColumn: true,
  },
  {
    code: "SF-T",
    name: "sofico Tender",
    brickLookup: "customer-code",
    customerCodeHeaders: ["ORDERACCOUNT"],
    customerNameHeaders: ["CUSTOMERNAME0013", "CUSTOMERNAME"],
    customerAddressHeaders: ["ADDRESSSHIP"],
    productNameHeaders: ["ITEMNAME"],
    productCodeHeaders: ["ITEMIDE", "OLDITEM"],
    qtyHeaders: ["qty"],
    dateHeaders: ["BILLINGDATE"],
    dateFormat: "day-first",
    fingerprintHeaders: ["ORDERACCOUNT", "ITEMIDE", "BILLINGDATE"],
    hasDateColumn: true,
  },
  {
    code: "EG-HOS",
    name: "EGD Hospital",
    brickLookup: "customer-code",
    customerCodeHeaders: ["CUSTOMER_CODE"],
    customerNameHeaders: ["CUSTOMER_NAME"],
    customerAddressHeaders: ["CUSTOMER_ADDRESS"],
    productNameHeaders: ["ITEM_NAME"],
    productCodeHeaders: ["ITEM_CODE"],
    qtyHeaders: ["QTY_INVOICE"],
    dateHeaders: ["INVOICE_DATE"],
    dateFormat: "day-first",
    fingerprintHeaders: ["CUSTOMER_CODE", "ITEM_CODE", "QTY_INVOICE"],
    hasDateColumn: true,
  },
  {
    // Office — pivot of product NAME + total units, no geography. Units are allocated to bricks by
    // contribution share (handled by the office allocator, not the row resolver). No date column.
    code: "Office",
    name: "Office",
    brickLookup: "office-allocation",
    productNameHeaders: ["Row Labels"],
    qtyHeaders: ["Sum of المبيعات", "Sum of Sales"],
    fingerprintHeaders: ["Row Labels"],
    hasDateColumn: false,
  },
];

const BY_CODE = new Map(DISTRIBUTOR_TEMPLATES.map((t) => [t.code.trim().toUpperCase(), t]));

// Look up a distributor template by code (case-insensitive; tolerant of "EG HOS" vs "EG-HOS").
export function getDistributorTemplate(code: string): DistributorTemplate | undefined {
  const key = String(code ?? "").trim().toUpperCase();
  return BY_CODE.get(key) ?? BY_CODE.get(key.replace(/\s+/g, "-"));
}

export function listDistributorTemplates(): DistributorTemplate[] {
  return DISTRIBUTOR_TEMPLATES;
}
