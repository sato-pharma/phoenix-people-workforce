import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertDirectOrderMayBeRaised,
  assertPaymentStandingAllowsFinalApproval,
  assertRequesterHasNoLateReceipts,
  classifyPharmacyPaymentStanding,
  lateReceiptRefusal,
  loadDirectOrderPaymentStandingNotice,
  owedOn,
  paymentStandingNoticeLines,
  paymentStandingVerdict,
  type PaymentStandingOrder,
} from "../src/lib/direct-orders/payment-standing.ts";
import { listLateReceiptsForRequester } from "../src/lib/direct-orders/receipt-books.ts";
import { withPostgrestStandIn, type Row, type StandIn } from "./support/postgrest-stand-in.ts";

// ─────────────────────────────────────────────────────────────────────────────
// What a pharmacy still owes, and the late delivery receipt (owner, 27 Nov 2026):
//   «حد اقصى اسبوع ولا ينفذ له اوردارات اخرى فى حاله عدم رفعه» — a receipt original past its due date
//   (counted from Finance's warehouse exit: Original 1 in 3 days, Original 2 in 6 working days) stops the
//   manager who raised the order from raising another;
//   «اى اوردر لاى عميل لم يسدد قيمه الاوردر الاول لا يتم خروج اوردر تانى له من نفس الصنف» — nothing
//   paid on an earlier order of the SAME product refuses the new one; another product is untouched;
//   part-paid, or «عميل غير ملتزم بمواعيد التسديد», means only Dr Anwar's own approval finishes it.
// ─────────────────────────────────────────────────────────────────────────────

const LACTO = "LA-ADV-1";
const IVY = "IVY-100";

function owing(overrides: Partial<PaymentStandingOrder> = {}): PaymentStandingOrder {
  return {
    requestId: "r-1",
    salesValue: 1000,
    remainingAmount: null,
    collectionDate: "2026-12-30",
    decidedAt: "2026-12-01T09:00:00.000Z",
    productCodes: [LACTO],
    productNames: ["Lacto Advanced 1"],
    ...overrides,
  };
}

