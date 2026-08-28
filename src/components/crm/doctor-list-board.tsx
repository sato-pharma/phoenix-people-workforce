import { DoctorListRepPicker, DoctorListTable } from "@/components/crm/doctor-list-tables";
import {
  EXPECTED_PM_MAX,
  EXPECTED_PM_MIN,
  type DoctorListBoard,
} from "@/lib/crm/contact-lists";

// Server half of Doctor List. The Section/Tile vocabulary is copied verbatim from
// rep-doctor-lists-board.tsx, its neighbour in the same shell — flat borders, slate-900 header bar,
// KPI tiles, orange accent. Never a one-off look (owner's standing rule).

function Section({
  action,
  children,
  description,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <div className="border-b border-slate-200 bg-white last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 bg-slate-900 px-5 py-3.5">
        {/* flex-1 with a zero basis, NOT auto width: the description is a long sentence, so an
            auto-width title block measures wider than the row and pushes the rep picker onto a
            second line at every desktop size. Measured at 1280px — picker back beside the title
            at x=971..1259, page scroll width unchanged. */}
        <div className="min-w-0 flex-1">
          <h2 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{title}</h2>
          {description ? <p className="mt-0.5 text-phx-2xs text-slate-400">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Tile({ label, sub, tone, value }: { label: string; sub?: string; tone?: "amber" | "emerald" | "rose"; value: string }) {
  const valueClass =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "rose"
          ? "text-rose-700"
          : "text-slate-900";
  return (
    <div className="border border-slate-200 px-3 py-2.5">
      <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className={`text-lg font-black ${valueClass}`}>{value}</p>
      {sub ? <p className="text-phx-2xs text-slate-400">{sub}</p> : null}
    </div>
  );
}

/** Cairo wall-clock, per the owner's standing rule that no raw UTC is ever shown. */
function cairoStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date(iso));
}

export function DoctorListBoardView({ basePath, board }: { basePath: string; board: DoctorListBoard }) {
  const { reps, rows, scopeLabel, scopeReason, selected, syncedAt } = board;

  // A viewer who reaches nobody is told so in words. An empty picker would read as "the CRM holds
  // no lists", which is a completely different statement and the one a manager would act on.
  if (scopeReason) {
    return (
      <div className="border border-slate-200">
        <Section description="No reps are in your reach." title="Doctor List">
          <div className="px-5 py-6">
            <p className="text-sm font-semibold text-slate-700">{scopeReason}</p>
            <p className="mt-1 text-phx-xs text-slate-500">
              This board shows the doctor lists of the reps who report to you. Until the organogram places
              reps under your seat there is nothing here — which is not the same as the CRM holding no lists.
            </p>
          </div>
        </Section>
      </div>
    );
  }

  // An empty mirror is not the same statement as "this rep has no doctors", and the difference
  // matters enough to say in words: the first means the sync has not run, the second is a finding.
  if (!selected) {
    return (
      <div className="border border-slate-200">
        <Section description="Nothing has been mirrored from the CRM yet." title="Doctor List">
          <div className="px-5 py-6">
            <p className="text-sm font-semibold text-slate-700">No doctor lists have been synced yet.</p>
            <p className="mt-1 text-phx-xs text-slate-500">
              The daily sync fills this board from the CRM&apos;s own contact list. Until it has run once there is
              nothing to show — which is not the same as a rep having no doctors.
            </p>
          </div>
        </Section>
      </div>
    );
  }

  // Doctors and pharmacies are counted apart because they are not one population, and the owner's
  // 90-120 rule describes only the first. Both stay on screen; neither is folded into the other.
  const doctors = rows.filter((row) => row.listType !== "Pharmacy");
  const pharmacies = rows.filter((row) => row.listType === "Pharmacy");

  const gradeCounts = doctors.reduce<Record<string, number>>((acc, row) => {
    const key = row.grade?.trim() || "No grade";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const gradeSummary = Object.entries(gradeCounts)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([grade, count]) => `${grade} ${count}`)
    .join(" · ");

  const withAddress = doctors.filter((row) => Boolean(row.address?.trim())).length;
  const description = [
    "The rep's own CRM contact list — name, specialty, grade and address, exactly as the CRM holds them",
    "live contacts only; a doctor removed from the list stops being returned",
    `your reach: ${scopeLabel}`,
    syncedAt ? `last refreshed ${cairoStamp(syncedAt)} Cairo` : "never refreshed",
  ].join(" · ");

  return (
    <div className="border border-slate-200">
      <Section
        action={<DoctorListRepPicker basePath={basePath} reps={reps} selectedAgentCrmId={selected.agentCrmId} />}
        description={description}
        title={`Doctor List — ${selected.name}`}
      >
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile
              label="Doctor list"
              sub={
                selected.inExpectedBand
                  ? `within ${EXPECTED_PM_MIN}–${EXPECTED_PM_MAX}`
                  : `outside ${EXPECTED_PM_MIN}–${EXPECTED_PM_MAX}`
              }
              tone={selected.inExpectedBand ? "emerald" : "amber"}
              value={String(selected.pmCount)}
            />
            <Tile label="AM list" sub="second doctor list" value={String(selected.amCount)} />
            <Tile label="Pharmacies" sub="not doctors" value={String(selected.pharmacyCount)} />
            <Tile label="With an address" sub={`of ${doctors.length} doctors`} value={String(withAddress)} />
            <Tile label="Reps with a list" sub="mirrored from the CRM" value={String(reps.length)} />
            <Tile label="Grades" sub={gradeSummary || "none recorded"} value={String(Object.keys(gradeCounts).length)} />
          </div>
        </div>
      </Section>

      <Section
        description="Name, specialty, grade and address. Not visits — those live on Rep Doctor Lists."
        title={`Doctors — ${doctors.length}`}
      >
        <DoctorListTable repName={selected.name} rows={doctors} syncedAt={syncedAt} />
      </Section>

      {pharmacies.length > 0 ? (
        <Section
          description="Held on the same rep's account, kept separate because they are not doctors."
          title={`Pharmacies — ${pharmacies.length}`}
        >
          <DoctorListTable repName={selected.name} rows={pharmacies} syncedAt={syncedAt} />
        </Section>
      ) : null}
    </div>
  );
}
