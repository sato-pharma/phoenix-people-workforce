import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { ReceiptPrintButton } from "@/components/direct-orders/receipt-print-button";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { canManageDirectOrderReceiptBooks } from "@/lib/direct-orders/finance-authority";
import { loadDirectOrderReceiptPrint, type DirectOrderReceiptOriginal } from "@/lib/direct-orders/receipt-books";
import { cairoDate, cairoDateTime, utcDate } from "@/lib/format/cairo-datetime";
import { isUuid } from "@/lib/http/uuid";

export const dynamic = "force-dynamic";

// The page carries a customer's signed and stamped page. It must never be indexed or cached.
export const metadata: Metadata = {
  robots: { follow: false, index: false, nocache: true },
  title: "Verified receipt — Phoenix",
};

function money(value: number): string {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 0 })} EGP`;
}

function Original({ title, original }: { title: string; original: DirectOrderReceiptOriginal | null }) {
  return (
    <section className="break-inside-avoid border border-slate-400 p-4">
      <h2 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-900">{title}</h2>
      {original ? (
        <>
          <p className="mt-1 text-[12px] text-slate-700">
            Entered on Phoenix{original.enteredByName ? ` by ${original.enteredByName}` : ""}
            {original.enteredAt ? ` on ${cairoDateTime(original.enteredAt)}` : ""}.
          </p>
          {original.photoUrl && !original.photoIsPdf ? (
            // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived storage URL printed as it is
            <img alt={title} className="mt-3 max-h-[120mm] w-full object-contain" src={original.photoUrl} />
          ) : original.photoUrl ? (
            <p className="mt-3 text-[12px] font-bold text-slate-900">Entered as a PDF file — print it from the order&apos;s page.</p>
          ) : (
            <p className="mt-3 text-[12px] font-bold text-rose-700">The photo could not be opened just now. Reload the page.</p>
          )}
        </>
      ) : (
        <p className="mt-1 text-[12px] font-bold text-slate-900">Not entered on Phoenix yet.</p>
      )}
    </section>
  );
}

/**
 * The verified print of an order's delivery receipt (owner, 27 Nov 2026). A photographed page shows
 * «مُصوَّر — غير صالح» by design, so a photocopy is never proof; this page is — both originals as they
 * were entered on Phoenix, with who entered each and when, and who printed it.
 *
 * DELIBERATELY OUTSIDE BOTH SHELLS, under /print, so the paper holds the receipt and nothing else. The
 * cost is that the shell's gate is gone, so it is repeated here, and it is the SAME gate as the Receipt
 * Books desk: Finance or the Administrator only. The loader refuses everyone else as well.
 */
export default async function DirectOrderReceiptPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const access = await resolveAuthenticatedPageAccess();
  if (!canManageDirectOrderReceiptBooks(access)) redirect("/admin/direct-orders");
  const print = await loadDirectOrderReceiptPrint(access, id);
  if (!print) notFound();

  return (
    <main className="mx-auto max-w-[190mm] bg-white px-4 py-6 text-slate-900 print:px-0 print:py-0">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b-2 border-slate-900 pb-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">Sato Pharma · Finance</p>
          <h1 className="text-[20px] font-black leading-tight">Delivery receipt {print.serialLabel} — verified on Phoenix</h1>
          <p className="text-[12px] text-slate-600">Book {print.bookNo} · two originals and a copy</p>
        </div>
        <ReceiptPrintButton />
      </header>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-[12px] sm:grid-cols-2">
        <div>
          <dt className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">Customer</dt>
          <dd className="break-words font-bold" dir="auto">{print.pharmacyName}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">Manager in custody</dt>
          <dd className="break-words font-bold">{print.requesterName}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">Goods</dt>
          <dd className="break-words">
            {print.productName} · {money(print.salesValue)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">Approved · left the warehouse</dt>
          <dd>
            {cairoDate(print.approvedAt)} · {print.exitDate ? utcDate(print.exitDate) : "not recorded yet"}
          </dd>
        </div>
      </dl>

      <div className="mt-5 space-y-4">
        <Original original={print.custody} title="Original 1 — the custody page the manager signed" />
        <Original original={print.delivery} title="Original 2 — signed and stamped by the customer" />
      </div>

      <footer className="mt-5 border-t border-slate-400 pt-2 text-[10px] text-slate-600">
        Printed from Phoenix on {cairoDateTime(print.printedAt)}
        {print.printedByName ? ` by ${print.printedByName}` : ""}. The paper originals stay in the receipt book and with the manager; the carbon copy is the
        customer&apos;s. A photocopy of a receipt page is never proof — it prints marked as a copy.
      </footer>
    </main>
  );
}
