"use client";

import { useState } from "react";

import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import {
  PRINT_COPIES_CHOICES,
  PRINT_COPIES_MAX,
  parsePrintCopies,
} from "@/lib/hiring-pack/copies-clause";
import {
  OFFICE_ADDRESS_AR,
  PRINT_ADDRESS_LABELS,
  type PrintAddressChoice,
} from "@/lib/hiring-pack/print-address";
import {
  DOCUMENT_MARK_LABELS,
  type DocumentMark,
} from "@/lib/hiring-pack/document-marks";

/** What the desk answered: how many copies, which address, and what this run is stamped with. */
export type PrintAnswer = {
  address: PrintAddressChoice | null;
  copies: number;
  /** The marks TICKED FOR THIS PRINT. Empty is the normal answer and the default - see below. */
  marks: DocumentMark[];
};

/**
 * THE QUESTIONS ASKED BEFORE ANY HR FORM PRINTS — the owner, 2026-09-20: "before you print any copy
 * from any HR form you should ask me how many copies … and based on what I tell you, you write here",
 * and "make me choose the address, this one or that one, before we print".
 *
 * A dialog rather than two boxes left on the row, because a box with a sensible default is a box
 * nobody looks at: the count on the Copies field had been sitting there all along, and the paper
 * still printed a fixed "two copies" sentence. Nothing prints until this is confirmed.
 *
 * MOUNTED ONLY WHILE OPEN, so its state starts from the caller's defaults every time and a cancelled
 * answer can never leak into the next paper.
 *
 * THE ADDRESS HAS NO PRE-SELECTED ANSWER THE FIRST TIME — Print stays disabled until one is picked —
 * because the two addresses are both legitimate and the point of asking is that the desk decides, not
 * that the system's habit does. Once one has been picked in this session it is offered again as the
 * starting point (`initialAddress`), which is a convenience and still one click to change.
 */
