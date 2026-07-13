export interface EncodingRule {
  pattern: string;
  encoding: string | null;
  line: number;
}

export interface EncodingRules {
  root: string;
  file: string | null;
  rules: readonly EncodingRule[];
}

export type BomKind = "utf-8" | "utf-16le" | "utf-16be" | null;
export type NewlineKind = "\r\n" | "\n" | "\r" | null;

export interface DecodedText {
  text: string;
  encoding: string;
  bom: BomKind;
  newline: NewlineKind;
}

export interface EncodeTextOptions {
  bom?: BomKind;
  newline?: NewlineKind;
}
