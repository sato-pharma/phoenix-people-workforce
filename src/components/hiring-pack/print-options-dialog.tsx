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

/** What the desk answered: how many copies, and which company address goes on them (or no choice). */
export type PrintAnswer = { address: PrintAddressChoice | null; copies: number };

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
  registeredAddress: string | null;
  title: string;
}) {
  const [copies, setCopies] = useState(String(defaultCopies));
  const [address, setAddress] = useState<PrintAddressChoice | null>(askAddress ? initialAddress : null);
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
            onClick={() => onConfirm({ address, copies: count })}
            type="button"
          >
            Print {count >= 1 ? count : ""} {count === 1 ? "copy" : "copies"}
          </button>
        </div>
      </div>
    </div>
  );
}
