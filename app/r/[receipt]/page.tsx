import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { isGuestFallbackAccess } from "@/lib/auth/page-access-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadDirectOrderReceiptScan } from "@/lib/direct-orders/receipt-books";

export const dynamic = "force-dynamic";

// A receipt's link carries its printed code. It must never be indexed or cached.
export const metadata: Metadata = {
  robots: { follow: false, index: false, nocache: true },
  title: "Receipt check — Phoenix",
};

/**
 * The page a receipt sheet's QR opens (owner, 28 Nov 2026: "كيو ار كود يقرا فينيكس ده اساسي" — the scan
 * asks for a sign-in; signed in, it opens the order; not signed in, it shows nothing).
 *
 * OUTSIDE BOTH SHELLS, like /print, because a manager on the portal and Finance on the admin shell scan
 * the same paper. A used receipt goes straight to `/admin/direct-orders/<id>`, which sends a portal user
 * to the portal's twin and answers only for an order the reader may already see.
 */
export default async function ReceiptScanPage({ params }: { params: Promise<{ receipt: string }> }) {
  const { receipt } = await params;
  const access = await resolveAccessContextFromPage();
  if (isGuestFallbackAccess(access)) {
    redirect(`/login?returnUrl=${encodeURIComponent(`/r/${receipt}`)}`);
  }
  const scan = await loadDirectOrderReceiptScan(access, receipt);
  const { outcome } = scan;
  if (outcome.kind === "used" && outcome.requestId) {
    redirect(`/admin/direct-orders/${encodeURIComponent(outcome.requestId)}`);
  }

  const verdict =
    outcome.kind === "not_genuine"
      ? { tone: "border-rose-700 text-rose-800", title: "Not a Sato Pharma receipt", body: "This code does not match any page of the Sato Pharma receipt books. Do not accept this paper; give it to Finance." }
      : outcome.kind === "unused"
        ? { tone: "border-emerald-700 text-emerald-800", title: `Genuine receipt ${scan.serialLabel}`, body: `A real page of book ${outcome.bookNo}. It has not been entered on any order yet.` }
        : outcome.kind === "voided"
          ? { tone: "border-rose-700 text-rose-800", title: `Receipt ${scan.serialLabel} was cancelled`, body: `A real page of book ${outcome.bookNo}, cancelled by Finance${outcome.reason ? `: ${outcome.reason}` : ""}. It proves no order.` }
          : { tone: "border-amber-700 text-amber-800", title: `Receipt ${scan.serialLabel} is used`, body: `A real page of book ${outcome.bookNo}, already entered on an order that is no longer on file. Give it to Finance.` };

  return (
    <main className="mx-auto max-w-xl bg-white px-4 py-8 text-slate-900">
      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">Sato Pharma · Receipt check</p>
      <section className={`mt-3 border-l-4 bg-white px-4 py-3 ${verdict.tone}`}>
        <h1 className="break-words text-[20px] font-black leading-tight">{verdict.title}</h1>
        <p className="mt-2 break-words text-[14px] text-slate-700">{verdict.body}</p>
        {scan.holderName ? <p className="mt-2 break-words text-[13px] text-slate-700">Book holder: {scan.holderName}</p> : null}
      </section>
      <p className="mt-4 text-[12px] text-slate-500">
        A photocopy carries the same code as its original. Only the receipt entered on Phoenix proves an order.
      </p>
      <Link className="mt-6 inline-block text-[13px] font-bold text-slate-900 underline" href="/">
        Back to Phoenix
      </Link>
    </main>
  );
}
