"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import {
  DIRECT_ORDER_INVOICE_ACCEPT_ATTRIBUTE,
  DIRECT_ORDER_INVOICE_MAX_BYTES,
  directOrderInvoiceSlotLabel,
  directOrderInvoiceSlotsFullMessage,
  isDirectOrderInvoiceContentType,
  type DirectOrderInvoiceSlotCount,
} from "@/lib/direct-orders/invoice-evidence";
import {
  phxFieldClassName,
  phxLabelClassName,
} from "@/components/ui/form-tokens";

type Props = {
  pharmacyId: string;
  pharmacyName: string;
  /** The held order this invoice belongs to. The server refuses an invoice with no order behind it. */
  requestId: string;
  /** The rep's own open invoice slots, read on the server when the page loaded. */
  slots: DirectOrderInvoiceSlotCount;
  onDone?: () => void;
};

/**
 * Validating a pharmacy on a distributor invoice (owner, 2026-09-14).
 *
 * Its own component rather than a branch inside `PharmacyValidationCapture`, deliberately: that
 * screen's only file inputs are the licence's, and a test holds it to that so a storefront upload
 * button can never slip in beside the live camera. The invoice is a document, like the licence — a
 * photo, a scan or a PDF — so it gets the camera AND the file picker, here, on its own screen.
 *
 * No location and no photo of the sign are asked for. The price is the limit: a rep holds at most
 * five pharmacies on an invoice alone, and the counter says how many are in use before they start.
 */
