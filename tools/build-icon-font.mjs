import pkg from "svgicons2svgfont"; const SVGIcons2SVGFontStream = pkg.SVGIcons2SVGFontStream ?? pkg;
import svg2ttf from "svg2ttf";
import ttf2woff from "ttf2woff";
import { Readable } from "node:stream";
import fs from "node:fs";

// Builds media/pi-icons.woff: an icon font holding a monochrome glyph of the pi.dev
// logo, contributed as the `pi-logo` product icon so terminals (which only show
// ThemeIcons in every location) can carry the logo. Run: npm run build:icons
const OUT_WOFF = "media/pi-icons.woff";

// Monochrome glyph of the official pi.dev logo (same three blocks, one path).
const glyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="141.8 141.8 516.4 516.4">
<path d="M165.29 165.29H517.36V400H400V282.65H165.29Z M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z M517.36 400H634.72V634.72H517.36Z"/></svg>`;

const font = new SVGIcons2SVGFontStream({ fontName: "pi-icons", normalize: false, fontHeight: 1000, log: () => {} });
let svgFont = "";
font.on("data", (d) => (svgFont += d));
font.on("end", () => {
  const ttf = svg2ttf(svgFont, { ts: 0 })  /* fixed timestamp → reproducible output */;
  fs.writeFileSync(OUT_WOFF, Buffer.from(ttf2woff(new Uint8Array(ttf.buffer)).buffer));
  console.log("wrote", OUT_WOFF);
});
const s = Readable.from([glyph]);
s.metadata = { unicode: ["\uE900"], name: "pi-logo" };
font.write(s);
font.end();
