"use client";

import { countOf } from "@/lib/i18n/format";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import type {
  DirectOrderCleanupLookAlike,
  DirectOrderCleanupMerge,
  DirectOrderCleanupPlan,
  DirectOrderCleanupRequestSummary,
} from "@/lib/direct-orders/service";
import { stableEnGbFormatter, utcDate } from "@/lib/format/cairo-datetime";
import { humanizeCode } from "@/lib/format/code-label";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import { adminPanelClassName, adminPanelHeaderClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

type Props = { plan: DirectOrderCleanupPlan };

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

const cairoStamp = (iso: string | null) =>
  iso
    ? stableEnGbFormatter({
        timeZone: "Africa/Cairo",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(iso))
    : "—";

const STATUS_TONE: Record<string, string> = {
  pending_approval: "bg-amber-100 text-amber-800",
  held: "bg-slate-200 text-slate-600",
  returned: "bg-orange-100 text-orange-800",
  draft: "bg-slate-100 text-slate-500",
};

/** Every field that made two requests the same order, spelled out — the evidence, not a verdict. */
function OrderLine({ request }: { request: DirectOrderCleanupRequestSummary }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-bold text-slate-900">
          {request.productName}
        </span>
        <span className={`px-1.5 py-0.5 text-phx-2xs font-black uppercase ${STATUS_TONE[request.status] ?? "bg-slate-200 text-slate-600"}`}>
          {humanizeCode(request.status)}
        </span>
        {request.approvedStepCount > 0 ? (
          <span className="bg-emerald-100 px-1.5 py-0.5 text-phx-2xs font-black uppercase text-emerald-800">
            {request.approvedStepCount} approval(s) given
          </span>
        ) : null}
      </div>
      <div className="mt-0.5 text-phx-xs text-slate-600">
        {request.qty.toLocaleString("en-US")} units · {request.dealType}
        {request.discountPct != null ? ` ${request.discountPct}%` : ""} · {money(request.salesValue)} · collection{" "}
        {utcDate(request.collectionDate)}
      </div>
      <div className="text-phx-xs text-slate-500" dir="auto">
        {request.requesterName} · {request.pharmacyName} · submitted{" "}
        {cairoStamp(request.submittedAt)}
      </div>
    </div>
  );
}

/**
 * Approved orders a merge would repoint — the losing records' already-committed business.
 *
 * Read off the losers only, never the survivor: the survivor's own approved orders do not move.
 * The plan's `requestsMoved` cannot answer this, because it is built from the OPEN-status query
 * that feeds the cancellation proposal, while the merge write repoints every request regardless of
 * status. Two different questions, and conflating them is what let the screen under-report.
 */
const approvedMoving = (merge: DirectOrderCleanupMerge) =>
  merge.merged.reduce((sum, entry) => sum + entry.approvedRequestCount, 0);

/**
 * Same name, same area — and the system will NOT rule on it.
 *
 * Review-only by construction, not by convention: this renders no checkbox and no radio, and
 * nothing it displays is wired to the confirm payload. Every pair it can show has approved orders
 * on at least one side, and the owner's rule of 2026-08-29 is that a venue row carrying confirmed
 * orders is never touched — so offering a default-ticked merge here would be offering exactly the
 * write that rule forbids. What a reviewer gets instead is both records side by side, what each is
 * carrying, and why the system is staying out of it.
 */
function LookAlikes({ groups }: { groups: DirectOrderCleanupLookAlike[] }) {
  if (groups.length === 0) return null;
  return (
    <section className="mt-5 border border-amber-300 bg-white">
      <header className="border-b border-amber-300 bg-amber-50 px-4 py-2.5">
        <p className="text-phx-xs font-black uppercase tracking-wider text-amber-800">
          Look-alike venues — your judgement
        </p>
        <p className="text-phx-sm text-amber-900">
          {groups.length} pair(s) share a name and an area, and the system will not merge them on its own. Nothing
          here is applied by the confirm button — read them and decide.
        </p>
      </header>
      <div className="space-y-3 p-3">
        {groups.map((group) => (
          <article key={`${group.normalizedName}|${group.areaCode}`} className="border border-phx-line p-3">
            <p className="text-sm font-black text-slate-900" dir="auto">
              {group.members[0]?.pharmacyName} — area {group.areaCode}
            </p>
            <p className="mt-0.5 text-phx-sm text-slate-600">{group.explanation}</p>
            <div className="mt-2 space-y-1.5">
              {group.members.map((member) => (
                <div key={member.pharmacyId} className={`border border-[#eef1f3] bg-white px-2 py-1.5 ${adminSoftDepthClassName}`}>
                  <p className="text-phx-sm font-bold text-slate-900" dir="auto">
                    {member.pharmacyName}
                    <span
                      className={`ml-1 text-phx-2xs font-black uppercase ${
                        member.active ? "text-emerald-700" : "text-slate-500"
                      }`}
                    >
                      {member.active ? "active" : "closed"}
                    </span>
                  </p>
                  <p className="text-phx-xs text-slate-600">
                    {member.linkedCodes.length > 0 ? member.linkedCodes.join(" · ") : "no distributor code linked"}
                    {" · "}
                    {countOf(member.openRequestCount, "open request")} · registered by {member.createdByName} on{" "}
                    {cairoStamp(member.createdAt)}
                  </p>
                  {member.approvedRequestCount > 0 ? (
                    <p className="text-phx-xs font-bold text-amber-700">
                      {member.approvedRequestCount} approved order(s) · {money(member.approvedRequestValue)} already
                      committed — this record cannot be closed while that stands
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * The cleanup desk (owner rules 1-5, 2026-08-09).
 *
 * Every proposal is opt-in and individually switchable. The default is ON — the owner asked the
 * system to do the work, not to present a blank form — but a reviewer who disagrees with one merge
 * unticks it and confirms the rest. That is what "SFE REVISE AND CONFIRM AND IF ANY EDIT HE DO IT"
 * means in practice: the system decides, the human overrides.
 *
 * A merge also lets the reviewer pick a DIFFERENT survivor, because the ranking is a rule and the
 * reviewer may know something the rule does not.
 */
export function DirectOrderCleanupDesk({ plan }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  // Everything on by default; unticking is the edit.
  const [offMerges, setOffMerges] = useState<Set<string>>(new Set());
  const [offDuplicates, setOffDuplicates] = useState<Set<string>>(new Set());
  const [offRepairs, setOffRepairs] = useState<Set<string>>(new Set());
  const [offReleases, setOffReleases] = useState<Set<string>>(new Set());
  // survivorId override, keyed by the proposal's original survivor.
  const [survivorChoice, setSurvivorChoice] = useState<Record<string, string>>({});

  const toggle = (setter: typeof setOffMerges) => (key: string) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const changeCount = useMemo(() => {
    const merges = plan.merges.filter((merge) => !offMerges.has(merge.survivor.pharmacyId)).length;
    const duplicates = plan.duplicates
      .filter((group) => !offDuplicates.has(group.keeper.requestId))
      .reduce((sum, group) => sum + group.duplicates.length, 0);
    const repairs = plan.repairs.filter((repair) => !offRepairs.has(repair.pharmacyId)).length;
    const releases = plan.releases
      .filter((release) => !offReleases.has(release.pharmacyId))
      .reduce((sum, release) => sum + release.requests.length, 0);
    return { merges, duplicates, repairs, releases, total: merges + duplicates + repairs + releases };
  }, [plan, offMerges, offDuplicates, offRepairs, offReleases]);

  async function confirm() {
    if (!reason.trim()) {
      setError("Say why this cleanup is being applied — the reason is the record.");
      return;
    }
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch("/api/direct-orders/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merges: plan.merges
            .filter((merge) => !offMerges.has(merge.survivor.pharmacyId))
            .map((merge) => {
              const chosen = survivorChoice[merge.survivor.pharmacyId] ?? merge.survivor.pharmacyId;
              const everyone = [merge.survivor.pharmacyId, ...merge.merged.map((entry) => entry.pharmacyId)];
              return { survivorId: chosen, mergedIds: everyone.filter((id) => id !== chosen) };
            }),
          duplicates: plan.duplicates
            .filter((group) => !offDuplicates.has(group.keeper.requestId))
            .map((group) => ({
              keeperId: group.keeper.requestId,
              duplicateIds: group.duplicates.map((request) => request.requestId),
            })),
          repairPharmacyIds: plan.repairs
            .filter((repair) => !offRepairs.has(repair.pharmacyId))
            .map((repair) => repair.pharmacyId),
          releasePharmacyIds: plan.releases
            .filter((release) => !offReleases.has(release.pharmacyId))
            .map((release) => release.pharmacyId),
          reason: reason.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        message?: string;
        pharmaciesMerged?: number;
        requestsMoved?: number;
        requestsCancelled?: number;
        codesRepaired?: number;
        requestsReleased?: number;
      };
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not apply the cleanup.");
        return;
      }
      setOk(
        `Done — ${data.pharmaciesMerged ?? 0} venue record(s) merged, ${countOf(data.requestsMoved ?? 0, "request")} moved, ` +
          `${data.requestsCancelled ?? 0} duplicate(s) cancelled, ${data.codesRepaired ?? 0} code(s) repaired, ` +
          `${countOf(data.requestsReleased ?? 0, "held request")} released.`,
      );
      setReason("");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (plan.isEmpty) {
    return (
      <>
        <section className={`border border-phx-line bg-white px-4 py-8 text-center ${adminSoftDepthClassName}`}>
          <p className="text-sm font-bold text-slate-800">
            {plan.lookAlikes.length > 0 ? "Nothing the system can fix on its own." : "Nothing to clean up."}
          </p>
          <p className="mt-1 text-phx-sm text-slate-500">
            {plan.lookAlikes.length > 0 ? (
              <>
                No order is submitted twice and every distributor code is in its own column. What is left is{" "}
                {plan.lookAlikes.length} look-alike pair(s) below that only a person can rule on. This page checks
                live data each time it loads.
              </>
            ) : (
              <>
                No venue is registered twice, no order is submitted twice, and every distributor code is in its own
                column. This page checks live data each time it loads.
              </>
            )}
          </p>
        </section>
        <LookAlikes groups={plan.lookAlikes} />
      </>
    );
  }

  return (
    <>
      <section className={adminPanelClassName}>
        <header className={`${adminPanelHeaderClassName} flex flex-wrap items-center justify-between gap-3 px-4 py-2.5`}>
          <div>
            <p className="text-phx-xs font-black uppercase tracking-wider text-orange-400">Proposed cleanup</p>
            <p className="text-phx-sm text-slate-300">
              {changeCount.total} change(s) selected — everything is on by default; untick anything you disagree with.
            </p>
          </div>
        </header>

        {error ? <p className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700">{error}</p> : null}
        {ok ? <p className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700">{ok}</p> : null}

        {/* ── One pharmacy, two records ─────────────────────────────────────────── */}
        {plan.merges.length > 0 ? (
          <div className="border-b border-phx-line p-3">
            <p className="mb-2 text-phx-xs font-black uppercase tracking-wider text-slate-500">
              Same venue, entered more than once
            </p>
            <div className="space-y-3">
              {plan.merges.map((merge) => {
                const key = merge.survivor.pharmacyId;
                const on = !offMerges.has(key);
                const chosen = survivorChoice[key] ?? merge.survivor.pharmacyId;
                const everyone = [merge.survivor, ...merge.merged];
                return (
                  <article key={key} className={`border p-3 ${on ? "border-phx-line" : "border-slate-200 bg-slate-50 opacity-60"}`}>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={on} onChange={() => toggle(setOffMerges)(key)} className="mt-1" />
                      <span className="min-w-0">
                        <span className="block text-sm font-black text-slate-900">
                          {everyone.length} records are one venue
                        </span>
                        <span className="block text-phx-sm text-slate-600">
                          {merge.provenBy.kind === "code" ? (
                            <>
                              Proven by the same distributor customer: {merge.provenBy.distributorCode} /{" "}
                              {merge.provenBy.customerCode}. A distributor customer cannot belong to two venues.
                            </>
                          ) : (
                            <>
                              Same name, same area ({merge.provenBy.areaCode}) — neither record carries a distributor
                              code, so this is a resemblance, not a distributor-proven fact. Check the names below
                              before merging.
                            </>
                          )}
                        </span>
                      </span>
                    </label>

                    <div className="mt-2 space-y-1.5">
                      {everyone.map((pharmacy) => (
                        <label
                          key={pharmacy.pharmacyId}
                          className={`flex items-start gap-2 border px-2 py-1.5 ${
                            pharmacy.pharmacyId === chosen ? "border-emerald-300 bg-emerald-50" : "border-[#eef1f3] bg-white"
                          }`}
                        >
                          <input
                            type="radio"
                            name={`survivor-${key}`}
                            checked={pharmacy.pharmacyId === chosen}
                            onChange={() => setSurvivorChoice((prev) => ({ ...prev, [key]: pharmacy.pharmacyId }))}
                            disabled={!on}
                            className="mt-1"
                          />
                          <span className="min-w-0">
                            <span className="block text-phx-sm font-bold text-slate-900" dir="auto">
                              {pharmacy.pharmacyName}
                              {pharmacy.pharmacyId === chosen ? (
                                <span className="ml-1 text-phx-2xs font-black uppercase text-emerald-700">keeps everything</span>
                              ) : (
                                <span className="ml-1 text-phx-2xs font-black uppercase text-rose-700">will be closed</span>
                              )}
                            </span>
                            <span className="block text-phx-xs text-slate-600">
                              {pharmacy.linkedCodes.length > 0 ? pharmacy.linkedCodes.join(" · ") : "no distributor code linked"}
                              {" · "}
                              {countOf(pharmacy.openRequestCount, "open request")} · registered by {pharmacy.createdByName} on{" "}
                              {cairoStamp(pharmacy.createdAt)}
                            </span>
                            {pharmacy.approvedRequestCount > 0 ? (
                              <span className="block text-phx-xs font-bold text-amber-700">
                                {pharmacy.approvedRequestCount} approved order(s) · {money(pharmacy.approvedRequestValue)}{" "}
                                already committed — a merge moves these onto the surviving record
                              </span>
                            ) : null}
                          </span>
                        </label>
                      ))}
                    </div>
                    <p className="mt-1.5 text-phx-xs text-slate-500">
                      Kept because {merge.reason}. {countOf(merge.requestsMoved.length, "open request")}
                      {approvedMoving(merge) > 0
                        ? ` and ${approvedMoving(merge)} approved order(s) move across`
                        : " move across"}
                      ; nothing is deleted and the closed record keeps a pointer to the one that survived.
                    </p>
                  </article>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* ── One order, two submissions ────────────────────────────────────────── */}
        {plan.duplicates.length > 0 ? (
          <div className="border-b border-phx-line p-3">
            <p className="mb-2 text-phx-xs font-black uppercase tracking-wider text-slate-500">
              Same order, submitted more than once
            </p>
            <div className="space-y-3">
              {plan.duplicates.map((group) => {
                const key = group.keeper.requestId;
                const on = !offDuplicates.has(key);
                const doubled = group.duplicates.reduce((sum, request) => sum + request.salesValue, 0);
                return (
                  <article key={key} className={`border p-3 ${on ? "border-phx-line" : "border-slate-200 bg-slate-50 opacity-60"}`}>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={on} onChange={() => toggle(setOffDuplicates)(key)} className="mt-1" />
                      <span className="min-w-0">
                        <span className="block text-sm font-black text-slate-900">
                          {money(doubled)} counted twice — {group.duplicates.length} copy(ies) to cancel
                        </span>
                        <span className="block text-phx-sm text-slate-600">
                          Same venue, product, quantity, deal terms and collection date.
                        </span>
                      </span>
                    </label>

                    <div className="mt-2 space-y-1.5">
                      <div className="border border-emerald-300 bg-emerald-50 px-2 py-1.5">
                        <p className="text-phx-2xs font-black uppercase text-emerald-700">Kept — {group.reason}</p>
                        <OrderLine request={group.keeper} />
                      </div>
                      {group.duplicates.map((request) => (
                        <div key={request.requestId} className="border border-rose-200 bg-rose-50 px-2 py-1.5">
                          <p className="text-phx-2xs font-black uppercase text-rose-700">
                            Cancelled as a duplicate, linked to the one above
                          </p>
                          <OrderLine request={request} />
                        </div>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* ── Codes in the wrong field ──────────────────────────────────────────── */}
        {plan.repairs.length > 0 ? (
          <div className="border-b border-phx-line p-3">
            <p className="mb-2 text-phx-xs font-black uppercase tracking-wider text-slate-500">
              Distributor code typed into the venue name
            </p>
            <div className="space-y-2">
              {plan.repairs.map((repair) => {
                const on = !offRepairs.has(repair.pharmacyId);
                return (
                  <label
                    key={repair.pharmacyId}
                    className={`flex items-start gap-2 border p-2.5 ${on ? "border-phx-line" : "border-slate-200 bg-slate-50 opacity-60"}`}
                  >
                    <input type="checkbox" checked={on} onChange={() => toggle(setOffRepairs)(repair.pharmacyId)} className="mt-1" />
                    <span className="min-w-0">
                      <span className="block text-phx-sm font-bold text-slate-900" dir="auto">
                        {repair.pharmacyName}
                      </span>
                      <span className="block text-phx-xs text-slate-600">
                        Move {repair.distributorName} / {repair.customerCode} into the distributor-code column
                        {repair.renameTo ? `, and correct the name to "${repair.renameTo}"` : ""}. This unlocks the
                        pharmacy&apos;s retail sales history, which cannot be matched without the code.
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* ── Held requests that resolution frees ───────────────────────────────── */}
        {plan.releases.length > 0 ? (
          <div className="border-b border-phx-line p-3">
            <p className="mb-2 text-phx-xs font-black uppercase tracking-wider text-slate-500">
              Held requests these fixes release
            </p>
            <div className="space-y-2">
              {plan.releases.map((release) => {
                const on = !offReleases.has(release.pharmacyId);
                return (
                  <label
                    key={release.pharmacyId}
                    className={`flex items-start gap-2 border p-2.5 ${on ? "border-phx-line" : "border-slate-200 bg-slate-50 opacity-60"}`}
                  >
                    <input type="checkbox" checked={on} onChange={() => toggle(setOffReleases)(release.pharmacyId)} className="mt-1" />
                    <span className="min-w-0">
                      <span className="block text-phx-sm font-bold text-slate-900" dir="auto">
                        {release.pharmacyName} — {countOf(release.requests.length, "held request")}
                      </span>
                      <span className="block text-phx-xs text-slate-600">
                        Once this venue is resolved, every one of its held requests enters the approval chain at
                        step 1 (SFE Manager) — not just one of them. Releasing is not skipping review.
                      </span>
                      <span className="mt-1 block space-y-1">
                        {release.requests.map((request) => (
                          <span key={request.requestId} className={`block border border-[#eef1f3] bg-white px-2 py-1 ${adminSoftDepthClassName}`}>
                            <OrderLine request={request} />
                          </span>
                        ))}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* ── Confirm ───────────────────────────────────────────────────────────── */}
        <div className="p-3">
          <label className="block text-phx-xs font-black uppercase tracking-wider text-slate-500" htmlFor="cleanup-reason">
            Why you are applying this
          </label>
          <textarea
            id="cleanup-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            placeholder="Reviewed the pairs against the distributor master — same venue, same order."
            className={`${phxTextareaClassName} mt-1`}
          />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={confirm}
              disabled={busy || changeCount.total === 0}
              className="bg-slate-900 px-4 py-2 text-phx-sm font-black uppercase tracking-wider text-white disabled:opacity-50"
            >
              {busy ? "Applying…" : `Confirm ${changeCount.total} change(s)`}
            </button>
            <p className="text-phx-xs text-slate-500">
              {changeCount.merges} merge(s) · {changeCount.duplicates} cancellation(s) · {changeCount.repairs} code
              repair(s) · {changeCount.releases} release(s)
            </p>
          </div>
        </div>
      </section>
      <LookAlikes groups={plan.lookAlikes} />
    </>
  );
}
