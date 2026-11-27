"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { adminPanelClassName, adminPanelDepthClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import { WarehouseExitField } from "@/components/direct-orders/direct-order-receipt-panel";
import { FormField } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonDangerClassName,
  phxButtonGhostClassName,
  phxFieldClassName,
  phxFormErrorClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import type { DirectOrderReceiptRegister, ReceiptRegisterBook, ReceiptRegisterOrder } from "@/lib/direct-orders/receipt-books";
import { cairoDate, cairoDateTime, utcDate } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<ReceiptRegisterBook["status"], string> = {
  in_store: "With Finance",
  issued: "With the manager",
  returned: "Returned",
  lost: "Lost",
};

function money(value: number): string {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 0 })} EGP`;
}

async function post(body: Record<string, unknown>): Promise<string> {
  const res = await fetch("/api/direct-orders/receipt-books", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
  if (!res.ok || !data.success) throw new Error(data.message || "Could not update the receipt book.");
  return data.message ?? "Saved.";
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={adminPanelClassName}>
      <header className={cn(adminPanelHeaderClassName, "px-4 py-2.5")}>
        <h2 className="text-phx-xs font-black uppercase tracking-wider text-white">{title}</h2>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Where one order stands on its two originals, in a line. */
function originalsLine(order: ReceiptRegisterOrder): string {
  const custody = order.custodyEntered ? "Original 1 in" : `Original 1 due ${utcDate(order.custodyDue)}`;
  const delivery = order.deliveryEntered ? "Original 2 in" : `Original 2 due ${utcDate(order.deliveryDue)}`;
  const late = order.lateness ? ` · ${order.lateness.daysLate} day${order.lateness.daysLate === 1 ? "" : "s"} late` : "";
  return `Left the warehouse ${utcDate(order.exitDate)} · ${custody} · ${delivery}${late}`;
}

/**
 * Finance's Receipt Books desk (owner, 26 Nov 2026: "Finance"; 27 Nov: two originals and a copy).
 * Approved orders waiting for Finance to record the day the goods left the warehouse (nothing is due
 * until then), orders with an original still to enter — Original 1 within 3 days of the exit, Original
 * 2 within 6 working days, Friday off — orders raised by someone holding no book (owner, 27 Nov
 * 2026: "Flag them"), the orders asked to stand without a receipt (the CEO decides each, owner,
 * 27 Nov 2026), the sixteen books and who holds each, the spoiled-page cancel, and the receipts
 * entered. Every action is checked again on the server.
 */
export function ReceiptBooksDesk({ register }: { register: DirectOrderReceiptRegister }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spareHolder, setSpareHolder] = useState<Record<number, string>>({});
  const [lostBook, setLostBook] = useState<number | null>(null);
  const [lostNote, setLostNote] = useState("");
  const [voidSerial, setVoidSerial] = useState("");
  const [voidReason, setVoidReason] = useState("");

  async function act(key: string, body: Record<string, unknown>, after?: () => void) {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      setMessage(await post(body));
      after?.();
      router.refresh();
    } catch (actError) {
      setError(actError instanceof Error ? actError.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const overdue = register.missing.filter((order) => order.standing === "overdue");
  const waiting = register.missing.filter((order) => order.standing === "waiting");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

  return (
    <div className="space-y-5">
      {message ? <p className={`border border-slate-300 bg-white px-3 py-2 text-phx-sm font-bold text-slate-800 ${adminPanelDepthClassName}`}>{message}</p> : null}
      {error ? <p className={phxFormErrorClassName}>{error}</p> : null}

      <Panel title={`Waiting for the warehouse exit — ${register.awaitingExit.length}`}>
        {register.awaitingExit.length === 0 ? (
          <p className="text-phx-sm text-slate-600">Every approved order has its warehouse exit day recorded.</p>
        ) : (
          <>
            <p className="mb-2 text-phx-sm text-slate-600">
              Record the day the goods left the warehouse. Both due dates count from the next day: Original 1 within {register.custodyDueDays} days, Original 2 within{" "}
              {register.deliveryDueWorkingDays} working days, Friday off. Until it is recorded, nothing on the order is late.
            </p>
            <ul className="divide-y divide-slate-200">
              {register.awaitingExit.map((order) => (
                <li className="grid grid-cols-1 gap-2 py-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)] lg:gap-3" key={order.requestId}>
                  <div className="min-w-0">
                    <Link className="break-words text-phx-sm font-bold text-slate-900 underline-offset-2 hover:underline" href={`/admin/direct-orders/${order.requestId}?from=/admin/direct-orders/receipts`}>
                      {order.pharmacyName}
                    </Link>
                    <p className="break-words text-phx-xs text-slate-500">
                      {order.productName} · {money(order.salesValue)} · {order.requesterName}
                    </p>
                  </div>
                  <p className="text-phx-sm text-slate-600">
                    Approved {cairoDate(order.decidedAt)} · {order.days} day{order.days === 1 ? "" : "s"}
                    {order.custodyEntered ? " · Original 1 in" : ""}
                  </p>
                  <WarehouseExitField exitDate={null} requestId={order.requestId} todayCairo={today} />
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      <Panel title={`An original still to enter — ${overdue.length} late, ${waiting.length} not yet due`}>
        {register.missing.length === 0 ? (
          <p className="text-phx-sm text-slate-600">
            Every order whose goods left the warehouse has both originals on Phoenix. Orders approved before the manager received a book never owe one.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200">
            {register.missing.map((order) => (
              <li className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-3" key={order.requestId}>
                <div className="min-w-0">
                  <Link className="break-words text-phx-sm font-bold text-slate-900 underline-offset-2 hover:underline" href={`/admin/direct-orders/${order.requestId}?from=/admin/direct-orders/receipts`}>
                    {order.pharmacyName}
                  </Link>
                  <p className="break-words text-phx-xs text-slate-500">
                    {order.productName} · {money(order.salesValue)}
                  </p>
                </div>
                <p className="break-words text-phx-sm text-slate-700">{order.requesterName}</p>
                <p className={cn("text-phx-sm", order.standing === "overdue" ? "font-bold text-rose-700" : "text-slate-600")}>{originalsLine(order)}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={`Approved with no receipt book — ${register.noBook.length}`}>
        {register.noBook.length === 0 ? (
          <p className="text-phx-sm text-slate-600">
            Every order approved since the first book was handed out was raised by a manager holding a book.
          </p>
        ) : (
          <>
            <p className="mb-2 text-phx-sm text-slate-600">
              Raised by someone who held no receipt book on the day it was approved, so no signed page stands behind it. A book handed to them later can still prove it.
            </p>
            <ul className="divide-y divide-slate-200">
              {register.noBook.map((order) => (
                <li className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-3" key={order.requestId}>
                  <div className="min-w-0">
                    <Link className="break-words text-phx-sm font-bold text-slate-900 underline-offset-2 hover:underline" href={`/admin/direct-orders/${order.requestId}?from=/admin/direct-orders/receipts`}>
                      {order.pharmacyName}
                    </Link>
                    <p className="break-words text-phx-xs text-slate-500">
                      {order.productName} · {money(order.salesValue)}
                    </p>
                  </div>
                  <p className="break-words text-phx-sm text-slate-700">{order.requesterName}</p>
                  <p className="text-phx-sm font-bold text-rose-700">
                    Approved {cairoDate(order.decidedAt)} · {order.days} day{order.days === 1 ? "" : "s"}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      <Panel
        title={`Without a receipt — ${register.withoutReceipt.filter((order) => order.status === "pending").length} waiting for the CEO, ${register.withoutReceipt.filter((order) => order.status === "approved").length} approved`}
      >
        {register.withoutReceipt.length === 0 ? (
          <p className="text-phx-sm text-slate-600">
            No order has been asked to stand without a delivery receipt. Only the CEO can approve one: ask from the order&apos;s own page, with the reason.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200">
            {register.withoutReceipt.map((order) => (
              <li className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)] sm:gap-3" key={order.requestId}>
                <div className="min-w-0">
                  <Link className="break-words text-phx-sm font-bold text-slate-900 underline-offset-2 hover:underline" href={`/admin/direct-orders/${order.requestId}?from=/admin/direct-orders/receipts`}>
                    {order.pharmacyName}
                  </Link>
                  <p className="break-words text-phx-xs text-slate-500">
                    {order.productName} · {money(order.salesValue)} · {order.requesterName}
                  </p>
                </div>
                <p className="break-words text-phx-sm text-slate-700" dir="auto">
                  {order.reason}
                </p>
                <p className={cn("text-phx-sm", order.status === "pending" ? "font-bold text-amber-700" : "text-slate-600")}>
                  {order.status === "pending"
                    ? `Waiting for the CEO since ${cairoDate(order.askedAt)}`
                    : `Approved${order.decidedByName ? ` by ${order.decidedByName}` : ""}${order.waiverDecidedAt ? ` ${cairoDate(order.waiverDecidedAt)}` : ""}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="The receipt books">
        <ul className="divide-y divide-slate-200">
          {register.books.map((book) => {
            const key = `book-${book.bookNo}`;
            return (
              <li className="grid grid-cols-1 gap-2 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)] lg:gap-3" key={book.bookNo}>
                <div>
                  <p className="text-phx-sm font-black text-slate-900">Book {book.bookNo}</p>
                  <p className="text-phx-xs tabular-nums text-slate-500">{book.rangeLabel}</p>
                </div>
                <div className="min-w-0">
                  <p className="break-words text-phx-sm text-slate-800">
                    {book.holderName ?? book.printedHolderName ?? "Spare — no name printed"}
                  </p>
                  <p className="text-phx-xs text-slate-500">
                    {STATUS_LABEL[book.status]}
                    {book.issuedAt ? ` · handed out ${cairoDate(book.issuedAt)}` : ""}
                    {book.closedAt ? ` · ${book.status === "lost" ? "lost" : "returned"} ${cairoDate(book.closedAt)}` : ""}
                  </p>
                </div>
                <div>
                  <p className="text-phx-sm tabular-nums text-slate-700">
                    {book.used} used · {book.voided} cancelled · {book.unused} unused
                  </p>
                  {book.owing > 0 ? (
                    <p className="text-phx-xs font-bold text-rose-700">
                      {book.owing} approved order{book.owing === 1 ? "" : "s"} still {book.owing === 1 ? "owes" : "owe"} a receipt from it
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  {book.status === "in_store" && book.printedHolderHrId ? (
                    <button className={phxButtonGhostClassName} disabled={busy !== null} onClick={() => void act(key, { action: "issue", bookNo: book.bookNo, holderHrId: book.printedHolderHrId })} type="button">
                      Hand to {book.printedHolderName}
                    </button>
                  ) : null}
                  {book.status === "in_store" && !book.printedHolderHrId ? (
                    <div className="flex w-full flex-wrap items-end gap-2">
                      <FormField className="min-w-0 flex-1" label="Hand the spare to" htmlFor={`spare-${book.bookNo}`}>
                        <select
                          className={phxSelectClassName}
                          id={`spare-${book.bookNo}`}
                          onChange={(event) => setSpareHolder((current) => ({ ...current, [book.bookNo]: event.target.value }))}
                          value={spareHolder[book.bookNo] ?? ""}
                        >
                          <option value="">Choose a District Manager</option>
                          {register.holderOptions.map((option) => (
                            <option key={option.hrId} value={option.hrId}>
                              {option.name}
                            </option>
                          ))}
                        </select>
                      </FormField>
                      <button
                        className={phxButtonGhostClassName}
                        disabled={busy !== null || !spareHolder[book.bookNo]}
                        onClick={() => void act(key, { action: "issue", bookNo: book.bookNo, holderHrId: spareHolder[book.bookNo] })}
                        type="button"
                      >
                        Hand out
                      </button>
                    </div>
                  ) : null}
                  {book.status === "issued" ? (
                    <button className={phxButtonGhostClassName} disabled={busy !== null} onClick={() => void act(key, { action: "return", bookNo: book.bookNo })} type="button">
                      Returned to Finance
                    </button>
                  ) : null}
                  {(book.status === "issued" || book.status === "in_store") && lostBook !== book.bookNo ? (
                    <button className={phxButtonGhostClassName} disabled={busy !== null} onClick={() => { setLostBook(book.bookNo); setLostNote(""); }} type="button">
                      Record lost
                    </button>
                  ) : null}
                  {lostBook === book.bookNo ? (
                    <div className="w-full space-y-2">
                      <FormField label="What happened to the book" required htmlFor={`lost-${book.bookNo}`}>
                        <input className={phxFieldClassName} id={`lost-${book.bookNo}`} onChange={(event) => setLostNote(event.target.value)} value={lostNote} />
                      </FormField>
                      <p className="text-phx-xs text-slate-500">Every unused receipt in it is cancelled, so a page from it is refused on any order.</p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          className={phxButtonDangerClassName}
                          disabled={busy !== null || lostNote.trim().length < 3}
                          onClick={() => void act(key, { action: "lost", bookNo: book.bookNo, note: lostNote }, () => setLostBook(null))}
                          type="button"
                        >
                          Record book {book.bookNo} lost
                        </button>
                        <button className={phxButtonGhostClassName} onClick={() => setLostBook(null)} type="button">
                          Keep it
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel title="Cancel a spoiled receipt">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end">
          <FormField label="Receipt number" htmlFor="void-serial">
            <input className={phxFieldClassName} id="void-serial" inputMode="numeric" onChange={(event) => setVoidSerial(event.target.value)} placeholder="000123" value={voidSerial} />
          </FormField>
          <FormField label="Why" htmlFor="void-reason">
            <input className={phxFieldClassName} id="void-reason" onChange={(event) => setVoidReason(event.target.value)} placeholder="Spoiled, all three parts kept in the book" value={voidReason} />
          </FormField>
          <button
            className={phxButtonAccentClassName}
            disabled={busy !== null || !voidSerial.trim() || voidReason.trim().length < 3}
            onClick={() => void act("void", { action: "void", serial: voidSerial, reason: voidReason }, () => { setVoidSerial(""); setVoidReason(""); })}
            type="button"
          >
            Cancel receipt
          </button>
        </div>
        <p className="mt-2 text-phx-xs text-slate-500">A receipt that already proves an order can never be cancelled.</p>
      </Panel>

      <Panel title="Receipts entered and cancelled">
        {register.recent.length === 0 ? (
          <p className="text-phx-sm text-slate-600">No receipt has been entered or cancelled yet.</p>
        ) : (
          <ul className="divide-y divide-slate-200">
            {register.recent.map((entry) => (
              <li className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] sm:gap-3" key={entry.serialLabel}>
                <p className="text-phx-sm font-black tabular-nums text-slate-900">
                  {entry.serialLabel} <span className="font-normal text-slate-500">· book {entry.bookNo}</span>
                </p>
                <p className="min-w-0 break-words text-phx-sm text-slate-700">
                  {entry.state === "used" && entry.requestId ? (
                    <>
                      <Link className="underline-offset-2 hover:underline" href={`/admin/direct-orders/${entry.requestId}?from=/admin/direct-orders/receipts`}>
                        {entry.pharmacyName ?? "Open the order"}
                      </Link>
                      <span className="text-slate-500">{entry.deliveryEntered ? " · both originals in" : " · Original 2 still to enter"}</span>
                    </>
                  ) : (
                    `Cancelled${entry.voidedReason ? ` — ${entry.voidedReason}` : ""}`
                  )}
                </p>
                <p className="text-phx-xs text-slate-500">
                  {entry.byName ?? ""}
                  {entry.at ? ` · ${cairoDateTime(entry.at)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
