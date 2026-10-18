import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckCheck, Eye, GalleryHorizontalEnd, ShieldAlert, Undo2, Users } from "lucide-react";

import { AdminCallout, AdminPageHero, AdminStatCard, AdminTableShell } from "@/components/admin/admin-design-system";
import { IntegrityBoardView } from "@/components/crm-integrity/integrity-board-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import {
  canReadIntegrityBoard,
  canSettleIntegrityCases,
  loadIntegrityBoard,
  readsPositionCases,
  type BehaviourCase,
} from "@/lib/phoenix-crm/server/integrity-board";

export const dynamic = "force-dynamic";

/**
 * Location integrity — the Super Admin's and the SFE Manager's board, and the ONLY screen that reads
 * the evidence (owner, 2026-09-26: "recorded in the admin and the SFE account").
 *
 * 🔒 IT CARRIES FOUR DETECTORS AND KEEPS ITS NAME. The position checks judge one fix, the nightly
 * photo sweep judges one picture (D5, source "photo"), the signboard pass judges whether the sign on
 * the building names the customer the place was validated for (source "signboard", from 2026-10-08),
 * and the behaviour pass judges a rep's whole month (D4, its own table and its own section below).
 * The name says one of the four, and that was PUT TO THE OWNER on 2026-09-27 once it had stopped
 * describing the board. He answered "keep the name Location integrity". Settled, not deferred: the
 * fourth detector landed and the DESCRIPTION widened, exactly as that ruling said it should.
 *
 * It sits under /admin, which a rep cannot open at all. That is the whole reason it is a page of its
 * own rather than a tab inside Phoenix CRM: the CRM tabs are the same component tree the field app
 * renders, and one wrong role check there would show a rep that he had been caught. Here there is no
 * such tree to get wrong.
 *
 * THE ONE THING THIS PAGE DOES IS SETTLE A CASE, and only for the Super Admin. He writes why, the
 * case leaves the counters, and NOTHING is deleted: the row keeps its flags, its signals and its
 * evidence, and the settlement is four extra columns beside them. No rep is notified, because no rep
 * is ever told he was flagged in the first place. What to DO about a case — the rep, the day, the
 * money — is still his call away from this screen; settling only records that he has looked.
 *
 * 🔴 AND A SETTLED CASE COMES BACK ON ITS OWN. The settlement stamps the flags it was taken on, and
 * a case counts as settled only while those still match the row's — so a detector that files a new
 * finding on the same subject puts it back among the findings with no filer knowing settling exists.
 * Settled is "he has looked", never "closed for ever".
 *
 * 🔴 THE CASES THEMSELVES ARE IN `IntegrityBoardView`, AND THIS PAGE IS THE FRAME AROUND THEM. It
 * reads the board, gates it, and renders the hero, the counters, every callout, the behaviour table
 * and the By-rep list — everything whose answer is one number. The three case lists are a client
 * component because what he asked for on 2026-10-13 is all interaction: filter by everything,
 * multi-select, open one case into its own story, see the readings on a map. Narrowing 164 cases in
 * the browser costs nothing; narrowing them on the server would re-run ten chunked reads per
 * keystroke.
 *
 * 🔴 A FLAG A LATER READING NO LONGER SUPPORTS IS SHOWN, NOT CLEARED, and that is a different thing
 * again. A signboard verdict is not stable — the same photograph read a name at 18:12 and nothing at
 * 18:34 on 2026-10-09 — so four of the five signboard flags on this board that evening were already
 * contradicted by the place's own stored verdict, and the page said nothing about it. They sit in
 * their own section with both readings side by side and out of the counters, because a counter is a
 * call to look. Withdrawn is the EVIDENCE giving way; settled is a DECISION. A case that is both is
 * listed as withdrawn, so that section's claim stays true of every row in it.
 */

/**
 * The counter row's grid, by how many of the two conditional counters are showing.
 *
 * Written out in full because Tailwind reads the SOURCE: a class assembled at runtime is never
 * generated, so the row would collapse to one column at every width with nothing to see in the diff.
 */
const COUNTER_GRID = ["sm:grid-cols-3", "sm:grid-cols-2 xl:grid-cols-4", "sm:grid-cols-2 xl:grid-cols-5"] as const;

function monthName(month: string): string {
  const [year, index] = month.split("-").map((part) => Number(part));
  if (!Number.isFinite(year) || !Number.isFinite(index)) return month;
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(Date.UTC(year, index - 1, 1)));
}

