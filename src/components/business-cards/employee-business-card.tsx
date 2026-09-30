"use client";

import { useState } from "react";
import { Check, Globe, IdCard, Loader2, Mail, MapPin, Phone, Send } from "lucide-react";

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

// The employee's own card, and the one place they may correct it before asking HR to print.
// Only Name and Mobile are editable (owner: email is never changed here); the title, line·area
// and email are the register's and shown read-only. Nothing here writes back to the record — the
// send button opens a request that lands on HR's consolidated queue.

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<BusinessCardRequestRow[]>(initialRequests);
  const [justSent, setJustSent] = useState(false);

  const trimmedName = name.trim();
  const dirty =
    trimmedName !== card.name.trim() || mobile.trim() !== card.mobile.trim() || note.trim().length > 0;

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
      {/* The card preview — what will print, with the edits live. */}
      <section className="border border-phx-line bg-phx-paper p-4 sm:p-6">
        <p className="mb-3 flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
          <IdCard className="h-4 w-4 text-phx-accent-press" />
          Your card
        </p>
        <article className="mx-auto w-full max-w-md border border-slate-300 bg-white p-5 shadow-[0_12px_32px_rgba(15,23,42,0.10)]">
          <h2 className="break-words text-lg font-black text-[#0A527D]">{trimmedName || "Your name"}</h2>
          {card.title ? (
            <p className="mt-0.5 text-phx-xs font-bold uppercase tracking-[0.12em] text-[#1482C2]">{card.title}</p>
          ) : null}
          {card.lineArea ? (
            <p className="mt-0.5 text-phx-xs font-semibold uppercase tracking-[0.1em] text-phx-ink-soft">{card.lineArea}</p>
          ) : null}
          <div className="mt-4 h-px w-full bg-slate-200" />
          <dl className="mt-4 space-y-1.5 text-phx-sm text-slate-700">
            {mobile.trim() ? (
              <div className="flex items-center gap-2">
                <Phone className="h-3.5 w-3.5 shrink-0 text-[#1482C2]" />
                <dd className="min-w-0 break-words">{mobile.trim()}</dd>
              </div>
            ) : null}
            {card.email ? (
              <div className="flex items-center gap-2">
                <Mail className="h-3.5 w-3.5 shrink-0 text-[#1482C2]" />
                <dd className="min-w-0 break-words">{card.email}</dd>
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <Globe className="h-3.5 w-3.5 shrink-0 text-[#1482C2]" />
              <dd className="min-w-0 break-words">{card.website}</dd>
            </div>
            <div className="flex items-start gap-2">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#1482C2]" />
              <dd className="min-w-0 break-words">{card.address}</dd>
            </div>
          </dl>
        </article>
      </section>

      {/* Edit the two lines that are yours, then send the request. */}
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
          {dirty ? <span className="text-phx-xs font-semibold text-phx-ink-soft">Your edits will be sent with the request.</span> : null}
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
