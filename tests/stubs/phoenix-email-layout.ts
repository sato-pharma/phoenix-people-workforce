export type PhoenixEmailAction = {
  href: string;
  label: string;
  tone?: "primary" | "danger" | "secondary";
};

export type PhoenixEmailMetadataRow = {
  label: string;
  value: string | number | null | undefined;
};

export type PhoenixEmailLayoutProps = {
  action?: PhoenixEmailAction;
  bodyHtml: string;
  metadataRows?: PhoenixEmailMetadataRow[];
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

export function renderPhoenixEmailText(input: PhoenixEmailLayoutProps & { bodyText?: string }) {
  return `${input.title}\n\n${input.bodyText ?? input.previewText}`;
}
