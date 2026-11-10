import { redirect } from "next/navigation";
import { CheckCircle2, MapPinOff, Users } from "lucide-react";

import { AdminCallout, AdminPageHero, AdminStatCard, AdminTableShell } from "@/components/admin/admin-design-system";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { TryLocationsMap } from "@/components/admin/refused-try-map";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  OUTCOME_LABELS,
  refusalSentence,
  refusedSubjectLabel,
  stillBlocked,
  type AttemptOutcome,
} from "@/lib/phoenix-crm/refused-readings-rules";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import {
  canReadRefusedReadings,
  loadRefusedReadingsBoard,
  readsMockAnswer,
  type RefusedAttemptRow,
  type RepRefusalRow,
} from "@/lib/phoenix-crm/server/refused-readings-board";

export const dynamic = "force-dynamic";

/**
 * Refused readings — the Super Admin's and the SFE Manager's list of reps whose phone Phoenix CRM
 * turned away on its LOCATION, and whether each of them got through afterwards (owner, 2026-10-03:
 * "build the refused readings view for the SFE").
 *
 * 🔒 HOUSEKEEPING, NOT A FLAG — AND THAT IS WHY IT IS NOT A TAB OF THE INTEGRITY BOARD. A refusal is
 * the system saying no to a phone, and the rep already read it on his own screen the moment it
 * happened. The question here is "who is stuck, and can I help", never "who is lying", so a rep
 * turned away eighteen times for a rough GPS fix is not filed beside a mock-location case. Same stance
 * as the duplicate-customers list.
 *
 * It sits under /admin, which a rep cannot open at all. Nothing on this page acts: no button, no
 * decision, no write, no notification.
 */
