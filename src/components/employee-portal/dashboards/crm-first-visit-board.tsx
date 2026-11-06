import { AlarmClock, AlertTriangle, CheckCircle2, Clock, Sunrise } from "lucide-react";

import { SectionHead } from "@/components/employee-portal/portal-command-center";
import { EARLY_BIRD_LIMIT, type NsmCrmComplianceData } from "@/lib/employee-portal/nsm-crm-compliance";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

// Shared "who has submitted their first CRM visit today" board. Extracted from the NSM command
// center so the National (line-scoped) and Regional (region-scoped) dashboards render one
// identical widget — the data is roster-driven (see nsm-crm-compliance.ts), so the only difference
// between the two is which roster the caller passes in.

function cairoTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "Africa/Cairo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Early-bird `at` is a VENDOR timestamp — either the GPS check_date or the crm_save_date, both
// zone-less Cairo wall-clock stored as +00, so the clock reading is ALREADY Cairo-local. Render
// as-is (timeZone "UTC"); using cairoTime here (as lastSyncAt correctly does for the true-UTC
// synced_at) would double-add the offset and show submission times 2–3h late. `at` is null when
// the vendor sent no usable clock for the visit — the person still ranks (they did submit), so
// show a dash rather than a fabricated time.
function vendorLocalTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// The visit time's provenance, stated on every chip: a GPS check-in is real on-site presence, a
// save time is rep-controlled paperwork, and "no time" is a submitted visit the vendor sent no
// clock for. All three rank together, so the badge is what keeps them comparable.
export type EarlyBirdSource = NsmCrmComplianceData["earlyBirds"][number]["source"];

/** Exported so the fortnightly Early Birds board labels provenance identically. A competition where
 * one screen says "GPS" and another stays silent about a self-reported clock is one reps learn to
 * game. */
export const SOURCE_BADGE: Record<EarlyBirdSource, { label: string; className: string; title: string }> = {
  gps_checkin: {
    label: "GPS",
    className: "bg-emerald-100 text-emerald-700",
    title: "Real GPS check-in time (on site)",
  },
  save_time: {
    label: "Logged",
    className: "bg-slate-100 text-slate-500",
    title: "Logged/save time — not GPS-verified; may be logged later",
  },
  none: {
    label: "No time",
    className: "bg-amber-100 text-amber-700",
    title: "Visit submitted, but no usable clock was recorded for it — ranked last",
  },
};

function PersonChips({ people, tone }: { people: Array<{ hrId: string; name: string }>; tone: "danger" | "muted" }) {
  const cls =
    tone === "danger"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : "border-slate-200 bg-slate-50 text-slate-600";
  return (
    <div className="flex flex-wrap gap-1.5">
      {people.map((p) => (
        <span key={p.hrId || p.name} className={`whitespace-nowrap border px-2 py-1 text-phx-xs font-semibold ${cls}`}>
          {p.name}
        </span>
      ))}
    </div>
  );
}

