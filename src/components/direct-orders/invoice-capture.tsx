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
  // TWO inputs, not one whose `capture` attribute is toggled before the click. An input carrying
  // `capture` opens the camera on most phones and never offers the gallery, so a single input can
  // only ever be one of the two things. Setting the attribute and then calling click() in the same
  // tick is unreliable across mobile browsers; two inputs are simply two inputs.
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InvoiceExtractionResult | null>(null);
  const [appliedIndex, setAppliedIndex] = useState<number | null>(null);
  // What is CURRENTLY in each line's boxes, keyed by line index. Seeded from the reading and then
  // owned by the submitter. Held separately from `result` so the reading stays intact underneath —
  // comparing the two is what tells us a value was corrected.
  const [edits, setEdits] = useState<Record<number, { qty: string; bonus: string }>>({});

  function fieldValue(index: number, field: "qty" | "bonus", fallback: number | null | undefined): string {
    const edited = edits[index]?.[field];
    if (edited !== undefined) return edited;
    return fallback == null ? "" : String(fallback);
  }

  function setField(
    index: number,
    field: "qty" | "bonus",
    value: string,
    printed: InvoiceExtractionResult["resolved"]["lines"][number]["read"],
  ) {
    setEdits((prev) => ({
      ...prev,
      [index]: {
        bonus: field === "bonus" ? value : (prev[index]?.bonus ?? (printed.bonus == null ? "" : String(printed.bonus))),
        qty: field === "qty" ? value : (prev[index]?.qty ?? (printed.qty == null ? "" : String(printed.qty))),
      },
    }));
    // Editing a line un-uses it: the form now holds the OLD numbers, and leaving the button
    // reading "Used" would tell the submitter their correction had been applied when it had not.
    setAppliedIndex((current) => (current === index ? null : current));
  }

  async function read(file: File, source: "camera" | "upload") {
    setBusy(true);
    setError(null);
    setResult(null);
    setAppliedIndex(null);
    setEdits({});
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
        // `source` is recorded, never used to decide anything. It answers "do the photos people
        // forward read worse than the ones they take?" — and if they do, the answer is better
        // guidance, not a refusal.
        body: JSON.stringify({ imageBase64: base64, mimeType: file.type, source }),
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
          Photograph the distributor invoice, or choose a photo you already have, and Phoenix fills
          in what it can. You confirm every line before it is used — nothing is entered on its own.
        </p>

        {/* The CAMERA route. `capture="environment"` asks for the rear lens directly. */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so choosing the SAME photo again still fires a change event — otherwise a
            // retry after a failed read looks like a dead button.
            event.target.value = "";
            if (file) void read(file, "camera");
          }}
        />
        {/* The GALLERY route. NO `capture` attribute — that single word is the whole difference.
            With it, a phone opens the camera and never offers the files, which left a rep whose
            invoice arrived by WhatsApp with no way in at all. */}
        <input
          ref={uploadRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void read(file, "upload");
          }}
        />

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="bg-slate-900 px-4 py-2 text-[11px] font-black uppercase tracking-wider text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            disabled={busy}
            onClick={() => cameraRef.current?.click()}
          >
            {busy ? "Reading the invoice…" : "Photograph the invoice"}
          </button>
          <button
            type="button"
            className="border border-slate-900 px-4 py-2 text-[11px] font-black uppercase tracking-wider text-slate-900 hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400 disabled:hover:bg-transparent disabled:hover:text-slate-400"
            disabled={busy}
            onClick={() => uploadRef.current?.click()}
          >
            Choose a photo
          </button>
        </div>
        <p className="text-[11px] text-slate-400">
          Either way, Phoenix straightens and sharpens the picture before reading it — a photo taken
          in a dim shop, or one forwarded to you, both work.
        </p>

        {error ? (
          <p className="border border-rose-300 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-800">{error}</p>
        ) : null}

        {result ? (
          <div className="space-y-3">
            {/* A thin reading is almost always the PHOTOGRAPH, and the submitter is standing in
                front of the invoice right now — retaking costs ten seconds here and an approval
                cycle later. So say it plainly and put the button next to the sentence.

                It never blocks. `AREA_PROXIMITY_FLAG_KM` in the validation service states the rule
                this follows: a hard gate rejects real work and produces exactly the "the new system
                blocked everything" complaint the design exists to avoid. A rep in a dim pharmacy at
                six in the evening with a creased invoice must still be able to file the order — by
                hand if that is what it takes. Refusing them would send them back to typing codes,
                which is the behaviour that created the false pharmacies in the first place. */}
            {!result.resolved.customer || result.resolved.lines.every((line) => !line.product) ? (
              <div className="border border-amber-300 bg-amber-50 px-3 py-2">
                <p className="text-[12px] font-bold text-amber-900">
                  Not much came off this photo. If the invoice is still in front of you, a second
                  shot usually fixes it — get closer, keep the page flat, and avoid the glare.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="border border-amber-800 px-3 py-1.5 text-[11px] font-black uppercase tracking-wider text-amber-900 hover:bg-amber-800 hover:text-white"
                    onClick={() => cameraRef.current?.click()}
                  >
                    Retake the photo
                  </button>
                  {/* Both routes offered again here. A thin read from a forwarded photo cannot be
                      fixed by retaking it — the paper is not in front of them — so "choose another"
                      is the only move that helps, and offering only a retake would be advice they
                      cannot follow. */}
                  <button
                    type="button"
                    className="border border-amber-800 px-3 py-1.5 text-[11px] font-black uppercase tracking-wider text-amber-900 hover:bg-amber-800 hover:text-white"
                    onClick={() => uploadRef.current?.click()}
                  >
                    Choose another
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-amber-800">
                  Or carry on and fill the rest in yourself — nothing here stops you submitting.
                </p>
              </div>
            ) : null}

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
                why: dropping it would turn a five-line invoice into four with nobody the wiser.

                The numbers are EDITABLE, seeded from the reading. Before this, a line was
                use-as-read or nothing — so a quantity that came back 240 against a printed 249 sent
                the submitter to type the whole order by hand. Hand-typing is the behaviour this
                whole feature exists to remove, and refusing a one-digit correction was quietly
                reinstating it. A quantity that did not read at all is now typeable for the same
                reason.

                The PRODUCT is deliberately not editable. A line the master database could not
                confirm still has no button — that rule predates this and is the one that stops a
                code nobody has checked from entering at speed. */}
            <div className="space-y-2">
              {result.resolved.lines.map((line, index) => {
                const qty = fieldValue(index, "qty", line.read.qty);
                const bonus = fieldValue(index, "bonus", line.read.bonus);
                const qtyNumber = Number(qty);
                const usable = Boolean(line.product) && qty.trim() !== "" && Number.isFinite(qtyNumber) && qtyNumber > 0;
                const corrected =
                  qty !== (line.read.qty == null ? "" : String(line.read.qty)) ||
                  bonus !== (line.read.bonus == null ? "" : String(line.read.bonus));
                return (
                  <div key={`${line.read.productCode ?? "?"}-${index}`} className="border border-[#e4e9ec] px-3 py-2">
                    <p className="text-sm font-bold text-slate-900" dir="auto">
                      {line.product?.productName ?? line.read.productName ?? line.read.productCode ?? "Unreadable line"}
                    </p>
                    {line.problem ? <p className="text-[11px] font-semibold text-amber-800">{line.problem}</p> : null}

                    <div className="mt-2 flex flex-wrap items-end gap-3">
                      <label className="block">
                        <span className="block text-[10px] font-black uppercase tracking-wider text-slate-400">
                          Quantity
                        </span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          value={qty}
                          placeholder={line.read.qty == null ? "not read — type it" : undefined}
                          onChange={(event) => setField(index, "qty", event.target.value, line.read)}
                          className="mt-0.5 w-28 border border-[#e4e9ec] px-2 py-1 text-sm font-semibold text-slate-900"
                        />
                      </label>
                      <label className="block">
                        <span className="block text-[10px] font-black uppercase tracking-wider text-slate-400">
                          Bonus
                        </span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          value={bonus}
                          onChange={(event) => setField(index, "bonus", event.target.value, line.read)}
                          className="mt-0.5 w-24 border border-[#e4e9ec] px-2 py-1 text-sm font-semibold text-slate-900"
                        />
                      </label>
                      {line.product ? (
                        <button
                          type="button"
                          disabled={!usable}
                          className="border border-slate-900 px-3 py-1.5 text-[11px] font-black uppercase tracking-wider text-slate-900 hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                          onClick={() => {
                            onApply({
                              bonus: bonus.trim(),
                              customer: result.resolved.customer,
                              productCode: line.product?.productCode ?? "",
                              qty: qty.trim(),
                            });
                            setAppliedIndex(index);
                          }}
                        >
                          {appliedIndex === index ? "Used" : "Use this line"}
                        </button>
                      ) : null}
                    </div>

                    {corrected ? (
                      <p className="mt-1.5 text-[11px] text-slate-500">
                        Changed from what the invoice printed — your number is the one that will be used.
                      </p>
                    ) : null}
                  </div>
                );
              })}
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
