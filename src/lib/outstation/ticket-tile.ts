/**
 * How a ticket or receipt is drawn on the approver's trip page (owner's review, 2026-11-07: a
 * broken thumbnail, a black frame and a raw file name all read as "Ticket" with nothing to say why).
 *
 * - "pdf"   → the PDF tile.
 * - "image" → a thumbnail the browser can actually draw (JPEG, PNG, WebP, GIF, AVIF, BMP, SVG).
 * - "file"  → anything else — HEIC from an iPhone, a Word file — gets a file tile and opens in a
 *   new tab, never a broken <img>.
 *
 * Unknown type with no extension stays "image": that is how the queue drew it before, and the
 * tile's own load-failure state catches the rest.
 */
export type TicketTileKind = "file" | "image" | "pdf";

const DRAWABLE_IMAGE = /^image\/(jpe?g|png|webp|gif|avif|bmp|svg\+xml)$/i;
const DRAWABLE_EXTENSION = /\.(jpe?g|png|webp|gif|avif|bmp|svg)(\?|#|$)/i;
const ANY_EXTENSION = /\.([a-z0-9]{2,5})(\?|#|$)/i;

export function ticketTileKind(ticket: { contentType?: string | null; name?: string | null; url: string }): TicketTileKind {
  const type = String(ticket.contentType ?? "").trim();
  const path = String(ticket.name ?? "") || ticket.url;
  if (/pdf/i.test(type) || /\.pdf(\?|#|$)/i.test(ticket.url) || /\.pdf$/i.test(path)) return "pdf";
  if (DRAWABLE_IMAGE.test(type)) return "image";
  if (DRAWABLE_EXTENSION.test(ticket.url) || DRAWABLE_EXTENSION.test(path)) return "image";
  if (type && type !== "application/octet-stream") return "file";
  return ANY_EXTENSION.test(ticket.url) || ANY_EXTENSION.test(path) ? "file" : "image";
}

/** "Ticket 1", "Ticket 2" … — the stored file name is the tile's tooltip, never its label. */
export function ticketTileLabel(index: number): string {
  return `Ticket ${index + 1}`;
}
