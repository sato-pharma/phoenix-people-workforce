"use client";

// The Archive on the WhatsApp Applicants page: the old WhatsApp applicants the owner kept when the CVs
// received before 11 October 2026 were cleaned out (2026-10-18). They are NOT candidates — nothing here
// marks, books or sends anyone; it shows who they were, what they answered, and opens their CV. Why,
// and where the rows live: src/lib/recruitment/whatsapp-cv-archive.ts.
//
// THE LOOK (owner, 2026-10-19, the full-module premium sweep): one panel under the house dark band,
// each folder a row that opens in place, and the people inside it a fixed-layout table on a desktop and
// one card per person on a phone — the same shape as the search above it.

import { useState } from "react";
import { ChevronDown, Download, FileText, FolderArchive, FolderOpen, Phone, Mail } from "lucide-react";

import { adminChipDepthClassName, adminControlDepthClassName } from "@/components/admin/admin-design-tokens";
import { phxButtonGhostClassName, phxLabelClassName, phxLabelTextClassName } from "@/components/ui/form-tokens";
import { RecruitmentPanel } from "@/components/recruitment/recruitment-premium";
import { cairoDate } from "@/lib/format/cairo-datetime";
import {
  ARCHIVE_FOLDER_NAME,
  archiveFileHref,
  type WhatsAppCvArchiveFolder,
  type WhatsAppCvArchivePerson,
  type WhatsAppCvArchiveView,
} from "@/lib/recruitment/whatsapp-cv-archive";
import { cn } from "@/lib/utils";

const PEOPLE_PER_STEP = 25;

/** The two file buttons: hairline square controls, lifted like every control in the module. */
const fileButtonClass = `inline-flex items-center gap-1 border border-slate-300 bg-white px-2 py-1 text-xs font-bold text-slate-700 transition hover:border-orange-400 hover:text-orange-700 ${adminControlDepthClassName}`;

function PersonCell({ person }: { person: WhatsAppCvArchivePerson }) {
  return (
    <div className="min-w-0">
      <span className="block break-words text-sm font-black text-slate-950" dir="auto">
        {person.name}
      </span>
      <span className="mt-0.5 block break-words text-xs text-slate-500">Received {cairoDate(person.receivedAt)}</span>
      {person.phone ? (
        <span className="mt-1 flex items-center gap-1.5 break-words text-xs tabular-nums text-slate-600" dir="ltr">
          <Phone aria-hidden="true" className="h-3 w-3 flex-none text-slate-400" />
          {person.phone}
        </span>
      ) : null}
      {person.email ? (
        <span className="mt-0.5 flex items-start gap-1.5 text-xs text-slate-600" dir="ltr">
          <Mail aria-hidden="true" className="mt-0.5 h-3 w-3 flex-none text-slate-400" />
          <span className="min-w-0 break-all">{person.email}</span>
        </span>
      ) : null}
    </div>
  );
}