export function PharmacyInvoiceValidationCapture({ pharmacyId, pharmacyName, requestId, slots, onDone }: Props) {
  const router = useRouter();
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [name, setName] = useState(pharmacyName);
  const [address, setAddress] = useState("");
  const [doctor, setDoctor] = useState("");
  const [reason, setReason] = useState("");
  const [invoice, setInvoice] = useState<{ dataUrl: string; fileName: string; isPdf: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Said before the rep starts rather than after a round trip: the sixth claim is refused on the
  // server, and finding that out after photographing the invoice is the worst moment to learn it.
  const slotsFull = slots.used >= slots.limit;

  /** Camera and file picker both land here, exactly like the licence. Checked again on the server. */
  function readInvoiceFile(file: File | null | undefined) {
    setError(null);
    if (!file) return;
    if (!isDirectOrderInvoiceContentType(file.type)) {
      setError("The distributor invoice must be a JPEG, a PNG, or a PDF.");
      return;
    }
    if (file.size > DIRECT_ORDER_INVOICE_MAX_BYTES) {
      setError("The distributor invoice file is too large. Attach a file under 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError("That file could not be read. Try attaching it again.");
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl) {
        setError("That file could not be read. Try attaching it again.");
        return;
      }
      setInvoice({ dataUrl, fileName: file.name || "distributor-invoice", isPdf: file.type === "application/pdf" });
      setMessage("Distributor invoice attached.");
    };
    reader.readAsDataURL(file);
  }

  function clearInvoice() {
    setInvoice(null);
    // Reset so re-choosing the SAME file fires `change` again.
    if (cameraRef.current) cameraRef.current.value = "";
    if (fileRef.current) fileRef.current.value = "";
  }

  async function submit() {
    setError(null);
    if (slotsFull) return setError(directOrderInvoiceSlotsFullMessage(slots));
    if (!invoice) return setError("Attach the distributor invoice.");
    if (!name.trim()) return setError("Pharmacy name is required.");
    if (!reason.trim()) return setError("Say why this pharmacy is not in the master database.");
    setBusy(true);
    try {
      const res = await fetch("/api/direct-orders/pharmacy-validations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pharmacyId,
          requestId,
          validationRoute: "invoice",
          invoiceDataUrl: invoice.dataUrl,
          claimedPharmacyName: name.trim(),
          claimedAddress: address.trim() || null,
          claimedDoctorName: doctor.trim() || null,
          claimedReason: reason.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not submit the validation.");
      setSent(true);
      setMessage(
        "Sent for review with the invoice. Your order stays on hold until an SFE Manager or a System Admin reviews it.",
      );
      clearInvoice();
      onDone?.();
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass = `${phxFieldClassName} mt-1`;
  const labelClass = phxLabelClassName;

  return (
    <div className="space-y-3 px-4 py-4">
      <p className="border border-sky-300 bg-sky-50 px-3 py-2 text-phx-sm font-semibold text-sky-900">
        A distributor invoice issued to this pharmacy validates it on its own — no location and no
        photo of the sign. An SFE Manager or a System Admin reviews it.
      </p>

      <div className={`border px-3 py-2 ${slotsFull ? "border-amber-300 bg-amber-50" : "border-[#eef1f3]"}`}>
        <p className="text-phx-sm font-black text-slate-900">{directOrderInvoiceSlotLabel(slots)}</p>
        <p className={`mt-0.5 text-phx-xs font-semibold ${slotsFull ? "text-amber-900" : "text-slate-500"}`}>
          {slotsFull
            ? directOrderInvoiceSlotsFullMessage(slots)
            : `You can hold up to ${slots.limit} pharmacies on an invoice at a time. Validating one of them later with a live photo and location frees its slot.`}
        </p>
      </div>

      <div>
        <label className={labelClass}>Pharmacy name *</label>
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} dir="auto" />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className={labelClass}>Address</label>
          <input className={inputClass} value={address} onChange={(e) => setAddress(e.target.value)} dir="auto" />
        </div>
        <div>
          <label className={labelClass}>Doctor / owner</label>
          <input className={inputClass} value={doctor} onChange={(e) => setDoctor(e.target.value)} dir="auto" />
        </div>
      </div>
      <div>
        <label className={labelClass}>Why is it not in the master database? *</label>
        <textarea
          className={inputClass}
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="New pharmacy, opened recently, buys from a distributor not yet in the sheets…"
          dir="auto"
        />
      </div>

      <div className={`border p-3 ${invoice ? "border-[#eef1f3]" : "border-amber-300 bg-amber-50"}`}>
        <p className="text-phx-xs font-black uppercase tracking-wider text-slate-500">Distributor invoice *</p>
        <p className="mt-1 text-phx-sm font-medium text-slate-600">
          The invoice a distributor issued to this pharmacy. The reviewer checks that it names this
          pharmacy.
        </p>
        <input
          accept={DIRECT_ORDER_INVOICE_ACCEPT_ATTRIBUTE}
          capture="environment"
          className="hidden"
          onChange={(e) => readInvoiceFile(e.target.files?.[0])}
          ref={cameraRef}
          type="file"
        />
        <input
          accept={DIRECT_ORDER_INVOICE_ACCEPT_ATTRIBUTE}
          className="hidden"
          onChange={(e) => readInvoiceFile(e.target.files?.[0])}
          ref={fileRef}
          type="file"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => cameraRef.current?.click()}
            className="border border-slate-300 bg-white px-3 py-1.5 text-phx-sm font-bold text-slate-700 hover:bg-slate-50"
          >
            Photograph invoice
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="border border-slate-300 bg-white px-3 py-1.5 text-phx-sm font-bold text-slate-700 hover:bg-slate-50"
          >
            Choose file
          </button>
          <span className="text-phx-xs font-medium text-slate-400">JPEG, PNG or PDF · up to 5 MB</span>
        </div>
        {invoice ? (
          <div className="mt-2 border border-emerald-300 bg-emerald-50 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-all text-phx-sm font-bold text-emerald-900" dir="auto">{invoice.fileName}</span>
              <button type="button" onClick={clearInvoice} className="text-phx-xs font-bold text-orange-600">
                Remove
              </button>
            </div>
            {invoice.isPdf ? null : (
              <ZoomablePhoto
                alt="Distributor invoice"
                caption="Distributor invoice"
                className="mt-2 w-full max-w-md border border-emerald-200"
                src={invoice.dataUrl}
              />
            )}
          </div>
        ) : null}
      </div>

      {message ? <p className="text-phx-sm font-semibold text-slate-600">{message}</p> : null}
      {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}

      <button
        type="button"
        onClick={submit}
        disabled={busy || sent || slotsFull || !invoice}
        className="w-full bg-orange-500 px-4 py-2.5 text-phx-md font-black uppercase tracking-wider text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {busy ? "Sending…" : "Send the invoice for review"}
      </button>
    </div>
  );
}
