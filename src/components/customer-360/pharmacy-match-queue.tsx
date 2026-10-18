"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { MapPin, Store } from "lucide-react";
import { useMemo, useState, useTransition } from "react";

import { adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  phxButtonApproveClassName,
  phxButtonDangerClassName,
  phxButtonGhostClassName,
  phxCheckInputClassName,
  phxCheckTileClassName,
  phxFormErrorClassName,
} from "@/components/ui/form-tokens";
import type { MatchQueueItem, MatchQueueShop } from "@/lib/customer-360/match-queue";
import { cairoDate } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";

type Filter = "waiting" | "auto" | "confirmed" | "rejected";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "waiting", label: "Waiting" },
  { key: "auto", label: "Tied by the rule" },
  { key: "confirmed", label: "Confirmed" },
  { key: "rejected", label: "None of these" },
];

const egp = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

/**
 * The Super Admin's confirm tab (owner, 2026-10-18). Each item is one pharmacy name reps typed in one
 * brick; he confirms which shop it is, says none of these, or undoes a decision. The rule's own ties
 * are listed too, so he can audit them and overrule one with "None of these".
 */
export function PharmacyMatchQueue({ items, lastMonthsLabel }: { items: MatchQueueItem[]; lastMonthsLabel: string }) {
  const [filter, setFilter] = useState<Filter>("waiting");
  const counts = useMemo(() => {
    const out: Record<Filter, number> = { auto: 0, confirmed: 0, rejected: 0, waiting: 0 };
    for (const item of items) out[item.status] += 1;
    return out;
  }, [items]);
  const shown = items.filter((item) => item.status === filter);

  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-slate-600">
        A pharmacy a rep names on a visit is tied to the doctor automatically when exactly one shop with that name is in the
        brick where the doctor is validated. Every other name waits here for your decision. Sales shown are the closing&apos;s
        value over {lastMonthsLabel}.
      </p>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Pharmacy match status">
        {FILTERS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={filter === entry.key}
            onClick={() => setFilter(entry.key)}
            className={cn(
              "border px-3 py-1.5 text-phx-xs font-black uppercase tracking-wide transition",
              filter === entry.key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-600 hover:border-slate-400",
            )}
          >
            {entry.label} <span className="opacity-70">{counts[entry.key]}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="border border-dashed border-slate-300 bg-white p-8 text-center text-sm font-semibold text-slate-500">
          No pharmacy name is in this list.
        </div>
      ) : (
        <ul className="space-y-4">
          {shown.map((item) => (
            <li key={item.key}>
              <MatchCard item={item} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MatchCard({ item }: { item: MatchQueueItem }) {
  const router = useRouter();
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const send = (body: Record<string, unknown>) => {
    setError(null);
    startTransition(async () => {
      const response = await fetch("/api/customer-360/pharmacy-matches", {
        body: JSON.stringify({ brickId: item.brickId, nameKey: item.nameKey, typedExample: item.typedAs[0] ?? "", ...body }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "The decision could not be recorded.");
        return;
      }
      router.refresh();
    });
  };

  const toggle = (index: number) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <article className={cn("border border-slate-200 bg-white", adminPanelDepthClassName)}>
      <header className="flex flex-col gap-1 border-b border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-phx-2xs font-black uppercase tracking-[0.15em] text-slate-500">Named on a visit</p>
        <h3 dir="auto" className="break-words text-base font-black text-slate-900">
          {item.typedAs.join(" · ")}
        </h3>
        <p className="break-words text-xs font-semibold text-slate-500">
          {[item.brickName ? `Brick ${item.brickName}` : "No brick on the visit's place", item.areaName].filter(Boolean).join(" · ")}
        </p>
        {item.reasonText ? <p className="text-xs font-bold text-amber-700">{item.reasonText}</p> : null}
        {item.decidedAt ? <p className="text-xs font-semibold text-slate-500">Decided on {cairoDate(item.decidedAt)}</p> : null}
      </header>

      <div className="space-y-4 p-4">
        <section>
          <h4 className="text-phx-2xs font-black uppercase tracking-[0.15em] text-slate-500">Where it was named</h4>
          <ul className="mt-2 divide-y divide-slate-100 border border-slate-200">
            {item.sightings.map((sighting, index) => (
              <li key={`${sighting.customerHref}-${sighting.visitDate}-${index}`} className="space-y-0.5 px-3 py-2 text-xs text-slate-600">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <Link dir="auto" href={sighting.customerHref} className="break-words font-bold text-slate-900 hover:text-orange-700 hover:underline">
                    {sighting.customerName}
                  </Link>
                  <span className="font-semibold text-slate-400">{sighting.customerKind}</span>
                </p>
                <p className="break-words">
                  {sighting.repName} · {sighting.lineLabel} · {cairoDate(sighting.visitDate)} · typed <span dir="auto">“{sighting.typed}”</span>
                </p>
                <p className="flex flex-wrap items-center gap-1.5 break-words">
                  <MapPin aria-hidden className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span dir="auto">{sighting.address || "No address on the validated place"}</span>
                  {sighting.mapUrl ? (
                    <a href={sighting.mapUrl} target="_blank" rel="noreferrer" className="font-bold text-orange-700 hover:underline">
                      Open the validated location
                    </a>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {item.tied.length > 0 ? (
          <section>
            <h4 className="text-phx-2xs font-black uppercase tracking-[0.15em] text-slate-500">
              {item.status === "auto" ? "Tied by the rule" : "Tied"}
            </h4>
            <ul className="mt-2 space-y-2">
              {item.tied.map((shop, index) => (
                <li key={index}>
                  <ShopDetails shop={shop} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {item.status === "waiting" ? (
          <section>
            <h4 className="text-phx-2xs font-black uppercase tracking-[0.15em] text-slate-500">Which shop is it?</h4>
            {item.candidates.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">No shop on the sales customer map fits this name.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {item.candidates.map((shop, index) => (
                  <li key={index}>
                    <label className={cn(phxCheckTileClassName(picked.has(index)), "items-start")}>
                      <input type="checkbox" className={cn(phxCheckInputClassName, "mt-1")} checked={picked.has(index)} onChange={() => toggle(index)} />
                      <ShopDetails shop={shop} bare />
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {error ? <p className={phxFormErrorClassName}>{error}</p> : null}

        <div className="flex flex-wrap gap-2">
          {item.status === "waiting" ? (
            <>
              <button
                type="button"
                disabled={pending || picked.size === 0}
                onClick={() => send({ action: "confirm", pairs: [...picked].flatMap((index) => item.candidatePairs[index] ?? []) })}
                className={phxButtonApproveClassName}
              >
                Confirm this pharmacy
              </button>
              <button type="button" disabled={pending} onClick={() => send({ action: "reject" })} className={phxButtonDangerClassName}>
                None of these
              </button>
            </>
          ) : null}
          {item.status === "auto" ? (
            <button type="button" disabled={pending} onClick={() => send({ action: "reject" })} className={phxButtonDangerClassName}>
              None of these
            </button>
          ) : null}
          {item.status === "confirmed" || item.status === "rejected" ? (
            <button type="button" disabled={pending} onClick={() => send({ action: "undo" })} className={phxButtonGhostClassName}>
              Undo
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function ShopDetails({ shop, bare = false }: { shop: MatchQueueShop; bare?: boolean }) {
  return (
    <div className={cn("min-w-0 flex-1 space-y-1 text-xs text-slate-600", bare ? "" : "border border-slate-200 p-3")}>
      <p className="flex flex-wrap items-center gap-1.5">
        <Store aria-hidden className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <span dir="auto" className="break-words text-sm font-bold text-slate-900">
          {shop.name}
        </span>
      </p>
      {shop.why ? <p className="font-bold text-slate-500">{shop.why}</p> : null}
      <p dir="auto" className="break-words">
        {shop.address || "No address on the sales customer map"}
      </p>
      <p className="break-words">{[shop.brickName ? `Brick ${shop.brickName}` : null, shop.areaName].filter(Boolean).join(" · ") || "No brick recorded"}</p>
      <ul className="space-y-0.5">
        {shop.codes.map((code) => (
          <li key={`${code.distributorCode}-${code.customerCode}`} className="break-words">
            {code.distributorName} · customer {code.customerCode} · {egp(code.recentValue)}
          </li>
        ))}
      </ul>
    </div>
  );
}