function AnswerList({ person }: { person: WhatsAppCvArchivePerson }) {
  if (person.answers.length === 0) {
    return <span className="text-xs text-slate-400">No answers on file</span>;
  }
  return (
    <dl className="min-w-0 divide-y divide-slate-100">
      {person.answers.map((answer, index) => (
        <div className="min-w-0 py-1.5 first:pt-0 last:pb-0" key={`${answer.question}-${index}`}>
          <dt className="break-words text-xs text-slate-500" dir="auto">
            {answer.question}
          </dt>
          <dd className="break-words text-sm font-bold text-slate-900" dir="auto">
            {answer.answer}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CvLinks({ person }: { person: WhatsAppCvArchivePerson }) {
  if (person.files.length === 0) {
    return <span className="text-xs text-slate-400">No CV file</span>;
  }
  return (
    <ul className="min-w-0 space-y-2.5">
      {person.files.map((file) => (
        <li className="min-w-0" key={file.id}>
          <span className="flex items-start gap-1.5 text-xs text-slate-600" dir="auto">
            <FileText aria-hidden="true" className="mt-px h-3.5 w-3.5 flex-none text-orange-500" />
            <span className="min-w-0 break-all">{file.fileName}</span>
          </span>
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {/* A new tab, so the open folder is still here when the CV is closed. */}
            <a className={fileButtonClass} href={archiveFileHref(file.id, "inline")} rel="noopener" target="_blank">
              <FolderOpen aria-hidden="true" className="h-3 w-3" />
              Open CV
            </a>
            <a className={fileButtonClass} href={archiveFileHref(file.id, "download")}>
              <Download aria-hidden="true" className="h-3 w-3" />
              Download
            </a>
          </span>
        </li>
      ))}
    </ul>
  );
}

function FolderPeople({ folder }: { folder: WhatsAppCvArchiveFolder }) {
  const [limit, setLimit] = useState(PEOPLE_PER_STEP);
  const shown = folder.people.slice(0, limit);
  return (
    <div className="border-t border-slate-200 bg-slate-50/50">
      <div className="hidden md:block">
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[28%]" />
            <col className="w-[44%]" />
            <col className="w-[28%]" />
          </colgroup>
          <thead className="bg-slate-100/70">
            <tr className={cn("border-b border-slate-200", phxLabelTextClassName)}>
              <th className="px-4 py-2.5" scope="col">Applicant</th>
              <th className="px-3 py-2.5" scope="col">Their answers</th>
              <th className="px-4 py-2.5" scope="col">CV</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {shown.map((person) => (
              <tr className="align-top" key={person.id}>
                <td className="px-4 py-3">
                  <PersonCell person={person} />
                </td>
                <td className="px-3 py-3">
                  <AnswerList person={person} />
                </td>
                <td className="px-4 py-3">
                  <CvLinks person={person} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-slate-100 bg-white md:hidden">
        {shown.map((person) => (
          <li className="space-y-3 px-4 py-4 text-sm" key={person.id}>
            <PersonCell person={person} />
            <AnswerList person={person} />
            <div>
              <span className={phxLabelClassName}>CV</span>
              <CvLinks person={person} />
            </div>
          </li>
        ))}
      </ul>

      {folder.people.length > shown.length ? (
        <div className="border-t border-slate-200 p-3 sm:px-4">
          <button
            className={cn(phxButtonGhostClassName, "w-full justify-center text-xs")}
            onClick={() => setLimit((current) => current + PEOPLE_PER_STEP)}
            type="button"
          >
            Show {Math.min(PEOPLE_PER_STEP, folder.people.length - shown.length)} more ({folder.people.length - shown.length}{" "}
            not shown yet)
          </button>
        </div>
      ) : null}
    </div>
  );
}

function FolderRow({ folder }: { folder: WhatsAppCvArchiveFolder }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="min-w-0">
      <button
        aria-expanded={open}
        className={cn(
          "flex w-full min-w-0 items-start justify-between gap-3 border-l-[3px] px-4 py-3 text-left transition-colors sm:px-5",
          open ? "border-l-orange-500 bg-orange-50/40" : "border-l-transparent hover:bg-slate-50",
        )}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="flex min-w-0 items-start gap-2">
          <FolderArchive aria-hidden="true" className="mt-0.5 h-4 w-4 flex-none text-orange-500" />
          <span className="min-w-0 break-words text-sm text-slate-700" dir="auto">
            {folder.path.join(" › ")} › <span className="font-black text-slate-950">{ARCHIVE_FOLDER_NAME}</span>
          </span>
        </span>
        <span className="flex flex-none items-center gap-1.5 text-xs font-bold tabular-nums text-slate-500">
          <span className={`border border-slate-200 bg-slate-50 px-1.5 py-0.5 ${adminChipDepthClassName}`}>
            {folder.people.length === 1 ? "1 CV" : `${folder.people.length} CVs`}
          </span>
          <ChevronDown aria-hidden="true" className={cn("h-4 w-4 transition-transform", open ? "rotate-180" : "")} />
        </span>
      </button>
      {/* People are drawn only once the folder is opened, so 400 CVs never cost a render up front. */}
      {open ? <FolderPeople folder={folder} /> : null}
    </li>
  );
}

export function WhatsAppCvArchive({ view }: { view: WhatsAppCvArchiveView }) {
  if (view.people === 0) return null;
  return (
    <section aria-labelledby="whatsapp-cv-archive-heading">
      <RecruitmentPanel
        count={view.people === 1 ? "1 person" : `${view.people} people`}
        description={
          <>
            Older WhatsApp CVs, received before 11 October 2026, that were filed in their folder and answered most of
            the questions. They are kept here only: they are not in the recruitment pool, on Screening, or in any
            folder.{" "}
            <span className="tabular-nums">
              {view.people === 1 ? "1 person" : `${view.people} people`} in{" "}
              {view.folders.length === 1 ? "1 folder" : `${view.folders.length} folders`}.
            </span>
          </>
        }
        icon={<FolderArchive aria-hidden="true" className="h-4 w-4" />}
        title={<span id="whatsapp-cv-archive-heading">{ARCHIVE_FOLDER_NAME}</span>}
      >
        <ul className="divide-y divide-slate-100">
          {view.folders.map((folder) => (
            <FolderRow folder={folder} key={folder.key} />
          ))}
        </ul>
      </RecruitmentPanel>
    </section>
  );
}
