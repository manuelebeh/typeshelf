// "Preview in your design": how the text selected in a design application is shown in the grid.
import type { DesignSelection, Face } from "./api";

/** The style of a family closest to the one used in the document: what gets applied. */
export function closestFace(faces: Face[], reference: Face): Face {
  const distance = (f: Face) =>
    Math.abs(f.weight - reference.weight) +
    (f.italic === reference.italic ? 0 : 1000) +
    Math.abs(f.width - reference.width) * 50 -
    (f.psName === reference.psName ? 1 : 0);
  return faces.reduce((best, f) => (distance(f) < distance(best) ? f : best));
}

/** The selected text on one line, as the cards show it. */
export const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}

/**
 * Inline CSS giving a preview the colour and letter spacing of the selection. A colour that
 * would not read on the card (`card`, `#rrggbb`) gets a backing of the opposite lightness.
 * The colour was checked by the backend to be `#rrggbb`.
 */
export function selectionCSS(selection: DesignSelection, card: string): string {
  let css = "";
  if (selection.tracking) css += `;letter-spacing:${selection.tracking / 1000}em`;
  const color = selection.color;
  if (!color) return css;
  css += `;color:${color}`;
  if (/^#[0-9a-f]{6}$/i.test(card) && contrast(color, card) < 3) {
    css += `;background:${luminance(color) < 0.18 ? "#f2f2f4" : "#1c1c1f"};border-radius:6px;padding-inline:8px`;
  }
  return css;
}
