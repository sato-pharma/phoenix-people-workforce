"use client";

// Recruitment / ATS — an applicant's WhatsApp answers, each under the question it answers.
//
// ONE layout for every screen that shows them — the screening workstation, the pool's candidate
// profile and the older screening session — so no two screens can disagree about what an applicant
// said. Which answers are listed, and in what order, is `candidateWhatsAppAnswers`'s decision; this
// only lays them out.

import type { WhatsAppAnswer } from "@/lib/recruitment/whatsapp-answers";

/**
 * `flat` is the workstation's side panel: full-width rows divided by hairlines, square, on the
 * workstation's own tokens. `card` sits inside the slate card the older screens draw and follows
 * that card's grid, so a wide profile uses its width.
 *
 * THE QUESTION IS IN SENTENCE CASE, never uppercased like the field labels around it. These are whole
 * sentences — "If you were offered the job, when could you start?" — and a sentence in capitals is
 * slower to read than the answer beneath it. Both wrap; nothing is cut short.
 *
 * `dir="auto"` on each value, because each is one language and some are Arabic — house style for
 * single-language free text.
 */
export function WhatsAppAnswersList({
  answers,
  className,
  columns = 1,
  frame = "card",
}: {
  answers: readonly WhatsAppAnswer[];
  className?: string;
  columns?: 1 | 2 | 3;
  frame?: "card" | "flat";
}) {
  if (frame === "flat") {
    return (
      <dl className={className}>
        {answers.map((entry) => (
          <div className="border-b border-phx-line/70 px-3 py-1.5 last:border-b-0" key={entry.key}>
            <dt className="break-words text-[11px] font-semibold leading-[1.45] text-phx-ink-soft" dir="auto">
              {entry.question}
            </dt>
            <dd
              className="mt-0.5 whitespace-pre-wrap break-words text-[13px] font-medium leading-[1.45] text-phx-ink"
              dir="auto"
            >
              {entry.answer}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  const gridColumns =
    columns === 1 ? "grid-cols-1" : columns === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";
  return (
    <dl className={`grid gap-x-6 gap-y-2 ${gridColumns} ${className ?? ""}`}>
      {answers.map((entry) => (
        <div className="min-w-0" key={entry.key}>
          <dt className="break-words text-xs text-slate-500" dir="auto">
            {entry.question}
          </dt>
          <dd className="whitespace-pre-wrap break-words text-sm font-medium text-slate-900" dir="auto">
            {entry.answer}
          </dd>
        </div>
      ))}
    </dl>
  );
}
