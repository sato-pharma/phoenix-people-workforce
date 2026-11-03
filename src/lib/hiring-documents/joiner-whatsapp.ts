// ─────────────────────────────────────────────────────────────────────────────────────────────
// The message to a joiner, written so HR never has to type it (owner, 2026-11-03).
//
// A PREPARED MESSAGE, NEVER A SEND. WhatsApp's Cloud API refuses free text to anyone who has not
// written to the business in the last 24 hours, which is every joiner, so this composes the words and
// `whatsAppSendUrl` opens the chat with them in the box. A person reads it and presses send, and can
// change it first. See `src/lib/auth/password-setup-whatsapp.ts` for the same reasoning.
//
// ONLY THE PAPERS THE JOINER CARRIES IN. "required" is what they fetch from elsewhere; "onboarding" is
// what they sign at HR on the day, so listing it would send them looking for a contract they have not
// been given. Pure, so the wording is tested without a browser and a client component can read it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import type { HiringDocumentDefinition, HiringDocumentEntry } from "@/lib/hiring-documents/types";

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

type PaperDefinition = Pick<HiringDocumentDefinition, "documentGroup" | "id" | "isExitDocument" | "name">;

export type JoinerWhatsAppInput = {
  /** The day and time on screen, `YYYY-MM-DD` and `HH:MM`. Either may be empty. */
  attendanceDate: string | null;
  attendanceTime: string | null;
  companyName: string;
  documents: readonly PaperDefinition[];
  /** The person's checklist once they have a record. Null means no record, so every paper is owed. */
  employeeDocuments: Readonly<Record<string, Pick<HiringDocumentEntry, "status">>> | null;
  name: string;
};

/** The day as a person reads it: `Tuesday 10 November 2026`. Null when it is not a real date. */
export function joinerAttendanceDayLabel(key: string | null): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key ?? "");
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${WEEKDAY_NAMES[date.getUTCDay()]} ${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

/** `09:30` as `9:30 AM`. Null when it is not a time of day. */
export function joinerAttendanceTimeLabel(time: string | null): string | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time ?? "");
  if (!match) return null;
  const hour = Number(match[1]);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}

/** The papers this joiner still has to bring, in the checklist's order. */
export function joinerPapersToBring(
  documents: readonly PaperDefinition[],
  employeeDocuments: JoinerWhatsAppInput["employeeDocuments"],
): string[] {
  return documents
    .filter((document) => document.documentGroup === "required" && !document.isExitDocument)
    .filter((document) => employeeDocuments?.[document.id]?.status !== "submitted")
    .map((document) => document.name.replace(/\s+/gu, " ").trim());
}

function attendanceLine(input: Pick<JoinerWhatsAppInput, "attendanceDate" | "attendanceTime">): string {
  const day = joinerAttendanceDayLabel(input.attendanceDate);
  if (!day) return "We will confirm your first day and time with you.";
  const time = joinerAttendanceTimeLabel(input.attendanceTime);
  return time ? `Please attend on ${day} at ${time}.` : `Please attend on ${day}. We will confirm the time with you.`;
}

/** The whole message. It names no sender: whoever presses send is the person the joiner replies to. */
export function joinerWhatsAppMessage(input: JoinerWhatsAppInput): string {
  const papers = joinerPapersToBring(input.documents, input.employeeDocuments);
  const paperLines =
    papers.length > 0
      ? ["Please bring these papers with you:", ...papers.map((paper, index) => `${index + 1}. ${paper}`)]
      : ["We have received all the papers we asked you to bring."];

  return [
    `Hello ${input.name.trim()},`,
    "",
    `This is the HR team at ${input.companyName}, about your joining.`,
    "",
    attendanceLine(input),
    "",
    ...paperLines,
    "",
    "Please reply to this message to confirm, or if anything is not clear.",
  ].join("\n");
}
