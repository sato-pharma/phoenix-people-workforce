"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { adminPanelClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import { prepareDirectOrderInvoiceFile, type PreparedDirectOrderInvoice } from "@/components/direct-orders/invoice-file";
import { FormField } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxFieldClassName,
  phxFormErrorClassName,
} from "@/components/ui/form-tokens";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import type { DirectOrderReceiptPanel as Panel } from "@/lib/direct-orders/receipt-books";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";

/**
 * The delivery receipt on a direct order (owner, 26 Nov 2026: "Build the check").
 *
 * Shows the receipt that proves the order, or — to the manager who raised it, and to Finance — the
 * three things to enter from the signed page: its number, the code printed beside it, and a photo.
 * The server checks every rule again; this panel is the convenience, never the gate.
 */
export function DirectOrderReceiptPanel({ requestId, panel }: { requestId: string; panel: Panel }) {
  const router = useRouter();
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [serial, setSerial] = useState("");
  const [code, setCode] = useState("");
  const [photo, setPhoto] = useState<PreparedDirectOrderInvoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (panel.standing === "not_required" && !panel.receipt && !panel.entryBook) return null;

  async function choose(file: File | null | undefined) {
    setError(null);
    if (!file) return;
    try {
      setPhoto(await prepareDirectOrderInvoiceFile(file));
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : "That photo could not be attached.");
    }
  }

  async function send() {
    if (!serial.trim()) return setError("Type the receipt number printed at the top of the page.");
    if (!code.trim()) return setError("Type the six-character code printed beside the number.");
    if (!photo) return setError("Photograph the signed and stamped receipt page.");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/direct-orders/${encodeURIComponent(requestId)}/receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial, code, photoDataUrl: photo.dataUrl }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not save the receipt.");
      setMessage(data.message ?? "The receipt is saved with the order.");
      router.refresh();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const overdue = panel.standing === "overdue";
  const days = panel.daysSinceApproval;
  return (
    <section className={adminPanelClassName}>
      <header className={cn(adminPanelHeaderClassName, "px-4 py-2.5")}>
        <h2 className="text-phx-xs font-black uppercase tracking-wider text-white">Delivery receipt</h2>
      </header>
      <div className="space-y-3 p-4">
        {panel.receipt ? (
          <div className="space-y-2">
            <p className="text-phx-sm text-slate-700">
              Receipt <span className="font-black tabular-nums text-slate-900">{panel.receipt.serialLabel}</span> from book{" "}
              {panel.receipt.bookNo} proves this delivery
              {panel.receipt.usedByName ? `, entered by ${panel.receipt.usedByName}` : ""}
              {panel.receipt.usedAt ? ` on ${cairoDateTime(panel.receipt.usedAt)}` : ""}.
            </p>
            {panel.receipt.photoUrl && !panel.receipt.photoIsPdf ? (
              <ZoomablePhoto
                alt={`Delivery receipt ${panel.receipt.serialLabel}`}
                caption={`Delivery receipt ${panel.receipt.serialLabel}`}
                className="w-full max-w-md border border-slate-200"
                src={panel.receipt.photoUrl}
              />
            ) : panel.receipt.photoUrl ? (
              <a className="text-phx-sm font-bold text-orange-700 underline" href={panel.receipt.photoUrl} rel="noreferrer" target="_blank">
                Open the receipt file
              </a>
            ) : (
              <p className="text-phx-sm text-rose-700">The receipt photo could not be opened just now.</p>
            )}
          </div>
        ) : (
          <p className={cn("text-phx-sm", overdue ? "font-bold text-rose-700" : "text-slate-700")}>
            {overdue
              ? `No receipt has been entered ${days} days after approval. Finance is flagged after ${panel.overdueDays} days.`
              : `No receipt entered yet${days !== null ? ` — approved ${days} day${days === 1 ? "" : "s"} ago` : ""}. Enter it once the venue has signed and stamped the page.`}
          </p>
        )}

        {panel.noOpenBook ? (
          <p className="text-phx-sm text-slate-600">
            The manager who raised this order holds no open receipt book, so the receipt cannot be entered yet. Finance hands the books out.
          </p>
        ) : null}

        {panel.entryBook && !panel.receipt && !message ? (
          <div className="space-y-3 border-t border-slate-200 pt-3">
            <p className="text-phx-sm text-slate-600">
              From book {panel.entryBook.bookNo} ({panel.entryBook.rangeLabel}). A receipt proves one order only and can never be used again.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Receipt number" required hint="Six digits, at the top of the page" htmlFor={`receipt-serial-${requestId}`}>
                <input
                  autoComplete="off"
                  className={phxFieldClassName}
                  id={`receipt-serial-${requestId}`}
                  inputMode="numeric"
                  maxLength={8}
                  onChange={(event) => setSerial(event.target.value)}
                  placeholder="000123"
                  value={serial}
                />
              </FormField>
              <FormField label="Code beside the number" required hint="Six letters and digits" htmlFor={`receipt-code-${requestId}`}>
                <input
                  autoCapitalize="characters"
                  autoComplete="off"
                  className={cn(phxFieldClassName, "uppercase tracking-widest")}
                  id={`receipt-code-${requestId}`}
                  maxLength={8}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="AB3K7Q"
                  value={code}
                />
              </FormField>
            </div>
            <input accept="image/*" capture="environment" className="hidden" onChange={(event) => void choose(event.target.files?.[0])} ref={cameraRef} type="file" />
            <input accept="image/*,application/pdf" className="hidden" onChange={(event) => void choose(event.target.files?.[0])} ref={fileRef} type="file" />
            <div className="flex flex-wrap items-center gap-2">
              <button className={phxButtonGhostClassName} disabled={busy} onClick={() => cameraRef.current?.click()} type="button">
                Photograph the signed page
              </button>
              <button className={phxButtonGhostClassName} disabled={busy} onClick={() => fileRef.current?.click()} type="button">
                Choose file
              </button>
            </div>
            {photo && !photo.isPdf ? (
              <ZoomablePhoto alt="Receipt page" caption="Receipt page" className="w-full max-w-md border border-slate-200" src={photo.dataUrl} />
            ) : photo ? (
              <p className="break-all text-phx-sm font-bold text-slate-700" dir="auto">
                {photo.fileName}
              </p>
            ) : null}
            {error ? <p className={phxFormErrorClassName}>{error}</p> : null}
            <button className={cn(phxButtonAccentClassName, "w-full justify-center")} disabled={busy} onClick={() => void send()} type="button">
              {busy ? "Checking the receipt…" : "Save the receipt"}
            </button>
          </div>
        ) : null}
        {message ? <p className="text-phx-sm font-semibold text-slate-800">{message}</p> : null}
      </div>
    </section>
  );
}
