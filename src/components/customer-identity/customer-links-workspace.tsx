"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { CheckCheck, Link2, ListChecks, ShieldQuestion, Users } from "lucide-react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminSectionHeader,
  AdminStatCard,
} from "@/components/admin/admin-design-system";
import type {
  EvidenceBand,
  IdentityKind,
  IdentityMasterSummary,
  IdentitySuggestion,
  SuggestionCluster,
} from "@/lib/customer-identity/types";

/**
 * Phoenix CRM Wave 2 — where the Super Admin says who a customer IS.
 *
 * 🔴 IT WEARS THE ADMIN DESIGN SYSTEM, AND THE FIRST CUT DID NOT. `AdminPageHero`, `AdminStatCard`,
 * `AdminSectionHeader` and `AdminInsightChip` are what all 131 admin pages use; this screen shipped
 * with a hand-rolled header and hand-rolled figure tiles instead, which is exactly the one-off look
 * the owner's standing rule forbids ("before building new UI, match the sibling pages' exact design
 * identity"). Every heading, chip, tile and callout below is now the shared primitive, so a change
 * to the house look reaches this page like any other.
 *
 * 🔴 THE SCREEN ONLY EVER OFFERS (owner, 2026-09-30: the system suggests and HE confirms, "bulk or
 * by hand, full control"). Nothing links by itself, nothing is pre-ticked, and no action runs on a
 * timer. Every pair carries the reason it is offered in words he can check — never a score and
 * never a percentage — because what he is deciding is whether two records are one real person, and
 * a number cannot help him with that.
 *
 * 🔴 IT CHANGES NO SOURCE SYSTEM. Confirming is an annotation in `customer_identity_*`: nothing is
 * merged, renamed, re-territoried or removed in Phoenix CRM, marketing, the direct-order desk or
 * the iReports360 mirror, and no rep's board moves. That is the treasure rule, and it is why this
 * screen can be used freely — a wrong confirmation is undone by changing the link, not by
 * repairing four systems.
 *
 * Clustered rather than listed flat: production holds thousands of name groups, and a flat list of
 * pairs makes him decide the same name four times over.
 */

const SOURCE_LABEL: Record<string, string> = {
  direct_order: "Direct orders",
  ireports360: "iReports360",
  marketing: "Marketing register",
  phoenix_crm: "Phoenix CRM",
};

const BAND_LABEL: Record<EvidenceBand, string> = {
  fact: "Certain",
  likely: "Likely",
  possible: "Possible",
  strong: "Strong",
};

/** Certainty carries a colour, never a number — and the weakest band is grey, not red. */
const BAND_INK: Record<EvidenceBand, string> = {
  fact: "border-emerald-500 bg-emerald-50 text-emerald-700",
  likely: "border-amber-500 bg-amber-50 text-amber-800",
  possible: "border-slate-300 bg-slate-50 text-slate-500",
  strong: "border-sky-500 bg-sky-50 text-sky-700",
};

const KIND_LABEL: Record<IdentityKind, string> = { AM: "AM", PM: "PM", pharmacy: "Pharmacies" };