function BehaviourReasons({ entry }: { entry: BehaviourCase }) {
  return (
    <ul className="space-y-1">
      {entry.reasons.map((reason) => (
        <li key={reason} className="flex items-start gap-2 text-sm leading-6 text-slate-700">
          <span className={`mt-2 h-1.5 w-1.5 shrink-0 ${entry.strong ? "bg-rose-500" : "bg-amber-500"}`} />
          <span>{reason}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function PhoenixCrmIntegrityPage() {
  const access = await resolveAccessContextFromPage();
  // Gate one before the organogram (audit, 2026-10-02): a per-account module lock on Phoenix CRM
  // closes this page as well, which `canReadIntegrityBoard` alone — a role test — never did.
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canReadIntegrityBoard(viewer)) redirect("/admin");

  const board = await loadIntegrityBoard(viewer);
  const weakCount = board.cases.length - board.strongCount;
  // The position cases are the Super Admin's alone (owner, 2026-10-02); the service never queries them
  // for the SFE Manager, so his page must not describe a detector whose cases it will never show him.
  const positions = readsPositionCases(viewer);
  // Settling is the Super Admin's alone, and the button is simply absent for anybody else. The route
  // and the service each refuse him as well — this is the UX layer of three, never the gate.
  const canSettle = canSettleIntegrityCases(viewer);
  // Three counters always; the two that only mean something once a case has reached that state appear
  // when it has. A withdrawn or settled case is never silently absent — it is counted by name instead.
  const extraCounters = (board.withdrawn.length > 0 ? 1 : 0) + (board.settled.length > 0 ? 1 : 0);

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="Location integrity"
        description={
          positions
            ? "Captures Phoenix could not account for — a mock location app the phone admitted to, a coordinate used before, a trip nobody could have made, a photograph that had already been sent, a sign on the building naming somebody else, or a month whose shape no honest month has. Nothing here is a verdict and no rep is told: it is where to look, and what to look at."
            : "Captures Phoenix could not account for — a photograph that had already been sent, or a month whose shape no honest month has. Nothing here is a verdict and no rep is told: it is where to look, and what to look at."
        }
        icon={<ShieldAlert className="h-3.5 w-3.5" />}
        actions={
          // The one-by-one review lives on Place checks, which is the Super Admin's alone — the SFE
          // Manager, who reads this board, is never offered a door to a page that would turn him away.
          canSettle && board.cases.length > 0 ? (
            <Link
              className="inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-none border border-orange-600 bg-orange-600 px-4 py-2 text-center text-sm font-black text-white transition hover:bg-orange-700"
              href="/admin/field-crm/validation-reviews?review=integrity"
            >
              <GalleryHorizontalEnd aria-hidden className="h-4 w-4 shrink-0" />
              Review the cases one by one
            </Link>
          ) : undefined
        }
      />

      {/* Three, four or five counters. A withdrawn flag and a settled case each leave the findings and
          are counted by name instead — never silently absent from the page. The grid stays two-up on a
          phone and never scrolls sideways whichever way it lands. */}
      {/* 🔴 WHOLE CLASS NAMES, never a built string: Tailwind generates what it can SEE in the source,
          so `"xl:grid-cols-" + n` compiles to a class that does not exist and the row silently stays
          one-up at every width. */}
      <div className={`grid gap-3 ${COUNTER_GRID[extraCounters]}`}>
        <AdminStatCard
          icon={<ShieldAlert className="h-5 w-5" />}
          label="Strong cases"
          value={board.strongCount}
          description="At least one signal that stands on its own"
          tone="rose"
          size="compact"
        />
        <AdminStatCard
          icon={<Eye className="h-5 w-5" />}
          label="Worth a look"
          value={weakCount}
          description="Corroborating signals only"
          tone="orange"
          size="compact"
        />
        <AdminStatCard
          icon={<Users className="h-5 w-5" />}
          label="Reps involved"
          value={board.byRep.length}
          description="A pattern matters more than an incident"
          tone="blue"
          size="compact"
        />
        {board.withdrawn.length > 0 ? (
          <AdminStatCard
            icon={<Undo2 className="h-5 w-5" />}
            label="Withdrawn"
            value={board.withdrawn.length}
            description="A later reading no longer supports them"
            tone="violet"
            size="compact"
          />
        ) : null}
        {board.settled.length > 0 ? (
          <AdminStatCard
            icon={<CheckCheck className="h-5 w-5" />}
            label="Settled"
            value={board.settled.length}
            description="Looked at, with the reason on the record"
            tone="emerald"
            size="compact"
          />
        ) : null}
      </div>

      {/* 🔴 SAID BEFORE ANY COUNT, because every counter above is a count of what was READ. The board
          ran on a flat `.limit(200)` with no tiebreaker until 2026-10-12: past that it showed the
          newest cases and said nothing, and "nothing flagged" could have meant "nothing in the first
          200". It pages now, and this is what it says when it still reaches its ceiling. */}
      {board.capped ? (
        <AdminCallout tone="warning">
          <span>
            This board is showing the strongest and newest cases only: there are more than one read can hold. Settle what is here, or
            narrow the board, to reach the older ones — every count on this page is a count of what was read.
          </span>
        </AdminCallout>
      ) : null}

      {/* Every list, not just the live one: five withdrawn flags or a settled case beside the words
          "nothing flagged" would be the page contradicting itself. */}
      {!board.capped && board.cases.length === 0 && board.withdrawn.length === 0 && board.settled.length === 0 ? (
        <AdminCallout tone="success">
          <span>
            {positions
              ? "Nothing flagged. Every position and every photograph captured in Phoenix CRM so far has been one the server could account for — and the checks run on every visit and every validated place, whether or not the phone reports anything."
              : "Nothing flagged. Every photograph captured in Phoenix CRM so far has been one the server could account for — and the check runs on every visit and every validated place."}
          </span>
        </AdminCallout>
      ) : null}

      {board.cases.length === 0 && board.withdrawn.length > 0 && board.settled.length === 0 ? (
        <AdminCallout tone="neutral">
          <span>
            Nothing stands. Every flag on this board has been read again since it was filed, and the later reading no longer supports it — they are listed
            below with both readings, and none of them has been deleted.
          </span>
        </AdminCallout>
      ) : null}

      {/* The two can be true at once, and the honest line names both rather than picking one. */}
      {board.cases.length === 0 && board.settled.length > 0 ? (
        <AdminCallout tone="neutral">
          <span>
            Nothing is waiting. {board.settled.length === 1 ? "One case has" : `All ${board.settled.length} cases have`} been looked at and settled, with the
            reason on each
            {board.withdrawn.length > 0
              ? `, and ${board.withdrawn.length === 1 ? "one more flag has" : `${board.withdrawn.length} more flags have`} been read again to a verdict that no longer carries them`
              : ""}
            . Nothing has been deleted, and a settled case comes back here by itself the moment the same subject is flagged again.
          </span>
        </AdminCallout>
      ) : null}

      {board.bySource.length > 1 ? (
        <AdminCallout tone="neutral">
          <span>
            {board.bySource.map((entry) => `${entry.label.toLowerCase()} ${entry.cases}`).join(" · ")} — which check filed each case. A capture can carry
            one from each, and they are counted apart because a re-used photograph and an impossible journey are different things to look at.
          </span>
        </AdminCallout>
      ) : null}

      {board.behaviour.length > 0 ? (
        <AdminTableShell
          title="Months that do not look like months"
          description="A whole month judged on its shape, not on one capture. Only a repeated duration stands on its own; the rest is read beside it."
        >
          {/* Desktop: the full table. `table-fixed` with a colgroup, never a min-width in a scroller. */}
          <div className="hidden lg:block">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[20%]" />
                <col className="w-[18%]" />
                <col className="w-[12%]" />
                <col className="w-[50%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-3">Rep</th>
                  <th className="px-5 py-3">Month</th>
                  <th className="px-5 py-3">Visits</th>
                  <th className="px-5 py-3">What is wrong</th>
                </tr>
              </thead>
              <tbody>
                {board.behaviour.map((entry) => (
                  <tr key={entry.id} className="border-b border-slate-100 align-top even:bg-slate-50/60">
                    <td className="px-5 py-4 text-sm font-semibold text-slate-900">{entry.repName}</td>
                    <td className="px-5 py-4 text-sm text-slate-700">{monthName(entry.month)}</td>
                    <td className="px-5 py-4 text-sm tabular-nums text-slate-700">{entry.visits}</td>
                    <td className="px-5 py-4">
                      <BehaviourReasons entry={entry} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: the same months as cards. */}
          <div className="space-y-3 px-5 py-4 lg:hidden sm:px-6">
            {board.behaviour.map((entry) => (
              <div key={entry.id} className="border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-bold text-slate-900">{entry.repName}</span>
                  <span className="text-xs text-slate-500">{monthName(entry.month)}</span>
                </div>
                <p className="mt-1 text-sm text-slate-700">{entry.visits} visits</p>
                <div className="mt-3">
                  <BehaviourReasons entry={entry} />
                </div>
              </div>
            ))}
          </div>
        </AdminTableShell>
      ) : null}

      {board.behaviourNotChecked > 0 ? (
        <AdminCallout tone="neutral">
          <span>
            {board.behaviourNotChecked} rep-months held too few visits to judge on shape, so they were not checked — which is not the same as clean. A
            month of leave and a month of nothing look alike from here, and neither is a finding.
          </span>
        </AdminCallout>
      ) : null}

      {board.byRep.length > 1 ? (
        <AdminTableShell title="By rep" description="Where the same name keeps appearing. One case is an incident; a column of them is a habit.">
          <div className="px-5 py-4 sm:px-6">
            <ul className="space-y-2">
              {board.byRep.map((rep) => (
                <li key={rep.repHrId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-slate-100 pb-2 last:border-0">
                  <span className="text-sm font-semibold text-slate-900">{rep.repName}</span>
                  <span className="text-sm text-slate-600">
                    {rep.strongCases > 0 ? `${rep.strongCases} strong · ` : ""}
                    {rep.cases} in total
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </AdminTableShell>
      ) : null}

      {/* The three case lists, with the filter bar, the fold, the stories, the photographs, the maps
          and the bulk settle. One component for all three, so they can never print different facts
          about one row — and `canSettle` is passed through rather than re-derived there. */}
      {board.cases.length > 0 || board.withdrawn.length > 0 || board.settled.length > 0 ? (
        <IntegrityBoardView canSettle={canSettle} cases={board.cases} settled={board.settled} withdrawn={board.withdrawn} />
      ) : null}
    </div>
  );
}
