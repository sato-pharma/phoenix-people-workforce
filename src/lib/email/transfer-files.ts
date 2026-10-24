/**
 * What a paste or a drag actually carried — the pure half of "drop a photo in the message".
 *
 * Owner 2026-09-23: "in sato email composer i want to be able to insert attachment and upload
 * photo either in message body or as attachment."
 *
 * Both buttons already existed (#3773). What did not was the gesture everybody actually uses: a
 * screenshot on the clipboard, or a photo dragged out of a folder. The editor's paste handler
 * called `preventDefault()` and then read `text/plain` only, so pasting a picture did precisely
 * nothing — no picture, no message, nothing to tell the sender the gesture was not supported.
 *
 * 🔴 THIS FILTER IS DELIBERATELY WIDER THAN THE STORE'S ALLOWLIST. A phone photo is usually HEIC,
 * which `validateSatoEmailUpload` refuses — and it should. But refusing it HERE would make the
 * gesture silently do nothing again, which is the bug being fixed. So anything that looks like a
 * picture is handed to the upload, and the refusal comes back from the server in words the screen
 * can show.
 *
 * Kept pure, and generic over `{ name, type }` rather than over `File`, so the rule can be checked
 * in the test suite without a browser.
 */

/** The picture types this app's own editors accept when the host does not name its own list. */
export const EDITOR_IMAGE_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";

type TransferFile = { name?: string | null; type?: string | null };

const PICTURE_EXTENSION = /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;
const ANY_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

function fileName(file: TransferFile): string {
  return String(file.name ?? "").trim();
}

function fileType(file: TransferFile): string {
  return String(file.type ?? "").trim().toLowerCase();
}

/**
 * A folder dragged in arrives as an entry with no type and no extension, and uploading one fails
 * with a message about an empty file that explains nothing. Dropped before the upload instead.
 */
function looksLikeFolder(file: TransferFile): boolean {
  return fileType(file) === "" && !ANY_EXTENSION.test(fileName(file));
}

/** Whether this entry is a picture, by MIME type or — when the drag carried none — by extension. */
export function looksLikePicture(file: TransferFile): boolean {
  const type = fileType(file);
  if (type.startsWith("image/")) return true;
  return type === "" && PICTURE_EXTENSION.test(fileName(file));
}

/** The pictures in a paste or a drag, in the order the browser handed them over. */
export function picturesFromTransfer<T extends TransferFile>(files: readonly T[]): T[] {
  return files.filter((file) => looksLikePicture(file));
}

/** Everything in a drag that is a file at all — the attachment picker decides the rest. */
export function attachablesFromTransfer<T extends TransferFile>(files: readonly T[]): T[] {
  return files.filter((file) => fileName(file) !== "" && !looksLikeFolder(file));
}

/**
 * The files in a paste or a drag that are NOT pictures — a PDF, a spreadsheet, a Word file.
 *
 * Owner 2026-10-24: a handbook PDF dropped into the message body vanished — the editor stopped the
 * browser opening it and then did nothing with it, and the email went out saying "attached" with
 * nothing attached. A body that can hand these to its host's attachments row does so now.
 */
export function nonPicturesFromTransfer<T extends TransferFile>(files: readonly T[]): T[] {
  return attachablesFromTransfer(files).filter((file) => !looksLikePicture(file));
}
