import { LandingFigure, LandingMeta, LandingPanel, LandingRailLine } from "@/components/employee-portal/landing-kit";
import { EARLY_BIRD_LIMIT, type NsmCrmComplianceData } from "@/lib/employee-portal/nsm-crm-compliance";

// Shared "who has submitted their first CRM visit today" board. Extracted from the NSM command
// center so the National (line-scoped) and Regional (region-scoped) dashboards render one
// identical widget — the data is roster-driven (see nsm-crm-compliance.ts), so the only difference
// between the two is which roster the caller passes in.
//
// Drawn in the landing language (owner, 2026-11-20: "EVERY SINGLE COMPONENT TO BE PREMIUM GODMODE
// POLISHED"): a white panel with the tick title, the two counts as figures, the early birds as ruled
// rows rather than chips carrying chips, and every state as one line beside a coloured rail — the
// rail of the rep's Needs you rows — so a quiet morning, a fetch failure and an all-clear never look alike.

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

// The visit time's provenance, stated on every row: a GPS check-in is real on-site presence, a
// save time is rep-controlled paperwork, and "no time" is a submitted visit the vendor sent no
// clock for. All three rank together, so the label is what keeps them comparable.
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

/**
 * The same provenance on this board, as INK under the time rather than a filled badge inside a
 * chip — the board's rows carry no badge on a badge. Same words as SOURCE_BADGE, same three colours.
 */
const SOURCE_INK: Record<EarlyBirdSource, string> = {
  gps_checkin: "text-emerald-700",
  save_time: "text-slate-500",
  none: "text-amber-700",
};

/** One line of state beside a coloured rail. The rail says what kind of line it is before the words do. */
/** A small capital label inside the panel's body: quieter than the panel title, never a second tick. */
function BodyLabel({ children, tone = "text-slate-500" }: { children: React.ReactNode; tone?: string }) {
  return <h3 className={`min-w-0 break-words text-phx-xs font-black uppercase tracking-[0.12em] ${tone}`}>{children}</h3>;
}

