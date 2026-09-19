// Minimal ambient types for "mammoth" (DOCX text extraction) — the package ships no
// TypeScript definitions and there is no @types/mammoth on npm. Only the surface this
// codebase actually calls (extractRawText, convertToHtml) is declared.
declare module "mammoth" {
  export type MammothMessage = { type: string; message: string };
  export type MammothRawTextResult = { value: string; messages: MammothMessage[] };
  export type MammothHtmlResult = { value: string; messages: MammothMessage[] };
  export function extractRawText(input: { buffer: Buffer } | { path: string }): Promise<MammothRawTextResult>;
  export function convertToHtml(input: { buffer: Buffer } | { path: string }): Promise<MammothHtmlResult>;
}
