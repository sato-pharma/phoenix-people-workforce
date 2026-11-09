"use client";

// The two "I only have half the key" lookups, sitting ABOVE the distributor picker on purpose:
// both questions are asked precisely when the distributor is the unknown, so scoping them to a
// selected distributor would defeat them.
//
// The customer-code answer is allowed to REFUSE, and that refusal is the feature rather than a
// shortfall. 3,156 codes on production are used by two distributors and 544 of those land on a
// different brick, 141 in a different area — guessing there moves a sale between governorates.
// When that happens this panel shows both candidates and makes a person choose.

import { useCallback, useState } from "react";
import { Download, Loader2, Search } from "lucide-react";

import type { CodeLookupResult, TerritoryLookupResult } from "@/lib/sales/mapping-lookup";
import { cn } from "@/lib/utils";
import {
  phxFieldClassName,
  phxLabelTextClassName,
} from "@/components/ui/form-tokens";

const panel = "border border-phx-line bg-white/95";
const label = phxLabelTextClassName;
const field = `${phxFieldClassName} min-w-0`;
const goBtn = "inline-flex h-9 shrink-0 items-center gap-1.5 border border-phx-line bg-[#0B0B0B] px-3 text-xs font-black text-white transition hover:opacity-90 disabled:opacity-60";

type CodePayload = { success?: boolean; error?: string; result?: CodeLookupResult };
type TerritoryPayload = { success?: boolean; error?: string; result?: TerritoryLookupResult };

type Tone = "bad" | "good" | "warn";

// One verdict line per status. The wording is deliberate: "choose" never says "not found", because
// the map DOES know this code — it knows two incompatible answers for it.
const CODE_VERDICT: Record<CodeLookupResult["status"], { text: string; tone: Tone }> = {
  choose: { text: "Two distributors use this code and they sit in different territories. Pick the right one — this cannot be answered from the code alone.", tone: "bad" },
  not_found: { text: "No customer in the map carries this code.", tone: "warn" },
  resolved: { text: "One distributor uses this code.", tone: "good" },
  resolved_multi_distributor: { text: "Two distributors use this code, but both land on the same brick — the territory is the same either way.", tone: "warn" },
};

const TERRITORY_VERDICT: Record<TerritoryLookupResult["status"], { text: string; tone: Tone }> = {
  ambiguous: { text: "This name is used by two different territories, so the import pipeline refuses it too. It needs an owner decision, not a lookup.", tone: "bad" },
  area_only: { text: "An area alias answers this, but no brick does. Write the area; the brick is still an open question.", tone: "warn" },
  brick: { text: "A brick alias answers this outright.", tone: "good" },
  unresolved: { text: "Nothing in either alias table matches. A bare territory text has no other route — a brick NAME is deliberately not one.", tone: "warn" },
};

const TONE_CLASS: Record<Tone, string> = { bad: "text-rose-700", good: "text-emerald-700", warn: "text-amber-700" };

function Verdict({ text, tone }: { text: string; tone: Tone }) {
  return <p className={cn("text-sm font-bold", TONE_CLASS[tone])}>{text}</p>;
}

function Row({ name, value }: { name: string; value: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className={label}>{name}</span>
      <span dir="auto" className="min-w-0 break-words text-sm font-semibold text-phx-ink">{value?.trim() ? value : "—"}</span>
    </div>
  );
}

function territoryLine(candidate: CodeLookupResult["candidates"][number]): string {
  return [candidate.areaName?.trim() || candidate.areaCode, candidate.regionCode].filter(Boolean).join(" · ") || "no area";
}

