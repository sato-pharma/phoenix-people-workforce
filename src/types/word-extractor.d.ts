// Minimal ambient types for "word-extractor" (LEGACY .doc text extraction — the Word 97-2003
// OLE2 binary format, which mammoth cannot read). The package ships no TypeScript definitions
// and there is no @types/word-extractor on npm. Only the surface this codebase actually calls
// is declared: construct, extract from a Buffer, read the body text.
declare module "word-extractor" {
  export class WordDocument {
    getBody(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getHeaders(): string;
    getFooters(): string;
    getAnnotations(): string;
    getTextboxes(): string;
  }
  export default class WordExtractor {
    extract(source: Buffer | string): Promise<WordDocument>;
  }
}
