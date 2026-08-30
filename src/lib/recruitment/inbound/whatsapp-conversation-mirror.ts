// Recruitment / ATS — the owner's window onto the Cloud API WhatsApp line.
//
// WHY THIS EXISTS. There are two HR WhatsApp numbers and only one of them can be opened on a phone:
//
//   01159888247  the advertised handset. Runs the WhatsApp Business APP. The owner reads it, and
//                forwards CVs off it by hand. Nothing on it reaches Phoenix by itself.
//   01098500699  the Cloud API line. Everything sent here reaches the webhook automatically and the
//                applicant is asked to classify themselves — but it CANNOT be opened on a phone,
//                and a Cloud API number never can be. That is not a limitation to work around; it
//                is what makes the automation possible.
//
// Advertising the Cloud API line is what turns "the owner forwards 433 CVs a month by hand" into
// "the applicant answers three questions and files themselves". The single thing it costs him is
// sight of those conversations, because there is no handset to read them on. This module pays that
// cost back: every applicant who reaches the automated line is mirrored to his Telegram, which he
// already carries and already receives Phoenix alerts on.
//
// Best-effort, always. A Telegram outage must never affect a CV that has already been captured —
// capturing the CV is the only thing in this flow that actually matters. Nothing here throws.

import { resolveAdminTelegramChatIds } from "@/lib/email/admin-telegram-mirror";
import { sendTelegramNotification } from "@/lib/notifications/telegram";
import { logError } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";

/** Cut for an applicant's own words. Never an ellipsis — see `previewOf`. */
const MESSAGE_PREVIEW_MAX = 600;

export type WhatsAppMirrorEvent =
  | {
      kind: "cv_received";
      waId: string;
      /** WhatsApp profile name — what the applicant calls themselves. */
      contactName: string | null;
      /** Name read off the CV, once extraction has run. Preferred over the profile name. */
      candidateName: string | null;
      filename: string | null;
      /** The applicant's own message, if they wrote one alongside the file. */
      note: string | null;
    }
  | {
      kind: "classified";
      waId: string;
      candidateName: string | null;
      roleLabel: string | null;
      backgroundLabel: string | null;
      regionLabel: string | null;
      areaName: string | null;
      /** Whether the area question was part of this applicant's flow — Medical Rep only. When false
       *  the area line is omitted entirely, rather than shown as "not answered": a manager was never
       *  asked it, and "not answered" would read as a question they skipped. */
      areaApplies: boolean;
      /** Years-of-experience label, asked to everyone. "not answered" when they stopped short. */
      experienceLabel: string | null;
      /** Expected salary, verbatim as typed. "not answered" when they stopped short. */
      expectedSalary: string | null;
    };

/**
 * `201001234567` -> `+20 100 123 4567`. He rings these numbers; an unbroken 12-digit run is a number
 * you misdial. Anything that is not a 12-digit Egyptian mobile is returned with a leading `+` and
 * otherwise untouched, rather than being forced into a shape it does not have.
 */
