"use client";

// The Archive on the WhatsApp Applicants page: the old WhatsApp applicants the owner kept when the CVs
// received before 11 October 2026 were cleaned out (2026-10-18). They are NOT candidates — nothing here
// marks, books or sends anyone; it shows who they were, what they answered, and opens their CV. Why,
// and where the rows live: src/lib/recruitment/whatsapp-cv-archive.ts.

import { useState } from "react";

import { adminControlDepthClassName, adminPanelDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { cairoDate } from "@/lib/format/cairo-datetime";
import {
  ARCHIVE_FOLDER_NAME,
  archiveFileHref,
  type WhatsAppCvArchiveFolder,
  type WhatsAppCvArchivePerson,
  type WhatsAppCvArchiveView,
} from "@/lib/recruitment/whatsapp-cv-archive";

const PEOPLE_PER_STEP = 25;
const labelClass = "block text-xs font-semibold uppercase tracking-wide text-slate-500";

function PersonCell({ person }: { person: WhatsAppCvArchivePerson }) {
  return (
    <div className="min-w-0">
      <span className="block break-words font-semibold text-slate-900" dir="auto">
        {person.name}
      </span>
      <span className="mt-0.5 block break-words text-xs text-slate-500">Received {cairoDate(person.receivedAt)}</span>
      {person.phone ? (
        <span className="mt-0.5 block break-words text-xs text-slate-600" dir="ltr">
          {person.phone}
        </span>
      ) : null}
      {person.email ? (
        <span className="mt-0.5 block break-all text-xs text-slate-600" dir="ltr">
          {person.email}
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
    <dl className="min-w-0 space-y-1.5">
      {person.answers.map((answer, index) => (
        <div className="min-w-0" key={`${answer.question}-${index}`}>
          <dt className="break-words text-xs text-slate-500" dir="auto">
            {answer.question}
          </dt>
          <dd className="break-words text-sm font-medium text-slate-900" dir="auto">
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
    <ul className="min-w-0 space-y-2">
      {person.files.map((file) => (
        <li className="min-w-0" key={file.id}>
          <span className="block break-words text-xs text-slate-600" dir="auto">
            {file.fileName}
          </span>
          <span className="mt-1 flex flex-wrap gap-1.5">
            {/* A new tab, so the open folder is still here when the CV is closed. */}
            <a
              className={`border border-slate-300 bg-white px-2 py-0.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 ${adminControlDepthClassName}`}
              href={archiveFileHref(file.id, "inline")}
              rel="noopener"
              target="_blank"
            >
              Open CV
            </a>
            <a
              className={`border border-slate-300 bg-white px-2 py-0.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 ${adminControlDepthClassName}`}
              href={archiveFileHref(file.id, "download")}
            >
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
    <div className="space-y-3 border-t border-slate-200 px-3 py-3">
      <div className={`hidden border border-slate-200 bg-white md:block ${adminPanelDepthClassName}`}>
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[28%]" />
            <col className="w-[44%]" />
            <col className="w-[28%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 text-xs font-bold uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Applicant</th>
              <th className="px-3 py-2">Their answers</th>
              <th className="px-3 py-2">CV</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((person) => (
              <tr className="border-b border-slate-100 align-top last:border-b-0" key={person.id}>
                <td className="px-3 py-3">
                  <PersonCell person={person} />
                </td>
                <td className="px-3 py-3">
                  <AnswerList person={person} />
                </td>
                <td className="px-3 py-3">
                  <CvLinks person={person} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className={`divide-y divide-slate-100 border border-slate-200 bg-white md:hidden ${adminPanelDepthClassName}`}>
        {shown.map((person) => (
          <li className="space-y-2.5 px-4 py-3 text-sm" key={person.id}>
            <PersonCell person={person} />
            <AnswerList person={person} />
            <div>
              <span className={labelClass}>CV</span>
              <div className="mt-1">
                <CvLinks person={person} />
              </div>
            </div>
          </li>
        ))}
      </ul>

      {folder.people.length > shown.length ? (
        <button
          className={`w-full border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 ${adminControlDepthClassName}`}
          onClick={() => setLimit((current) => current + PEOPLE_PER_STEP)}
          type="button"
        >
          Show {Math.min(PEOPLE_PER_STEP, folder.people.length - shown.length)} more ({folder.people.length - shown.length}{" "}
          not shown yet)
        </button>
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
        className="flex w-full min-w-0 items-start justify-between gap-3 px-3 py-2.5 text-left hover:bg-slate-50"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="min-w-0 break-words text-sm text-slate-900" dir="auto">
          {folder.path.join(" › ")} › <span className="font-semibold">{ARCHIVE_FOLDER_NAME}</span>
        </span>
        <span className="flex-none text-xs font-semibold tabular-nums text-slate-500">
          {folder.people.length === 1 ? "1 CV" : `${folder.people.length} CVs`} {open ? "▴" : "▾"}
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
    <section className="mt-8 space-y-3" aria-labelledby="whatsapp-cv-archive-heading">
      <div>
        <h2 className="text-base font-semibold text-slate-900" id="whatsapp-cv-archive-heading">
          {ARCHIVE_FOLDER_NAME}
        </h2>
        <p className="break-words text-sm text-slate-500">
          Older WhatsApp CVs, received before 11 October 2026, that were filed in their folder and answered most of the
          questions. They are kept here only: they are not in the recruitment pool, on Screening, or in any folder.{" "}
          <span className="tabular-nums">
            {view.people === 1 ? "1 person" : `${view.people} people`} in {view.folders.length === 1 ? "1 folder" : `${view.folders.length} folders`}.
          </span>
        </p>
      </div>
      <ul className={`divide-y divide-slate-100 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        {view.folders.map((folder) => (
          <FolderRow folder={folder} key={folder.key} />
        ))}
      </ul>
    </section>
  );
}