export function PrintOptionsDialog({
  availableMarks = [],
  askAddress,
  defaultCopies,
  initialAddress,
  onCancel,
  onConfirm,
  registeredAddress,
  title,
}: {
  /** False on the two Authority forms, which never carry the choice. */
  askAddress: boolean;
  defaultCopies: number;
  initialAddress: PrintAddressChoice | null;
  onCancel: () => void;
  onConfirm: (answer: PrintAnswer) => void;
  /**
   * The registered head office as the company details hold it — the other address is fixed. Null from
   * a caller that cannot see the company record; the prompt then says where it is read from.
   */
  /**
   * The marks this paper has a POSITION for - what may be offered, never what is printed.
   *
   * Empty for the great majority of papers, and then the section below does not appear at all: a
   * tick-box that would place nothing is worse than no tick-box, because it reads as a stamp that
   * silently failed. Positions are set by dragging in the layout editor.
   *
   * OPTIONAL, AND THE DEFAULT IS NONE. Three screens open this dialog - the hiring pack, the manual
   * paper workspace and the device register - and only the first knows anything about marks. A
   * required prop would have forced the other two to pass an empty array to say nothing, which is a
   * sentence they should not have to speak; absent already means "offer no stamp", which is both the
   * safe answer and the true one for them.
   */
  availableMarks?: readonly DocumentMark[];
  registeredAddress: string | null;
  title: string;
}) {
  const [copies, setCopies] = useState(String(defaultCopies));
  const [address, setAddress] = useState<PrintAddressChoice | null>(askAddress ? initialAddress : null);
  /**
   * WHAT THIS RUN IS STAMPED AND SIGNED WITH, and it starts EMPTY every time.
   *
   * The owner, 2026-09-29: "donot put the stamp permanent, make able to add them freely as i want."
   * A mark placed in the layout editor says WHERE the seal sits on this paper; it does not say the
   * paper is stamped. That is decided here, per print, and the box opens unticked - so the default
   * outcome is always the unstamped document, and a stamped one is always something somebody chose.
   *
   * The dialog is mounted only while open, so this cannot carry over from the last paper.
   */
  const [marks, setMarks] = useState<DocumentMark[]>([]);
  const dialogRef = useDialogA11y<HTMLDivElement>({ open: true, onClose: onCancel });

  const count = parsePrintCopies(copies, 0);
  const ready = count >= 1 && (!askAddress || address !== null);

  const addressOptions: ReadonlyArray<{ choice: PrintAddressChoice; text: string | null }> = [
    { choice: "registered", text: registeredAddress },
    { choice: "office", text: OFFICE_ADDRESS_AR },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center">
      <div
        aria-labelledby="print-options-title"
        aria-modal
        className="max-h-full w-full max-w-lg overflow-y-auto border border-slate-200 bg-white shadow-xl"
        ref={dialogRef}
        role="dialog"
      >
        <div className="px-5 py-4">
          <h2 className="text-base font-semibold text-slate-950" id="print-options-title">
            Before printing — {title}
          </h2>

          <p className="mt-4 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
            How many copies?
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {PRINT_COPIES_CHOICES.map((choice) => (
              <button
                aria-pressed={count === choice}
                className={`h-10 w-10 border text-sm font-semibold ${
                  count === choice
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 bg-white text-slate-700"
                }`}
                key={choice}
                onClick={() => setCopies(String(choice))}
                type="button"
              >
                {choice}
              </button>
            ))}
            <input
              aria-label="Number of copies"
              className="h-10 w-20 border border-slate-300 px-2 text-sm"
              dir="ltr"
              inputMode="numeric"
              max={PRINT_COPIES_MAX}
              min={1}
              onChange={(event) => setCopies(event.target.value)}
              type="number"
              value={copies}
            />
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            A paper that states how it was drawn up — the Arabic HR letter — writes this number on
            itself.
          </p>

          {askAddress ? (
            <>
              <p className="mt-4 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
                Which company address goes on the paper?
              </p>
              <div className="mt-2 flex flex-col gap-2" role="radiogroup">
                {addressOptions.map((option) => (
                  <button
                    aria-checked={address === option.choice}
                    className={`border px-3 py-2.5 text-start ${
                      address === option.choice
                        ? "border-slate-900 bg-slate-50"
                        : "border-slate-300 bg-white"
                    }`}
                    key={option.choice}
                    onClick={() => setAddress(option.choice)}
                    role="radio"
                    type="button"
                  >
                    <span className="block text-sm font-semibold text-slate-950">
                      {address === option.choice ? "● " : "○ "}
                      {PRINT_ADDRESS_LABELS[option.choice]}
                    </span>
                    {option.text ? (
                      <span className="mt-1 block text-sm text-slate-700" dir="rtl">
                        {option.text}
                      </span>
                    ) : (
                      <span className="mt-1 block text-sm text-slate-700">
                        The address held in the company details.
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {/*
            STAMP AND SIGNATURE - asked here, for THIS print, and never remembered.

            The owner, 2026-09-29: "make it optional to choose for any form i want." It sits beside
            the copy count and the address because those are the other two things he already decides
            per print, and it opens unticked for the same reason the address has no pre-selected
            answer: the point of asking is that the desk decides, not that the system's habit does.

            Shown only for the marks this paper has a position for, so the box can never offer a
            stamp that would land nowhere.
          */}
          {availableMarks.length > 0 ? (
            <>
              <div className="text-sm font-semibold text-slate-800">
                Stamp or sign this print?
              </div>
              <div className="flex flex-col gap-2">
                {availableMarks.map((mark) => {
                  const on = marks.includes(mark);
                  return (
                    <button
                      aria-checked={on}
                      className={
                        on
                          ? "flex items-center gap-2 border border-slate-800 bg-slate-50 px-3 py-2 text-left text-sm text-slate-900"
                          : "flex items-center gap-2 border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-700"
                      }
                      key={mark}
                      onClick={() =>
                        setMarks((current) =>
                          current.includes(mark)
                            ? current.filter((entry) => entry !== mark)
                            : [...current, mark],
                        )
                      }
                      role="checkbox"
                      type="button"
                    >
                      <span aria-hidden>{on ? "☑ " : "☐ "}</span>
                      <span className="font-medium">{DOCUMENT_MARK_LABELS[mark]}</span>
                    </button>
                  );
                })}
                <span className="text-phx-2xs text-slate-500">
                  Left unticked, the paper prints blank here for a real stamp and a real signature.
                </span>
              </div>
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <button
            className="border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            disabled={!ready}
            onClick={() => onConfirm({ address, copies: count, marks })}
            type="button"
          >
            Print {count >= 1 ? count : ""} {count === 1 ? "copy" : "copies"}
          </button>
        </div>
      </div>
    </div>
  );
}
