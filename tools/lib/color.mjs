// Color helpers (WCAG 2.2 relative luminance and contrast ratio). Node built-ins only.

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HEX3 = /^#[0-9a-fA-F]{3}$/;

/** True for a '#rrggbb' string (either case). */
export function isHex6(value) {
  return typeof value === 'string' && HEX6.test(value);
}

/** '#rgb' or '#rrggbb' -> [r, g, b] (0-255). Throws on anything else. */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') throw new TypeError(`hexToRgb: expected a string, got ${typeof hex}`);
  let h = hex.trim();
  if (HEX3.test(h)) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (!HEX6.test(h)) throw new Error(`hexToRgb: not a #rrggbb color: ${JSON.stringify(hex)}`);
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** [r, g, b] -> '#rrggbb' (lowercase; channels are rounded and clamped to 0-255). */
export function rgbToHex(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) throw new TypeError('rgbToHex: expected [r, g, b]');
  return '#' + rgb.slice(0, 3).map((c) => {
    const v = Math.max(0, Math.min(255, Math.round(Number(c))));
    if (!Number.isFinite(v)) throw new Error(`rgbToHex: bad channel ${c}`);
    return v.toString(16).padStart(2, '0');
  }).join('');
}

function toRgb(color) {
  return Array.isArray(color) ? color : hexToRgb(color);
}

function channel(c8) {
  const c = c8 / 255;
  // WCAG 2.2 uses 0.04045 (2.0 used 0.03928); no 8-bit value lies between them.
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance (0 = black, 1 = white) of a hex string or [r, g, b]. */
export function relLuminance(color) {
  const [r, g, b] = toRgb(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio (1..21) between two colors; order does not matter. */
export function contrast(a, b) {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Ratio rounded down to 2 decimals for display (never rounds a failing ratio up to a pass). */
export function formatRatio(ratio) {
  return (Math.floor(ratio * 100) / 100).toFixed(2);
}

/** '#rrggbb' + alpha (0-1) -> 'rgba(r, g, b, a)'. */
export function withAlpha(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  const a = Math.max(0, Math.min(1, Number(alpha)));
  return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
}