function cairo(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

const OUTCOME_TONE: Record<AttemptOutcome, string> = {
  got_through: "bg-emerald-500",
  not_yet: "bg-rose-500",
  unknown: "bg-slate-400",
};

function Outcome({ outcome }: { outcome: AttemptOutcome }) {
  return (
    <span className="flex items-start gap-2 text-sm leading-6 text-slate-700">
      <span className={`mt-2 h-1.5 w-1.5 shrink-0 ${OUTCOME_TONE[outcome]}`} />
      <span>{OUTCOME_LABELS[outcome]}</span>
    </span>
  );
}

/** What it cost him, in one sentence a person can act on. One component for the table cell AND the phone card. */
function RepSummary({ entry }: { entry: RepRefusalRow }) {
  const blocked = stillBlocked(entry);
  return (
    <>
      <div className="text-sm text-slate-700">
        {entry.attempts} {entry.attempts === 1 ? "refusal" : "refusals"}
        <span className="text-xs text-slate-500">
          {" "}
          · {entry.places} on a place · {entry.visits} on a visit
        </span>
      </div>
      <div className="text-xs text-slate-500">
        {entry.targets > 0
          ? `${entry.gotThrough} of ${entry.targets} ${entry.targets === 1 ? "customer" : "customers"} got through${blocked > 0 ? ` · ${blocked} still blocked` : ""}`
          : "No customer chosen yet on any of them"}
        {entry.untied > 0 && entry.targets > 0 ? ` · ${entry.untied} before a customer was chosen` : ""}
      </div>
    </>
  );
}

function Readings({ entry, showMock }: { entry: RefusedAttemptRow; showMock: boolean }) {
  return (
    <>
      <p className="text-sm leading-6 text-slate-700">{refusalSentence(entry)}</p>
      {showMock ? (
        <p className="text-xs text-slate-500">
          Mock-location answer from the phone: {entry.deviceMocked === null ? "not asked" : entry.deviceMocked ? "a mock location app was reported" : "none reported"}
        </p>
      ) : null}
    </>
  );
}

/**
 * The picture the phone sent with the refused capture, as a small thumbnail that opens full screen —
 * what shows WHERE the rep stood, and whether a retry sent the same one again. One component for the
 * table cell AND the phone card. `lazy`, because the list holds up to a hundred and the hidden copy
 * (desktop or phone) of an eager image still loads. A row with no photo says so in words: a grey tile
 * per old row would read as a broken picture rather than as a refusal that never kept one.
 */
function SentPhoto({ entry, size }: { entry: RefusedAttemptRow; size: string }) {
  if (!entry.photoPath) return <span className="text-xs text-slate-500">None kept</span>;
  const caption = [entry.repName, entry.customerName ?? "No customer chosen yet", cairo(entry.refusedAt)].join(" · ");
  return <CrmPhotoThumb alt={`Photo the phone sent: ${caption}`} caption={caption} className={size} lazy path={entry.photoPath} />;
}

/**
 * Where the phone was on this try, beside the customer's saved place, on a small map (owner, 2026-11-10).
 * One component for the table cell AND the phone card, so the two cannot place a try differently. It
 * sits in the row's own "What happened" cell: a panel row under every row is a second row per try.
 */
function TryLocations({ entry }: { entry: RefusedAttemptRow }) {
  return <TryLocationsMap map={entry.map} savedPlace={entry.savedPlace} tryPoint={entry.tryPoint} />;
}

export default async function PhoenixCrmRefusedReadingsPage() {
  const access = await resolveAccessContextFromPage();
  // Gate one before the organogram: a per-account module lock on Phoenix CRM closes this page as well,
  // which `canReadRefusedReadings` alone — a role test — would not.
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canReadRefusedReadings(viewer)) redirect("/admin");

  const board = await loadRefusedReadingsBoard(viewer);
  const showMock = readsMockAnswer(viewer);

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="Refused readings"
        description={`Captures Phoenix CRM turned away because the phone sent no position, or one too rough to trust — the last ${board.windowDays} days. It is where to see who is stuck and whether they got through afterwards. Nothing here is a flag and nobody is accused: the rep read the refusal on their own screen at the time, and this page adds nothing they are told.`}
        icon={<MapPinOff className="h-3.5 w-3.5" />}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <AdminStatCard
          icon={<MapPinOff className="h-5 w-5" />}
          label="Refusals"
          value={board.total}
          description={`In the last ${board.windowDays} days`}
          tone="orange"
          size="compact"
        />
        <AdminStatCard
          icon={<Users className="h-5 w-5" />}
          label="Reps refused"
          value={board.reps.length}
          description="Different people turned away at least once"
          tone="blue"
          size="compact"
        />
        <AdminStatCard
          icon={<CheckCircle2 className="h-5 w-5" />}
          label="Reps still blocked"
          value={board.stuckReps}
          description="At least one customer they have not got through on"
          tone="rose"
          size="compact"
        />
      </div>

      {board.total === 0 ? (
        <AdminCallout tone="success">
          <span>
            Nothing refused in the last {board.windowDays} days. Every capture the field sent carried a position the server could use.
          </span>
        </AdminCallout>
      ) : null}

      {board.truncated ? (
        <AdminCallout tone="neutral">
          <span>
            This window holds more refusals than one read can carry, so the counts below are a floor, not the whole {board.windowDays} days.
          </span>
        </AdminCallout>
      ) : null}

      {board.reps.length > 0 ? (
        <AdminTableShell
          title="By rep"
          description="Reps still blocked come first. A rep refused many times who always gets through is listed too — a phone that needs eleven tries is worth knowing about — but below the one who cannot do their work."
        >
          {/* Desktop: the full table. `table-fixed` with a colgroup, never a min-width in a scroller. */}
          <div className="hidden lg:block">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[24%]" />
                <col className="w-[44%]" />
                <col className="w-[16%]" />
                <col className="w-[16%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-3">Rep</th>
                  <th className="px-5 py-3">What happened</th>
                  <th className="px-5 py-3">Roughest reading</th>
                  <th className="px-5 py-3">Last refused</th>
                </tr>
              </thead>
              <tbody>
                {board.reps.map((entry) => (
                  <tr key={entry.repHrId} className="border-b border-slate-100 align-top even:bg-slate-50/60">
                    <td className="px-5 py-4 text-sm font-semibold text-slate-900">{entry.repName}</td>
                    <td className="px-5 py-4">
                      <RepSummary entry={entry} />
                    </td>
                    <td className="px-5 py-4 text-sm tabular-nums text-slate-700">
                      {entry.widestMeters === null ? "—" : `within ${Math.round(entry.widestMeters)} m`}
                    </td>
                    <td className="px-5 py-4 text-sm text-slate-700">{cairo(entry.lastRefusedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: the same reps as cards. */}
          <div className="space-y-3 px-5 py-4 lg:hidden sm:px-6">
            {board.reps.map((entry) => (
              <div key={entry.repHrId} className="border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-bold text-slate-900">{entry.repName}</span>
                  <span className="text-xs text-slate-500">{cairo(entry.lastRefusedAt)}</span>
                </div>
                <div className="mt-2">
                  <RepSummary entry={entry} />
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  Roughest reading: {entry.widestMeters === null ? "—" : `within ${Math.round(entry.widestMeters)} m`}
                </p>
              </div>
            ))}
          </div>
        </AdminTableShell>
      ) : null}

      {board.latest.length > 0 ? (
        <AdminTableShell
          title="Latest refusals"
          description="Newest first. A retry resends the same photo, so several refusals in a row with the same photo reading mean the photo itself could not improve. Tap a photo to open it. Each try with a position carries a small map: where the phone was beside the customer's saved place, with the distance between them."
        >
          {/* Desktop: the full table. `table-fixed` with a colgroup, never a min-width in a scroller. */}
          <div className="hidden lg:block">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[12%]" />
                <col className="w-[18%]" />
                <col className="w-[11%]" />
                <col className="w-[43%]" />
                <col className="w-[16%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-3">When</th>
                  <th className="px-5 py-3">Rep and customer</th>
                  <th className="px-3 py-3">Photo</th>
                  <th className="px-5 py-3">What happened</th>
                  <th className="px-5 py-3">After that</th>
                </tr>
              </thead>
              <tbody>
                {board.latest.map((entry) => (
                  <tr key={entry.id} className="border-b border-slate-100 align-top even:bg-slate-50/60">
                    <td className="px-5 py-4 text-sm text-slate-700">
                      <div className="font-semibold text-slate-900">{cairo(entry.refusedAt)}</div>
                      <div className="text-xs text-slate-500">{refusedSubjectLabel(entry.subjectKind)}</div>
                    </td>
                    <td className="px-5 py-4 text-sm">
                      <div className="font-semibold text-slate-900">{entry.repName}</div>
                      <div className="text-slate-700">{entry.customerName ?? "—"}</div>
                    </td>
                    <td className="px-3 py-4">
                      <SentPhoto entry={entry} size="h-16 w-16" />
                    </td>
                    <td className="px-5 py-4">
                      <Readings entry={entry} showMock={showMock} />
                      <div className="mt-3">
                        <TryLocations entry={entry} />
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <Outcome outcome={entry.outcome} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: the same refusals as cards. */}
          <div className="space-y-3 px-5 py-4 lg:hidden sm:px-6">
            {board.latest.map((entry) => (
              <div key={entry.id} className="border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-bold text-slate-900">{entry.repName}</span>
                  <span className="text-xs text-slate-500">{cairo(entry.refusedAt)}</span>
                </div>
                <p className="mt-1 text-sm text-slate-700">
                  {entry.customerName ?? "No customer chosen yet"} · {refusedSubjectLabel(entry.subjectKind).toLowerCase()}
                </p>
                <div className="mt-3">
                  <Readings entry={entry} showMock={showMock} />
                </div>
                <div className="mt-3">
                  <SentPhoto entry={entry} size="h-20 w-20" />
                </div>
                <div className="mt-3">
                  <TryLocations entry={entry} />
                </div>
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <Outcome outcome={entry.outcome} />
                </div>
              </div>
            ))}
          </div>
        </AdminTableShell>
      ) : null}
    </div>
  );
}
