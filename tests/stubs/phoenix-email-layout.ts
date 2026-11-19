export type PhoenixEmailAction = {
  href: string;
  label: string;
  tone?: "primary" | "danger" | "secondary";
};

export type PhoenixEmailMetadataRow = {
  label: string;
  value: string | number | null | undefined;
};

export type PhoenixEmailMetadataSection = {
  heading: string;
  rows: PhoenixEmailMetadataRow[];
};

export type PhoenixEmailHeroStat = {
  badge?: string;
  label: string;
  value: string;
};

export type PhoenixEmailLayoutProps = {
  action?: PhoenixEmailAction;
  bodyHtml: string;
  closingText?: string;
  greeting?: string;
  heroStat?: PhoenixEmailHeroStat;
  metadataRows?: PhoenixEmailMetadataRow[];
  metadataSections?: PhoenixEmailMetadataSection[];
  subtitle?: string;
  previewText: string;
  signatureName?: string;
  subject: string;
  title: string;
};

export const phoenixEmailSignatureHostedUrl = "https://example.com/phoenix-email-signature.png";

export function PhoenixEmailLayout(props: PhoenixEmailLayoutProps) {
  return props;
}

export function escapeEmailHtml(value: string | number | null | undefined) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderEmailParagraphs(value: string | null | undefined) {
  return String(value ?? "")
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeEmailHtml(paragraph)}</p>`)
    .join("");
}

export function renderPhoenixEmailHtml(input: PhoenixEmailLayoutProps) {
  return `<h1>${escapeEmailHtml(input.title)}</h1>${input.bodyHtml}`;
}

export function renderPhoenixMetadataTable(rows: PhoenixEmailMetadataRow[] | undefined) {
  const cleanRows = (rows ?? []).filter((row) => String(row.value ?? "").trim());
  if (cleanRows.length === 0) return "";
  return `<table>${cleanRows
    .map((row) => `<tr><td>${escapeEmailHtml(row.label)}</td><td>${escapeEmailHtml(row.value)}</td></tr>`)
    .join("")}</table>`;
}

export function renderPhoenixMetadataTableText(rows: PhoenixEmailMetadataRow[] | undefined) {
  return (rows ?? [])
    .filter((row) => String(row.value ?? "").trim())
    .map((row) => `${row.label}: ${row.value}`)
    .join("\n");
}

// The sectioned equivalents of the two table renderers above. Added 2026-09-09 with the six
// code-built senders that moved onto templates: the direct-order approval passes its grouped
// detail sections through {{detailsSections}}, and without these the whole suite fails to
// import — which is how CI caught it when every locally-run suite was green.
export function renderPhoenixMetadataSections(sections: PhoenixEmailMetadataSection[] | undefined) {
  const clean = (sections ?? []).filter((section) => section.rows.some((row) => String(row.value ?? "").trim()));
  if (clean.length === 0) return "";
  return clean
    .map((section) => `<h3>${escapeEmailHtml(section.heading)}</h3>${renderPhoenixMetadataTable(section.rows)}`)
    .join("");
}

export function renderPhoenixMetadataSectionsText(sections: PhoenixEmailMetadataSection[] | undefined) {
  return (sections ?? [])
    .map((section) => `${section.heading}\n${renderPhoenixMetadataTableText(section.rows)}`)
    .filter((block) => block.trim())
    .join("\n\n");
}

export function renderPhoenixEmailText(input: PhoenixEmailLayoutProps & { bodyText?: string }) {
  return `${input.title}\n\n${input.bodyText ?? input.previewText}`;
}

// The data grid the production-planning sweeps (reorder and expiry) put in their emails. Added
// 19 Nov 2026: without these the reorder cron route could not be imported under the test loader, so
// the route guard harness had to list it as not callable.
export type PhoenixEmailGridColumn = {
  readonly label: string;
  readonly align?: "left" | "right";
};

export type PhoenixEmailGridCell = {
  readonly text: string | number | null | undefined;
  readonly sub?: string | null;
  readonly note?: string | null;
  readonly tone?: "neutral" | "danger" | "warning" | "ok";
};

type PhoenixEmailGridRow = readonly (PhoenixEmailGridCell | string | number | null | undefined)[];

function gridCellText(cell: PhoenixEmailGridCell | string | number | null | undefined) {
  if (cell === null || cell === undefined) return "";
  return typeof cell === "object" ? String(cell.text ?? "") : String(cell);
}

export function renderPhoenixDataGrid(columns: readonly PhoenixEmailGridColumn[], rows: readonly PhoenixEmailGridRow[]) {
  if (columns.length === 0 || rows.length === 0) return "";
  const head = columns.map((column) => `<th>${escapeEmailHtml(column.label)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${columns.map((_column, index) => `<td>${escapeEmailHtml(gridCellText(row[index]))}</td>`).join("")}</tr>`)
    .join("");
  return `<table><tr>${head}</tr>${body}</table>`;
}

export function renderPhoenixDataGridText(columns: readonly PhoenixEmailGridColumn[], rows: readonly PhoenixEmailGridRow[]) {
  if (columns.length === 0 || rows.length === 0) return "";
  return [columns.map((column) => column.label), ...rows.map((row) => columns.map((_column, index) => gridCellText(row[index])))]
    .map((cells) => cells.join(" | "))
    .join("\n");
}
