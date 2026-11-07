"use client";

// Recruitment / Medical Rep hiring — the candidate's CV and application, beside every step of the
// hiring journey and for everyone who opens it (owner, 7 Nov 2026: "the cv and application must
// appear and be appearing in all steps for every one"): the HR Manager, Talent Acquisition, the CEO,
// and the DSM, RSM and NSM on the candidate's interviews.
//
// The application is every question the candidate was asked and their answer, under the labels the
// workspace's Medical Rep tab uses; the CV is the document itself. Both come from the CV route, which
// admits exactly the people the journey admits. A manager reads the CV with its phone numbers masked
// and no download — the manager portal's own rule, since HR books every Medical Rep interview.
//
// THREE PANES ON A WIDE SCREEN (owner, 7 Nov 2026: "separate the screen into three panes the first in
// the cv at the left in the middle his data and whats app replies and applying … and the right the
// same it is today"). layout="panes" hands the sheet two panes of its own — the CV on the left, the
// application and the WhatsApp replies in the middle — and the journey stays the third, on the right.
// A narrow screen keeps one column: the application, then the CV, under the current step.

import { FileText } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { adminChipDepthClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { CvDocumentView } from "@/components/recruitment/cv-preview-modal";
import { getJson } from "@/components/recruitment/recruitment-fetch";
import { AnswerChip } from "@/components/recruitment/workspace/answer-chip";
import { todayInCairo } from "@/lib/date-only";
import { primaryCvFile } from "@/lib/recruitment/cv-file-choice";
import type { RecruitmentFile } from "@/lib/recruitment/types";
import type { WorkspaceAnswerChip } from "@/lib/recruitment/workspace/types";
import { cn } from "@/lib/utils";

type State =
  | { phase: "loading" }
  | { phase: "ready"; application: WorkspaceAnswerChip[]; files: RecruitmentFile[]; phonesHidden: boolean }
  | { phase: "failed"; message: string };

export type MrCvApplicationLayout = "stacked" | "panes";

const PANE = "min-h-0 shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50 px-4 py-4 sm:px-5";
/** Left: the CV, the widest of the three, so a page reads without zooming. */
const CV_PANE = `${PANE} w-[38%]`;
/** Middle: the application and the WhatsApp replies. The journey takes what is left, on the right. */
const APPLICATION_PANE = `${PANE} w-[30%]`;

export function MrCvApplication({
  candidateId,
  className,
  layout = "stacked",
}: {
  candidateId: string;
  className?: string;
  /** "panes": the CV and the application as two panes beside the journey; "stacked": one column. */
  layout?: MrCvApplicationLayout;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const base = `/api/recruitment/mr-hiring/${encodeURIComponent(candidateId)}/cv`;
  const fileUrl = (fileId: string) => `${base}?file=${encodeURIComponent(fileId)}`;

  useEffect(() => {
    let live = true;
    getJson(base)
      .then((data) => {
        if (!live) return;
        setState({
          application: Array.isArray(data.application) ? (data.application as WorkspaceAnswerChip[]) : [],
          files: Array.isArray(data.files) ? (data.files as RecruitmentFile[]) : [],
          phase: "ready",
          phonesHidden: data.phonesHidden !== false,
        });
      })
      .catch((caught: unknown) => {
        if (live) setState({ message: caught instanceof Error ? caught.message : "The CV could not be loaded.", phase: "failed" });
      });
    return () => {
      live = false;
    };
  }, [base]);

  const panes = layout === "panes";
  const arrange = (cv: ReactNode, application: ReactNode) =>
    panes ? (
      <>
        <div className={CV_PANE}>{cv}</div>
        <div className={APPLICATION_PANE}>{application}</div>
      </>
    ) : (
      <div className={cn("space-y-4", className)}>
        {application}
        {cv}
      </div>
    );

  if (state.phase === "loading") {
    return arrange(
      <div aria-busy="true" className="h-[28rem] animate-pulse bg-slate-100" role="status" />,
      panes ? <div aria-hidden className="h-[28rem] animate-pulse bg-slate-100" /> : null,
    );
  }
  if (state.phase === "failed") {
    return arrange(
      <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800" dir="auto" role="alert">
        {state.message}
      </p>,
      null,
    );
  }

  const file = primaryCvFile(state.files);
  const others = state.files.filter((item) => item.id !== file?.id);
  const today = todayInCairo();

  const application = (
    <section aria-label="Application and WhatsApp replies">
      <h3 className="text-phx-xs font-black uppercase tracking-[0.15em] text-slate-700">Application and WhatsApp replies</h3>
      {state.application.length > 0 ? (
        <ul className="mt-2 divide-y divide-slate-100 border border-slate-200">
          {state.application.map((chip) => (
            <li className="flex flex-wrap items-center justify-between gap-2 bg-white px-3 py-2" key={chip.key}>
              <span className={cn("text-xs font-black uppercase tracking-wide", chip.value === null ? "text-amber-800" : "text-slate-500")}>
                {chip.label}
              </span>
              <AnswerChip canEdit={false} chip={chip} today={today} withLabel={false} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm font-medium text-slate-600">No answers are recorded for this candidate.</p>
      )}
    </section>
  );

  const cv = (
    <section aria-label="CV">
      <h3 className="text-phx-xs font-black uppercase tracking-[0.15em] text-slate-700">CV</h3>
      {file ? (
        <div className={`mt-2 min-h-[28rem] border border-slate-200 bg-slate-50 ${adminRecessedDepthClassName}`}>
          <CvDocumentView
            allowDownload={!state.phonesHidden}
            downloadUrl={fileUrl(file.id)}
            fileName={file.fileName}
            mimeType={file.mimeType}
            redactPhones={state.phonesHidden}
          />
        </div>
      ) : (
        <p className="mt-2 flex items-center gap-2 border border-dashed border-slate-300 bg-white px-3 py-6 text-sm font-semibold text-slate-600">
          <FileText aria-hidden className="h-4 w-4 text-slate-400" />
          No readable CV is attached. The application is what the candidate told the company WhatsApp.
        </p>
      )}
      {others.length > 0 && !state.phonesHidden ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-phx-xs font-black uppercase tracking-wide text-slate-500">Other files</span>
          {others.map((item) => (
            <a
              className={`inline-flex items-center gap-1 border border-slate-200 bg-white px-2 py-0.5 text-xs font-bold text-slate-700 hover:border-orange-300 ${adminChipDepthClassName}`}
              href={fileUrl(item.id)}
              key={item.id}
            >
              <FileText aria-hidden className="h-3 w-3" />
              <span className="break-words" dir="auto">
                {item.fileName}
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );

  return arrange(cv, application);
}
