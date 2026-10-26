"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChequePayee } from "@/lib/spotlight/cheque-people";
import { CHEQUE_MAX_PER_REQUEST, blankChequeInput, type ChequeInput } from "@/lib/spotlight/cheque-request";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { useCspNonce } from "@/components/security/csp-nonce-provider";
import { withScriptNonce } from "@/lib/security/csp-nonce";
import { cn } from "@/lib/utils";

/**
 * Award cheques - the generator's form and its live preview.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * EVERY FIELD ON THE CHEQUE IS TYPED, NONE IS LOOKED UP. The roster only suggests a name (and fills
 * the position when that is empty); the person can overwrite anything, or pay to a name that is on no
 * list at all. Nothing here reads payroll, and the amount is whatever is typed - the sheet is a
 * presentation piece, not a payment.
 *
 * The preview is the server's own document (`/api/spotlight/cheques`, format html) drawn scaled into a
 * sandboxed frame, so what is on screen is what the PDF prints - there is no second renderer to drift.
 * The CEO's signature never passes through this page inside a cheque: the server reads it from its
 * private bucket. This page only uploads a replacement and shows a thumbnail.
 *
 * 🔒 NO HORIZONTAL SCROLL, desktop and mobile: the form is a grid that collapses to one column, the
 * 914 mm sheet is scaled to the width of its card, and corners are square.
 */

type Props = { payees: ChequePayee[] };
type Row = { id: string; data: ChequeInput };

const FIELD = cn(phxFieldClassName, "w-full px-3 py-2 text-[13px]");
const LABEL = "block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const CARD = "rounded-none border border-slate-200 bg-white p-4";
const BUTTON =
  "rounded-none border border-slate-300 bg-white px-3 py-2 text-[12px] font-semibold text-slate-700"
  + " hover:border-sky-700 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY =
  "rounded-none border border-sky-800 bg-sky-800 px-4 py-2 text-[13px] font-semibold text-white"
  + " hover:bg-sky-900 disabled:cursor-not-allowed disabled:opacity-50";

/** The sheet is 914 x 406 mm; the frame is laid out at that size in CSS pixels and scaled down to fit. */
const SHEET_W = Math.round((914 / 25.4) * 96);
const SHEET_H = Math.round((406 / 25.4) * 96);

const newId = () => globalThis.crypto.randomUUID();

/** Today in Cairo as `YYYY-MM-DD` - the transfer date most cheques carry. */
function cairoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/** "Muhammad Nasr Al-Sayed Ibrahim" -> "Muhammad Nasr Al-Sayed" - the first three names, the way the sheet is set for the video. */
function firstThreeNames(name: string): string {
  return name.trim().split(/\s+/).slice(0, 3).join(" ");
}

/**
 * A scanned or photographed signature on white paper becomes a transparent PNG: the paper turns clear,
 * the ink keeps its colour, and the picture is cropped to the ink. Done here in the browser so the
 * server never has to decode an image (its image library is not dependable on the production image).
 */
