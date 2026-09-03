"use client";

import Link from "next/link";
import { Building2, MapPin, Search, ShoppingCart, Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { CustomerRegister } from "@/lib/customer-360/subject";

export type Customer360ListItem = {
  areaCode: string | null;
  areaName: string | null;
  codeCount: number;
  displayName: string;
  id: string;
  lineName: string | null;
  ownerName: string | null;
  register: CustomerRegister;
  regionName: string | null;
  validationStatus: string | null;
  venueType: string | null;
};

type RegisterTab = "all" | CustomerRegister;

const TABS: { key: RegisterTab; label: string }[] = [
  { key: "all", label: "All customers" },
  { key: "marketing", label: "Marketing" },
  { key: "direct-order", label: "Direct orders" },
];

const REGISTER_META: Record<CustomerRegister, { label: string; tone: string }> = {
  "direct-order": { label: "Direct orders", tone: "bg-sky-50 text-sky-700 ring-sky-200" },
  marketing: { label: "Marketing", tone: "bg-orange-50 text-orange-700 ring-orange-200" },
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const joined = parts.map((part) => part[0] ?? "").join("");
  return joined ? joined.toUpperCase() : "—";
}

export function CustomerSearchList({ customers }: { customers: Customer360ListItem[] }) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<RegisterTab>("all");
  const [area, setArea] = useState("");

  const areas = useMemo(
    () =>
      Array.from(new Set(customers.map((c) => c.areaName).filter((v): v is string => Boolean(v)))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [customers],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return customers.filter((customer) => {
      if (tab !== "all" && customer.register !== tab) return false;
      if (area && customer.areaName !== area) return false;
      if (!needle) return true;
      return [customer.displayName, customer.areaName, customer.regionName, customer.ownerName, customer.lineName]
        .filter(Boolean)
        .some((value) => (value as string).toLowerCase().includes(needle));
    });
  }, [area, customers, query, tab]);

  const hasFilters = Boolean(query.trim()) || tab !== "all" || Boolean(area);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((entry) => {
          const count =
            entry.key === "all" ? customers.length : customers.filter((c) => c.register === entry.key).length;
          const active = tab === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              aria-pressed={active}
              className={
                active
                  ? "rounded-full bg-slate-900 px-3 py-1.5 text-[13px] font-bold text-white"
                  : "rounded-full bg-white px-3 py-1.5 text-[13px] font-bold text-slate-600 ring-1 ring-slate-200 hover:ring-slate-300"
              }
            >
              {entry.label}
              <span className="ml-1.5 text-[11px] font-black opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative flex-1">
          <span className="sr-only">Search customers</span>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by pharmacy, area, region or owner"
            className="w-full rounded-[14px] border border-slate-200 bg-white py-2 pl-9 pr-3 text-[13px] font-medium text-slate-900 outline-none placeholder:text-slate-400 focus:border-orange-300"
          />
        </label>
        <label className="sm:w-56">
          <span className="sr-only">Filter by area</span>
          <select
            value={area}
            onChange={(event) => setArea(event.target.value)}
            className="w-full rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-[13px] font-semibold text-slate-700 outline-none focus:border-orange-300"
          >
            <option value="">All areas</option>
            {areas.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center justify-between gap-3 text-[12px] font-semibold text-slate-500">
        <span>
          {filtered.length} of {customers.length} customers
        </span>
        {hasFilters ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setTab("all");
              setArea("");
            }}
            className="inline-flex items-center gap-1 font-bold text-orange-600 hover:underline"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
            Clear
          </button>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-[18px] border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-[13px] font-semibold text-slate-500">No customer matches those filters.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((customer) => (
            <li key={customer.id}>
              <CustomerCard customer={customer} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CustomerCard({ customer }: { customer: Customer360ListItem }) {
  const meta = REGISTER_META[customer.register];
  return (
    <Link
      href={`/customer-360/${encodeURIComponent(customer.id)}`}
      className="group flex h-full items-start gap-3 rounded-[16px] border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-orange-300 hover:shadow-[0_16px_32px_rgba(15,23,42,0.08)]"
    >
      <span
        aria-hidden
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-700 to-slate-900 text-[11px] font-black text-white"
      >
        {initials(customer.displayName)}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        {/* Wraps rather than truncating — a pharmacy name a reader cannot finish is not a name. */}
        <p dir="auto" className="break-words text-[13px] font-bold leading-5 text-slate-900">{customer.displayName}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide ring-1 ${meta.tone}`}>
            {customer.register === "marketing" ? (
              <Sparkles aria-hidden className="h-3 w-3" />
            ) : (
              <ShoppingCart aria-hidden className="h-3 w-3" />
            )}
            {meta.label}
          </span>
          {customer.codeCount > 0 ? (
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-black text-slate-600">
              {customer.codeCount} {customer.codeCount === 1 ? "code" : "codes"}
            </span>
          ) : (
            <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-black text-amber-700 ring-1 ring-amber-200">
              No distributor code
            </span>
          )}
        </div>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] font-semibold text-slate-500">
          <MapPin aria-hidden className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          <span className="break-words">{customer.areaName || "No area"}</span>
          {customer.regionName ? <span className="break-words">· {customer.regionName}</span> : null}
        </p>
        {customer.ownerName ? (
          <p className="flex flex-wrap items-center gap-1.5 text-[12px] font-semibold text-slate-500">
            <Building2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span dir="auto" className="break-words">{customer.ownerName}</span>
          </p>
        ) : null}
      </div>
    </Link>
  );
}
