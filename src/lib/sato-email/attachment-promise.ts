/**
 * Whether an email TELLS its reader a file comes with it.
 *
 * Owner 2026-10-24: "fix the composer so an attached PDF uploads before Send". That evening a
 * welcome email reached five inboxes saying "Your New Starter Handbook is attached" with nothing
 * attached: the PDF had been dropped into the message body, where the editor refused to open it
 * and did nothing else with it either. The body editor now hands such a file to the attachments
 * row, and this check is the second net — whatever gesture lost the file, an email that promises
 * one and carries none is stopped at the confirmation and has to be sent on purpose.
 *
 * Deliberately narrow, so the warning stays worth reading: "attached", "attachment(s)",
 * "enclosed" and the Arabic مرفق family. The bare verb "attach" is left out on purpose — "please
 * attach your CV" asks the READER for a file and promises nothing.
 *
 * Kept pure so the rule is checked in the suite without a browser.
 */

const PROMISE_WORDS = /\b(?:attached|attachments?|enclosed)\b/i;
// No \b for Arabic: JavaScript's word boundary only knows ASCII letters.
const ARABIC_PROMISE = /مرفق|مُرفق|المرفقات/;

function plainText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function promisesAnAttachment(subject: string, bodyHtml: string): boolean {
  const text = `${subject} ${plainText(bodyHtml)}`;
  return PROMISE_WORDS.test(text) || ARABIC_PROMISE.test(text);
}
