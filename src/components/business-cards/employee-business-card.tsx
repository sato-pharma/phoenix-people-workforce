"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Download, IdCard, Loader2, RefreshCw, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CARD_FIELD_MAX_LENGTH } from "@/lib/business-cards/card-content";
import {
  type BusinessCardRequestRow,
  type BusinessCardRequestStatus,
  type OwnBusinessCard,
} from "@/lib/business-cards/request-types";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";

// The employee's own card — shown as the REAL Sato Pharma card (front and back, the same
// print-ready PDF the HR generator produces), editable in the two lines that are theirs (name and
// mobile), downloadable as a high-quality printable PDF, and requestable from HR. Email, job title,
// line·area and the company details come from the register and are never editable here (owner).

const STATUS_VARIANT: Record<BusinessCardRequestStatus, "neutral" | "success" | "warning" | "danger"> = {
  Pending: "warning",
  "In Progress": "neutral",
  Printed: "success",
  Cancelled: "neutral",
};

// Square edges everywhere — the golden rule.
const inputClassName =
  "h-10 rounded-none border-phx-line bg-white/95 text-sm shadow-sm focus:border-phx-accent-line focus:ring-phx-accent/15";
const labelClassName = "mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";

function formatDate(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatStableEnGb(date, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
  });
}

function safeFileName(name: string): string {
  const safe = name.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `business-card-${safe || "card"}.pdf`;
}