// Desktop gets the table, mobile gets cards — the admin shell rule, and here it is load-bearing
// rather than cosmetic: at 375px a three-column head puts "DISTRIBUTOR" straight through the
// "CUSTOMER" heading beside it. That collision is CLIPPING, so `scrollWidth > clientWidth` reports
// a clean 375 while the header is unreadable. Do not "simplify" this back to one table.
//
// Three columns, not six: the fits-the-screen rule says merge columns rather than shrink type, so
// brick / area / region ride together in one wrapping cell.
function CandidateTable({ result }: { result: CodeLookupResult }) {
  return (
    <>
      <div className="space-y-2 md:hidden">
        {result.candidates.map((candidate) => (
          <div className="border border-phx-line bg-white p-2" key={`c-${candidate.distributorCode}:${candidate.customerCode}`}>
            <Row name="Distributor" value={candidate.distributorCode} />
            <Row name="Customer" value={candidate.customerName} />
            {candidate.address?.trim() ? <Row name="Address" value={candidate.address} /> : null}
            <Row name="Brick" value={candidate.brickName?.trim() || candidate.brickId || "unmapped"} />
            <Row name="Area" value={territoryLine(candidate)} />
          </div>
        ))}
      </div>

      <table className="hidden w-full table-fixed border-collapse text-left md:table">
        <colgroup>
          <col className="w-[22%]" />
          <col className="w-[40%]" />
          <col className="w-[38%]" />
        </colgroup>
        <thead>
          <tr className="bg-[#020617] text-phx-xs font-black uppercase tracking-[0.12em] text-white">
            <th className="break-words px-2 py-1.5">Distributor</th>
            <th className="break-words px-2 py-1.5">Customer</th>
            <th className="break-words px-2 py-1.5">Territory</th>
          </tr>
        </thead>
        <tbody>
          {result.candidates.map((candidate) => (
            <tr className="border-b border-phx-line align-top" key={`${candidate.distributorCode}:${candidate.customerCode}`}>
              <td className="px-2 py-2 text-sm font-black text-phx-ink">{candidate.distributorCode}</td>
              <td className="px-2 py-2">
                <span dir="auto" className="block break-words text-sm font-semibold text-phx-ink">{candidate.customerName?.trim() || "—"}</span>
                {candidate.address?.trim() ? <span dir="auto" className="mt-0.5 block break-words text-xs text-phx-ink-soft">{candidate.address}</span> : null}
              </td>
              <td className="px-2 py-2">
                <span className="block break-words text-sm font-bold text-phx-ink">{candidate.brickName?.trim() || candidate.brickId || "unmapped"}</span>
                <span className="mt-0.5 block break-words text-xs text-phx-ink-soft">{territoryLine(candidate)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function MappingLookupPanel() {
  const [code, setCode] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeResult, setCodeResult] = useState<CodeLookupResult | null>(null);

  const [territory, setTerritory] = useState("");
  const [territoryBusy, setTerritoryBusy] = useState(false);
  const [territoryError, setTerritoryError] = useState<string | null>(null);
  const [territoryResult, setTerritoryResult] = useState<TerritoryLookupResult | null>(null);

  const runCode = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    setCodeBusy(true);
    setCodeError(null);
    setCodeResult(null);
    try {
      const res = await fetch(`/api/sales/mapping-database/lookup?code=${encodeURIComponent(value)}`);
      const payload = (await res.json()) as CodePayload;
      if (payload.success && payload.result) setCodeResult(payload.result);
      else setCodeError(payload.error ?? "Lookup failed.");
    } catch (caught) {
      setCodeError(caught instanceof Error ? caught.message : "Lookup failed.");
    } finally {
      setCodeBusy(false);
    }
  }, []);

  const runTerritory = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    setTerritoryBusy(true);
    setTerritoryError(null);
    setTerritoryResult(null);
    try {
      const res = await fetch(`/api/sales/mapping-database/lookup?territory=${encodeURIComponent(value)}`);
      const payload = (await res.json()) as TerritoryPayload;
      if (payload.success && payload.result) setTerritoryResult(payload.result);
      else setTerritoryError(payload.error ?? "Lookup failed.");
    } catch (caught) {
      setTerritoryError(caught instanceof Error ? caught.message : "Lookup failed.");
    } finally {
      setTerritoryBusy(false);
    }
  }, []);

  return (
    <section className={cn(panel, "p-4")}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-sm font-black uppercase tracking-[0.12em] text-phx-ink">Look it up</h2>
          <p className="mt-1 text-xs font-medium text-phx-ink-soft">
            Paste what you have. A customer code finds its distributor; a district or brick name finds its
            territory. Either can answer that it does not know, which is the honest answer rather than a guess.
          </p>
        </div>
        {/* The same two answers, in a workbook that needs no login and no internet. Built fresh on
            every click, never a stored file: a mapping snapshot goes wrong silently the moment
            someone edits a mapping here, and nothing on its face would say so. */}
        <a
          className="inline-flex h-9 shrink-0 items-center gap-1.5 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink-2 transition hover:border-phx-accent-line"
          href="/api/sales/mapping-database/offline-workbook"
        >
          <Download className="h-4 w-4" /> Offline copy (.xlsx)
        </a>
      </div>
      <p className="mt-2 text-phx-sm font-semibold text-phx-ink-faint">
        The offline copy is a snapshot of this moment. Download it again whenever the answer matters.
      </p>

      <div className="mt-3 grid gap-4 md:grid-cols-2">
        {/* customer code, distributor unknown */}
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void runCode(code); }}>
          <label className={label} htmlFor="lookup-code">Customer code — distributor unknown</label>
          <div className="flex gap-2">
            <input
              className={cn(field, "font-mono")}
              id="lookup-code"
              onChange={(event) => setCode(event.target.value)}
              placeholder="e.g. 0001500013"
              value={code}
            />
            <button className={goBtn} disabled={codeBusy || !code.trim()} type="submit">
              {codeBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Find
            </button>
          </div>
          <p className="text-phx-sm font-semibold text-phx-ink-faint">
            Leading zeros are part of the code, not formatting — they are never stripped.
          </p>

          {codeError ? <p className="text-sm font-bold text-rose-700">{codeError}</p> : null}
          {codeResult ? (
            <div className="space-y-2 border border-phx-line bg-[#FCFDFE] p-3">
              <Verdict text={CODE_VERDICT[codeResult.status].text} tone={CODE_VERDICT[codeResult.status].tone} />
              {codeResult.candidates.length > 0 ? <CandidateTable result={codeResult} /> : null}
              {codeResult.status === "choose" && codeResult.agreesOnArea ? (
                <p className="text-xs font-semibold text-phx-ink-soft">
                  Both sit in the same area, but the brick differs — and the brick is what gets written.
                </p>
              ) : null}
              {codeResult.variants.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-xs font-bold text-phx-ink-soft">
                    The same digits spelled differently DO exist. That is a different customer until you confirm otherwise:
                  </p>
                  {codeResult.variants.map((variant) => (
                    <button
                      className="block border border-dashed border-phx-line px-2 py-1 text-left text-xs font-bold text-phx-accent-press hover:border-phx-accent-line"
                      key={variant.customerCode}
                      onClick={() => { setCode(variant.customerCode); void runCode(variant.customerCode); }}
                      type="button"
                    >
                      <span className="font-mono">{variant.customerCode}</span> — {variant.label}, {variant.candidates} row{variant.candidates === 1 ? "" : "s"}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </form>

        {/* territory text, no customer code */}
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void runTerritory(territory); }}>
          <label className={label} htmlFor="lookup-territory">District or brick text</label>
          <div className="flex gap-2">
            <input
              className={field}
              dir="auto"
              id="lookup-territory"
              onChange={(event) => setTerritory(event.target.value)}
              placeholder="e.g. الباجور"
              value={territory}
            />
            <button className={goBtn} disabled={territoryBusy || !territory.trim()} type="submit">
              {territoryBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Find
            </button>
          </div>
          <p className="text-phx-sm font-semibold text-phx-ink-faint">
            Matched exactly as the import pipeline matches it — spacing and ة / ه spelling both count.
          </p>

          {territoryError ? <p className="text-sm font-bold text-rose-700">{territoryError}</p> : null}
          {territoryResult ? (
            <div className="space-y-2 border border-phx-line bg-[#FCFDFE] p-3">
              <Verdict text={TERRITORY_VERDICT[territoryResult.status].text} tone={TERRITORY_VERDICT[territoryResult.status].tone} />
              {territoryResult.status === "brick" || territoryResult.status === "area_only" ? (
                <div className="space-y-1">
                  <Row name="Brick" value={territoryResult.brickName ?? territoryResult.brickId} />
                  <Row name="Area" value={territoryResult.areaName ?? territoryResult.areaCode} />
                  <Row name="Region" value={territoryResult.regionName ?? territoryResult.regionCode} />
                </div>
              ) : null}
              <p className="text-phx-sm font-semibold text-phx-ink-faint">
                Matched on: <span dir="auto" className="font-mono">{territoryResult.key || "(empty)"}</span>
              </p>
            </div>
          ) : null}
        </form>
      </div>
    </section>
  );
}
