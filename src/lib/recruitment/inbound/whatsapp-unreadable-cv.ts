// Recruitment / ATS — the applicant who DID send something and was told nothing.
//
// WHY THIS EXISTS. The sibling module whatsapp-text-only-applicant.ts closed the "wrote, attached
// nothing" hole on 2026-08-29. Within four hours of it going live, production showed the hole next
// to it, and showed it happening to a real person:
//
//   23:14  Hind writes "مساء الخير", then "بتقبلو بار مديكال ؟"
//   23:14  Phoenix replies — send the CV as a file, a photo cannot be processed
//   23:16  Hind sends a PHOTO
//   ...    nothing. No candidate, no reply to her, no alert to anyone.
//
// She did what she was asked, in the only way her phone made obvious, and the system went silent.
// From the owner's side this is indistinguishable from "the CV was not recognised" — which is
// exactly the words he used. Measured the same night: FOUR members of the public have hit this
// since 25 July (Hind, Hanin, HKM, Noor), every one of them recorded as
// `ignored_unsupported_attachment` with the reason "Attachment does not appear to be a CV/resume
// (automated content check)". One of them, Hanin, rescued herself by sending a PDF five seconds
// later. The other three were never heard from again.
//
// WHAT REACHES HERE. Not a wrong file type — an image is a first-class CV kind in this codebase
// (detectCvFileKind answers "image"; cv-extraction reads it with vision). It reaches here when the
// READ came back and judged the picture not to be a CV, or when the file was too large to pull.
// So the picture may genuinely be a certificate, or it may be a photographed CV the model called
// wrong. Both land identically, and the system cannot tell them apart.
//
// WHICH IS WHY THIS NEVER DECIDES. The house rule is that Phoenix FLAGS and a human rules — the
// system never auto-rejects. So this does two things and neither of them is a judgement:
//
//   1. ASK the applicant, in their own thread, to resend as a PDF or Word file — naming the 📎
//      button and the "Document" option, because "send it as a file" is what she was already told
//      and it was not enough. Wording that works whether the picture was a certificate or a CV:
//      it never tells anyone their CV was rejected.
//   2. NOTIFY a human that a real person sent something unreadable, so the picture can be opened
//      by eye. The media is still fetchable — the queue keeps `mediaId` — so this is recoverable
//      right up until Meta ages the media out.
//
// The record already exists before this runs: finalizeIntakeEvent writes the
// `ignored_unsupported_attachment` row. That is why this module records nothing itself, and why
// the "already handled" guard below counts THAT outcome rather than one of its own.
//
// Free-form text is correct here without an approved template for the same reason as the sibling:
// this only ever runs moments after the applicant messaged us, i.e. inside Meta's 24-hour customer
// service window.
//
// Split pure-decision from I/O, same as the sibling, so every guard is assertable with no database
// and no Meta.

import { logError } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";
import { notifyInboundWhatsAppUnreadableCv } from "@/lib/recruitment/inbound/recruitment-notify";
import { sendWhatsAppText } from "@/lib/recruitment/inbound/whatsapp-interactive";
import { isWhatsAppImportSender } from "@/lib/recruitment/inbound/whatsapp-payload-parser";
import { textOnlySenderLabel, TEXT_ONLY_WINDOW_MS } from "@/lib/recruitment/inbound/whatsapp-text-only-applicant";

/** Same window as the text-only path, deliberately: a person who tries again tomorrow is a new
 *  attempt and deserves the same help, while a burst of photo pages tonight is one conversation. */
export const UNREADABLE_CV_WINDOW_MS = TEXT_ONLY_WINDOW_MS;

/** Why the attachment never became a candidate. Decides the WORDING, never whether to reply. */
export type UnreadableCvCause = "not_recognised" | "too_large";

export type UnreadableCvContext = {
  /** A configured bulk-import handset, not an applicant. */
  isImportSender: boolean;
  /** A coexistence history replay — it already happened, possibly months ago. */
  historical: boolean;
  /** How many unreadable attachments this sender already produced inside the window, EXCLUDING
   *  this one. Zero means this is the first, and the only one that speaks or pages anybody. */
  priorUnreadableInWindow: number;
  /** The kill switch, read once by the caller so the decision stays pure. */
  replyEnabled: boolean;
};

