/**
 * Busy indicator, used wherever Pi is working (main chat, tree, toolbar).
 * The Pi logo uses three blocks that light up in turn (see `.spinner` in styles.css).
 * An SVG, not the π character: a font glyph sits low in its box, and the result changed with the font.
 */
export const SPINNER =
  `<svg class="spinner" viewBox="165 165 470 470" aria-hidden="true">` +
  `<path d="M165.29 165.29H517.36V400H400V282.65H165.29Z"/>` +
  `<path d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z"/>` +
  `<path d="M517.36 400H634.72V634.72H517.36Z"/>` +
  `</svg>`;

export const ACP_SPINNER =
  `<svg class="spinner acp-spinner" viewBox="0 0 16 16" aria-hidden="true">` +
  `<path d="M4.2 8a1.4 1.4 0 1 0-2.8 0 1.4 1.4 0 1 0 2.8 0"/>` +
  `<path d="M9.4 8a1.4 1.4 0 1 0-2.8 0 1.4 1.4 0 1 0 2.8 0"/>` +
  `<path d="M14.6 8a1.4 1.4 0 1 0-2.8 0 1.4 1.4 0 1 0 2.8 0"/>` +
  `</svg>`;
