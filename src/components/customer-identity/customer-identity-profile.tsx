import Link from "next/link";
import { Building2, History, Link2, ShieldQuestion, Users } from "lucide-react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
// Through `types`, never `server/profile`: a component may not name server code, and an
// `import type` counts — the boundary rule this module wrote for `SuggestionCluster`.
import type { IdentityProfile, IdentityProfileRow } from "@/lib/customer-identity/types";

/**
 * Customer 360 — everything the four systems know about ONE confirmed identity.
 *
 * 🔴 IT IS NOT A SECOND COPY OF `customer-360`. That page opens on a PHARMACY in one of two
 * registers and its own header explains why it shows no CRM visits: the names do not meet — 1 of
 * 330 marketing pharmacy names and 0 of 52 direct-order names match a CRM pharmacy name, so there
 * is no pharmacy-level CRM join to build. Wave 2 IS that join, made by a person rather than by a
 * name match, and this page opens on the MASTER — so it reaches a doctor, which the other cannot.
 *
 * 🔴 EVERY ROW IS HERE BECAUSE SOMEBODY CONFIRMED IT. Nothing on this page is inferred, matched or
 * scored: each row carries the band the evidence reached and the name of the person who agreed, so
 * a reader can weigh it rather than take it. A row whose source has gone is shown as MISSING, not
 * dropped — a link quietly disappearing turns "this was decided" into "this never happened".
 *
 * A server component: it reads and links, and nothing on it acts. The decisions are made on the
 * review screen, which is where the permission to make them is gated.
 */

const SOURCE_LABEL: Record<string, string> = {
  direct_order: "Direct orders",
  ireports360: "iReports360",
  marketing: "Marketing register",
  phoenix_crm: "Phoenix CRM",
  // Named for what it IS, so nobody reads it as a register that could be opened: it is a name a
  // rep wrote on a visit, and there is no row behind it to look up.
  visit_feedback: "Typed on a visit",
};

const BAND_WORD: Record<string, string> = {
  fact: "A fact — the systems already tie these two together",
  likely: "Likely — the names match and they share a brick or a phone",
  possible: "Possible — the same name in the same region",
  strong: "Strong — the names match and the places are close",
};

const KIND_WORD: Record<string, string> = { AM: "AM customer", PM: "PM customer", pharmacy: "Pharmacy" };

/** "2026-09-30 21:40", Cairo — a stamp on a decision is read in the reader's own day. */
function cairoStamp(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString("en-GB", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
}

/** What this source knows that the others may not — never an empty row of dashes. */
function factsOf(row: IdentityProfileRow): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = [];
  if (row.speciality) facts.push({ label: "Speciality", value: row.speciality });
  if (row.phone) facts.push({ label: "Phone", value: row.phone });
  if (row.brickCode) facts.push({ label: "Brick", value: row.brickCode });
  if (row.regionCode) facts.push({ label: "Region", value: row.regionCode });
  const pairs = row.distributorPairs ?? [];
  if (pairs.length > 0) {
    facts.push({
      // Whose code it is matters as much as the code: the same number at two distributors is two
      // different shops, which is the whole reason a code pair only counts within one distributor.
      // A shop with two codes shows BOTH — dropping one hides the evidence the link was made on.
      label: pairs.length === 1 ? "Distributor code" : "Distributor codes",
      value: pairs.map((pair) => `${pair.code} · at ${pair.distributorId}`).join(" · "),
    });
  }
  if (row.contactCrmId !== null && row.contactCrmId !== undefined) {
    facts.push({ label: "Contact id", value: String(row.contactCrmId) });
  }
  if (row.lat !== null && row.lat !== undefined && row.lon !== null && row.lon !== undefined) {
    facts.push({ label: "Captured at", value: `${row.lat.toFixed(5)}, ${row.lon.toFixed(5)}` });
  }
  return facts;
}

