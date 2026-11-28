"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { adminPanelClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import { ApprovalConfirmButtons, approvalActionClassName } from "@/components/approvals-hub/approval-action-kit";
import { prepareDirectOrderInvoiceFile, type PreparedDirectOrderInvoice } from "@/components/direct-orders/invoice-file";
import { ReceiptQrCamera, type ReceiptCameraShot } from "@/components/direct-orders/receipt-qr-camera";
import { FormField } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonDangerClassName,
  phxButtonGhostClassName,
  phxFieldClassName,
  phxFormErrorClassName,
} from "@/components/ui/form-tokens";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import type {
  DirectOrderHandEntryReview,
  DirectOrderReceiptOriginal,
  DirectOrderReceiptPanel as Panel,
  DirectOrderReceiptPanelUnavailable,
} from "@/lib/direct-orders/receipt-books";
import { formatReceiptSerial, parseReceiptSerial } from "@/lib/direct-orders/receipt-rules";
import { cairoDateTime, utcDate } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";

async function postReceipt(requestId: string, body: Record<string, unknown>, fallback: string): Promise<string> {
  const res = await fetch(`/api/direct-orders/${encodeURIComponent(requestId)}/receipt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
  if (!res.ok || !data.success) throw new Error(data.message || fallback);
  return data.message ?? "Saved.";
}

/**
 * The delivery receipt on a direct order (owner, 26 Nov 2026: "Build the check"; 27 Nov 2026: two
 * originals and a copy).
 *
 * Every receipt is three sheets under one number and code. Original 1 is the manager's signed custody
 * of the goods; Original 2 is the delivery page the customer signs and stamps, whose carbon copy the
 * customer keeps. Both originals are photographed here. Finance records the day the goods left the
 * warehouse, and both due dates count from the next day: Original 1 within 3 days, Original 2 within
 * 6 working days, Friday off. The server checks every rule again; this panel is the convenience, never
 * the gate. Finance can take a receipt off an order it was entered on by mistake, with a written reason.
 *
 * An order that will never have a receipt stands without one only with the CEO's approval (owner,
 * 27 Nov 2026: the CEO's authority alone, carried out through Finance): Finance asks here with a
 * reason, and the CEO approves or refuses on the same panel.
 */
export function DirectOrderReceiptPanel({ requestId, panel: given }: { requestId: string; panel: Panel | DirectOrderReceiptPanelUnavailable }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [releaseReason, setReleaseReason] = useState("");

  if ("unavailable" in given) {
    return (
      <section className={adminPanelClassName}>
        <header className={cn(adminPanelHeaderClassName, "px-4 py-2.5")}>
          <h2 className="text-phx-xs font-black uppercase tracking-wider text-white">Delivery receipt</h2>
        </header>
        <p className="p-4 text-phx-sm font-bold text-rose-700">The delivery receipt could not be read just now. Reload the page in a minute.</p>
      </section>
    );
  }
  const panel = given;
  if (panel.standing === "not_required" && !panel.receipt && !panel.entryBook) return null;

  async function release() {
    if (releaseReason.trim().length < 3) return setError("Write why the receipt is taken off this order.");
    setBusy(true);
    setError(null);
    try {
      setMessage(await postReceipt(requestId, { action: "release", reason: releaseReason }, "Could not take the receipt off the order."));
      setReleasing(false);
      setReleaseReason("");
      router.refresh();
    } catch (releaseError) {
      setError(releaseError instanceof Error ? releaseError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const late = panel.lateness;
  const exit = panel.exit;
  return (
    <section className={adminPanelClassName}>
      <header className={cn(adminPanelHeaderClassName, "px-4 py-2.5")}>
        <h2 className="text-phx-xs font-black uppercase tracking-wider text-white">Delivery receipt — two originals</h2>
      </header>
      <div className="space-y-3 p-4">
        {panel.standing === "without_receipt" ? (
          <p className="text-phx-sm font-bold text-slate-800">The CEO approved this order to stand without a delivery receipt. It no longer owes one.</p>
        ) : panel.standing === "no_book" ? (
          <p className="text-phx-sm font-bold text-rose-700">
            The manager who raised this order held no receipt book when it was approved, so no signed page stands behind it. Finance lists it on the Receipt Books desk.
          </p>
        ) : panel.standing === "has_receipt" ? (
          <p className="text-phx-sm font-bold text-slate-800">Both originals of this order are on Phoenix.</p>
        ) : null}

        {panel.standing !== "without_receipt" && panel.standing !== "not_required" ? (
          exit ? (
            <p className="text-phx-sm text-slate-700">
              The goods left the warehouse on <span className="font-bold text-slate-900">{utcDate(exit.date)}</span>
              {exit.recordedByName ? ` (recorded by ${exit.recordedByName})` : ""}. Original 1 is due by{" "}
              <span className="font-bold text-slate-900">{utcDate(exit.custodyDue)}</span> and Original 2 by{" "}
              <span className="font-bold text-slate-900">{utcDate(exit.deliveryDue)}</span>.
            </p>
          ) : panel.standing !== "has_receipt" ? (
            <p className="text-phx-sm text-slate-700">
              Finance has not yet recorded the day the goods left the warehouse. Nothing is due until it does: Original 1 is then due within 3 days and Original 2 within 6 working days (Friday off), counted from the next day.
            </p>
          ) : null
        ) : null}

        {late ? (
          <p className="text-phx-sm font-bold text-rose-700">
            {late.original === "custody" ? "Original 1, the custody page," : "Original 2, the page the customer signed and stamped,"} is {late.daysLate} day
            {late.daysLate === 1 ? "" : "s"} late (due {utcDate(late.dueDate)}). Finance is flagged, and the manager who raised this order cannot raise a new one until it is entered.
          </p>
        ) : null}

        {panel.lastRejectedHandEntry ? <RejectedHandEntryNotice rejected={panel.lastRejectedHandEntry} /> : null}

        {panel.mayRecordExit ? <WarehouseExitField exitDate={exit?.date ?? null} requestId={requestId} todayCairo={panel.todayCairo} /> : null}

        {panel.receipt ? (
          <div className="space-y-3 border-t border-slate-200 pt-3">
            <p className="text-phx-sm text-slate-700">
              Receipt <span className="font-black tabular-nums text-slate-900">{panel.receipt.serialLabel}</span> from book {panel.receipt.bookNo}.
            </p>
            <OriginalShown label="Original 1 — the custody page the manager signed" original={panel.receipt.custody} requestId={requestId} serialLabel={panel.receipt.serialLabel} />
            {panel.receipt.delivery ? (
              <OriginalShown label="Original 2 — signed and stamped by the customer" original={panel.receipt.delivery} requestId={requestId} serialLabel={panel.receipt.serialLabel} />
            ) : (
              <p className="text-phx-sm text-slate-600">Original 2 — the page the customer signs and stamps — is not entered yet.</p>
            )}
            {panel.mayPrint ? (
              <a
                className="inline-block text-phx-sm font-bold text-orange-700 underline"
                href={`/print/direct-order-receipt/${encodeURIComponent(requestId)}`}
                rel="noreferrer"
                target="_blank"
              >
                Print the verified receipt
              </a>
            ) : null}
            {panel.mayRelease && !message ? (
              releasing ? (
                <div className="space-y-2 border-t border-slate-200 pt-3">
                  <FormField label="Why is this receipt taken off the order" required htmlFor={`receipt-release-${requestId}`}>
                    <input
                      className={phxFieldClassName}
                      id={`receipt-release-${requestId}`}
                      onChange={(event) => setReleaseReason(event.target.value)}
                      placeholder="Entered on the wrong order"
                      value={releaseReason}
                    />
                  </FormField>
                  <p className="text-phx-xs text-slate-500">
                    The receipt and both its originals go back to unused so it can be entered on the right order. The reason, the photos and who entered them stay on this order&apos;s history.
                  </p>
                  {error ? <p className={phxFormErrorClassName}>{error}</p> : null}
                  <div className="flex flex-wrap gap-2">
                    <button className={phxButtonDangerClassName} disabled={busy || releaseReason.trim().length < 3} onClick={() => void release()} type="button">
                      {busy ? "Taking it off…" : `Take receipt ${panel.receipt.serialLabel} off`}
                    </button>
                    <button className={phxButtonGhostClassName} disabled={busy} onClick={() => { setReleasing(false); setError(null); }} type="button">
                      Keep it
                    </button>
                  </div>
                </div>
              ) : (
                <button className={phxButtonGhostClassName} onClick={() => { setReleasing(true); setError(null); }} type="button">
                  Undo — entered on the wrong order
                </button>
              )
            ) : null}
          </div>
        ) : null}

        {panel.noOpenBook ? (
          <p className="text-phx-sm text-slate-600">
            The manager who raised this order holds no open receipt book, so the receipt cannot be entered yet. Finance hands the books out.
          </p>
        ) : null}

        {panel.entryBook && !panel.receipt && !message ? (
          <OriginalEntry
            buttonLabel="Save Original 1"
            intro={`Original 1 — the custody page you signed when the goods left the warehouse. From book ${panel.entryBook.bookNo} (${panel.entryBook.rangeLabel}).${
              panel.entryBook.returned ? " The book is back with Finance; a page from it still proves this order, because it was approved while the manager held the book." : ""
            } Hold the signed page in front of the camera: it saves as soon as its QR is read. A receipt proves one order only and can never be used again.`}
            expectedSerial={null}
            mayChooseFile={panel.mayChooseFile}
            reviewerLabel={panel.handEntryReviewerLabel}
            requestId={requestId}
          />
        ) : null}

        {panel.mayEnterDelivery && panel.receipt && !message ? (
          <OriginalEntry
            action="delivery"
            buttonLabel="Save Original 2"
            intro={`Original 2 — the page the customer signed and stamped. It carries the same number, ${panel.receipt.serialLabel}, and the same code as Original 1. Tear off its carbon copy for the customer, then hold Original 2 in front of the camera: it saves as soon as its QR is read.`}
            expectedSerial={parseReceiptSerial(panel.receipt.serialLabel)}
            mayChooseFile={panel.mayChooseFile}
            reviewerLabel={panel.handEntryReviewerLabel}
            requestId={requestId}
          />
        ) : null}
        {message ? <p className="text-phx-sm font-semibold text-slate-800">{message}</p> : null}

        <NoReceiptSection panel={panel} requestId={requestId} />
      </div>
    </section>
  );
}

function OriginalShown({ label, original, serialLabel, requestId }: { label: string; original: DirectOrderReceiptOriginal; serialLabel: string; requestId: string }) {
  return (
    <div className="space-y-1">
      <p className="text-phx-xs font-black uppercase tracking-wider text-slate-500">{label}</p>
      <p className="text-phx-sm text-slate-700">
        Entered{original.enteredByName ? ` by ${original.enteredByName}` : ""}
        {original.enteredAt ? ` on ${cairoDateTime(original.enteredAt)}` : ""}
        {original.review ? "" : ", its QR read from the photo"}.
      </p>
      {original.review ? <HandEntryNotice requestId={requestId} review={original.review} /> : null}
      {original.photoUrl && !original.photoIsPdf ? (
        <ZoomablePhoto alt={`${label}, receipt ${serialLabel}`} caption={`${label}, receipt ${serialLabel}`} className="w-full max-w-md border border-slate-200" src={original.photoUrl} />
      ) : original.photoUrl ? (
        <a className="text-phx-sm font-bold text-orange-700 underline" href={original.photoUrl} rel="noreferrer" target="_blank">
          Open the file
        </a>
      ) : (
        <p className="text-phx-sm text-rose-700">The photo could not be opened just now.</p>
      )}
    </div>
  );
}

/**
 * One original: photographed LIVE, its QR read (owner, 28 Nov 2026: "لايف مش ابلود"). The camera turns
 * green and saves on its own once it reads the receipt; the number and code come from the QR, whatever
 * would have been typed. "QR won't read?" opens the typed number and code with a shutter: that original
 * is saved too, but waits for review before it counts. A manager has no gallery and no file; Finance keeps
 * "Choose file" for a page it already holds. The server reads the QR again from the photo and decides.
 */
function OriginalEntry({
  requestId,
  action,
  intro,
  buttonLabel,
  expectedSerial,
  mayChooseFile,
  reviewerLabel,
}: {
  requestId: string;
  action?: "delivery";
  intro: string;
  buttonLabel: string;
  /** Original 2 must carry Original 1's number; null for Original 1. */
  expectedSerial: number | null;
  mayChooseFile: boolean;
  /** Who checks an original typed by hand here: "Finance", or "the Administrator" for Finance's own. */
  reviewerLabel: string;
}) {
  const router = useRouter();
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<"scan" | "manual">("scan");
  const [cameraProblem, setCameraProblem] = useState<string | null>(null);
  const [serial, setSerial] = useState("");
  const [code, setCode] = useState("");
  const [photo, setPhoto] = useState<PreparedDirectOrderInvoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${action ?? "custody"}-${requestId}`;

  async function choose(file: File | null | undefined) {
    setError(null);
    if (!file) return;
    try {
      setPhoto(await prepareDirectOrderInvoiceFile(file));
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : "That photo could not be attached.");
    }
  }

  async function send(values: { serial: string; code: string; photoDataUrl: string }) {
    setBusy(true);
    setError(null);
    try {
      setMessage(await postReceipt(requestId, { ...(action ? { action } : {}), ...values }, "Could not save the receipt."));
      router.refresh();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Something went wrong.");
      setPhoto(null);
      // A fresh camera for the next try: the one that saved has stopped looking.
      setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  function shot(taken: ReceiptCameraShot) {
    if (taken.read) {
      void send({ serial: formatReceiptSerial(taken.read.serial), code: taken.read.code, photoDataUrl: taken.dataUrl });
      return;
    }
    setPhoto({ dataUrl: taken.dataUrl, fileName: "receipt-photo.jpg", isPdf: false });
  }

  function sendTyped() {
    if (!serial.trim()) return setError("Type the receipt number printed at the top of the page.");
    if (!code.trim()) return setError("Type the six-character code printed beside the number.");
    if (!photo) return setError("Photograph the signed page.");
    void send({ serial, code, photoDataUrl: photo.dataUrl });
  }

  if (message) return <p className="text-phx-sm font-semibold text-slate-800">{message}</p>;
  const typed = mode === "manual" || cameraProblem !== null || photo !== null;
  return (
    <div className="space-y-3 border-t border-slate-200 pt-3">
      <p className="text-phx-sm text-slate-600">{intro}</p>

      {cameraProblem === null && photo === null && !busy ? (
        <ReceiptQrCamera
          expectedSerial={expectedSerial}
          key={`${mode}-${attempt}`}
          manual={mode === "manual"}
          onShot={shot}
          onUnavailable={setCameraProblem}
        />
      ) : null}
      {busy ? <p className="text-phx-sm font-bold text-emerald-700">Checking the receipt…</p> : null}
      {cameraProblem ? (
        <div className="space-y-2">
          <p className="text-phx-sm font-bold text-rose-700">{cameraProblem}</p>
          <input accept="image/*" capture="environment" className="hidden" onChange={(event) => void choose(event.target.files?.[0])} ref={cameraRef} type="file" />
          <button className={phxButtonGhostClassName} disabled={busy} onClick={() => cameraRef.current?.click()} type="button">
            Open the phone&apos;s camera
          </button>
        </div>
      ) : null}

      {mode === "scan" && cameraProblem === null && photo === null && !busy ? (
        <button className={phxButtonGhostClassName} onClick={() => { setMode("manual"); setError(null); }} type="button">
          QR won&apos;t read? Type the number
        </button>
      ) : null}

      {typed ? (
        <>
          <p className="text-phx-sm text-slate-700">
            Typed by hand, this original is saved with the order but waits for {reviewerLabel} to check the photo before it counts. If the QR reads in the photo, it counts at once.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label="Receipt number" required hint="Six digits, at the top of the page" htmlFor={`receipt-serial-${key}`}>
              <input
                autoComplete="off"
                className={phxFieldClassName}
                id={`receipt-serial-${key}`}
                inputMode="numeric"
                maxLength={8}
                onChange={(event) => setSerial(event.target.value)}
                placeholder="000123"
                value={serial}
              />
            </FormField>
            <FormField label="Code beside the number" required hint="Six letters and digits" htmlFor={`receipt-code-${key}`}>
              <input
                autoCapitalize="characters"
                autoComplete="off"
                className={cn(phxFieldClassName, "uppercase tracking-widest")}
                id={`receipt-code-${key}`}
                maxLength={8}
                onChange={(event) => setCode(event.target.value)}
                placeholder="AB3K7Q"
                value={code}
              />
            </FormField>
          </div>
        </>
      ) : null}

      {mayChooseFile ? (
        <>
          <input accept="image/*,application/pdf" className="hidden" onChange={(event) => void choose(event.target.files?.[0])} ref={fileRef} type="file" />
          <button className={phxButtonGhostClassName} disabled={busy} onClick={() => fileRef.current?.click()} type="button">
            Choose file
          </button>
        </>
      ) : null}

      {photo && !photo.isPdf ? (
        <div className="space-y-2">
          <ZoomablePhoto alt="The photo of the page" caption="The photo of the page" className="w-full max-w-md border border-slate-200" src={photo.dataUrl} />
          <button className={phxButtonGhostClassName} disabled={busy} onClick={() => { setPhoto(null); setAttempt((n) => n + 1); }} type="button">
            Take it again
          </button>
        </div>
      ) : photo ? (
        <p className="break-all text-phx-sm font-bold text-slate-700" dir="auto">
          {photo.fileName}
        </p>
      ) : null}
      {error ? <p className={phxFormErrorClassName}>{error}</p> : null}
      {typed ? (
        <button className={cn(phxButtonAccentClassName, "w-full justify-center")} disabled={busy || !photo} onClick={sendTyped} type="button">
          {busy ? "Checking the receipt…" : buttonLabel}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A rejected hand-entered original, as its manager reads it (owner, 28 Nov 2026: "it must show the manager the reason
 * of the rejection, the accurate reason"): which original, who rejected it and when, what to do now, and the reason
 * on a line of its own in the reviewer's own words — never folded into a sentence.
 */
function RejectedHandEntryNotice({ rejected }: { rejected: NonNullable<Panel["lastRejectedHandEntry"]> }) {
  const custody = rejected.original === "custody";
  return (
    <div className="space-y-1 border-l-4 border-rose-600 bg-white pl-3" role="status">
      <p className="text-phx-sm font-bold text-rose-700">
        {custody ? "Original 1" : "Original 2"} of receipt {rejected.serialLabel}, typed by hand, was rejected
        {rejected.reviewedByName ? ` by ${rejected.reviewedByName}` : ""}
        {rejected.reviewedAt ? ` on ${cairoDateTime(rejected.reviewedAt)}` : ""}.
      </p>
      <p className="text-phx-sm font-bold text-slate-900">Reason:</p>
      {/* Its own line, its direction taken from its words: an Arabic reason reads right to left, whole. */}
      <p className="whitespace-pre-wrap break-words text-phx-sm text-slate-900" dir="auto">
        {rejected.note ?? "No reason was written."}
      </p>
      <p className="text-phx-sm text-slate-700">
        {custody
          ? "The receipt was taken off the order. Enter Original 1 again, then Original 2."
          : "Original 2 was taken back out. Enter it again."}
      </p>
    </div>
  );
}

/** How a hand-entered original stands, and — for its reviewer — the approve and reject buttons. */
function HandEntryNotice({ requestId, review }: { requestId: string; review: DirectOrderHandEntryReview }) {
  if (review.status === "approved") {
    return (
      <p className="text-phx-sm text-slate-700">
        Typed by hand (its QR was not read); checked and approved{review.reviewedByName ? ` by ${review.reviewedByName}` : ""}
        {review.reviewedAt ? ` on ${cairoDateTime(review.reviewedAt)}` : ""}.
      </p>
    );
  }
  return (
    <div className="space-y-2 border-l-4 border-amber-600 bg-white pl-3">
      <p className="text-phx-sm font-bold text-amber-800">
        Typed by hand — its QR was not read in the photo. It waits for {review.reviewerLabel} to check the photo before it counts.
      </p>
      {review.mayDecide ? <HandEntryReviewButtons entryId={review.entryId} requestId={requestId} /> : null}
    </div>
  );
}

/**
 * Approve or reject one hand-entered original (owner, 28 Nov 2026: Finance reviews a manager's, the Super
 * Admin reviews Finance's). A rejection needs a reason and takes the original back out, so it is entered again.
 */
export function HandEntryReviewButtons({ requestId, entryId }: { requestId: string; entryId: string }) {
  const router = useRouter();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    if (decision === "reject" && note.trim().length < 3) return setError("Write why it is rejected.");
    setBusy(true);
    setError(null);
    try {
      setMessage(await postReceipt(requestId, { action: "decide_hand_entry", entryId, decision, note }, "Could not save the review."));
      router.refresh();
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (message) return <p className="text-phx-sm font-semibold text-slate-800">{message}</p>;
  return (
    <div className="space-y-2">
      {rejecting ? (
        <FormField label="Why is it rejected — the manager reads exactly what you write" required htmlFor={`hand-entry-note-${entryId}`}>
          <input
            className={phxFieldClassName}
            id={`hand-entry-note-${entryId}`}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
            placeholder="The number in the photo is not the one typed"
            value={note}
          />
        </FormField>
      ) : null}
      {error ? <p className={phxFormErrorClassName}>{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {rejecting ? (
          <>
            <button className={phxButtonDangerClassName} disabled={busy || note.trim().length < 3} onClick={() => void decide("reject")} type="button">
              {busy ? "Saving…" : "Reject — take it back out"}
            </button>
            <button className={phxButtonGhostClassName} disabled={busy} onClick={() => { setRejecting(false); setError(null); }} type="button">
              Back
            </button>
          </>
        ) : (
          <>
            <button className={phxButtonAccentClassName} disabled={busy} onClick={() => void decide("approve")} type="button">
              {busy ? "Saving…" : "Approve — the photo matches"}
            </button>
            <button className={phxButtonGhostClassName} disabled={busy} onClick={() => { setRejecting(true); setError(null); }} type="button">
              Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Finance records — or corrects — the day the goods left the warehouse. */
export function WarehouseExitField({ requestId, exitDate, todayCairo }: { requestId: string; exitDate: string | null; todayCairo: string }) {
  const router = useRouter();
  const [value, setValue] = useState(exitDate ?? todayCairo);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      setMessage(await postReceipt(requestId, { action: "warehouse_exit", exitDate: value }, "Could not record the warehouse exit."));
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <FormField className="min-w-0 flex-1" label={exitDate ? "Correct the warehouse exit day" : "The day the goods left the warehouse"} htmlFor={`warehouse-exit-${requestId}`}>
          <input className={phxFieldClassName} id={`warehouse-exit-${requestId}`} max={todayCairo} onChange={(event) => setValue(event.target.value)} type="date" value={value} />
        </FormField>
        <button className={phxButtonGhostClassName} disabled={busy || !value || value === exitDate} onClick={() => void save()} type="button">
          {busy ? "Saving…" : exitDate ? "Correct the day" : "Record the exit"}
        </button>
      </div>
      {error ? <p className={phxFormErrorClassName}>{error}</p> : null}
      {message ? <p className="text-phx-sm font-semibold text-slate-800">{message}</p> : null}
    </div>
  );
}

const NO_RECEIPT_STATUS: Record<NonNullable<Panel["withoutReceipt"]>["status"], string> = {
  pending: "Waiting for the CEO's decision",
  approved: "Approved by the CEO — the order stands without a receipt",
  refused: "Refused by the CEO — the order still owes its receipt",
};

/**
 * Asking the CEO to let an order stand without a delivery receipt, and his decision. Finance asks
 * with a reason; only the CEO decides. The server checks both again.
 */
function NoReceiptSection({ requestId, panel }: { requestId: string; panel: Panel }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [deciding, setDeciding] = useState<"approve" | "refuse" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = panel.withoutReceipt;
  if (!ask && !panel.mayAskWithoutReceipt) return null;

  async function post(body: Record<string, unknown>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      setMessage(await postReceipt(requestId, body, fallback));
      setAsking(false);
      setDeciding(null);
      setReason("");
      setNote("");
      router.refresh();
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <p className="text-phx-xs font-black uppercase tracking-wider text-slate-500">Without a receipt — the CEO decides</p>
      {ask ? (
        <div className="space-y-1">
          <p className={cn("text-phx-sm font-bold", ask.status === "refused" ? "text-rose-700" : "text-slate-900")}>{NO_RECEIPT_STATUS[ask.status]}</p>
          <p className="break-words text-phx-sm text-slate-700" dir="auto">
            Finance{ask.askedByName ? ` (${ask.askedByName})` : ""} asked on {cairoDateTime(ask.askedAt)}: {ask.reason}
          </p>
          {ask.decidedAt ? (
            <p className="break-words text-phx-sm text-slate-700" dir="auto">
              {ask.status === "approved" ? "Approved" : "Refused"}
              {ask.decidedByName ? ` by ${ask.decidedByName}` : ""} on {cairoDateTime(ask.decidedAt)}
              {ask.note ? `: ${ask.note}` : "."}
            </p>
          ) : null}
        </div>
      ) : null}

      {panel.mayDecideWithoutReceipt && !message ? (
        deciding ? (
          <div className="space-y-2">
            <FormField
              label={deciding === "approve" ? "Note (optional)" : "Why is the request refused"}
              required={deciding === "refuse"}
              htmlFor={`no-receipt-note-${requestId}`}
            >
              <input
                className={phxFieldClassName}
                dir="auto"
                id={`no-receipt-note-${requestId}`}
                onChange={(event) => setNote(event.target.value)}
                value={note}
              />
            </FormField>
            <p className="text-phx-xs text-slate-500">
              {deciding === "approve"
                ? "The order will stand without a delivery receipt and leaves Finance's missing-receipt list. This cannot be changed afterwards."
                : "The order keeps owing its delivery receipt. Finance can ask again with a new reason."}
            </p>
            {error ? <p className={phxFormErrorClassName}>{error}</p> : null}
            <ApprovalConfirmButtons
              busy={busy}
              confirmLabel={deciding === "approve" ? "Yes, approve without a receipt" : "Yes, refuse the request"}
              disabled={deciding === "refuse" && note.trim().length < 3}
              onCancel={() => {
                setDeciding(null);
                setError(null);
              }}
              onConfirm={() => void post({ action: "decide_without_receipt", decision: deciding, note }, "Could not save the decision.")}
            />
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button className={approvalActionClassName("approve", "regular", "flex-1 md:flex-none")} onClick={() => setDeciding("approve")} type="button">
              Approve without a receipt
            </button>
            <button className={approvalActionClassName("reject", "regular", "flex-1 md:flex-none")} onClick={() => setDeciding("refuse")} type="button">
              Refuse
            </button>
          </div>
        )
      ) : null}

      {panel.mayAskWithoutReceipt && !message ? (
        asking ? (
          <div className="space-y-2">
            <FormField label="Why will this order have no delivery receipt" required htmlFor={`no-receipt-reason-${requestId}`}>
              <input
                className={phxFieldClassName}
                dir="auto"
                id={`no-receipt-reason-${requestId}`}
                onChange={(event) => setReason(event.target.value)}
                placeholder="The venue refused to sign and stamp the page"
                value={reason}
              />
            </FormField>
            <p className="text-phx-xs text-slate-500">
              Only the CEO can let an order stand without a receipt. The request reaches the CEO&apos;s Needs action list and is decided on this order.
            </p>
            {error ? <p className={phxFormErrorClassName}>{error}</p> : null}
            <ApprovalConfirmButtons
              busy={busy}
              confirmLabel="Send to the CEO"
              disabled={reason.trim().length < 3}
              onCancel={() => {
                setAsking(false);
                setError(null);
              }}
              onConfirm={() => void post({ action: "ask_without_receipt", reason }, "Could not send the request.")}
            />
          </div>
        ) : (
          <button className={phxButtonGhostClassName} onClick={() => setAsking(true)} type="button">
            Ask the CEO to approve it without a receipt
          </button>
        )
      ) : null}
      {message ? <p className="text-phx-sm font-semibold text-slate-800">{message}</p> : null}
    </div>
  );
}
