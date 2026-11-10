import Link from "next/link";
import { notFound } from "next/navigation";

import { phxButtonGhostClassName } from "@/components/ui/form-tokens";
import type { AccessContext } from "@/lib/auth/permissions";
import { todayInCairo } from "@/lib/date-only";
import { pickerMonthKeys, resolveMonthKey } from "@/lib/marketing-functions/months";
import { canEditFieldFeedback, isMarketingFunctionsAuthor, seesEveryMarketingSheet } from "@/lib/marketing-functions/scope";
import {
  getFieldFeedback,
  listAccompaniedPeople,
  listMarketingAuthors,
  listRideAlongDays,
  loadFieldFeedbackBoard,
  loadMonthSheet,
} from "@/lib/marketing-functions/service";

import { FieldFeedbackBoard, type FieldFeedbackTab } from "./field-feedback-board";
import { FieldFeedbackForm } from "./field-feedback-form";
import { FieldFeedbackView } from "./field-feedback-view";
import { MarketingFunctionsWorkspace } from "./marketing-functions-workspace";

// The bodies the portal and the admin pages share. Each page keeps its own inline permission gate (the
// nav guard reads the page file); what it renders inside comes from here, so the two shells cannot drift.

type Params = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() ? first.trim() : null;
}

export async function MarketingFunctionsBody({
  access,
  params,
  basePath,
  feedbackBasePath,
}: {
  access: AccessContext;
  params: Params;
  basePath: string;
  feedbackBasePath: string;
}) {
  const today = todayInCairo();
  const monthKey = resolveMonthKey(one(params.month), today);
  const monthOptions = pickerMonthKeys(today);
  if (!monthOptions.includes(monthKey)) monthOptions.push(monthKey);
  monthOptions.sort().reverse();

  const authors = await listMarketingAuthors(access);
  // A reader with no author named opens the first Product Manager rather than an empty page.
  const requested = one(params.author) ?? authors[0]?.hrId ?? null;
  const sheet = await loadMonthSheet(access, { authorHrId: requested, monthKey });

  return (
    <MarketingFunctionsWorkspace
      authors={authors}
      basePath={basePath}
      feedbackBasePath={feedbackBasePath}
      // Keyed by whose month it is, so switching month or author starts from that sheet's rows.
      key={`${sheet?.authorHrId ?? "none"}:${monthKey}:${sheet?.month?.status ?? "new"}`}
      monthKey={monthKey}
      monthOptions={monthOptions}
      sheet={sheet}
      todayIso={today}
    />
  );
}

export async function FieldFeedbackBoardBody({
  access,
  params,
  basePath,
  newHref,
}: {
  access: AccessContext;
  params: Params;
  basePath: string;
  newHref: string | null;
}) {
  const tab: FieldFeedbackTab = one(params.tab) === "tracking" ? "tracking" : "forms";
  const board = await loadFieldFeedbackBoard(access);
  return (
    <FieldFeedbackBoard
      basePath={basePath}
      canCreate={isMarketingFunctionsAuthor(access) && newHref !== null}
      forms={board.forms}
      newHref={newHref}
      showAuthor={!isMarketingFunctionsAuthor(access)}
      tab={tab}
      teamGaps={board.teamGaps}
      tracks={board.tracks}
    />
  );
}

export async function FieldFeedbackNewBody({ access, basePath }: { access: AccessContext; basePath: string }) {
  const [rideAlongDays, people] = await Promise.all([listRideAlongDays(access), listAccompaniedPeople(access)]);
  return (
    <div className="space-y-4">
      <Link className={phxButtonGhostClassName} href={basePath}>
        Back to the forms
      </Link>
      <FieldFeedbackForm basePath={basePath} initial={null} people={people} rideAlongDays={rideAlongDays} todayIso={todayInCairo()} />
    </div>
  );
}

export async function FieldFeedbackDetailBody({ access, id, basePath }: { access: AccessContext; id: string; basePath: string }) {
  const form = /^[0-9a-f-]{36}$/i.test(id) ? await getFieldFeedback(access, id) : null;
  if (!form) notFound();
  const editable = canEditFieldFeedback(access, form);
  const [rideAlongDays, people] = editable
    ? await Promise.all([listRideAlongDays(access), listAccompaniedPeople(access)])
    : [[], []];
  return (
    <div className="space-y-4">
      <Link className={phxButtonGhostClassName} href={basePath}>
        Back to the forms
      </Link>
      {editable ? (
        <FieldFeedbackForm basePath={basePath} initial={form} people={people} rideAlongDays={rideAlongDays} todayIso={todayInCairo()} />
      ) : (
        <FieldFeedbackView form={form} />
      )}
      {seesEveryMarketingSheet(access) ? <p className="text-xs text-slate-500">Filed by {form.authorName}.</p> : null}
    </div>
  );
}
