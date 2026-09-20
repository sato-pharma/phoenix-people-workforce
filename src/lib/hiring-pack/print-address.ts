// WHICH COMPANY ADDRESS A PAPER PRINTS — chosen at the desk, at the moment of printing.
//
// THE OWNER, 2026-09-20: "make me choose the address — the one you wrote here, or the one that is
// property no. 8, نموذج ن, block 1258 — one or the other, in the document, before we print". The
// company holds two addresses and every house paper's recital used to print only the first:
//
//   registered — المركز العام as the commercial register and the contract's recital give it
//                (`company.contractRecital.headOfficeAr`, editable in company details).
//   office     — the office the company works from (`systemInterviewVenue.addressAr`, the address
//                candidates are already sent to).
//
// THE CHOICE IS MADE ON THE DATA, NOT ON EACH RENDERER. Every renderer reads the recital's head
// office as its `COMPANY_HEAD_OFFICE_FULL` blank, so swapping that one value before rendering moves
// the address on all of them at once, and a renderer added later follows without being told. The two
// government forms print the short `company.headOfficeAr` instead and are not touched: they are
// copied to the Authority's own layout, and an address the Authority did not issue is not theirs to
// carry (see `documentTakesAddressChoice`).

import { systemInterviewVenue } from "@/config/system-settings";
import type { HiringPackData } from "@/lib/hiring-pack/types";

export const PRINT_ADDRESS_CHOICES = ["registered", "office"] as const;
export type PrintAddressChoice = (typeof PRINT_ADDRESS_CHOICES)[number];

/** What each choice is called on the prompt — English for the desk; the Arabic text is the address. */
export const PRINT_ADDRESS_LABELS: Record<PrintAddressChoice, string> = {
  registered: "Registered head office",
  office: "Working office",
};

/** The office address, as the company writes it. One source, shared with the interview invitation. */
export const OFFICE_ADDRESS_AR: string = systemInterviewVenue.addressAr;

/** A query-string value, narrowed. Anything else — including absent — is `null`: no choice made. */
export function parsePrintAddress(raw: string | null | undefined): PrintAddressChoice | null {
  return (PRINT_ADDRESS_CHOICES as readonly string[]).includes(raw ?? "")
    ? (raw as PrintAddressChoice)
    : null;
}

/**
 * The papers the choice applies to: every one except the two the Authority issues (Form 1 and
 * Form 6), which print the company's short registered address as the Authority's own layout asks.
 */
export function documentTakesAddressChoice(document: string): boolean {
  return document !== "form1" && document !== "form6";
}

/** The address text a choice stands for, given the company as resolved for this print. */
export function printAddressText(
  company: Pick<HiringPackData["company"], "contractRecital">,
  choice: PrintAddressChoice,
): string {
  return choice === "office" ? OFFICE_ADDRESS_AR : company.contractRecital.headOfficeAr;
}

/**
 * The pack with the chosen address in the recital. `registered`, or no choice, returns the pack
 * untouched — the address the paper has always carried — and `office` returns a copy: the resolved
 * pack is shared by the caller and must never be edited in place.
 */
export function withPrintAddress(
  data: HiringPackData,
  choice: PrintAddressChoice | null,
): HiringPackData {
  if (choice !== "office") return data;
  return {
    ...data,
    company: {
      ...data.company,
      contractRecital: { ...data.company.contractRecital, headOfficeAr: OFFICE_ADDRESS_AR },
    },
  };
}
