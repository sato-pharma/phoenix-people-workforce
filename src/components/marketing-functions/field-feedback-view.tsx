import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { shortDateLabel } from "@/lib/marketing-functions/months";
import type { FieldFeedback } from "@/lib/marketing-functions/types";
import {
  CALL_RATING_LABELS,
  CALL_RATINGS,
  CALL_REMARKS,
  FIELD_ACTION_OWNER_LABELS,
  FIELD_FEEDBACK_LABELS,
  FIELD_FEEDBACK_TITLE,
  FIELD_VISIT_TYPE_LABEL,
  FIELD_VISIT_TYPE_LABELS,
} from "@/lib/marketing-functions/vocabulary";

// A signed Marketing Field Visit Feedback form, laid out as her Word form: the header boxes, the Call
// Remarks grid with its four columns, then the comments, recommendations and the signature line.

function Box({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0 border border-slate-300 px-3 py-2">
      <p className="text-phx-xs font-black uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 break-words text-sm font-bold text-slate-900">{value || "None"}</p>
    </div>
  );
}

function Paragraph({ label, value }: { label: string; value: string | null }) {
  return (
    <section className="border border-slate-300 px-3 py-2">
      <p className="text-sm font-black text-slate-900">{label}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">{value || "None"}</p>
    </section>
  );
}

export function FieldFeedbackView({ form }: { form: FieldFeedback }) {
  const clinics = [
    form.amClinics !== null ? `AM ${form.amClinics}` : null,
    form.pmClinics !== null ? `PM ${form.pmClinics}` : null,
  ].filter(Boolean);
  return (
    <article className="space-y-4 border border-slate-200 bg-white p-4 sm:p-5">
      <header className="flex flex-col gap-1 border-b border-slate-300 pb-3 sm:flex-row sm:items-end sm:justify-between">
        <h2 className="text-lg font-black text-slate-900">{FIELD_FEEDBACK_TITLE}</h2>
        <p className="text-sm font-bold text-slate-600">
          {FIELD_VISIT_TYPE_LABEL}: {FIELD_VISIT_TYPE_LABELS[form.visitType]}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Box label={FIELD_FEEDBACK_LABELS.accompaniedPerson} value={form.repName} />
        <Box label={FIELD_FEEDBACK_LABELS.jobTitle} value={form.repJobTitle} />
        <Box label={FIELD_FEEDBACK_LABELS.area} value={form.repArea} />
        <Box label={FIELD_FEEDBACK_LABELS.date} value={shortDateLabel(form.visitDate)} />
        <Box label={FIELD_FEEDBACK_LABELS.visitedClinics} value={clinics.length ? clinics.join(" · ") : null} />
        <Box label={FIELD_FEEDBACK_LABELS.visitedPharmacies} value={form.pharmacies !== null ? String(form.pharmacies) : null} />
      </div>

      <Paragraph label={FIELD_FEEDBACK_LABELS.objectives} value={form.objectives} />

      <section className="border border-slate-300">
        <p className="border-b border-slate-300 px-3 py-2 text-sm font-black text-slate-900">{FIELD_FEEDBACK_LABELS.callRemarks}</p>
        <table className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-[40%] md:w-[44%]" />
            {CALL_RATINGS.map((rating) => (
              <col className="w-[15%] md:w-[14%]" key={rating} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-slate-300 text-slate-900">
              <th className="px-2 py-2 text-left font-black" scope="col">
                <span className="sr-only">Remark</span>
              </th>
              {CALL_RATINGS.map((rating) => (
                <th className="break-words px-1 py-2 text-center text-xs font-black md:text-sm" key={rating} scope="col">
                  {CALL_RATING_LABELS[rating]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CALL_REMARKS.map((remark) => (
              <tr className="border-b border-slate-200 last:border-b-0" key={remark.key}>
                <th className="break-words px-2 py-2 text-left font-bold text-slate-900" scope="row">
                  {remark.label}
                </th>
                {CALL_RATINGS.map((rating) => (
                  <td className="border-l border-slate-200 px-1 py-2 text-center" key={rating}>
                    {form.ratings[remark.key] === rating ? (
                      <span aria-label={CALL_RATING_LABELS[rating]} className="inline-block h-3.5 w-3.5 bg-slate-900" role="img" />
                    ) : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <Paragraph label={FIELD_FEEDBACK_LABELS.comments} value={form.comments} />
      <Paragraph label={FIELD_FEEDBACK_LABELS.doctorsComments} value={form.doctorsComments} />
      <Paragraph label={FIELD_FEEDBACK_LABELS.recommendations} value={form.recommendations} />
      {form.actionOwners.length > 0 ? (
        <ul className="space-y-1 border border-slate-300 px-3 py-2 text-sm text-slate-800">
          {form.actionOwners.map((owner) => (
            <li className="border-l-2 border-slate-900 pl-2" key={owner}>
              {FIELD_ACTION_OWNER_LABELS[owner]}
            </li>
          ))}
        </ul>
      ) : null}

      <footer className="border-t border-slate-300 pt-3 text-sm text-slate-800">
        <span className="font-black">{FIELD_FEEDBACK_LABELS.signature}: </span>
        {form.signedAt ? `Signed by ${form.signedByName ?? form.authorName}, ${cairoDateTime(form.signedAt)}` : "Not signed yet"}
      </footer>
    </article>
  );
}