/** The names still missing, as flat outlined tags that wrap a row at a time inside a phone's width. */
function PersonTags({ people }: { people: Array<{ hrId: string; name: string }> }) {
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1.5">
      {people.map((p) => (
        <li
          className="max-w-full break-words border border-rose-200 px-2 py-1 text-phx-sm font-semibold leading-snug text-rose-800"
          dir="auto"
          key={p.hrId || p.name}
        >
          {p.name}
        </li>
      ))}
    </ul>
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
    <LandingPanel
      right={
        <>
          <span
            className="min-w-0 break-words text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500"
            title={crm?.lastSyncAt ? `Newest visit mirrored at ${cairoTime(crm.lastSyncAt)}` : undefined}
          >
            {syncLabel}
          </span>
          {action}
        </>
      }
      title="CRM First Visit"
    >
      {crm?.error ? (
        <LandingRailLine rail="bg-amber-400">
          CRM data is temporarily unavailable — this is a fetch issue, not a compliance gap. Try again shortly.
        </LandingRailLine>
      ) : rosterSize === 0 ? (
        <LandingRailLine rail="bg-amber-400">
          Nobody is attached to your team right now, so there is nothing to check here. This is a roster problem rather
          than a compliance result — no rep has been marked as missing.
        </LandingRailLine>
      ) : !crm || (!crm.synced && !crm.polled) ? (
        // Reached only when today's check could not be read: since iReports360 was retired (6 November
        // 2026) getNsmCrmCompliance marks every day checked, so a quiet morning reaches the red state below.
        <LandingRailLine rail="bg-slate-300">Today&apos;s visits could not be read yet. Reload the page in a minute.</LandingRailLine>
      ) : !crm.synced ? (
        // Polled but empty. Blaming the sync for a compliance fact is what the old copy did — this
        // says plainly that we looked and nobody has started.
        <LandingRailLine rail="bg-rose-500">
          {checkedAt ? `Checked ${cairoTime(checkedAt)} — ` : ""}nobody on your roster has submitted a visit yet today.
        </LandingRailLine>
      ) : (
        <>
          {/* Submitted counts: two figures, one hairline between them. */}
          <div className="grid grid-cols-2 divide-x divide-slate-200 border-b border-slate-200">
            {[
              { label: "Reps submitted", submitted: crm.reps.submitted, total: crm.reps.total },
              // "Managers", not "DSMs": a line's tier holds its Regional Manager too (owner, 2026-10-20).
              { label: "Managers submitted", submitted: crm.dsms.submitted, total: crm.dsms.total },
            ].map((s) => {
              const complete = s.total > 0 && s.submitted >= s.total;
              return (
                <div className="min-w-0 px-3 py-3 sm:px-4" key={s.label}>
                  <p className="break-words text-phx-xs font-bold uppercase leading-snug tracking-[0.08em] text-slate-500">
                    {s.label}
                  </p>
                  <div className="mt-2">
                    <LandingFigure size="md" tone={complete ? "text-emerald-700" : undefined} unit={`/${s.total}`}>
                      {s.submitted}
                    </LandingFigure>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Early birds */}
          <div className="border-b border-slate-200">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 pb-1 pt-3 sm:px-4">
              <BodyLabel>Early birds</BodyLabel>
              {crm.earlyBirds.length > 0 && (
                // State what the list contains out loud: N rows on their own cannot be told apart
                // from "only N people submitted today".
                <span className="ml-auto">
                  <LandingMeta items={[rankHint]} />
                </span>
              )}
            </div>
            {crm.earlyBirds.length === 0 ? (
              <p className="px-3 pb-3 pt-1 text-phx-sm text-slate-500 sm:px-4">No visits submitted yet today.</p>
            ) : (
              <ol>
                {crm.earlyBirds.map((b, i) => {
                  const badge = SOURCE_BADGE[b.source];
                  return (
                    <li
                      className="flex min-w-0 items-baseline gap-3 border-t border-slate-200 px-3 py-2.5 first:border-t-0 sm:px-4"
                      key={b.hrId || b.name}
                    >
                      <span className="w-5 shrink-0 text-right text-phx-sm font-bold tabular-nums text-slate-400">{i + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-phx-md font-bold leading-snug text-[#08111f]" dir="auto">
                          {b.name}
                        </span>
                        <span className="mt-0.5 block break-words text-phx-xs leading-snug text-slate-500">
                          <span className="font-bold uppercase tracking-[0.08em]">{b.visitType}</span>
                          {showAccount && (
                            // The account that first record was captured at. Arabic names are common
                            // here, so it carries dir="auto" and never truncates — a long name wraps
                            // inside its own row.
                            <>
                              <span aria-hidden="true" className="text-slate-300">
                                {" · "}
                              </span>
                              <span dir="auto">{b.account ?? "—"}</span>
                            </>
                          )}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-phx-md font-bold tabular-nums text-[#08111f]">{vendorLocalTime(b.at)}</span>
                        <span
                          className={`block text-phx-xs font-bold uppercase tracking-[0.08em] ${SOURCE_INK[b.source]}`}
                          title={badge.title}
                        >
                          {badge.label}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>

          {/* Not-yet-submitted alarm */}
          {crm.reps.missing.length === 0 && crm.dsms.missing.length === 0 ? (
            <LandingRailLine rail="bg-emerald-500">
              <span className="font-semibold text-emerald-800">{allClearMessage}</span>
            </LandingRailLine>
          ) : (
            <div className="flex min-w-0 gap-3 px-3 py-3 sm:px-4">
              <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-rose-500" />
              <div className="min-w-0 flex-1 space-y-3">
                <BodyLabel tone="text-rose-700">{crm.reps.missing.length + crm.dsms.missing.length} not yet submitted</BodyLabel>
                {crm.dsms.missing.length > 0 && (
                  <div>
                    <BodyLabel>Managers ({crm.dsms.missing.length})</BodyLabel>
                    <PersonTags people={crm.dsms.missing} />
                  </div>
                )}
                {crm.reps.missing.length > 0 && (
                  <div>
                    <BodyLabel>Med reps ({crm.reps.missing.length})</BodyLabel>
                    <PersonTags people={crm.reps.missing} />
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </LandingPanel>
  );
}