async function signaturePng(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1400 / bitmap.width);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser cannot process images.");
  context.drawImage(bitmap, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height);
  const px = image.data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < px.length; i += 4) {
    const paper = 255 - Math.min(px[i], px[i + 1], px[i + 2]);
    const clear = paper < 28 ? 0 : Math.min(255, Math.round(((paper - 28) * 255) / 110));
    px[i + 3] = Math.min(px[i + 3], clear);
    if (px[i + 3] > 8) {
      const at = i / 4;
      const x = at % width;
      const y = Math.floor(at / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error("No ink was found in that picture - use a dark signature on white paper.");
  context.putImageData(image, 0, 0);
  const pad = 6;
  const cropX = Math.max(0, minX - pad);
  const cropY = Math.max(0, minY - pad);
  const cropW = Math.min(width - cropX, maxX - minX + 1 + pad * 2);
  const cropH = Math.min(height - cropY, maxY - minY + 1 + pad * 2);
  const out = document.createElement("canvas");
  out.width = cropW;
  out.height = cropH;
  out.getContext("2d")?.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  return new Promise((resolve, reject) =>
    out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The signature could not be prepared."))), "image/png"),
  );
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export function ChequeWorkspace({ payees }: Props) {
  const [rows, setRows] = useState<Row[]>(() => [{ id: newId(), data: blankChequeInput() }]);
  const [selectedId, setSelectedId] = useState<string>(() => "");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  // A srcdoc frame inherits the page policy, so the cheque's fitting script runs only with the page
  // nonce (src/lib/security/csp-nonce.ts). The cheque is rendered by our server, every value escaped.
  const nonce = useCspNonce();
  const framedPreviewHtml = useMemo(() => withScriptNonce(previewHtml ?? "", nonce), [previewHtml, nonce]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [signature, setSignature] = useState<{ present: boolean; dataUri: string | null } | null>(null);
  const [signatureBusy, setSignatureBusy] = useState(false);
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [signatureVersion, setSignatureVersion] = useState(0);
  const [frameWidth, setFrameWidth] = useState(0);
  const frameBox = useRef<HTMLDivElement | null>(null);

  const selected = rows.find((row) => row.id === selectedId) ?? rows[0];
  const selectedIndex = Math.max(0, rows.findIndex((row) => row.id === selected.id));

  const positionByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const payee of payees) map.set(payee.name.toLowerCase(), payee.position);
    return map;
  }, [payees]);

  const update = useCallback(
    (id: string, patch: Partial<ChequeInput>) =>
      setRows((current) => current.map((row) => (row.id === id ? { ...row, data: { ...row.data, ...patch } } : row))),
    [],
  );

  const setName = (value: string) => {
    const patch: Partial<ChequeInput> = { recipientName: value };
    // Choosing a name from the roster brings its position along - only into an empty position field,
    // so a position that was typed by hand is never overwritten.
    const known = positionByName.get(value.trim().toLowerCase());
    if (known && selected.data.positionTitle.trim() === "") patch.positionTitle = known;
    update(selected.id, patch);
  };

  const addCheque = () => {
    if (rows.length >= CHEQUE_MAX_PER_REQUEST) return;
    const id = newId();
    // A new cheque starts from the current one's programme, date and signatory - the parts a run shares.
    const { programName, transferDate, signerTitle, signerTitleAr, signed } = selected.data;
    setRows((current) => [
      ...current,
      { id, data: blankChequeInput({ programName, transferDate, signerTitle, signerTitleAr, signed }) },
    ]);
    setSelectedId(id);
  };

  const duplicateCheque = () => {
    if (rows.length >= CHEQUE_MAX_PER_REQUEST) return;
    const id = newId();
    setRows((current) => {
      const at = current.findIndex((row) => row.id === selected.id);
      const copy = { id, data: { ...selected.data, serial: "" } };
      return [...current.slice(0, at + 1), copy, ...current.slice(at + 1)];
    });
    setSelectedId(id);
  };

  const removeCheque = () => {
    if (rows.length <= 1) {
      setRows([{ id: selected.id, data: blankChequeInput() }]);
      return;
    }
    const next = rows[selectedIndex + 1] ?? rows[selectedIndex - 1];
    setRows((current) => current.filter((row) => row.id !== selected.id));
    setSelectedId(next.id);
  };

  // ---- signature -----------------------------------------------------------------------------------
  useEffect(() => {
    let live = true;
    void fetch("/api/spotlight/cheques/signature", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { present: boolean; dataUri: string | null } | null) => {
        if (live) setSignature(body ?? { present: false, dataUri: null });
      })
      .catch(() => {
        if (live) setSignature({ present: false, dataUri: null });
      });
    return () => {
      live = false;
    };
  }, [signatureVersion]);

  const uploadSignature = async (file: File | undefined) => {
    if (!file) return;
    setSignatureBusy(true);
    setSignatureError(null);
    try {
      const png = await signaturePng(file);
      const response = await fetch("/api/spotlight/cheques/signature", {
        body: png,
        headers: { "Content-Type": "image/png" },
        method: "PUT",
      });
      if (!response.ok) throw new Error(await readError(response, "The signature could not be saved."));
      setSignatureVersion((v) => v + 1);
    } catch (error) {
      setSignatureError(error instanceof Error ? error.message : "The signature could not be saved.");
    } finally {
      setSignatureBusy(false);
    }
  };

  const removeSignature = async () => {
    setSignatureBusy(true);
    setSignatureError(null);
    try {
      const response = await fetch("/api/spotlight/cheques/signature", { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response, "The signature could not be removed."));
      setSignatureVersion((v) => v + 1);
    } catch (error) {
      setSignatureError(error instanceof Error ? error.message : "The signature could not be removed.");
    } finally {
      setSignatureBusy(false);
    }
  };

  // ---- live preview: the server's own sheet, redrawn a moment after the last keystroke --------------
  const previewData = selected.data;
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setPreviewing(true);
      try {
        const response = await fetch("/api/spotlight/cheques", {
          body: JSON.stringify({ cheques: [previewData], format: "html", index: 0 }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await readError(response, "The preview could not be drawn."));
        const body = (await response.json()) as { html: string };
        setPreviewHtml(body.html);
        setPreviewError(null);
      } catch (error) {
        if (controller.signal.aborted) return;
        setPreviewError(error instanceof Error ? error.message : "The preview could not be drawn.");
      } finally {
        if (!controller.signal.aborted) setPreviewing(false);
      }
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [previewData, signatureVersion]);

  useEffect(() => {
    const box = frameBox.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => setFrameWidth(entry.contentRect.width));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const scale = frameWidth > 0 ? frameWidth / SHEET_W : 0;

  // ---- the PDF ---------------------------------------------------------------------------------------
  const downloadPdf = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const response = await fetch("/api/spotlight/cheques", {
        body: JSON.stringify({ cheques: rows.map((row) => row.data), format: "pdf" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error(await readError(response, "The PDF could not be built."));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = rows.length === 1 ? "sato-award-cheque.pdf" : `sato-award-cheques-${rows.length}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "The PDF could not be built.");
    } finally {
      setDownloading(false);
    }
  };

  const d = selected.data;
  const chequeLabel = (row: Row, index: number) => row.data.recipientName.trim() || `Cheque ${index + 1}`;

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4 p-4 md:p-6">
      <header>
        <h1 className="text-[20px] font-semibold text-slate-900">Award cheques</h1>
        <p className="mt-1 text-[13px] text-slate-600">
          A presentation cheque for any bonus, to anyone, for anything. Every field is typed by you - the list only
          suggests a name. The sheet is the same design as the Semester Achievers cheques.
        </p>
      </header>

      <section className={CARD}>
        <div className="flex flex-wrap items-center gap-2">
          {rows.map((row, index) => (
            <button
              className={`max-w-full rounded-none border px-3 py-2 text-left text-[12px] font-semibold ${
                row.id === selected.id
                  ? "border-sky-800 bg-sky-800 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:border-sky-700"
              }`}
              key={row.id}
              onClick={() => setSelectedId(row.id)}
              type="button"
            >
              <span className="mr-2 opacity-70">{index + 1}</span>
              {chequeLabel(row, index)}
            </button>
          ))}
          <button className={BUTTON} disabled={rows.length >= CHEQUE_MAX_PER_REQUEST} onClick={addCheque} type="button">
            + Add a cheque
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className={BUTTON} disabled={rows.length >= CHEQUE_MAX_PER_REQUEST} onClick={duplicateCheque} type="button">
            Duplicate this cheque
          </button>
          <button className={BUTTON} onClick={removeCheque} type="button">
            {rows.length <= 1 ? "Clear this cheque" : "Remove this cheque"}
          </button>
          <span className="text-[12px] text-slate-500">
            {rows.length} cheque{rows.length === 1 ? "" : "s"} in this run - up to {CHEQUE_MAX_PER_REQUEST}.
          </span>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section className={`${CARD} space-y-4`}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className={LABEL} htmlFor="ck-name">Pay to the order of</label>
              <div className="flex gap-2">
                <input
                  autoComplete="off"
                  className={FIELD}
                  id="ck-name"
                  list="ck-payees"
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Type a name, or pick from the list"
                  value={d.recipientName}
                />
                <button
                  className={`${BUTTON} shrink-0`}
                  onClick={() => update(selected.id, { recipientName: firstThreeNames(d.recipientName) })}
                  title="Keep the first three names only"
                  type="button"
                >
                  3 names
                </button>
              </div>
              <datalist id="ck-payees">
                {payees.map((payee) => (
                  <option key={`${payee.name}|${payee.position}`} value={payee.name} />
                ))}
              </datalist>
            </div>
            <div className="sm:col-span-2">
              <label className={LABEL} htmlFor="ck-position">Position (printed after the name)</label>
              <input
                className={FIELD}
                id="ck-position"
                onChange={(event) => update(selected.id, { positionTitle: event.target.value })}
                placeholder="Senior Medical Representative"
                value={d.positionTitle}
              />
            </div>
            <div className="sm:col-span-2">
              <label className={LABEL} htmlFor="ck-for">For (the memo line)</label>
              <input
                className={FIELD}
                id="ck-for"
                onChange={(event) => update(selected.id, { awardTitle: event.target.value })}
                placeholder="Performance bonus - Q3 2026"
                value={d.awardTitle}
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Printed beside the amount. Fill Rank or Achievement below and those boxes print instead.
              </p>
            </div>
            <div>
              <label className={LABEL} htmlFor="ck-rank">Rank (optional)</label>
              <input
                className={FIELD}
                id="ck-rank"
                inputMode="numeric"
                onChange={(event) => update(selected.id, { rank: event.target.value })}
                placeholder="1"
                value={d.rank}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="ck-ach">Achievement % (optional)</label>
              <input
                className={FIELD}
                id="ck-ach"
                inputMode="decimal"
                onChange={(event) => update(selected.id, { achievementPct: event.target.value })}
                placeholder="112.4"
                value={d.achievementPct}
              />
            </div>
            <div className="sm:col-span-2">
              <label className={LABEL} htmlFor="ck-amount">Amount (EGP)</label>
              <input
                className={FIELD}
                id="ck-amount"
                inputMode="decimal"
                onChange={(event) => update(selected.id, { amount: event.target.value })}
                placeholder="12,500 or 12,500.50"
                value={d.amount}
              />
              <p className="mt-1 text-[11px] text-slate-500">
                The figures, the Arabic words and the bottom line all print from this one number.
              </p>
            </div>
            <div>
              <label className={LABEL} htmlFor="ck-date">Transfer date</label>
              <div className="flex gap-2">
                <input
                  className={FIELD}
                  id="ck-date"
                  onChange={(event) => update(selected.id, { transferDate: event.target.value })}
                  type="date"
                  value={d.transferDate}
                />
                <button
                  className={`${BUTTON} shrink-0`}
                  onClick={() => update(selected.id, { transferDate: cairoToday() })}
                  type="button"
                >
                  Today
                </button>
              </div>
            </div>
            <div>
              <label className={LABEL} htmlFor="ck-serial">Cheque number</label>
              <input
                className={FIELD}
                id="ck-serial"
                onChange={(event) => update(selected.id, { serial: event.target.value })}
                placeholder={`Automatic - ${String(selectedIndex + 1).padStart(6, "0")}`}
                value={d.serial}
              />
            </div>
            <div className="sm:col-span-2">
              <label className={LABEL} htmlFor="ck-program">Programme (heading and edge text)</label>
              <input
                className={FIELD}
                id="ck-program"
                onChange={(event) => update(selected.id, { programName: event.target.value })}
                value={d.programName}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="ck-signer">Signature line (English)</label>
              <input
                className={FIELD}
                id="ck-signer"
                onChange={(event) => update(selected.id, { signerTitle: event.target.value })}
                placeholder="Chief Executive Officer"
                value={d.signerTitle}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="ck-signer-ar">Signature line (Arabic)</label>
              <input
                className={FIELD}
                dir="rtl"
                id="ck-signer-ar"
                onChange={(event) => update(selected.id, { signerTitleAr: event.target.value })}
                placeholder="الرئيس التنفيذي"
                value={d.signerTitleAr}
              />
            </div>
          </div>

          <div className="border-t border-slate-200 pt-4">
            <p className={LABEL}>CEO signature</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <div className="flex h-16 w-40 items-center justify-center border border-slate-200 bg-slate-50">
                {signature?.dataUri ? (
                  // A data URI of the stored signature - not a file served from the site.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img alt="Stored CEO signature" className="max-h-full max-w-full" src={signature.dataUri} />
                ) : (
                  <span className="text-[11px] text-slate-400">{signature === null ? "Loading" : "None stored"}</span>
                )}
              </div>
              <label className={`${BUTTON} cursor-pointer`}>
                {signature?.present ? "Replace signature" : "Upload signature"}
                <input
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  disabled={signatureBusy}
                  onChange={(event) => {
                    void uploadSignature(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                  type="file"
                />
              </label>
              {signature?.present ? (
                <button className={BUTTON} disabled={signatureBusy} onClick={() => void removeSignature()} type="button">
                  Remove
                </button>
              ) : null}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              A dark signature on white paper is enough - the paper is made clear here. It is stored privately and only
              ever printed on a cheque.
            </p>
            {signatureError ? <p className="mt-2 text-[12px] font-semibold text-red-700">{signatureError}</p> : null}
            <label className="mt-3 flex items-center gap-2 text-[13px] text-slate-700">
              <input
                checked={d.signed}
                onChange={(event) => update(selected.id, { signed: event.target.checked })}
                type="checkbox"
              />
              Print the signature on this cheque
            </label>
          </div>
        </section>

        <section className={`${CARD} min-w-0`}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className={LABEL}>Preview - cheque {selectedIndex + 1}</p>
            <span className="text-[11px] text-slate-500">{previewing ? "Drawing..." : "Up to date"}</span>
          </div>
          <div className="relative w-full overflow-hidden border border-slate-200 bg-slate-100" ref={frameBox}
            style={{ height: scale > 0 ? Math.round(SHEET_H * scale) : undefined, aspectRatio: scale > 0 ? undefined : `${SHEET_W} / ${SHEET_H}` }}>
            {previewHtml && scale > 0 ? (
              <iframe
                className="absolute left-0 top-0 origin-top-left border-0 bg-white"
                sandbox="allow-scripts"
                srcDoc={framedPreviewHtml}
                style={{ height: SHEET_H, transform: `scale(${scale})`, width: SHEET_W }}
                title="Cheque preview"
              />
            ) : (
              <p className="p-4 text-[12px] text-slate-500">{previewError ? "" : "Drawing the cheque..."}</p>
            )}
          </div>
          {previewError ? <p className="mt-2 text-[12px] font-semibold text-red-700">{previewError}</p> : null}
          <p className="mt-2 text-[11px] text-slate-500">
            The blanks print as placeholders until you fill them. The PDF needs a name, an amount, and either a
            &ldquo;For&rdquo; line or a rank / achievement on every cheque.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
            <button className={PRIMARY} disabled={downloading} onClick={() => void downloadPdf()} type="button">
              {downloading
                ? "Building the PDF..."
                : rows.length === 1
                  ? "Download the cheque (PDF)"
                  : `Download all ${rows.length} cheques (PDF)`}
            </button>
            <span className="text-[11px] text-slate-500">Full sheet, 914 x 406 mm, one page per cheque.</span>
          </div>
          {downloadError ? <p className="mt-2 text-[12px] font-semibold text-red-700">{downloadError}</p> : null}
        </section>
      </div>
    </div>
  );
}