export function EmployeeBusinessCard({
  card,
  initialRequests,
}: {
  card: OwnBusinessCard;
  initialRequests: BusinessCardRequestRow[];
}) {
  const [name, setName] = useState(card.name);
  const [mobile, setMobile] = useState(card.mobile);
  const [note, setNote] = useState("");
  const [requests, setRequests] = useState<BusinessCardRequestRow[]>(initialRequests);

  // The rendered card (the real PDF, front and back).
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  // The request-to-HR flow.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSent, setJustSent] = useState(false);

  const trimmedName = name.trim();

  // Render the caller's own card server-side and hand back the print-ready PDF bytes.
  const fetchOwnCardPdf = useCallback(async (): Promise<Blob> => {
    const response = await fetch("/api/business-cards/mine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardName: name.trim(), cardMobile: mobile.trim() }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(payload?.message ?? "Your card could not be generated.");
    }
    return response.blob();
  }, [mobile, name]);

  const refreshPreview = useCallback(async () => {
    setGenerating(true);
    setPreviewError(null);
    try {
      const blob = await fetchOwnCardPdf();
      const url = URL.createObjectURL(blob);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setPdfUrl(url);
    } catch (caught) {
      setPreviewError(caught instanceof Error ? caught.message : "Your card could not be generated.");
    } finally {
      setGenerating(false);
    }
  }, [fetchOwnCardPdf]);

  // First render is immediate; edits regenerate the preview 800ms after typing stops.
  useEffect(() => {
    const first = urlRef.current === null;
    const timer = window.setTimeout(() => void refreshPreview(), first ? 0 : 800);
    return () => window.clearTimeout(timer);
  }, [refreshPreview]);

  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  async function download() {
    if (!trimmedName) {
      setPreviewError("Please keep a name on the card before downloading.");
      return;
    }
    setDownloading(true);
    setPreviewError(null);
    try {
      const blob = await fetchOwnCardPdf();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = safeFileName(trimmedName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (caught) {
      setPreviewError(caught instanceof Error ? caught.message : "Your card could not be downloaded.");
    } finally {
      setDownloading(false);
    }
  }

  async function sendRequest() {
    if (!trimmedName) {
      setError("Please keep a name on the card before sending the request.");
      return;
    }
    setBusy(true);
    setError(null);
    setJustSent(false);
    try {
      const response = await fetch("/api/business-card-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardName: trimmedName, cardMobile: mobile.trim(), note: note.trim() || null }),
      });
      const payload = (await response.json().catch(() => null)) as { item?: BusinessCardRequestRow; message?: string } | null;
      if (!response.ok || !payload?.item) {
        throw new Error(payload?.message ?? "Your request could not be sent. Please try again.");
      }
      setRequests((current) => [payload.item as BusinessCardRequestRow, ...current]);
      setNote("");
      setJustSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your request could not be sent. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* The real card — front and back, the same Sato Pharma design HR prints. */}
      <section className="border border-phx-line bg-phx-paper p-4 sm:p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
            <IdCard className="h-4 w-4 text-phx-accent-press" />
            Your card — front and back
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="h-9 rounded-none"
              disabled={generating || downloading}
              onClick={() => void refreshPreview()}
              size="sm"
              type="button"
              variant="outline"
            >
              {generating ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Update preview
            </Button>
            <Button
              className="h-9 rounded-none"
              disabled={downloading || generating || !trimmedName}
              onClick={() => void download()}
              size="sm"
              type="button"
            >
              {downloading ? <Loader2 className="animate-spin" /> : <Download />}
              Download printable PDF
            </Button>
          </div>
        </div>

        <div className="relative border border-slate-300 bg-slate-100">
          {pdfUrl ? (
            <iframe
              className="h-[560px] w-full bg-slate-100"
              src={`${pdfUrl}#toolbar=0&navpanes=0&view=FitH`}
              title="Your business card — front and back"
            />
          ) : (
            <div className="flex h-[560px] w-full items-center justify-center text-sm font-semibold text-phx-ink-soft">
              {previewError ? previewError : "Preparing your card…"}
            </div>
          )}
          {generating && pdfUrl ? (
            <div className="absolute right-3 top-3 flex items-center gap-1.5 bg-white/90 px-2 py-1 text-phx-xs font-semibold text-phx-ink-soft shadow">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Updating…
            </div>
          ) : null}
        </div>
        {previewError && pdfUrl ? (
          <p className="mt-2 text-phx-sm font-semibold text-rose-700" role="status">
            {previewError}
          </p>
        ) : null}
        <p className="mt-2 text-phx-xs text-phx-ink-soft">
          High-quality, print-ready PDF — page one is the front, page two is the back. It shows your edits as you make
          them.
        </p>
      </section>

      {/* Edit the two lines that are yours, then download or request. */}
      <section className="border border-slate-200/90 bg-white/95 p-4 shadow-[0_12px_32px_rgba(15,23,42,0.06)] sm:p-6">
        <p className="text-sm font-semibold text-phx-ink-soft">
          You can correct your name and number. Everything else — your job title, line, email and the company
          details — is taken from your record and can only be changed by HR.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <label className={labelClassName} htmlFor="business-card-name">
              Name
            </label>
            <Input
              className={inputClassName}
              id="business-card-name"
              maxLength={CARD_FIELD_MAX_LENGTH}
              onChange={(event) => setName(event.target.value)}
              placeholder="The name to print"
              value={name}
            />
          </div>
          <div className="min-w-0">
            <label className={labelClassName} htmlFor="business-card-mobile">
              Mobile number
            </label>
            <Input
              className={inputClassName}
              id="business-card-mobile"
              maxLength={CARD_FIELD_MAX_LENGTH}
              onChange={(event) => setMobile(event.target.value)}
              placeholder="The number to print"
              value={mobile}
            />
          </div>
          <div className="min-w-0">
            <label className={labelClassName} htmlFor="business-card-email">
              Email (not editable)
            </label>
            <Input
              className={`${inputClassName} bg-slate-100 text-slate-500`}
              disabled
              id="business-card-email"
              readOnly
              value={card.email || "No email on file"}
            />
          </div>
          <div className="min-w-0">
            <label className={labelClassName} htmlFor="business-card-note">
              Note to HR (optional)
            </label>
            <Input
              className={inputClassName}
              id="business-card-note"
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
              placeholder="e.g. how many cards you need"
              value={note}
            />
          </div>
        </div>

        {error ? (
          <p className="mt-3 text-phx-sm font-semibold text-rose-700" role="status">
            {error}
          </p>
        ) : null}
        {justSent ? (
          <p className="mt-3 flex items-center gap-1.5 text-phx-sm font-semibold text-emerald-700" role="status">
            <Check className="h-4 w-4" />
            Sent to HR — they have been notified. Your request is listed below and on the HR queue.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button className="h-10 rounded-none" disabled={busy || !trimmedName} onClick={() => void sendRequest()} type="button">
            {busy ? <Loader2 className="animate-spin" /> : <Send />}
            Request business cards from HR
          </Button>
          <span className="text-phx-xs font-semibold text-phx-ink-soft">
            You can download it yourself above, or ask HR to print it for you.
          </span>
        </div>
      </section>

      {/* The employee's own past requests. */}
      {requests.length > 0 ? (
        <section className="border border-slate-200/90 bg-white/95 p-4 shadow-[0_12px_32px_rgba(15,23,42,0.06)] sm:p-6">
          <p className="mb-3 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Your requests</p>
          <ul className="divide-y divide-slate-100">
            {requests.map((request) => (
              <li className="flex flex-wrap items-center justify-between gap-2 py-2.5" key={request.id}>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-phx-ink">{request.cardName}</p>
                  <p className="text-phx-xs text-phx-ink-soft">
                    {[request.cardMobile, formatDate(request.createdAt)].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <Badge variant={STATUS_VARIANT[request.status]}>{request.status}</Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
