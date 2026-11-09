"use client";

import * as React from "react";

import { candidateRoleFamilies, candidateRoleFamilyLabels } from "@/lib/recruitment/candidate-role-family";

/**
 * WHO IS ASKED THIS QUESTION — the job-title tick list, shared by both halves of
 * /admin/screening-questions.
 *
 * ONE COMPONENT ON PURPOSE. The extra-question builder grew this control on 2026-09-02; the owner
 * asked on 2026-09-05 for the same thing on the six built-in questions above it, in his words
 * "thinking exactly as you are doing [in the] other questions". Two copies of a tick list are two
 * copies of a rule — the empty state especially, which is the one an admin reads rather than clicks
 * — and the two screens sitting one above the other is exactly where a wording difference would read
 * as a behaviour difference.
 *
 * NOTHING TICKED MEANS EVERYONE, and the caption says so in words rather than leaving an empty row
 * of boxes to be interpreted. That is not a UI convenience: it is the state every question was in
 * before this control existed, so an admin who ignores it entirely gets the old behaviour instead of
 * a question nobody is asked.
 *
 * The two screens do differ in what they do with "nothing ticked" on the way to the database, and
 * that difference is deliberate and lives in the domain, not here — see `StoredAudience` in
 * whatsapp-question-audience.ts. This component only ever reports the ticked list.
 */
export type QuestionAudiencePickerProps = {
  /** The ticked job titles. EMPTY means everyone. */
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** Unique per question — the checkboxes need distinct ids on a screen holding a dozen of these. */
  idPrefix: string;
  disabled?: boolean;
  /**
   * Shown under the tick list when nothing is ticked. Defaults to the plain reading. The built-in
   * six pass their own, because on `area` "everyone" is a CHANGE from what the question does today
   * and the caption is the only place that can say so.
   */
  everyoneNote?: string;
};

export function QuestionAudiencePicker({
  disabled,
  everyoneNote,
  idPrefix,
  onChange,
  value,
}: QuestionAudiencePickerProps) {
  const ticked = React.useMemo(() => new Set(value), [value]);

  return (
    <div>
      <span className="text-phx-xs font-bold uppercase tracking-wider text-slate-400">Who is asked</span>
      {/* Wraps rather than scrolls, and the labels wrap inside their own cell — the fits-the-screen
          rule. Eleven job titles at 375px is four or five rows, which is the intended answer. */}
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {candidateRoleFamilies.map((family) => {
          const checked = ticked.has(family);
          return (
            <label
              className="flex items-center gap-1.5 text-sm text-slate-700"
              htmlFor={`${idPrefix}-audience-${family}`}
              key={family}
            >
              <input
                checked={checked}
                disabled={disabled}
                id={`${idPrefix}-audience-${family}`}
                onChange={() =>
                  onChange(
                    checked ? value.filter((entry) => entry !== family) : [...value, family],
                  )
                }
                type="checkbox"
              />
              {candidateRoleFamilyLabels[family]}
            </label>
          );
        })}
      </div>
      <p className="mt-1 text-phx-sm text-slate-400">
        {value.length === 0
          ? (everyoneNote ?? "Nothing ticked — every applicant is asked this question.")
          : "Only these applicants are asked it. Everyone else skips it."}
      </p>
    </div>
  );
}
