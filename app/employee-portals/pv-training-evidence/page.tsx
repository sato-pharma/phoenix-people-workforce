import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { TrainingEvidenceSearch } from "@/components/pv-training/training-evidence-search";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canOpenPvTrainingEvidence } from "@/lib/pv-training/access";
import { readPvTrainingSheetImage } from "@/lib/pv-training/server";
import {
  findPvTrainingPerson,
  listPvTrainingPeople,
  PV_TRAINING_SHEETS,
} from "@/lib/pv-training/training-sheets";

export const dynamic = "force-dynamic";

export default async function PvTrainingEvidencePage({
  searchParams,
}: {
  searchParams: Promise<{ person?: string | string[] }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.hrId) redirect("/login");
  // The QPPV's own account and no one else's — the sheets carry real signatures.
  if (!canOpenPvTrainingEvidence(access.hrId)) redirect("/employee-portals");

  const params = await searchParams;
  const requested = Array.isArray(params.person) ? params.person[0] : params.person;
  const person = findPvTrainingPerson(requested);
  const options = listPvTrainingPeople().map(({ key, name }) => ({ key, name }));

  const images = person
    ? await Promise.all(person.appearances.map(({ sheet }) => readPvTrainingSheetImage(sheet.page)))
    : [];

  return (
    <EmployeePortalPageShell
      badge="Pharmacovigilance"
      description={`Signed PV training sheets — ${PV_TRAINING_SHEETS.length} pages, ${options.length} attendees. Type a name to bring up the sheet they signed.`}
      errorBoundaryTitle="PV Training Evidence unavailable"
      title="PV Training Evidence"
    >
      <section className="border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <TrainingEvidenceSearch options={options} selectedKey={person?.key ?? ""} />
        {requested && !person ? (
          <p className="mt-3 text-sm font-semibold text-rose-700">No one by that name is on the training sheets.</p>
        ) : null}
      </section>

      {person ? (
        <>
          <section className="border border-slate-200 bg-white shadow-sm">
            <dl className="divide-y divide-slate-100 text-sm">
              <div className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[11rem_1fr] sm:gap-4 sm:px-5">
                <dt className="text-xs font-bold uppercase tracking-wider text-slate-500">Name</dt>
                <dd className="break-words font-semibold text-slate-900">{person.name}</dd>
              </div>
              <div className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[11rem_1fr] sm:gap-4 sm:px-5">
                <dt className="text-xs font-bold uppercase tracking-wider text-slate-500">Title</dt>
                <dd className="break-words text-slate-800">
                  {Array.from(new Set(person.appearances.map(({ attendee }) => attendee.title))).join(" · ")}
                </dd>
              </div>
              {person.appearances.map(({ sheet }) => (
                <div key={sheet.page} className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[11rem_1fr] sm:gap-4 sm:px-5">
                  <dt className="text-xs font-bold uppercase tracking-wider text-slate-500">Serial {sheet.serial}</dt>
                  <dd className="break-words text-slate-800">
                    <span className="block font-semibold text-slate-900">{sheet.title}</span>
                    <span className="block text-slate-600">{sheet.date} · {sheet.time} · {sheet.location}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {person.appearances.map(({ sheet }, index) => (
            <figure key={sheet.page} className="border border-slate-200 bg-white shadow-sm">
              <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-slate-200 px-4 py-2.5 sm:px-5">
                <span className="text-sm font-bold text-slate-900">Training sheet · Serial {sheet.serial}</span>
                <span className="text-xs text-slate-500">{sheet.date}</span>
              </figcaption>
              {/* eslint-disable-next-line @next/next/no-img-element -- a data URL read on the server; next/image cannot optimise it */}
              <img
                src={images[index]}
                alt={`Signed training sheet, serial ${sheet.serial}, ${sheet.date}`}
                className="mx-auto block h-auto w-full max-w-3xl"
              />
            </figure>
          ))}
        </>
      ) : null}
    </EmployeePortalPageShell>
  );
}