export function CustomerIdentityProfile({ profile }: { profile: IdentityProfile }) {
  const sources = new Set(profile.rows.map((row) => row.source));
  const missing = profile.rows.filter((row) => row.missing).length;

  return (
    <div className="grid min-w-0 gap-5">
      <AdminPageHero
        badges={
          <>
            <AdminInsightChip tone="orange">{KIND_WORD[profile.kind] ?? profile.kind}</AdminInsightChip>
            <AdminInsightChip>Confirmed by a person, never matched</AdminInsightChip>
          </>
        }
        description="Everything the four systems know about one confirmed identity, and who agreed to each link."
        eyebrow="Customer 360"
        icon={<Users className="h-4 w-4" />}
        title={profile.displayName || "Unnamed customer"}
      />

      <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <AdminStatCard
          description="Rows confirmed onto this identity"
          icon={<Link2 className="h-4 w-4" />}
          label="Links"
          size="compact"
          value={profile.rows.length}
        />
        <AdminStatCard
          description="Of the four systems"
          icon={<Building2 className="h-4 w-4" />}
          label="Sources"
          size="compact"
          tone="blue"
          value={sources.size}
        />
        <AdminStatCard
          description="Confirmations, merges and withdrawals"
          icon={<History className="h-4 w-4" />}
          label="Decisions"
          size="compact"
          tone="violet"
          value={profile.events.length}
        />
        <AdminStatCard
          description="Rows since gone from their own system"
          icon={<ShieldQuestion className="h-4 w-4" />}
          label="Missing"
          size="compact"
          tone={missing > 0 ? "rose" : "emerald"}
          value={missing}
        />
      </div>

      {missing > 0 ? (
        <AdminCallout tone="warning">
          <p>
            {missing === 1 ? "One row" : `${missing} rows`} confirmed onto this identity no longer exist in their own
            system. They are kept below rather than dropped, because a link that disappears quietly turns a decision
            somebody made into one nobody can find.
          </p>
        </AdminCallout>
      ) : null}

      <AdminTableShell
        description="Each row as its own system holds it, with how good the evidence was and who agreed."
        title="What each system knows"
      >
        <div className="grid min-w-0 gap-3 p-5">
          {profile.rows.length === 0 ? (
            <p className="text-sm font-semibold text-slate-600">Nothing is linked to this identity yet.</p>
          ) : null}
          {profile.rows.map((row) => (
            <article
              className="min-w-0 border border-l-[3px] border-slate-200 border-l-orange-500 bg-white px-4 py-3.5"
              key={`${row.source}:${row.sourceId}`}
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-black text-slate-950" dir="auto">
                    {row.name}
                  </p>
                  <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">
                    {SOURCE_LABEL[row.source] ?? row.source} · {KIND_WORD[row.kind] ?? row.kind}
                  </p>
                </div>
                <div className="flex min-w-0 flex-wrap gap-1.5">
                  {row.missing ? <AdminInsightChip tone="slate">No longer in its own system</AdminInsightChip> : null}
                  <AdminInsightChip tone={row.band === "fact" ? "emerald" : "neutral"}>{row.band}</AdminInsightChip>
                </div>
              </div>

              {factsOf(row).length > 0 ? (
                <dl className="mt-2.5 grid grid-cols-2 gap-2 lg:grid-cols-4">
                  {factsOf(row).map((fact) => (
                    <div className="min-w-0 border border-slate-100 bg-slate-50 px-2.5 py-2" key={fact.label}>
                      <dt className="break-words text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
                        {fact.label}
                      </dt>
                      <dd className="mt-0.5 min-w-0 break-words text-xs font-bold text-slate-800" dir="auto">
                        {fact.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-500">
                {BAND_WORD[row.band] ?? row.band} · confirmed by {row.confirmedBy} on {cairoStamp(row.confirmedAt)}
              </p>
            </article>
          ))}
        </div>
      </AdminTableShell>

      {profile.ruledApart.length > 0 ? (
        <AdminTableShell
          description="Pairs somebody decided are NOT the same, and which therefore never joined this identity."
          title="Ruled apart"
        >
          <div className="grid min-w-0 gap-2 p-5">
            {profile.ruledApart.map((ruling) => (
              <p className="break-words text-sm font-semibold leading-6 text-slate-700" key={ruling.pairKey}>
                <span className="font-black text-slate-900">{ruling.reason}</span>
                {` — ${ruling.ruledBy}, ${cairoStamp(ruling.ruledAt)}`}
              </p>
            ))}
          </div>
        </AdminTableShell>
      ) : null}

      <AdminTableShell
        description="Every confirmation, merge and withdrawal on this identity, newest first."
        title="How it was decided"
      >
        <div className="grid min-w-0 gap-2 p-5">
          {profile.events.length === 0 ? (
            <p className="text-sm font-semibold text-slate-600">Nothing has been decided on this identity yet.</p>
          ) : null}
          {profile.events.map((event, index) => (
            <p className="break-words text-sm font-semibold leading-6 text-slate-700" key={`${event.at}-${index}`}>
              <span className="font-black text-slate-900">{event.event}</span>
              {` — ${event.actor}, ${cairoStamp(event.at)}`}
            </p>
          ))}
          <p className="mt-1 break-words text-xs font-semibold text-slate-500">
            Created by {profile.createdBy} on {cairoStamp(profile.createdAt)}.
          </p>
        </div>
      </AdminTableShell>

      <p className="min-w-0">
        <Link
          className="text-xs font-black text-slate-600 underline underline-offset-2 hover:text-orange-700"
          href="/admin/customer-links"
        >
          ← Back to the links to review
        </Link>
      </p>
    </div>
  );
}
