"use client";

import {
  SatoEmailComposer,
  type ComposerVariant,
  type SatoListView,
  type SatoTemplateView,
} from "@/components/admin/sato-email-composer";
// 🔴 ./assist-limits, NEVER ./assist — that one imports the OpenAI client, so importing it here
// would pull the API key's reader and the model plumbing into the browser bundle.
import { CEO_ASSIST_MAX_INSTRUCTION_CHARS } from "@/lib/ceo-email/assist-limits";

/**
 * The CEO Email Composer.
 *
 * 🔴 IT IS THE SAME SCREEN, ON PURPOSE — see the `ComposerVariant` header in
 * `sato-email-composer.tsx` for the whole reasoning. Owner 2026-10-06 asked for a composer "exactly
 * as sato email composer copy paste", and the only way a second screen stays exactly like the first
 * is for it to BE the first. A literal copy of 1,500 lines would drift on the first fix applied to
 * one of them, and the one left behind would be the one that mails the company over the chief
 * executive's signature.
 *
 * Everything that differs between the two is in the object below, and nowhere else.
 *
 * 🔴 `CEO_ASSIST_MAX_INSTRUCTION_CHARS` IS IMPORTED RATHER THAN RETYPED, and it is the one value
 * here that must not be a copy: the route slices the instruction at it, so a smaller number on the
 * screen is a textarea that stops him mid-sentence, and a larger one is a briefing whose second half
 * is silently dropped on the way.
 */
export const CEO_COMPOSER_VARIANT: ComposerVariant = {
  apiBase: "/api/admin/ceo-email",
  // One box, no mode buttons. The server reads what he asked for; see src/lib/ceo-email/assist.ts.
  assist: "understood",
  dictation: true,
  instructionMaxChars: CEO_ASSIST_MAX_INSTRUCTION_CHARS,
  requestIdPrefix: "ceo",
  signOffDefault: "Sincerely",
  // 🔴 THE FIELD IS THE CLOSING LINE, NOT THE SIGNATORY. The name and the office under the signature
  // rule are resolved on the SERVER from the employee directory on every render
  // (src/lib/ceo-email/identity.ts) and cannot be posted from here — otherwise the Super Admin seat,
  // which can also open this screen, could mail a distribution list signed as somebody else.
  signOffHint:
    "The closing line above your signature. Your name, your office and the company are printed under it from the employee directory — they are not typed here.",
  signOffLabel: "Closing line",
};

export function CeoEmailComposer({
  dictationAvailable,
  initialLists,
  initialTemplates,
  loadWarnings,
}: {
  dictationAvailable: boolean;
  initialLists: SatoListView[];
  initialTemplates: SatoTemplateView[];
  loadWarnings: string[];
}) {
  return (
    <SatoEmailComposer
      dictationAvailable={dictationAvailable}
      initialLists={initialLists}
      initialTemplates={initialTemplates}
      loadWarnings={loadWarnings}
      variant={CEO_COMPOSER_VARIANT}
    />
  );
}