export function CrmFirstVisitBoard({
  crm,
  allClearMessage = "Everyone on your line has submitted their first visit.",
  rankHint = `first ${EARLY_BIRD_LIMIT} to submit`,
  showAccount = false,
  action,
}: {
  crm: NsmCrmComplianceData | null;
  /** Scope-specific wording for the all-clear state (e.g. "your region" vs "your line"). */
  allClearMessage?: string;
  /** What the ranking actually contains. The line/region board is capped, so it says so; the
   * District Manager board ranks every submitter and says that instead. */
  rankHint?: string;
  /** District Manager board: also name the account each rep's first visit was captured at. A DM
   * has a dozen reps and acts on them individually, so the account is the actionable detail; on a
   * whole line or region it would be noise. */
  showAccount?: boolean;
  /** Sync-now island, rendered beside the freshness label. */
  action?: React.ReactNode;
}) {
  // "Checked", not "as of". The label is driven by the sync RUN, so it moves even when a sync finds
  // nothing new — `lastSyncAt` (newest row) does not, which made a perfectly successful Sync press
  // look like a broken button. lastSyncAt survives only as the tooltip.
  const checkedAt = crm?.lastSyncRunAt ?? crm?.lastSyncAt ?? null;
  const syncLabel = checkedAt ? `Checked ${cairoTime(checkedAt)}` : "awaiting sync";

  // A ROSTER OF NOBODY IS NOT A CLEAN BOARD, and it used to render as one. With no reps and no DSMs
  // the counts read "0/0", the early-bird list read "No visits submitted yet today", and — because
  // nobody can be missing from an empty list — the alarm block below printed its GREEN all-clear,
  // "Every rep on your team has submitted their first visit." All three sat on one screen on
  // 2026-10-12, when the rosters were still derived from published sales (serving-roster.ts).
  // The roster is org-tree-derived now, so this state should be unreachable for an occupied seat —
  // which is exactly why it must say what it is rather than imitate a compliant day.
  const rosterSize = (crm?.reps.total ?? 0) + (crm?.dsms.total ?? 0);

  return (
    <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <SectionHead
        title="CRM First Visit"
        right={
          <span className="flex items-center gap-2">
            <span
              className="whitespace-nowrap text-phx-2xs font-bold uppercase tracking-widest text-slate-400"
              title={crm?.lastSyncAt ? `Newest visit mirrored at ${cairoTime(crm.lastSyncAt)}` : undefined}
            >
              {syncLabel}
            </span>
            {action}
          </span>
        }
      />
      {crm?.error ? (
        <div className="flex items-center gap-3 bg-white px-4 py-5 sm:px-5">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-sm text-slate-500">
            CRM data is temporarily unavailable — this is a fetch issue, not a compliance gap. Try again shortly.
          </p>
        </div>
      ) : rosterSize === 0 ? (
        <div className="flex items-center gap-3 bg-white px-4 py-5 sm:px-5">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-sm text-slate-500">
            Nobody is attached to your team right now, so there is nothing to check here. This is a
            roster problem rather than a compliance result — no rep has been marked as missing.
          </p>
        </div>
      ) : !crm || (!crm.synced && !crm.polled) ? (
        // Reached only when today's check could not be read: since iReports360 was retired (6 November
        // 2026) getNsmCrmCompliance marks every day checked, so a quiet morning reaches the red state below.
        <div className="flex items-center gap-3 bg-white px-4 py-5 sm:px-5">
          <Clock className="h-4 w-4 shrink-0 text-slate-400" />
          <p className="text-sm text-slate-500">
            Today&apos;s visits could not be read yet. Reload the page in a minute.
          </p>
        </div>
      ) : !crm.synced ? (
        // Polled but empty. Blaming the sync for a compliance fact is what the old copy did — this
        // says plainly that we looked and nobody has started.
        <div className="flex items-center gap-3 bg-white px-4 py-5 sm:px-5">
          <AlarmClock className="h-4 w-4 shrink-0 text-rose-500" />
          <p className="text-sm text-slate-500">
            {checkedAt ? `Checked ${cairoTime(checkedAt)} — ` : ""}nobody on your roster has submitted a visit yet today.
          </p>
        </div>
      ) : (
        <div className="space-y-px bg-slate-200">
          {/* Submitted counts */}
          <div className="grid grid-cols-2 gap-px bg-slate-200">
            {[
              { label: "Reps submitted", submitted: crm.reps.submitted, total: crm.reps.total },
              // "Managers", not "DSMs": a line's tier holds its Regional Manager too (owner, 2026-10-20).
              { label: "Managers submitted", submitted: crm.dsms.submitted, total: crm.dsms.total },
            ].map((s) => {
              const complete = s.total > 0 && s.submitted >= s.total;
              return (
                <div key={s.label} className="bg-white px-4 py-3">
                  <p className={`text-xl font-black tabular-nums ${complete ? "text-emerald-600" : "text-slate-900"}`}>
                    {s.submitted}
                    <span className="text-sm font-bold text-slate-400">/{s.total}</span>
                  </p>
                  <p className="mt-0.5 whitespace-nowrap text-phx-2xs font-semibold uppercase tracking-widest text-slate-400">{s.label}</p>
                </div>
              );
            })}
          </div>

          {/* Early birds */}
          <div className="bg-white px-4 py-3 sm:px-5">
            <div className="mb-2 flex items-center gap-2">
              <Sunrise className="h-4 w-4 text-emerald-600" />
              <p className="text-phx-2xs font-bold uppercase tracking-widest text-slate-500">Early birds</p>
              {crm.earlyBirds.length > 0 && (
                // State what the list contains out loud: N chips on their own cannot be told apart
                // from "only N people submitted today".
                <span className="ml-auto whitespace-nowrap text-phx-2xs font-semibold uppercase tracking-widest text-slate-400">
                  {rankHint}
                </span>
              )}
            </div>
            {crm.earlyBirds.length === 0 ? (
              <p className="text-sm text-slate-500">No visits submitted yet today.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {crm.earlyBirds.map((b, i) => {
                  const badge = SOURCE_BADGE[b.source];
                  return (
                    <span
                      key={b.hrId || b.name}
                      className="inline-flex items-center gap-1.5 whitespace-nowrap border border-emerald-200 bg-emerald-50 px-2 py-1 text-phx-xs font-semibold text-emerald-700"
                    >
                      <span className="font-black text-emerald-600">{i + 1}</span>
                      {b.name}
                      <span className="border border-emerald-200 bg-white px-1 py-0.5 text-phx-3xs font-bold uppercase tracking-wide text-emerald-700/80">
                        {b.visitType}
                      </span>
                      {showAccount && (
                        // The account that first record was captured at. Arabic names are common
                        // here, so the chip carries dir="auto" and never truncates — a long name
                        // makes a wider chip that wraps to the next row as a whole.
                        <span dir="auto" className="font-normal text-emerald-700/90">
                          {b.account ?? "—"}
                        </span>
                      )}
                      <span className="font-normal tabular-nums text-emerald-600/70">{vendorLocalTime(b.at)}</span>
                      <span
                        className={`rounded px-1 py-0.5 text-phx-3xs font-bold uppercase tracking-wide ${badge.className}`}
                        title={badge.title}
                      >
                        {badge.label}
                      </span>
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {/* Not-yet-submitted alarm */}
          <div className="bg-white px-4 py-3 sm:px-5">
            {crm.reps.missing.length === 0 && crm.dsms.missing.length === 0 ? (
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                <p className="text-sm font-medium text-emerald-700">{allClearMessage}</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <AlarmClock className="h-4 w-4 shrink-0 text-rose-600" />
                  <p className="text-phx-2xs font-bold uppercase tracking-widest text-rose-600">
                    {crm.reps.missing.length + crm.dsms.missing.length} not yet submitted
                  </p>
                </div>
                {crm.dsms.missing.length > 0 && (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1.5 text-phx-2xs font-bold uppercase tracking-wide text-slate-400">
                      <AlertTriangle className="h-3 w-3 text-rose-500" /> Managers ({crm.dsms.missing.length})
                    </p>
                    <PersonChips people={crm.dsms.missing} tone="danger" />
                  </div>
                )}
                {crm.reps.missing.length > 0 && (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1.5 text-phx-2xs font-bold uppercase tracking-wide text-slate-400">
                      <AlertTriangle className="h-3 w-3 text-rose-500" /> Med reps ({crm.reps.missing.length})
                    </p>
                    <PersonChips people={crm.reps.missing} tone="danger" />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
