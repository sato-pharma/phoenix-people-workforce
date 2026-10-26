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
  // Ibn Sina "Lacto" supplier feed (code IS-L) — the third Ibn Sina channel, by the owner's ruling of
  // 2026-10-13. Ibn Sina exports one workbook PER SUPPLIER, so LACTO MISR EG (supplier 111399, the
  // four Lacto SKUs) arrives separately from the Sato (PAS) one. Byte-identical column set to IS-S,
  // so this profile mirrors it exactly; the separate code is what keeps the two feeds' weeks from
  // de-cumulating against each other (weekly/distributors.ts). No monthly Lacto sheet has arrived
  // yet — this is the open lane for the first one, not a description of existing data.
  {
    distributorCode: "IS-L",
    distributorName: "Ibn Sina-Lacto",
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
    // EGD's sheet has worn THREE layouts, and all three are read (owner, 2026-10-26, choosing "teach
    // the old layouts" for the 2024 history). The FIRST name in each list is today's export and the
    // one a refusal names; the rest are the older ones:
    //   • today (May 2024 on):  QTY_INVOICE · INVOICE_DATE · TOTAL_VALUE_INVOICE · MRKZ_N
    //   • Jan–Feb 2024:         "net qty" · DATE_TRANS · VALUE · DISTRICT_NAME
    //   • the cut-down summary EGD sent for some 2024 months: "Sales" for the units, and NO date, no
    //     value and no item code. It carries no month of its own, so the Source Normalizer takes it
    //     only with the month picked on screen (recognize.ts, undatedPeriod); value is recomputed
    //     from the Phoenix price either way, so a missing value column loses nothing.
    // Measured on his 13 EGD workbooks: no sheet carries two of these names for one field, so an
    // older name can never shadow today's.
    distributorCode: "EG",
    distributorName: "EGD",
    productCodeColumns: ["ITEM_CODE"],
    productNameColumns: ["ITEM_NAME"],
    productColumns: ["ITEM_CODE", "ITEM_NAME"],
    qtyColumns: ["QTY_INVOICE", "net qty", "Sales"],
    valueColumns: ["TOTAL_VALUE_INVOICE", "VALUE"],
    valueSource: "recompute",
    dateColumns: ["INVOICE_DATE", "DATE_TRANS"],
    dateFormat: "day-first",
    customerCodeColumns: ["CUSTOMER_CODE"],
    customerNameColumns: ["CUSTOMER_NAME"],
    customerAddressColumns: ["CUSTOMER_ADDRESS"],
    territoryColumns: ["MRKZ_N", "DISTRICT_NAME"],
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
    // "شهر" is a month written YYYYMM ("202607"). It decides the row's month (owner, 2026-09-18),
    // not "تاريخ المستند", even where the two differ, and it carries no day — see periodFrom.
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
    // El Qema (QM) — registered by the owner 2026-09-07. An Arabic-headed invoice-LINE export: one
    // row per invoice line, carrying the customer, the product, the quantity and the discount.
    //
    // NO TERRITORY COLUMN EXISTS. All 28 columns of the owner's August 2026 file were read and not
    // one carries a brick, an area or a governorate. `territoryColumns` is therefore deliberately
    // absent, and every row resolves through the stored customer -> brick map on ACCOUNT_ID alone —
    // the fallback the other profiles only reach when their territory text is blank. That map must
    // hold El Qema's customers before an import can place a single unit; until it does the rows land
    // UNMAPPED rather than in the wrong area, which is the safe direction.
    //
    // `الصنف E` IS NOT THE ENGLISH NAME OF `الصنف` — it names a DIFFERENT PRODUCT, on every row.
    // Measured 2026-09-07: code 5754 is Lacto 1 Advance in `الصنف` and «ريسبينزو اقراص» in `الصنف E`
    // (40 rows); code 743 is Lacto 2 Advance against «اوتوكورت نقط» (24 rows). Mapping on `الصنف E`
    // would file Lacto as Respinzo and Otocort. `الصنف` agrees with `رقم الصنف` on all 64 rows and is
    // the only trustworthy product identity in this export.
    //
    // `المندوب` IS NOT A REP: 22 rows say «تشغيله», 18 «تشغيله واحده», 20 are blank and only 4 carry
    // a person's name. It is an operations note, so nothing reads it.
    //
    // ACCOUNT_ID is a clean customer key — 30 names to 30 ids on the August file, a perfect 1:1 with
    // no name holding two ids and no id holding two names. `س مستهلك` and `BARCODE_U` are entirely
    // empty and are ignored.
    //
    // valueSource "recompute" is measured, not assumed: the sheet's own arithmetic is
    // `اجمالى جمهور = qty x 330` then `الاجمالى = جمهور x (1 - خصم 1)`, exact on all 64 rows.
    distributorCode: "QM",
    distributorName: "El Qema",
    productCodeColumns: ["رقم الصنف"],
    productNameColumns: ["الصنف"],
    productColumns: ["رقم الصنف", "الصنف"],
    qtyColumns: ["الكمية"],
    valueColumns: ["الاجمالى"],
    valueSource: "recompute",
    dateColumns: ["التاريخ"],
    dateFormat: "day-first",
    customerCodeColumns: ["ACCOUNT_ID"],
    customerNameColumns: ["الاسم"],
    // Owner, 2026-10-05: "map by id if not available fall back to name". The September export
    // (`exclusive - El Qema9.xlsx`) carried the ACCOUNT_ID and رقم الصنف HEADERS but left every data
    // cell blank — only the customer NAME (`الاسم`) and product NAME (`الصنف`) were filled — so all 70
    // real sales rows were skipped as locationless footers. With this flag, a blank ACCOUNT_ID falls
    // back to `الاسم` as the customer key: the row resolves through the same customer→brick crosswalk
    // and, until a name is mapped, surfaces as a mappable customer unknown rather than being dropped.
    customerKeyNameFallback: true,
    // NO discountColumns, and that is a decision — owner, 2026-09-07: "you only consider the qty and
    // the city". `خصم 1` holds a real 17-22% and mapping it looked obviously right. At the time it
    // would have CREDITED THE REP FEWER UNITS THAN THE CUSTOMER BOUGHT, because `discount` then fed
    // `effective_units = qty x (1 - discount)`. Measured on their August file: 8,768 packs sold,
    // 6,995.92 credited — 1,772 packs, about 478,000 EGP at factory price, reaching nobody. The owner
    // struck that factor out of the entire system later the same day, so the column can no longer cost
    // anyone units — but it is still not mapped, because he asked for qty and the city and nothing else.
    //
    // El Qema is the ONLY distributor whose file carries a discount at all: Overseas, Ibn Sina-Sato,
    // EPDA and Direct all store zero on every August row. So reading it would have penalised the one
    // distributor transparent enough to report it, and left the closing comparing unlike with unlike.
    // The 64 rows already imported were corrected in production the same day (pre-image in
    // `qema_discount_backup_20260907`).
    //
    // NO bonusColumns either, and that is also a decision — 2026-09-18. `بونص` is a bonus COUNT that
    // sits beside the paid `الكمية` on the same invoice line; it is not a flag. The engine reads
    // `bonusColumns` as EPDA's `is_bonus`, a flag marking the WHOLE line as free goods, and drops any
    // row whose cell is not 0. Mapped here, a line of 120 paid packs carrying 12 bonus packs would lose
    // all 120 — and a bonus of 1 looks exactly like the flag. The owner's rule is the opposite: "we neglect
    // the bonus and the value in any distributor sheet, we take the units and multiply by factory"
    // (2026-09-07). The bonus is ignored, never used to drop paid units. It had not yet fired: every
    // row of the one El Qema batch (August, 64 rows, 8,768 packs) carries `بونص` = 0, and 0 were
    // ignored. The cell is still kept in `raw_row`, as every heading the file sends is.
    fingerprintColumns: ["رقم الفاتورة", "اجمالى جمهور", "ACCOUNT_ID"],
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