export function formatWaId(waId: string): string {
  const digits = String(waId ?? "").replace(/\D/g, "");
  if (digits.length !== 12 || !digits.startsWith("20")) return digits ? `+${digits}` : "(unknown number)";
  const national = digits.slice(2);
  return `+20 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
}

/**
 * An applicant's own words, capped.
 *
 * The owner's standing rule is that text is never cut with an ellipsis, so an over-long message is
 * cut at a word boundary and then SAYS it was cut. A silent trim is the failure mode this avoids:
 * it reads as a complete message, and he answers the half he was shown.
 */
function previewOf(note: string | null): string | null {
  const normalized = String(note ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  if (normalized.length <= MESSAGE_PREVIEW_MAX) return normalized;
  const cut = normalized.slice(0, MESSAGE_PREVIEW_MAX);
  const atWord = cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : cut.length);
  return `${atWord}\n(rest of the message is on the candidate's record)`;
}

/**
 * Pure builder — no IO, so the wording is unit-tested without a network or a database.
 *
 * Both shapes lead with the person, because that is what he is deciding about. A missing name is
 * stated as unread rather than left blank: "not read from the CV yet" is a fact about extraction,
 * and an empty line looks like a bug.
 */
export function buildWhatsAppMirrorMessage(event: WhatsAppMirrorEvent): { title: string; message: string } {
  const who = (event.candidateName ?? "").trim() || null;

  if (event.kind === "classified") {
    const lines = [
      `${who ?? "Name not read from the CV yet"} · ${formatWaId(event.waId)}`,
      "",
      `Applying for: ${event.roleLabel ?? "not answered"}`,
      `Background: ${event.backgroundLabel ?? "not answered"}`,
      `Region: ${event.regionLabel ?? "not answered"}`,
    ];
    // The area line appears when it has a value, and — for a Medical Rep, the only role asked it —
    // as "not answered" when they stopped short. For every other role it is omitted: they were
    // never asked, and a line claiming they skipped it would be false.
    if (event.areaName) lines.push(`Area: ${event.areaName}`);
    else if (event.areaApplies) lines.push("Area: not answered");
    // Experience and salary are asked of everyone, so a missing one reads as "not answered" — the
    // same treatment as background and region, and unlike area, which is role-scoped.
    lines.push(`Experience: ${event.experienceLabel ?? "not answered"}`);
    lines.push(`Expected salary: ${event.expectedSalary ?? "not answered"}`);
    lines.push("", "They chose these themselves, in WhatsApp.");
    return { message: lines.join("\n"), title: "Applicant filed themselves" };
  }

  const profile = (event.contactName ?? "").trim() || null;
  // The profile name is shown only when it adds something — repeating the CV name in brackets is
  // noise, and it is the same person either way.
  const nameLine =
    who && profile && profile !== who
      ? `${who} (WhatsApp name: ${profile})`
      : (who ?? profile ?? "Name not read from the CV yet");

  return {
    message: [
      `${nameLine} · ${formatWaId(event.waId)}`,
      event.filename ? `CV: ${event.filename}` : "CV: file name not given",
      previewOf(event.note) ? `\nThey wrote:\n${previewOf(event.note)}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
    title: "CV on the automated WhatsApp line",
  };
}

/**
 * Sends the mirror. Never throws, never awaited into anything that matters.
 *
 * Silent when the owner has no connected Telegram chat — that is a real state (only two people in
 * the whole system are `connected`), and a missing chat is not an incident worth logging on every
 * CV that arrives.
 */
export async function mirrorWhatsAppEventToOwner(event: WhatsAppMirrorEvent): Promise<void> {
  try {
    const chatIds = await resolveAdminTelegramChatIds();
    if (chatIds.length === 0) return;
    const { message, title } = buildWhatsAppMirrorMessage(event);
    for (const chatId of chatIds) {
      try {
        await sendTelegramNotification({ chatId, message, title });
      } catch (error) {
        logError("WhatsApp conversation mirror: send failed", {
          error,
          labels: { event: "whatsapp_owner_mirror_send_failed" },
        });
      }
    }
  } catch (error) {
    logError("WhatsApp conversation mirror: could not resolve or deliver", {
      error,
      labels: { event: "whatsapp_owner_mirror_error" },
    });
  }
}

/**
 * The applicant's name, read off the candidate record.
 *
 * Best-effort and deliberately separate from the builder: extraction may not have produced a name
 * yet (a scanned photo CV, an unreadable file), and "not read from the CV yet" is the honest thing
 * to show him — far better than a mirror that fails, or one that arrives with a blank where the
 * person should be.
 */
export async function candidateDisplayName(candidateId: string | null | undefined): Promise<string | null> {
  if (!candidateId) return null;
  try {
    const { data } = await recruitmentDb().from("ats_candidates").select("full_name").eq("id", candidateId).maybeSingle();
    return ((data as { full_name?: string | null } | null)?.full_name ?? "").trim() || null;
  } catch {
    return null;
  }
}