export function CustomerLinksWorkspace({
  clusters,
  kind,
  masters,
  totalClusters,
  totalPairs,
}: {
  clusters: SuggestionCluster[];
  kind: IdentityKind | null;
  /** What has already been confirmed — the way into each one's Customer 360. */
  masters: IdentityMasterSummary[];
  totalClusters: number;
  totalPairs: number;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: "danger" | "success" } | null>(null);
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());

  const byKey = useMemo(() => {
    const map = new Map<string, IdentitySuggestion>();
    for (const cluster of clusters) for (const pair of cluster.pairs) map.set(pair.pairKey, pair);
    return map;
  }, [clusters]);

  const toggle = useCallback((key: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleCluster = useCallback((pairs: readonly IdentitySuggestion[], on: boolean) => {
    setPicked((current) => {
      const next = new Set(current);
      for (const pair of pairs) {
        if (on) next.add(pair.pairKey);
        else next.delete(pair.pairKey);
      }
      return next;
    });
  }, []);

  /**
   * One path for one decision and for forty (owner: "bulk or by hand, full control"). The bulk
   * button posts the same array shape the single button does, so there is no second code path that
   * could skip a check — the commonest way a "confirm all" writes what the careful path refuses.
   */
  const decide = useCallback(
    async (action: "confirm" | "not_the_same", keys: readonly string[]) => {
      if (keys.length === 0 || busy) return;
      setBusy(true);
      setNote(null);
      try {
        const pairs = keys
          .map((key) => byKey.get(key))
          .filter((pair): pair is IdentitySuggestion => pair !== undefined)
          .map((pair) => ({
            band: pair.band,
            displayName: pair.left.name,
            kind: pair.kind,
            left: { source: pair.left.source, sourceId: pair.left.sourceId },
            right: { source: pair.right.source, sourceId: pair.right.sourceId },
          }));
        const response = await fetch("/api/customer-identity/decide", {
          body: JSON.stringify({ action, pairs }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          confirmed?: number;
          merged?: number;
          ruled?: number;
        };
        if (!response.ok) throw new Error(payload.error ?? "The decision could not be recorded.");
        setSettled((current) => new Set([...current, ...keys]));
        setPicked(new Set());
        // The merge is SAID, never silent: folding two identities into one is the biggest thing
        // this screen can do, and he should read that it happened rather than discover it later.
        const mergedSaid = payload.merged ? ` ${payload.merged === 1 ? "One identity was" : `${payload.merged} identities were`} folded into another.` : "";
        setNote({
          text:
            action === "confirm"
              ? `${payload.confirmed ?? keys.length} linked.${mergedSaid} Nothing in Phoenix CRM, marketing or the direct-order desk was changed.`
              : `${payload.ruled ?? keys.length} kept apart. You can undo this later and the pair comes back.`,
          tone: "success",
        });
      } catch (error) {
        setNote({ text: error instanceof Error ? error.message : "The decision could not be recorded.", tone: "danger" });
      } finally {
        setBusy(false);
      }
    },
    [busy, byKey],
  );

  const pickedKeys = useMemo(() => [...picked].filter((key) => !settled.has(key)), [picked, settled]);
  const liveClusters = clusters.filter((cluster) => cluster.pairs.some((pair) => !settled.has(pair.pairKey)));

  /**
   * Selecting a whole page at once — the half of "bulk or by hand, full control" that was missing.
   *
   * 🔴 THESE SELECT AND NOTHING ELSE. There is still no confirm-all on this screen: he presses
   * "Confirm these are the same" himself after reading what is ticked, exactly as before, and the
   * test pins that by counting the two places that may call `decide` with "confirm" — a button
   * that both selected and confirmed would add a third and go red. The difference is 2 presses
   * instead of 18 on a page of pharmacies, not a decision taken for him.
   *
   * "The certain ones" is scoped to the `fact` band because that is the band whose evidence needs
   * no judgement — the two rows carry the same contact id or the same code at one distributor. The
   * weaker bands rest on a name, a distance or a brick, and he reads those one at a time.
   *
   * 🔴 AND A CAUTIONED PAIR IS LEFT OUT OF IT — his choice on 2026-10-01, put to him with the
   * measurement that the test fires on exactly 1 of the 27 certain pharmacy pairs. A caution never
   * changes the band and refuses nothing: the pair is shown, it keeps its Certain chip, and he can
   * still tick it by hand or with "Everything on this page". What it may not do is ride in on ONE
   * press, because that press is the whole point of the control and the evidence says look.
   */
  const livePairsOnPage = liveClusters.flatMap((cluster) => cluster.pairs.filter((pair) => !settled.has(pair.pairKey)));
  const certainPairsOnPage = livePairsOnPage.filter((pair) => pair.band === "fact" && !pair.caution);

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4 p-3 sm:p-4" dir="auto">
      <AdminPageHero
        badges={
          <>
            <AdminInsightChip tone={totalClusters > 0 ? "orange" : "slate"}>{totalClusters} names to review</AdminInsightChip>
            <AdminInsightChip tone="slate">{totalPairs} pairs offered</AdminInsightChip>
            <AdminInsightChip tone={pickedKeys.length > 0 ? "orange" : "slate"}>{pickedKeys.length} selected</AdminInsightChip>
          </>
        }
        description="One doctor is held under a different record in Phoenix CRM, the marketing register, the direct-order desk and iReports360. These are the pairs worth a look. Nothing is linked until you confirm it, and confirming changes nothing in those four systems — it only records that they are one person."
        eyebrow="Phoenix CRM · Wave 2"
        icon={<Link2 className="h-3.5 w-3.5" />}
        title="Who is the same person"
      />

      <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
        <AdminStatCard
          description="Each is one decision about one person"
          icon={<Users className="h-5 w-5" />}
          label="Names to review"
          size="compact"
          tone="orange"
          value={totalClusters}
        />
        <AdminStatCard
          description="Across all four systems"
          icon={<ListChecks className="h-5 w-5" />}
          label="Pairs offered"
          size="compact"
          tone="blue"
          value={totalPairs}
        />
        <AdminStatCard
          description="On this page"
          icon={<ShieldQuestion className="h-5 w-5" />}
          label="Showing"
          size="compact"
          tone="violet"
          value={liveClusters.length}
        />
        <AdminStatCard
          description="Confirm or keep apart in one go"
          icon={<CheckCheck className="h-5 w-5" />}
          label="Selected"
          size="compact"
          tone={pickedKeys.length > 0 ? "emerald" : "blue"}
          value={pickedKeys.length}
        />
      </div>

      <div className="min-w-0 border border-slate-200/80 bg-white">
        <nav className="flex min-w-0 flex-wrap gap-2 px-5 py-4">
          {([null, "PM", "AM", "pharmacy"] as const).map((one) => (
            <a
              className={`border px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.1em] ${
                kind === one ? "border-orange-500 bg-orange-50 text-orange-700" : "border-slate-200 bg-white text-slate-600"
              }`}
              href={one ? `/admin/customer-links?kind=${one}` : "/admin/customer-links"}
              key={one ?? "all"}
            >
              {one ? KIND_LABEL[one] : "Everything"}
            </a>
          ))}
        </nav>

        {livePairsOnPage.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-slate-200/80 px-5 py-3">
            <p className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">Select</p>
            <button
              className="border border-emerald-500 bg-white px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-emerald-700 disabled:opacity-50"
              disabled={certainPairsOnPage.length === 0}
              onClick={() => toggleCluster(certainPairsOnPage, true)}
              type="button"
            >
              The certain ones ({certainPairsOnPage.length})
            </button>
            <button
              className="border border-slate-300 bg-white px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-700"
              onClick={() => toggleCluster(livePairsOnPage, true)}
              type="button"
            >
              Everything on this page ({livePairsOnPage.length})
            </button>
            {pickedKeys.length > 0 ? (
              <button
                className="px-2 py-1.5 text-phx-2xs font-bold uppercase tracking-[0.1em] text-slate-500"
                onClick={() => setPicked(new Set())}
                type="button"
              >
                Clear
              </button>
            ) : null}
            <p className="min-w-0 basis-full break-words text-phx-2xs font-semibold leading-4 text-slate-500">
              Selecting ticks the boxes. Nothing is recorded until you press a decision yourself.
            </p>
          </div>
        ) : null}
      </div>

      {/* The bulk bar appears only when something is selected, so the screen never offers a
          "confirm all" he did not ask for. */}
      {pickedKeys.length > 0 ? (
        <div className="sticky top-2 z-10 flex min-w-0 flex-wrap items-center gap-2 border border-orange-300 bg-orange-50 px-5 py-4">
          <p className="text-sm font-black text-orange-900">{pickedKeys.length} selected</p>
          <button
            className="border border-orange-600 bg-orange-600 px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-white disabled:opacity-50"
            disabled={busy}
            onClick={() => void decide("confirm", pickedKeys)}
            type="button"
          >
            Confirm these are the same
          </button>
          <button
            className="border border-slate-400 bg-white px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-700 disabled:opacity-50"
            disabled={busy}
            onClick={() => void decide("not_the_same", pickedKeys)}
            type="button"
          >
            Not the same
          </button>
          <button
            className="px-2 py-1.5 text-phx-2xs font-bold uppercase tracking-[0.1em] text-slate-500"
            onClick={() => setPicked(new Set())}
            type="button"
          >
            Clear
          </button>
        </div>
      ) : null}

      {note ? <AdminCallout tone={note.tone}>{note.text}</AdminCallout> : null}

      {liveClusters.length === 0 ? (
        <AdminCallout tone="success">Nothing is waiting. Every pair here has been decided.</AdminCallout>
      ) : null}

      {liveClusters.map((cluster) => {
        const live = cluster.pairs.filter((pair) => !settled.has(pair.pairKey));
        const allPicked = live.every((pair) => picked.has(pair.pairKey));
        return (
          <section className="min-w-0 border border-slate-200/80 bg-white" key={cluster.key}>
            <AdminSectionHeader
              action={
                <button
                  className="border border-slate-300 bg-white px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-700"
                  onClick={() => toggleCluster(live, !allPicked)}
                  type="button"
                >
                  {allPicked ? "Unselect this name" : "Select this name"}
                </button>
              }
              description={`${KIND_LABEL[cluster.kind]} · ${live.length === 1 ? "1 pair to decide" : `${live.length} pairs to decide`}`}
              title={cluster.name}
            />

            <ul className="divide-y divide-slate-200/80">
              {live.map((pair) => (
                <li className={`min-w-0 px-5 py-4 ${picked.has(pair.pairKey) ? "bg-orange-50/60" : ""}`} key={pair.pairKey}>
                  <label className="flex min-w-0 cursor-pointer items-start gap-3">
                    <input
                      checked={picked.has(pair.pairKey)}
                      className="mt-1 h-4 w-4 shrink-0 accent-orange-600"
                      onChange={() => toggle(pair.pairKey)}
                      type="checkbox"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className={`border px-2 py-px text-phx-3xs font-black uppercase tracking-[0.08em] ${BAND_INK[pair.band]}`}>
                          {BAND_LABEL[pair.band]}
                        </span>
                        {/* Beside the band, never instead of it: the evidence still holds, and this
                            is the one thing about it worth a second look. */}
                        {pair.caution ? (
                          <span className="border border-amber-500 bg-amber-50 px-2 py-px text-phx-3xs font-black uppercase tracking-[0.08em] text-amber-800">
                            Worth a look
                          </span>
                        ) : null}
                        <span className="break-words text-xs font-semibold leading-5 text-slate-600">{pair.reason}</span>
                      </span>
                      {pair.caution ? (
                        <span className="mt-1.5 block break-words text-phx-2xs font-semibold leading-4 text-amber-800" dir="auto">
                          {pair.caution}
                        </span>
                      ) : null}
                      <span className="mt-2.5 grid min-w-0 gap-2 md:grid-cols-2">
                        <Side pair={pair} which="left" />
                        <Side pair={pair} which="right" />
                      </span>
                    </span>
                  </label>
                  <div className="mt-2.5 flex flex-wrap gap-2 pl-7">
                    <button
                      className="border border-orange-600 bg-white px-3 py-1 text-phx-3xs font-black uppercase tracking-[0.1em] text-orange-700 disabled:opacity-50"
                      disabled={busy}
                      onClick={() => void decide("confirm", [pair.pairKey])}
                      type="button"
                    >
                      Same person
                    </button>
                    <button
                      className="border border-slate-300 bg-white px-3 py-1 text-phx-3xs font-black uppercase tracking-[0.1em] text-slate-600 disabled:opacity-50"
                      disabled={busy}
                      onClick={() => void decide("not_the_same", [pair.pairKey])}
                      type="button"
                    >
                      Not the same
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {/* What he has already decided, and the way into each one's Customer 360. It sits AFTER the
          queue rather than above it: the work is the queue, and a list of finished decisions at the
          top of the page is the first thing that pushes the work off the first screen. */}
      {masters.length > 0 ? (
        <section className="min-w-0 border border-slate-200/90 bg-white">
          <AdminSectionHeader
            description="Open one to see everything the four systems know about it, and who agreed to each link."
            title="Identities you have confirmed"
          />
          <ul className="grid min-w-0 gap-2 p-5">
            {masters.map((master) => (
              <li className="min-w-0" key={master.masterId}>
                <Link
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 border border-l-[3px] border-slate-200 border-l-orange-500 bg-white px-4 py-3 transition hover:border-slate-300 hover:bg-orange-50/40"
                  href={`/admin/customer-links/${master.masterId}`}
                >
                  <span className="min-w-0 break-words text-sm font-black text-slate-950" dir="auto">
                    {master.displayName || "Unnamed customer"}
                  </span>
                  <span className="break-words text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-500">
                    {master.kind} · {master.links} linked
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** One side of the pair, named by the system it comes from — never by a raw id. */
function Side({ pair, which }: { pair: IdentitySuggestion; which: "left" | "right" }) {
  const row = which === "left" ? pair.left : pair.right;
  const facts = [
    row.speciality ? String(row.speciality) : null,
    row.brickCode ? `Brick ${row.brickCode}` : null,
    row.regionCode ? String(row.regionCode) : null,
    // Every code the shop is known by, each with whose numbering it is: a bare code cannot be
    // checked, because the same integer at two distributors is two different shops.
    ...(row.distributorPairs ?? []).map((one) => `Code ${one.code} at ${one.distributorId}`),
  ].filter((one): one is string => Boolean(one));

  return (
    <span className="min-w-0 border border-l-[3px] border-slate-200 border-l-slate-300 bg-slate-50 px-3 py-2.5">
      <span className="block text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500">
        {SOURCE_LABEL[row.source] ?? row.source}
      </span>
      <span className="mt-1 block break-words text-sm font-black leading-5 text-slate-950" dir="auto">
        {row.name}
      </span>
      {facts.length > 0 ? (
        <span className="mt-1 block break-words text-phx-2xs font-semibold leading-4 text-slate-500" dir="auto">
          {facts.join(" · ")}
        </span>
      ) : null}
    </span>
  );
}
