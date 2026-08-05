"use client";

import { useRef, useState } from "react";

import type { InvoiceExtractionResult } from "@/lib/direct-orders/invoice-extraction";

export type InvoiceApplyPayload = {
  productCode: string;
  qty: string;
  bonus: string;
  customer: InvoiceExtractionResult["resolved"]["customer"];
};

type Props = {
  /** Called when the submitter accepts a line. The form owns what it does with it. */
  onApply: (payload: InvoiceApplyPayload) => void;
  /** Rendered under the customer block — lets each form say how IT will use the pharmacy. */
  customerHint?: string;
};

const box = "border border-[#e4e9ec] bg-white";

/**
 * Invoice-photo prefill (spec B5).
 *
 * Photograph the distributor invoice; the form fills itself in.
 *
 * Two rules shape every line of this component.
 *
 * **It is never announced.** Spec D4 is absolute: no "AI", no model name, no sparkle icon, no
 * confidence score, anywhere a user can see. The invoice was read. That is all it says. The reading
 * happens server-side so nothing in the browser betrays how.
 *
 * **It proposes, it never commits.** Nothing is applied until the submitter presses a button on a
 * specific line, and a line the master database could not confirm has no such button — only a
 * sentence saying what to do instead. This module exists because codes that did not exist were
 * accepted once; a reader that filled the form in silently would repeat that at speed and with
 * more conviction than any typo.
 */
export function InvoiceCapture({ onApply, customerHint }: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InvoiceExtractionResult | null>(null);
  const [appliedIndex, setAppliedIndex] = useState<number | null>(null);

  async function read(file: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    setAppliedIndex(null);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("read failed"));
        // FileReader gives "data:<mime>;base64,<payload>" — the server wants the payload alone.
        reader.onload = () => resolve(String(reader.result ?? "").split(",")[1] ?? "");
        reader.readAsDataURL(file);
      });
      if (!base64) {
        setError("That photo could not be opened. Take it again.");
        return;
      }
      const res = await fetch("/api/direct-orders/invoice-extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: base64, mimeType: file.type }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        result?: InvoiceExtractionResult;
        message?: string;
        success?: boolean;
      };
      if (!res.ok || !data.success || !data.result) {
        // The server's own sentence — it distinguishes a bad photo from an outage, and the
        // submitter must not retake a good photo five times to fix something on our side.
        setError(data.message ?? "The invoice could not be read.");
        return;
      }
      setResult(data.result);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={box}>
      <header className="border-b border-[#e4e9ec] bg-slate-900 px-4 py-2.5">
        <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-white">Fill from the invoice</h3>
      </header>
      <div className="space-y-3 px-4 py-4">
        <p className="text-[12px] text-slate-600">
          Photograph the distributor invoice and Phoenix fills in what it can. You confirm every line
          before it is used — nothing is entered on its own.
        </p>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so choosing the SAME photo again still fires a change event — otherwise a
            // retry after a failed read looks like a dead button.
            event.target.value = "";
            if (file) void read(file);
          }}
        />
        <button
          type="button"
          className="bg-slate-900 px-4 py-2 text-[11px] font-black uppercase tracking-wider text-white disabled:cursor-not-allowed disabled:bg-slate-300"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? "Reading the invoice…" : "Photograph the invoice"}
        </button>

        {error ? (
          <p className="border border-rose-300 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-800">{error}</p>
        ) : null}

        {result ? (
          <div className="space-y-3">
            {/* The pharmacy, and only if the master database confirmed it. */}
            <div className="border border-[#e4e9ec] px-3 py-2">
              <p className="text-[11px] font-black uppercase tracking-wider text-slate-500">Pharmacy on the invoice</p>
              {result.resolved.customer ? (
                <>
                  <p className="text-sm font-bold text-slate-900" dir="auto">
                    {result.resolved.customer.customerName ?? result.resolved.customer.customerCode}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {result.resolved.customer.customerCode}
                    {result.resolved.customer.areaName ? ` · ${result.resolved.customer.areaName}` : ""}
                  </p>
                  {customerHint ? <p className="mt-1 text-[11px] text-slate-400">{customerHint}</p> : null}
                </>
              ) : (
                <p className="text-[12px] font-semibold text-amber-800">
                  {result.read.customerCode
                    ? `Code ${result.read.customerCode} is not in the master database — pick the pharmacy yourself.`
                    : "No customer code could be read — pick the pharmacy yourself."}
                </p>
              )}
            </div>

            {/* One row per printed line. A line that could not be matched keeps its place and says
                why: dropping it would turn a five-line invoice into four with nobody the wiser. */}
            <div className="space-y-2">
              {result.resolved.lines.map((line, index) => (
                <div key={`${line.read.productCode ?? "?"}-${index}`} className="flex flex-wrap items-center justify-between gap-2 border border-[#e4e9ec] px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900" dir="auto">
                      {line.product?.productName ?? line.read.productName ?? line.read.productCode ?? "Unreadable line"}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {line.read.qty != null ? `${line.read.qty.toLocaleString("en-US")} units` : "no quantity read"}
                      {line.read.bonus ? ` · ${line.read.bonus.toLocaleString("en-US")} bonus` : ""}
                    </p>
                    {line.problem ? <p className="text-[11px] font-semibold text-amber-800">{line.problem}</p> : null}
                  </div>
                  {line.product && line.read.qty != null && line.read.qty > 0 ? (
                    <button
                      type="button"
                      className="border border-slate-900 px-3 py-1.5 text-[11px] font-black uppercase tracking-wider text-slate-900 hover:bg-slate-900 hover:text-white"
                      onClick={() => {
                        onApply({
                          bonus: line.read.bonus ? String(line.read.bonus) : "",
                          customer: result.resolved.customer,
                          productCode: line.product?.productCode ?? "",
                          qty: String(line.read.qty ?? ""),
                        });
                        setAppliedIndex(index);
                      }}
                    >
                      {appliedIndex === index ? "Used" : "Use this line"}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>

            {result.problems.length > 0 ? (
              <div className="border border-amber-300 bg-amber-50 px-3 py-2">
                <p className="text-[11px] font-black uppercase tracking-wider text-amber-900">Finish these by hand</p>
                <ul className="mt-1 space-y-0.5">
                  {result.problems.map((problem) => (
                    <li key={problem} className="text-[12px] text-amber-900">
                      {problem}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
