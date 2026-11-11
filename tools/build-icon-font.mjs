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
const PATH = `<path d="M165.29 165.29H517.36V400H400V282.65H165.29Z M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z M517.36 400H634.72V634.72H517.36Z"/>`;
const glyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="141.8 141.8 516.4 516.4">
${PATH}</svg>`;
// The status bar glyph has the logo at SMALL of the box: there the full-size glyph is larger than the text beside it.
// Both glyphs keep the same viewBox (the font scales each glyph by its viewBox), so the points are scaled, around the centre.
const SMALL = 0.75;
const small = (n) => 400 + (n - 400) * SMALL;

const font = new SVGIcons2SVGFontStream({ fontName: "pi-icons", normalize: false, fontHeight: 1000, log: () => {} });
let svgFont = "";
font.on("data", (d) => (svgFont += d));
font.on("end", () => {
  const ttf = svg2ttf(svgFont, { ts: 0 })  /* fixed timestamp → reproducible output */;
  fs.writeFileSync(OUT_WOFF, Buffer.from(ttf2woff(new Uint8Array(ttf.buffer)).buffer));
  console.log("wrote", OUT_WOFF);
});
// The three blocks of the logo, as points.
const BLOCKS = [
  [[165.29, 165.29], [517.36, 165.29], [517.36, 400], [400, 400], [400, 282.65], [165.29, 282.65]],
  [[165.29, 282.65], [282.65, 282.65], [282.65, 400], [400, 400], [400, 517.36], [282.65, 517.36], [282.65, 634.72], [165.29, 634.72]],
  [[517.36, 400], [634.72, 400], [634.72, 634.72], [517.36, 634.72]],
];
const d = (pts) => "M" + pts.map((p) => p.map((n) => +small(n).toFixed(2)).join(" ")).join("L") + "Z";
const smallGlyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="141.8 141.8 516.4 516.4">
<path d="${BLOCKS.map(d).join(" ")}"/></svg>`;

const glyphs = [
  [glyph, "\uE900", "pi-logo"],
  [smallGlyph, "\uE901", "pi-logo-small"],
];
if (process.argv.includes("--preview")) {
  // Print the glyphs as SVG, to look at them.
  for (const [svg, , name] of glyphs) console.log(`<!-- ${name} -->\n${svg}`);
  process.exit(0);
}
for (const [svg, unicode, name] of glyphs) {
  const s = Readable.from([svg]);
  s.metadata = { unicode: [unicode], name };
  font.write(s);
}
font.end();
