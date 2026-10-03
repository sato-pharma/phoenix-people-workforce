// Recruitment / ATS — the automatic WhatsApp replies as the admin screen sees them: each key paired
// with the DEFAULT text the sender that owns it would use, and with whatever the owner has saved.
//
// Separate from whatsapp-auto-replies.ts (pure metadata and validators) and from
// whatsapp-auto-replies-store.ts (the table) for one structural reason: this is the only module that
// imports the SENDERS, and the senders import the store. Keeping it apart is what stops
// sender -> store -> sender becoming a cycle.
//
// Server-side only. The admin client component is handed these rows as props and imports nothing
// from here — the same shape BuiltInQuestionsEditor has for the six questions.

import {
  AUTO_REPLY_KEYS,
  AUTO_REPLY_META,
  AUTO_REPLY_REQUIRED_TOKENS,
  type AutoReplyKey,
} from "@/lib/recruitment/inbound/whatsapp-auto-replies";
import { loadAutoReplyOverrides } from "@/lib/recruitment/inbound/whatsapp-auto-replies-store";
import { CLOSING_INTRO_DEFAULT, CLOSING_OUTRO_DEFAULT } from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import { textOnlyReplyDefault } from "@/lib/recruitment/inbound/whatsapp-text-only-applicant";
import { unreadableCvReplyDefault } from "@/lib/recruitment/inbound/whatsapp-unreadable-cv";

/** One automatic reply, with its default and whatever is saved — enough for the screen to show the
 *  live wording, mark which are reworded, and offer a reset without a second request. */
export type AutoReplyRow = {
  key: AutoReplyKey;
  label: string;
  note: string;
  /** The wording in code. Never stored in the database — see the store's reset path. */
  defaultBody: string;
  /** Tokens the owner's version must keep. Empty for every reply but the too-large one. */
  requiredTokens: readonly string[];
  /** The owner's wording, or null when this reply is still on its default. */
  savedBody: string | null;
};

/**
 * The default text for one reply, read from the module that SENDS it rather than from a copy here.
 *
 * A `switch` over the key union, deliberately exhaustive: adding a key to AUTO_REPLY_KEYS without
 * teaching this function where its words live is a typecheck failure, not a message that silently
 * renders blank on the screen.
 */
export function autoReplyDefault(key: AutoReplyKey): string {
  switch (key) {
    case "text_only_plain":
      return textOnlyReplyDefault("plain");
    case "text_only_job_enquiry":
      return textOnlyReplyDefault("asked_about_the_job");
    case "unreadable_photo":
      return unreadableCvReplyDefault("not_recognised");
    case "unreadable_too_large":
      return unreadableCvReplyDefault("too_large");
    case "closing_intro":
      return CLOSING_INTRO_DEFAULT;
    case "closing_outro":
      return CLOSING_OUTRO_DEFAULT;
  }
}

/**
 * Every automatic reply, in the order an applicant meets it, with the owner's wording where he has
 * saved one.
 *
 * The saved read is best-effort inside the store, so this never throws and a database problem shows
 * as "every reply is on its default" rather than as an error page over an editor.
 */
export async function listAutoReplies(): Promise<AutoReplyRow[]> {
  const overrides = await loadAutoReplyOverrides();
  return AUTO_REPLY_KEYS.map((key) => ({
    defaultBody: autoReplyDefault(key),
    key,
    label: AUTO_REPLY_META[key].label,
    note: AUTO_REPLY_META[key].note,
    requiredTokens: AUTO_REPLY_REQUIRED_TOKENS[key],
    savedBody: overrides.get(key) ?? null,
  }));
}
