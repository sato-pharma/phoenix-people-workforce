"use client";

/**
 * The Master List's profiles, one area or brick at a time (owner, 2026-10-26). Each brick lists its
 * speciality groups and its pharmacies; each profile shows the photograph it wears, who holds the
 * customer and on which lines, and when the visits happen — the usual window, the earliest and latest,
 * how long they last and on which days.
 *
 * The Super Admin's buttons store his word ("my click and automatic"); the CEO sees the same page without
 * them. A saved click re-reads the page, so what is shown is always what was stored.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { crmPost } from "@/components/phoenix-crm/api";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { CrmCardsOnPhone, CrmTable, crmTdClassName, crmThClassName } from "@/components/phoenix-crm/ui";
import { phxButtonApproveClassName, phxButtonDangerClassName, phxButtonGhostClassName } from "@/components/ui/form-tokens";
import { formatPhoenixDateTime } from "@/lib/i18n/format";
import { clockText, STATUS_TEXT, weekdaysText, type MasterBrick, type MasterProfile, type MasterVerdict } from "@/lib/phoenix-crm/master-list";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<MasterProfile["status"], string> = {
  confirmed: "border-emerald-600 text-emerald-700",
  needs_look: "border-amber-500 text-amber-700",
  rejected: "border-rose-600 text-rose-700",
};

type Save = (profile: MasterProfile, anchorPlaceId: string, verdict: MasterVerdict | null) => void;

function TimingText({ profile }: { profile: MasterProfile }) {
  const t = profile.timings;
  if (t.visits === 0) return <p className="text-xs font-semibold text-slate-500">No visits in the last three months</p>;
  return (
    <div className="space-y-1 text-xs font-semibold text-slate-700">
      <p>
        {t.visits} visits by {t.repsVisiting} {t.repsVisiting === 1 ? "rep" : "reps"}
      </p>
      {t.usualFrom !== null && t.usualTo !== null ? (
        <p>
          Usually {clockText(t.usualFrom)} to {clockText(t.usualTo)}
        </p>
      ) : null}
      {t.earliest !== null && t.latest !== null ? (
        <p className="text-slate-500">
          From {clockText(t.earliest)} to {clockText(t.latest)}
        </p>
      ) : null}
      {t.typicalMinutes !== null ? (
        <p className="text-slate-500">
          About {t.typicalMinutes} min ({t.shortestMinutes} to {t.longestMinutes})
        </p>
      ) : null}
      <p className="text-slate-500">{weekdaysText(t.weekdays)}</p>
    </div>
  );
}

function HoldersText({ profile }: { profile: MasterProfile }) {
  return (
    <ul className="space-y-1">
      {profile.holders.map((holder, index) => (
        <li key={`${profile.members[index]?.placeId ?? index}`} className="break-words text-xs font-semibold text-slate-700">
          {holder.repName}
          {holder.lineName ? <span className="text-slate-500"> · {holder.lineName}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function CustomerText({ profile }: { profile: MasterProfile }) {
  return (
    <div className="min-w-0 space-y-1">
      <p dir="auto" className="break-words text-sm font-black text-slate-900">
        {profile.title}
      </p>
      <p className="break-words text-xs font-semibold text-slate-500">
        {[profile.listType === "Pharmacy" ? "Pharmacy" : profile.listType, profile.speciality].filter(Boolean).join(" · ")}
      </p>
      {profile.anchor.address ? (
        <p dir="auto" className="break-words text-xs text-slate-500">
          {profile.anchor.address}
        </p>
      ) : null}
      {profile.members.length > 1 ? (
        <p className="break-words text-xs font-semibold text-slate-500">
          {profile.members.length} validations, {profile.spreadMeters ?? 0} m apart at most
        </p>
      ) : null}
    </div>
  );
}

function Photos({ profile, canDecide, busy, onSave }: { profile: MasterProfile; canDecide: boolean; busy: boolean; onSave: Save }) {
  const others = profile.members.filter((member) => member !== profile.anchor && member.photoPath);
  return (
    <div className="min-w-0 space-y-2">
      <CrmPhotoThumb alt={profile.title} lazy path={profile.anchor.photoPath} />
      {others.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {others.map((member) => (
            <div key={member.placeId} className="min-w-0 space-y-1">
              <CrmPhotoThumb alt={`${profile.title} — ${member.repName}`} className="h-14 w-14" lazy path={member.photoPath} />
              {canDecide ? (
                <button
                  type="button"
                  disabled={busy}
                  className="block text-phx-2xs font-black uppercase tracking-[0.08em] text-orange-700 hover:underline disabled:opacity-40"
                  onClick={() => onSave(profile, member.placeId, "confirmed")}
                >
                  Use this photo
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StatusBlock({ profile, canDecide, busy, onSave }: { profile: MasterProfile; canDecide: boolean; busy: boolean; onSave: Save }) {
  return (
    <div className="min-w-0 space-y-2">
      <span className={cn("inline-block border px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em]", STATUS_TONE[profile.status])}>
        {STATUS_TEXT[profile.status]}
      </span>
      <p className="break-words text-xs font-semibold text-slate-600">{profile.reason}</p>
      {profile.decision ? <p className="text-xs text-slate-500">{formatPhoenixDateTime(profile.decision.decidedAt)}</p> : null}
      {canDecide ? (
        <div className="flex flex-wrap gap-2">
          {profile.decision?.verdict !== "confirmed" ? (
            <button type="button" disabled={busy} className={phxButtonApproveClassName} onClick={() => onSave(profile, profile.id, "confirmed")}>
              Confirm
            </button>
          ) : null}
          {profile.decision?.verdict !== "rejected" ? (
            <button type="button" disabled={busy} className={phxButtonDangerClassName} onClick={() => onSave(profile, profile.id, "rejected")}>
              Not confirmed
            </button>
          ) : null}
          {profile.decision ? (
            <button type="button" disabled={busy} className={phxButtonGhostClassName} onClick={() => onSave(profile, profile.id, null)}>
              Clear decision
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function GroupTable({ profiles, canDecide, busyId, onSave }: { profiles: MasterProfile[]; canDecide: boolean; busyId: string | null; onSave: Save }) {
  return (
    <>
      <CrmCardsOnPhone>
        {profiles.map((profile) => (
          <div key={profile.id} className="space-y-3 px-4 py-4">
            <div className="flex min-w-0 gap-3">
              <Photos profile={profile} canDecide={canDecide} busy={busyId === profile.id} onSave={onSave} />
              <CustomerText profile={profile} />
            </div>
            <HoldersText profile={profile} />
            <TimingText profile={profile} />
            <StatusBlock profile={profile} canDecide={canDecide} busy={busyId === profile.id} onSave={onSave} />
          </div>
        ))}
      </CrmCardsOnPhone>
      <CrmTable columns={["20%", "24%", "18%", "20%", "18%"]}>
        <thead>
          <tr>
            <th className={crmThClassName}>Photo</th>
            <th className={crmThClassName}>Customer</th>
            <th className={crmThClassName}>Held by</th>
            <th className={crmThClassName}>Visits</th>
            <th className={crmThClassName}>Status</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => (
            <tr key={profile.id}>
              <td className={crmTdClassName}>
                <Photos profile={profile} canDecide={canDecide} busy={busyId === profile.id} onSave={onSave} />
              </td>
              <td className={crmTdClassName}>
                <CustomerText profile={profile} />
              </td>
              <td className={crmTdClassName}>
                <HoldersText profile={profile} />
              </td>
              <td className={crmTdClassName}>
                <TimingText profile={profile} />
              </td>
              <td className={crmTdClassName}>
                <StatusBlock profile={profile} canDecide={canDecide} busy={busyId === profile.id} onSave={onSave} />
              </td>
            </tr>
          ))}
        </tbody>
      </CrmTable>
    </>
  );
}

export function MasterListBoard({ bricks, canDecide }: { bricks: MasterBrick[]; canDecide: boolean }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const save: Save = (profile, anchorPlaceId, verdict) => {
    setBusyId(profile.id);
    setError(null);
    crmPost("/api/phoenix-crm/master-list/decision", { anchorPlaceId, memberPlaceIds: profile.members.map((member) => member.placeId), verdict }, "decision")
      .then(() => startTransition(() => router.refresh()))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Phoenix could not save this. Try again."))
      .finally(() => setBusyId(null));
  };

  return (
    <div className="space-y-5">
      {error ? <p className="border border-rose-300 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</p> : null}
      {bricks.map((brick) => (
        <section key={brick.brickName} className="border border-slate-200 bg-white">
          <header className="border-b border-slate-200 px-4 py-3">
            <h2 className="break-words text-base font-black text-slate-900">{brick.brickName}</h2>
            <p className="text-xs font-semibold text-slate-500">
              {brick.groups.reduce((total, group) => total + group.profiles.length, 0)} profiles · {brick.groups.map((group) => group.label).join(" · ")}
            </p>
          </header>
          {brick.groups.map((group) => (
            <div key={group.label}>
              <h3 className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs font-black uppercase tracking-[0.12em] text-slate-600">
                {group.label} · {group.profiles.length}
              </h3>
              <GroupTable profiles={group.profiles} canDecide={canDecide} busyId={busyId} onSave={save} />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
