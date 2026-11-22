"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";

import { prepareDirectOrderInvoiceFile, type PreparedDirectOrderInvoice } from "@/components/direct-orders/invoice-file";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { adminControlDepthClassName } from "@/components/admin/admin-design-tokens";
import { phxButtonAccentClassName } from "@/components/ui/form-tokens";

/**
 * Attach the distributor invoice to an order already sent (owner, 2026-09-14).
 *
 * The orders raised before the invoice was kept with the order reached the SFE Manager with no
 * invoice on them. The owner's answer was that the rep attaches it again — so this sits on the order
 * itself, for the requester only, while the invoice can still inform a decision. The server checks
 * all of that again; this control is the convenience, never the gate.
 */
export function AttachDirectOrderInvoice({ hasInvoice, requestId }: { hasInvoice: boolean; requestId: string }) {
  const router = useRouter();
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [invoice, setInvoice] = useState<PreparedDirectOrderInvoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(file: File | null | undefined) {
    setError(null);
    setMessage(null);
    if (!file) return;
    try {
      setInvoice(await prepareDirectOrderInvoiceFile(file));
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : "That file could not be attached.");
    }
  }

  function clear() {
    setInvoice(null);
    if (cameraRef.current) cameraRef.current.value = "";
    if (fileRef.current) fileRef.current.value = "";
  }

  async function send() {
    if (!invoice) return setError("Attach the distributor invoice.");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/direct-orders/${encodeURIComponent(requestId)}/invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceDataUrl: invoice.dataUrl }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not attach the invoice.");
      setMessage(data.message ?? "The invoice is saved with the order.");
      clear();
      router.refresh();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border border-slate-300 p-3">
      <p className="text-phx-xs font-black uppercase tracking-wider text-slate-600">
        {hasInvoice ? "Replace the invoice" : "Attach the invoice you used"}
      </p>
      <p className="mt-1 text-phx-sm text-slate-600">
        The distributor invoice for this order. Your approvers see it in full when they check the pharmacy.
      </p>
      <input
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(event) => void choose(event.target.files?.[0])}
        ref={cameraRef}
        type="file"
      />
      <input
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(event) => void choose(event.target.files?.[0])}
        ref={fileRef}
        type="file"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => cameraRef.current?.click()}
          className={`border border-slate-300 bg-white px-3 py-1.5 text-phx-sm font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400 ${adminControlDepthClassName} disabled:shadow-none`}
        >
          Photograph invoice
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className={`border border-slate-300 bg-white px-3 py-1.5 text-phx-sm font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400 ${adminControlDepthClassName} disabled:shadow-none`}
        >
          Choose file
        </button>
        <span className="text-phx-xs font-medium text-slate-400">Photo or PDF</span>
      </div>

      {invoice ? (
        <div className="mt-2 border border-l-4 border-slate-200 border-l-emerald-500 bg-white px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="break-all text-phx-sm font-bold text-emerald-900" dir="auto">
              {invoice.fileName}
            </span>
            <button type="button" onClick={clear} className="text-phx-xs font-bold text-[#08111f] underline-offset-2 hover:underline">
              Remove
            </button>
          </div>
          {invoice.isPdf ? null : (
            <ZoomablePhoto
              alt="Distributor invoice"
              caption="Distributor invoice"
              className="mt-2 w-full max-w-md border border-slate-200"
              src={invoice.dataUrl}
            />
          )}
        </div>
      ) : null}

      {message ? <p className="mt-2 text-phx-sm font-semibold text-emerald-800">{message}</p> : null}
      {error ? <p className="mt-2 text-phx-sm font-semibold text-rose-700">{error}</p> : null}

      <button
        type="button"
        onClick={() => void send()}
        disabled={busy || !invoice}
        className={cn(phxButtonAccentClassName, "mt-3 w-full justify-center py-2.5 text-phx-sm font-black uppercase tracking-wider disabled:cursor-not-allowed")}
      >
        {busy ? "Saving…" : hasInvoice ? "Replace the invoice" : "Attach the invoice"}
      </button>
    </div>
  );
}