function pureTests() {
  assert.equal(owedOn({ salesValue: 1000, remainingAmount: null }), 1000, "nothing recorded = the whole value owed");
  assert.equal(owedOn({ salesValue: 1000, remainingAmount: 250 }), 250);
  assert.equal(owedOn({ salesValue: 1000, remainingAmount: -3 }), 0, "an over-payment owes nothing");

  const today = "2026-12-20";
  const classify = (orders: PaymentStandingOrder[], codes = [LACTO]) => classifyPharmacyPaymentStanding({ orders, productCodes: codes, todayCairo: today });

  let s = classify([owing()]);
  assert.equal(s.unpaidSameProduct.length, 1, "the same product with nothing paid");
  assert.equal(paymentStandingVerdict(s, [LACTO]).kind, "refused", "is refused outright");
  assert.match((paymentStandingVerdict(s, [LACTO]) as { message: string }).message, /Lacto Advanced 1.*1,000 EGP.*another product can/);

  s = classify([owing()], [IVY]);
  assert.equal(s.unpaidSameProduct.length + s.partPaidSameProduct.length, 0, "another product is untouched by the same-product rule");
  assert.equal(paymentStandingVerdict(s, [IVY]).kind, "clear", "and not yet past its date, so the order is clear");

  s = classify([owing({ productCodes: ["la-adv-1 "] })]);
  assert.equal(s.unpaidSameProduct.length, 1, "a product code matches whatever its case or spacing");

  s = classify([owing({ remainingAmount: 400 })]);
  assert.equal(s.partPaidSameProduct.length, 1, "the same product part-paid");
  assert.equal(paymentStandingVerdict(s, [LACTO]).kind, "ceo_only", "needs Dr Anwar's own approval");

  s = classify([owing({ remainingAmount: 0.6 })]);
  assert.equal(paymentStandingVerdict(s, [LACTO]).kind, "clear", "a few piastres left by rounding count as paid");
  s = classify([owing({ remainingAmount: 1 })]);
  assert.equal(s.partPaidSameProduct.length, 1, "one pound still owed is a debt");

  s = classify([owing({ productCodes: [IVY], productNames: ["Ivyronc"], collectionDate: "2026-12-19" })]);
  assert.equal(s.overdue.length, 1, "owing after its collection date");
  const late = paymentStandingVerdict(s, [LACTO]);
  assert.equal(late.kind, "ceo_only", "a late payer needs Dr Anwar's own approval, whatever the product");
  assert.match((late as { message: string }).message, /not keeping to its payment dates: 1 order still owes 1,000 EGP after the date written on it/);
  s = classify([owing({ productCodes: [IVY], collectionDate: "2026-12-19" }), owing({ requestId: "r-2", productCodes: [IVY], collectionDate: "2026-12-18" })]);
  assert.match((paymentStandingVerdict(s, [LACTO]) as { message: string }).message, /2 orders still owe 2,000 EGP after the date written on them/);
  s = classify([owing({ productCodes: [IVY], collectionDate: today })]);
  assert.equal(s.overdue.length, 0, "due today is not late yet");
  s = classify([owing({ productCodes: [IVY], collectionDate: null })]);
  assert.equal(s.overdue.length, 0, "no date written is never late");

  s = classify([owing({ requestId: "r-1", remainingAmount: 400 }), owing({ requestId: "r-2", productCodes: [IVY], productNames: ["Ivyronc"], collectionDate: "2026-12-01" })]);
  const both = paymentStandingVerdict(s, [LACTO]);
  assert.equal(both.kind, "ceo_only");
  assert.match((both as { message: string }).message, /part-paid.*; and it is not keeping/, "both reasons are said");

  s = classify([owing({ remainingAmount: 0 }), owing({ requestId: "r-2", salesValue: 500, remainingAmount: 500, collectionDate: "2026-12-10" })]);
  assert.equal(paymentStandingVerdict(s, [LACTO]).kind, "refused", "nothing paid outranks everything else");
  const lines = paymentStandingNoticeLines(s, today);
  assert.deepEqual(
    lines.map((line) => [line.requestId, line.sameProduct, line.late, line.owed]),
    [["r-2", "unpaid", true, 500]],
    "an order listed for two reasons is one line; a paid one is not listed",
  );

  assert.equal(lateReceiptRefusal([]), null);
  assert.match(
    String(
      lateReceiptRefusal([
        { requestId: "a", pharmacyName: "El Shifa Pharmacy", days: 9, original: "custody" },
        { requestId: "b", pharmacyName: "El Nour Pharmacy", days: 12, original: "delivery" },
      ]),
    ),
    /^2 of your approved orders have an original receipt past its due date \(the longest overdue 12 days late: Original 2, the customer's signed and stamped page, El Nour Pharmacy\)\. Enter them first; no new order can be raised until then\.$/,
    "the manager is told which original is late (owner, 27 Nov 2026: two originals and a copy)",
  );
  assert.match(
    String(lateReceiptRefusal([{ requestId: "a", pharmacyName: "El Shifa Pharmacy", days: 1, original: "custody" }], "approver")),
    /^The manager who raised this order has 1 approved order with an original receipt past its due date \(the longest overdue 1 day late: Original 1, the custody page, El Shifa Pharmacy\)\. This order cannot be approved until it is entered\.$/,
    "the approver is told whose receipt holds the order",
  );

  // The service calls both checks where they belong: before anything is written, and at the last approval.
  const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  const submit = service.slice(service.indexOf("export async function submitDirectOrder("));
  assert.ok(
    submit.indexOf("await assertDirectOrderMayBeRaised(") > 0 && submit.indexOf("await assertDirectOrderMayBeRaised(") < submit.indexOf("autoLinkDirectOrderPharmacyCode("),
    "submitDirectOrder refuses before it repairs or writes anything",
  );
  const decide = service.slice(service.indexOf("export async function decideDirectOrder("));
  const finalGate = decide.indexOf('if (input.decision === "approve" && evaluation.isFinal) {');
  const standingGate = decide.indexOf("await assertPaymentStandingAllowsFinalApproval(");
  assert.ok(finalGate > 0 && standingGate > finalGate && standingGate < decide.indexOf("phx_apply_direct_order_decision"), "decideDirectOrder checks at the last approval, before the write");
  const receiptGate = decide.indexOf("await assertRequesterHasNoLateReceipts(request.requesterHrId)");
  assert.ok(receiptGate > finalGate && receiptGate < decide.indexOf("phx_apply_direct_order_decision"), "the late receipt is checked again at the last approval");
  const reversalSkip = decide.indexOf("if (!request.reversalOfRequestId) {");
  assert.ok(reversalSkip > finalGate && reversalSkip < receiptGate && reversalSkip < standingGate, "a reversal is never held by what the pharmacy owes or a late receipt");
  const revise = service.slice(service.indexOf("export async function reviseDirectOrder("));
  assert.ok(
    revise.indexOf("await assertDirectOrderMayBeRaised(") > 0 && revise.indexOf("await assertDirectOrderMayBeRaised(") < revise.indexOf('status: "pending_approval"'),
    "an order sent back and resubmitted meets the same refusals as a new one, before it is written",
  );
}

// ─── Behaviour, through the shared PostgREST stand-in ────────────────────────

const ORDER_A = "11111111-1111-4111-8111-111111111111";
const ORDER_B = "22222222-2222-4222-8222-222222222222";
const ORDER_USED = "33333333-3333-4333-8333-333333333333";
const PENDING = "66666666-6666-4666-8666-666666666666";

const NOW = new Date("2026-12-20T10:00:00.000Z");

function tables(): Record<string, Row[]> {
  return {
    direct_order_receipt_books: [
      { book_no: 1, first_serial: 1, last_serial: 50, printed_holder_hr_id: "AI-0001", holder_hr_id: "AI-0001", status: "issued", issued_at: "2026-12-01T08:00:00.000Z", closed_at: null },
    ],
    direct_order_receipts: [
      { serial: 9, book_no: 1, check_code: "HJ4MN5", state: "used", request_id: ORDER_USED, delivery_entered_at: "2026-12-11T09:00:00.000Z" },
    ],
    // Finance's warehouse exits: A left Thursday 10 Dec (Original 1 due 13 Dec), B on 17 Dec (due 20 Dec).
    direct_order_warehouse_exits: [
      { request_id: ORDER_A, exit_date: "2026-12-10" },
      { request_id: ORDER_B, exit_date: "2026-12-17" },
      { request_id: ORDER_USED, exit_date: "2026-12-09" },
    ],
    direct_order_no_receipt_requests: [],
    direct_order_requests: [
      // Momen's: A approved 10 Dec, B 15 Dec, the used one 9 Dec with its receipt.
      { id: ORDER_A, line: "Pedia", product_code: LACTO, requester_hr_id: "AI-0001", status: "approved", decided_at: "2026-12-10T09:00:00.000Z", reversal_of_request_id: null, pharmacy_id: "ph-1", product_name: "Lacto Advanced 1", sales_value: 1200, remaining_amount: null, collection_date: "2026-12-30" },
      { id: ORDER_B, line: "Pedia", product_code: IVY, requester_hr_id: "AI-0001", status: "approved", decided_at: "2026-12-15T09:00:00.000Z", reversal_of_request_id: null, pharmacy_id: "ph-2", product_name: "Ivyronc", sales_value: 800, remaining_amount: 300, collection_date: "2026-12-18" },
      { id: ORDER_USED, line: "Pedia", product_code: "GUA-1", requester_hr_id: "AI-0001", status: "approved", decided_at: "2026-12-09T09:00:00.000Z", reversal_of_request_id: null, pharmacy_id: "ph-1", product_name: "Guamusin", sales_value: 500, remaining_amount: 0, collection_date: "2026-12-15" },
      // The order being decided: never counted against itself.
      { id: PENDING, line: "Pedia", product_code: LACTO, requester_hr_id: "AI-0001", status: "pending_approval", decided_at: null, reversal_of_request_id: null, pharmacy_id: "ph-1", product_name: "Lacto Advanced 1", sales_value: 900, remaining_amount: null, collection_date: "2026-12-31" },
    ],
    direct_order_request_items: [
      { request_id: ORDER_A, product_code: LACTO, product_name: "Lacto Advanced 1" },
      { request_id: ORDER_B, product_code: IVY, product_name: "Ivyronc" },
      { request_id: ORDER_USED, product_code: "GUA-1", product_name: "Guamusin" },
      { request_id: PENDING, product_code: LACTO, product_name: "Lacto Advanced 1" },
    ],
    direct_order_pharmacies: [
      { id: "ph-1", pharmacy_name: "El Shifa Pharmacy" },
      { id: "ph-2", pharmacy_name: "El Nour Pharmacy" },
    ],
  };
}

async function rejectsWith(promise: Promise<unknown>, pattern: RegExp, label: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.match(String((error as Error)?.message ?? error), pattern, label);
    return true;
  });
}