export type UnreadableCvAction = {
  ask: boolean;
  notify: boolean;
  reason: "import_sender" | "historical" | "already_handled" | "reply_disabled" | "unreadable";
};

const SILENT = { ask: false, notify: false } as const;

/**
 * The whole guard set, in the order it must run.
 *
 * IMPORT SENDER first and HISTORICAL second — both are cheap, need no database, and between them
 * cover the overwhelming majority of this channel's traffic. A forwarder is not the applicant, and
 * a history replay would message months of old senders the moment a handset is linked.
 *
 * ALREADY HANDLED is the loop guard. Somebody photographing a four-page certificate sends four
 * images in one minute; they are one conversation and deserve one reply, not four.
 *
 * REPLY DISABLED still notifies. The switch exists to stop Phoenix TALKING to applicants, never to
 * stop it telling a human that somebody is waiting — muting both is how a kill switch becomes a
 * second outage.
 */
export function decideUnreadableCvAction(context: UnreadableCvContext): UnreadableCvAction {
  if (context.isImportSender) return { ...SILENT, reason: "import_sender" };
  if (context.historical) return { ...SILENT, reason: "historical" };
  if (context.priorUnreadableInWindow > 0) return { ...SILENT, reason: "already_handled" };
  if (!context.replyEnabled) return { ask: false, notify: true, reason: "reply_disabled" };
  return { ask: true, notify: true, reason: "unreadable" };
}

/** Shares the sibling's switch on purpose: one variable governs whether Phoenix ever writes to an
 *  applicant on this line, so silencing it in an incident does not mean finding two names. */
