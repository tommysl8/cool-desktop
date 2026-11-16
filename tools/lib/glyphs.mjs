// The safe glyph set (measured in both TermMono and Consolas by the glyph gate): printable ASCII, box drawing
// U+2500-U+257F (rounded corners included) and the extras below. Everything else falls back to another font with
// another advance and breaks the character grid.
// Single source for tools/validate.mjs and tools/glyph-gate.mjs. Node built-ins only.

/** The allowed characters outside ASCII and box drawing. */
export const SAFE_EXTRA = [
  '▀', // upper half block
  '▄', // lower half block
  '█', // full block
  '▌', // left half block
  '▐', // right half block
  '░', // light shade
  '▒', // medium shade
  '▓', // dark shade
  '°', // degree sign
  '·', // middle dot
  '»', // right-pointing double angle quotation mark
  '›', // single right-pointing angle quotation mark
  '•', // bullet
  '←', // leftwards arrow
  '↑', // upwards arrow
  '→', // rightwards arrow
  '↓', // downwards arrow
  '∙', // bullet operator
  '≈', // almost equal to
  '±', // plus-minus sign
  '≡', // identical to
  '⌂', // house
  '☼', // white sun with rays
  '▸', // black right-pointing small triangle
  '●', // black circle
  '○', // white circle
].join('');

/** 'U+XXXX' (at least 4 upper-case hex digits) for a code point. */
export function hex(cp) {
  return 'U+' + Number(cp).toString(16).toUpperCase().padStart(4, '0');
}

/** True when ch is exactly one character from the safe set. Control characters are not glyphs. */
export function isSafeChar(ch) {
  if (typeof ch !== 'string' || ch.length === 0) return false;
  const cp = ch.codePointAt(0);
  if (ch.length !== (cp > 0xffff ? 2 : 1)) return false;
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp >= 0x2500 && cp <= 0x257f) return true;
  return SAFE_EXTRA.includes(ch);
}

/** Distinct unsafe characters in text as sorted 'U+XXXX' strings ([] when all are safe). Tabs and line breaks are layout. */
export function unsafeChars(text) {
  const seen = new Set();
  for (const ch of String(text == null ? '' : text)) {
    if (ch === '\n' || ch === '\r' || ch === '\t') continue;
    if (!isSafeChar(ch)) seen.add(ch.codePointAt(0));
  }
  return [...seen].sort((a, b) => a - b).map(hex);
}

/** Every safe character as one string: printable ASCII, then box drawing, then SAFE_EXTRA. */
export function allSafe() {
  let out = '';
  for (let cp = 0x20; cp <= 0x7e; cp++) out += String.fromCharCode(cp);
  for (let cp = 0x2500; cp <= 0x257f; cp++) out += String.fromCharCode(cp);
  return out + SAFE_EXTRA;
}
