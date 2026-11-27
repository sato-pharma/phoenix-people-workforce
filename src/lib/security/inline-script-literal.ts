/**
 * A value written into an inline `<script>` the server renders, as a JavaScript literal.
 *
 * `JSON.stringify` gives a valid literal, and this also writes `<`, `>`, the control characters and
 * the two line separators as escapes. JavaScript reads the escaped literal back as exactly the same
 * value, and the HTML around the script never sees a `</script>` or a `<!--` inside it.
 *
 * Every boot script's values today are constants with none of these characters, so their text is
 * unchanged byte for byte. This keeps that true for any value added later.
 */
const SCRIPT_UNSAFE: Record<string, string> = {
  "<": "\\u003C",
  ">": "\\u003E",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\0": "\\0",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export function inlineScriptLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/[<>\b\f\n\r\t\0\u2028\u2029]/g, (character) => SCRIPT_UNSAFE[character]);
}