export function isUnreadableCvReplyEnabled(): boolean {
  return String(process.env.RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

/**
 * What the applicant is told.
 *
 * This is the SECOND thing many of them will have read from us — Hind had already been told "send
 * it as a file" and sent a photo anyway. So repeating that sentence is known not to work, and this
 * names the buttons instead: the paperclip, then Document rather than Gallery. That single
 * difference is the entire point of the message.
 *
 * It never says the CV was rejected, because nothing here knows that. The picture may have been a
 * certificate; it may have been a CV the model misread. Both readers get a sentence that is true.
 *
 * Arabic first — the adverts run in Arabic and the applicants write in Arabic.
 */
export function unreadableCvReplyText(cause: UnreadableCvCause, maxBytes = 15 * 1024 * 1024): string {
  if (cause === "too_large") {
    // Derived, never written down twice: the ceiling is env-overridable
    // (RECRUITMENT_INBOUND_CV_MAX_BYTES), and a message quoting a number the system no longer
    // enforces sends people away to shrink a file that would have been accepted.
    const maxMb = Math.max(1, Math.floor(maxBytes / (1024 * 1024)));
    return [
      "‏شكراً لإرسالك السيرة الذاتية 🌟",
      "‏لكن حجم الملف كبير جداً ولم نستطع فتحه.",
      `‏من فضلك أرسله مرة أخرى بحجم أصغر (أقل من ${maxMb} ميجابايت) كملف PDF أو Word.`,
      "",
      "Thanks for sending your CV.",
      `The file was too large for us to open — please send it again under ${maxMb} MB, as a PDF or Word file.`,
    ].join("\n");
  }
  return [
    "‏شكراً لتواصلك مع ساتو فارما 🌟",
    "‏وصلتنا صورة 📷 ولم نتمكن من قراءة السيرة الذاتية منها.",
    "‏من فضلك أرسلها *كملف* PDF أو Word بهذه الطريقة:",
    "‏١ اضغط على علامة المشبك 📎 داخل المحادثة",
    "‏٢ اختر (ملف / Document) وليس (صورة / Gallery)",
    "‏٣ اختر ملف السيرة الذاتية وأرسله",
    "",
    "Thanks for contacting Sato Pharma.",
    "We received a picture and could not read a CV from it. Please send it as a *file*: tap 📎 in the chat, choose *Document* (not Gallery), and pick your CV.",
  ].join("\n");
}

/**
 * How many unreadable attachments this sender already produced inside the window, not counting the
 * one just recorded.
 *
 * Counts the row the intake service ALREADY wrote, which is why the caller's own event is subtracted
 * rather than excluded by id: the count runs after finalizeIntakeEvent, so this message is always
 * one of the rows returned, and forgetting that would mean nobody is ever helped.
 *
 * Allowed to throw. A failure here must not silently widen the decision into a duplicate reply to a
 * real applicant — the caller treats the whole path as best-effort and drops it.
 */
export async function countPriorUnreadable(input: { phone: string; now: Date }): Promise<number> {
  const supabase = recruitmentDb();
  const sinceIso = new Date(input.now.getTime() - UNREADABLE_CV_WINDOW_MS).toISOString();
  const { count, error } = await supabase
    .from("ats_cv_intake_events")
    .select("id", { count: "exact", head: true })
    .eq("channel", "whatsapp")
    .eq("outcome", "ignored_unsupported_attachment")
    .eq("sender_identifier", input.phone)
    .gte("created_at", sinceIso);
  if (error) throw error;
  return Math.max(0, (count ?? 0) - 1);
}

/** Sends the reply. Never throws — an unsent reply must not cost the alert that follows it. */
export async function askForCvAsFile(input: {
  waId: string;
  phoneNumberId: string | null;
  cause: UnreadableCvCause;
  maxBytes?: number;
}): Promise<boolean> {
  const result = await sendWhatsAppText({
    phoneNumberId: input.phoneNumberId,
    text: unreadableCvReplyText(input.cause, input.maxBytes),
    toWaId: input.waId,
  }).catch((error) => {
    logError("WhatsApp unreadable-CV reply threw", {
      error,
      labels: { event: "whatsapp_unreadable_cv_reply_threw" },
    });
    return { detail: "threw", ok: false as const, reason: "failed" as const };
  });
  return result.ok === true;
}

export type HandleUnreadableCvResult = {
  asked: boolean;
  reason: UnreadableCvAction["reason"] | "error";
};

/**
 * The whole unreadable-attachment path, end to end. NEVER throws.
 *
 * Ask BEFORE notify, unlike the sibling — there the record was the idempotency anchor and had to be
 * written first, whereas here the record already exists and the guard reads it. So the ordering that
 * matters is instead: the applicant, who is waiting, before the alert, which can wait.
 *
 * Runs from the intake WORKER rather than the webhook, because the verdict this reacts to is only
 * reached after the media has been downloaded and read. That also means there is no per-delivery
 * reply budget to respect — the worker handles one queued row at a time.
 */
export async function handleUnreadableWhatsAppCv(input: {
  waId: string;
  wamid: string;
  contactName: string | null;
  filename: string | null;
  cause: UnreadableCvCause;
  historical: boolean;
  importSenders: readonly string[];
  deliveredToPhoneNumberId: string | null;
  maxBytes?: number;
  now?: Date;
}): Promise<HandleUnreadableCvResult> {
  // The two guards needing no database, answered before any round trip.
  if (isWhatsAppImportSender(input.waId, input.importSenders)) return { asked: false, reason: "import_sender" };
  if (input.historical) return { asked: false, reason: "historical" };

  const now = input.now ?? new Date();
  const phone = `+${input.waId}`;

  try {
    const action = decideUnreadableCvAction({
      historical: input.historical,
      isImportSender: false,
      priorUnreadableInWindow: await countPriorUnreadable({ now, phone }),
      replyEnabled: isUnreadableCvReplyEnabled(),
    });

    if (!action.ask && !action.notify) return { asked: false, reason: action.reason };

    const asked = action.ask
      ? await askForCvAsFile({
          cause: input.cause,
          maxBytes: input.maxBytes,
          phoneNumberId: input.deliveredToPhoneNumberId,
          waId: input.waId,
        })
      : false;

    if (action.notify) {
      // Best-effort: a notification failure must not cost the reply that already succeeded.
      await notifyInboundWhatsAppUnreadableCv({
        asked,
        cause: input.cause,
        filename: input.filename,
        senderLabel: textOnlySenderLabel(input.contactName, phone),
        wamid: input.wamid,
      }).catch((error) => {
        logError("WhatsApp unreadable-CV notification failed", {
          error,
          labels: { event: "whatsapp_unreadable_cv_notify_failed", wamid: input.wamid },
        });
      });
    }

    return { asked, reason: action.reason };
  } catch (error) {
    logError("WhatsApp unreadable-CV handling failed", {
      error,
      labels: { event: "whatsapp_unreadable_cv_failed", wamid: input.wamid },
    });
    return { asked: false, reason: "error" };
  }
}