const at = (iso: string) => new Date(iso);

async function behaviourTests() {
  // 1. The late original: due from the warehouse exit, the manager who raised it, and only an order owing one.
  {
    const standIn: StandIn = { tables: tables() };
    await withPostgrestStandIn(standIn, async () => {
      assert.deepEqual(await listLateReceiptsForRequester("AI-0001", at("2026-12-13T10:00:00.000Z")), [], "Original 1 on its due day is not late");
      const late = await listLateReceiptsForRequester("AI-0001", at("2026-12-14T10:00:00.000Z"));
      assert.deepEqual(
        late,
        [{ requestId: ORDER_A, pharmacyName: "El Shifa Pharmacy", days: 1, original: "custody" }],
        "the day after it is late; the order with both originals never is",
      );
      assert.deepEqual(
        (await listLateReceiptsForRequester("ai-0001", NOW)).map((o) => [o.requestId, o.days]),
        [[ORDER_A, 7]],
        "the HR id matches whatever its case; B, due today, is not late yet",
      );
      const exitB = standIn.tables.direct_order_warehouse_exits.find((row) => row.request_id === ORDER_B)!;
      standIn.tables.direct_order_warehouse_exits.splice(standIn.tables.direct_order_warehouse_exits.indexOf(exitB), 1);
      assert.deepEqual(
        (await listLateReceiptsForRequester("AI-0001", at("2027-02-01T10:00:00.000Z"))).map((o) => o.requestId),
        [ORDER_A],
        "with no exit recorded an order is never late, however long ago it was approved",
      );
      standIn.tables.direct_order_warehouse_exits.push(exitB);
      assert.deepEqual(await listLateReceiptsForRequester("PD-0012", NOW), [], "another manager is not held by Momen's receipts");

      standIn.tables.direct_order_no_receipt_requests.push({ request_id: ORDER_A, status: "pending" });
      assert.equal((await listLateReceiptsForRequester("AI-0001", at("2026-12-17T10:00:00.000Z"))).length, 1, "an ask still waiting does not lift the block");
      standIn.tables.direct_order_no_receipt_requests[0].status = "approved";
      assert.deepEqual(await listLateReceiptsForRequester("AI-0001", at("2026-12-17T10:00:00.000Z")), [], "the CEO's approval to stand without a receipt does");

      standIn.tables.direct_order_no_receipt_requests.length = 0;
      await rejectsWith(
        assertDirectOrderMayBeRaised({ requesterHrId: "AI-0001", pharmacyId: "ph-2", productCodes: ["GUA-1"], now: at("2026-12-17T10:00:00.000Z") }),
        /an original receipt past its due date.*no new order can be raised/,
        "the late manager raises no new order, for any pharmacy",
      );
      // At the last approval the same late receipt holds an order already climbing.
      await rejectsWith(
        assertRequesterHasNoLateReceipts("AI-0001", at("2026-12-17T10:00:00.000Z")),
        /^The manager who raised this order has 1 approved order .*cannot be approved until it is entered/,
        "an order raised before the receipt went late is not finished",
      );
      await assertRequesterHasNoLateReceipts("AI-0001", at("2026-12-13T10:00:00.000Z"));

      // A book Finance recorded lost: its receipts can never be entered, so they never hold the manager.
      Object.assign(standIn.tables.direct_order_receipt_books[0], { status: "lost", closed_at: "2026-12-16T08:00:00.000Z" });
      assert.deepEqual(await listLateReceiptsForRequester("AI-0001", NOW), [], "orders from a lost book are Finance's flag, not the manager's block");
      Object.assign(standIn.tables.direct_order_receipt_books[0], { status: "issued", closed_at: null });
    });
  }

  // 1b. A manager with hundreds of orders: the receipt reads go in batches, never one long address.
  {
    const standIn: StandIn = { tables: tables() };
    const many = Array.from({ length: 230 }, (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`);
    for (const [index, id] of many.entries()) {
      standIn.tables.direct_order_requests.push({ id, line: "Pedia", product_code: IVY, requester_hr_id: "AI-0001", status: "approved", decided_at: "2026-12-05T09:00:00.000Z", reversal_of_request_id: null, pharmacy_id: "ph-2", product_name: "Ivyronc", sales_value: 100, remaining_amount: 0, collection_date: "2026-12-30" });
      standIn.tables.direct_order_receipts.push({ serial: 100 + index, book_no: 1, check_code: "HJ4MN5", state: "used", request_id: id, delivery_entered_at: "2026-12-06T09:00:00.000Z" });
      standIn.tables.direct_order_warehouse_exits.push({ request_id: id, exit_date: "2026-12-05" });
    }
    const seen = await withPostgrestStandIn(standIn, async () => {
      assert.deepEqual((await listLateReceiptsForRequester("AI-0001", NOW)).map((o) => o.requestId), [ORDER_A], "every one of the 230 with both originals is seen as having them");
    });
    const receiptReads = seen.filter((entry) => entry.kind === "read" && entry.table === "direct_order_receipts");
    assert.equal(receiptReads.length, 3, "233 orders are read in three batches of at most 100");
  }

  // 2. No books handed out yet: nothing is late.
  {
    const standIn: StandIn = { tables: { ...tables(), direct_order_receipt_books: [] } };
    await withPostgrestStandIn(standIn, async () => {
      assert.deepEqual(await listLateReceiptsForRequester("AI-0001", NOW), []);
    });
  }

  // 3. The same product with nothing paid refuses the new order; another product is raised.
  {
    const standIn: StandIn = { tables: tables() };
    await withPostgrestStandIn(standIn, async () => {
      await rejectsWith(
        assertDirectOrderMayBeRaised({ requesterHrId: "PD-0012", pharmacyId: "ph-1", productCodes: [LACTO], now: NOW }),
        /has not paid anything on its earlier order of Lacto Advanced 1 \(1,200 EGP still owed\)/,
        "Lacto Advanced 1 again, with the first unpaid",
      );
      await assertDirectOrderMayBeRaised({ requesterHrId: "PD-0012", pharmacyId: "ph-1", productCodes: ["GUA-1"], now: NOW });
      await assertDirectOrderMayBeRaised({ requesterHrId: "PD-0012", pharmacyId: "ph-2", productCodes: [IVY], now: NOW });

      // An older order with no item rows is the single product on its own row.
      standIn.tables.direct_order_request_items = standIn.tables.direct_order_request_items.filter((item) => item.request_id !== ORDER_A);
      await rejectsWith(
        assertDirectOrderMayBeRaised({ requesterHrId: "PD-0012", pharmacyId: "ph-1", productCodes: [LACTO], now: NOW }),
        /has not paid anything on its earlier order of Lacto Advanced 1 \(1,200 EGP still owed\)/,
        "an unpaid order with no item rows still refuses the same product",
      );
    });
  }

  // 4. At the last approval: part-paid or late is Dr Anwar's own approval, never the Super Admin's.
  {
    const standIn: StandIn = { tables: tables() };
    await withPostgrestStandIn(standIn, async () => {
      const lateIvy = { requestId: PENDING, pharmacyId: "ph-2", productCodes: [IVY], now: NOW };
      await rejectsWith(assertPaymentStandingAllowsFinalApproval({ ...lateIvy, actorRole: "Super Admin" }), /Only Dr Anwar's own approval.*part-paid \(300 EGP still owed\).*payment dates/, "the Super Admin cannot finish it");
      await assertPaymentStandingAllowsFinalApproval({ ...lateIvy, actorRole: "CEO" });

      const unpaidLacto = { requestId: PENDING, pharmacyId: "ph-1", productCodes: [LACTO], now: NOW };
      await rejectsWith(assertPaymentStandingAllowsFinalApproval({ ...unpaidLacto, actorRole: "CEO" }), /has not paid anything/, "not even the CEO approves an unpaid product again");
      // The order being decided never counts against itself.
      standIn.tables.direct_order_requests.find((row) => row.id === PENDING)!.status = "approved";
      await rejectsWith(
        assertPaymentStandingAllowsFinalApproval({ requestId: PENDING, pharmacyId: "ph-1", productCodes: [LACTO], now: NOW, actorRole: "CEO" }),
        /1,200 EGP still owed/,
        "only the earlier order is counted, not this one's 900",
      );
      standIn.tables.direct_order_requests.find((row) => row.id === PENDING)!.status = "pending_approval";

      const notice = await loadDirectOrderPaymentStandingNotice({ requestId: PENDING, status: "pending_approval", pharmacyId: "ph-2", productCodes: [IVY], now: NOW });
      assert.ok(notice && !notice.unavailable);
      assert.equal(notice.verdict.kind, "ceo_only");
      assert.deepEqual(notice.lines.map((line) => [line.products, line.owed, line.late, line.sameProduct]), [["Ivyronc", 300, true, "part_paid"]]);
      assert.equal(await loadDirectOrderPaymentStandingNotice({ requestId: ORDER_A, status: "approved", pharmacyId: "ph-2", productCodes: [IVY], now: NOW }), null, "a decided order shows no notice");
      assert.equal(await loadDirectOrderPaymentStandingNotice({ requestId: PENDING, status: "pending_approval", pharmacyId: "ph-1", productCodes: ["GUA-1"], now: NOW }), null, "a clear pharmacy shows none");
      assert.equal(
        await loadDirectOrderPaymentStandingNotice({ requestId: PENDING, status: "pending_approval", pharmacyId: "ph-1", productCodes: [LACTO], isReversal: true, now: NOW }),
        null,
        "a reversal undoing an order shows no payment notice",
      );
    });
  }

  // 5. A failed read is said, never shown as a clear pharmacy.
  {
    const standIn: StandIn = { tables: tables(), failReads: { direct_order_requests: { status: 500, body: { message: "boom" } } } };
    await withPostgrestStandIn(standIn, async () => {
      const notice = await loadDirectOrderPaymentStandingNotice({ requestId: PENDING, status: "pending_approval", pharmacyId: "ph-2", productCodes: [IVY], now: NOW });
      assert.deepEqual(notice, { unavailable: true });
      await rejectsWith(assertPaymentStandingAllowsFinalApproval({ requestId: PENDING, pharmacyId: "ph-2", productCodes: [IVY], now: NOW, actorRole: "CEO" }), /boom/, "the gate fails closed");
    });
  }
}

export async function runDirectOrderPaymentStandingTests() {
  pureTests();
  await behaviourTests();
}
