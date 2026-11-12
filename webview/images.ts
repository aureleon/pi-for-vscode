/**
 * Transcript images that load when they come near the view.
 *
 * A session can hold many screenshots (a tool reads a PNG of 1 MB or more). If the transcript gives
 * each one its data URL at once, a tab load parses and decodes all of them. Here an image gets its
 * data URL only when it comes within `MARGIN` of the view; an image in a closed item never loads.
 * The size comes from the header of the image data, so the layout does not move when it loads.
 */

/** Load an image when it is this near the view, so that it is ready when you scroll to it. */
const MARGIN = "1500px 0px";

export interface ImageData {
  mimeType: string;
  data: string;
}

export interface LazyImages {
  /** Give `img` the image `im`. It loads when it comes near the view. */
  set(img: HTMLImageElement, im: ImageData): void;
  dispose(): void;
}

export function createLazyImages(root: HTMLElement): LazyImages {
  const pending = new WeakMap<HTMLImageElement, ImageData>();
  const load = (img: HTMLImageElement) => {
    const im = pending.get(img);
    if (!im) return;
    pending.delete(img);
    img.src = `data:${im.mimeType};base64,${im.data}`;
  };
  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              observer!.unobserve(e.target);
              load(e.target as HTMLImageElement);
            }
          },
          { root, rootMargin: MARGIN },
        )
      : undefined;
  return {
    set(img, im) {
      img.decoding = "async";
      const size = imageSize(im.data);
      if (size) {
        img.width = size[0];
        img.height = size[1];
      }
      pending.set(img, im);
      if (observer) observer.observe(img);
      else load(img);
    },
    dispose() {
      observer?.disconnect();
    },
  };
}

/**
 * The width and height of a PNG, GIF, JPEG or WebP image, from the start of its base64 data.
 * Undefined for other formats. A JPEG with an EXIF rotation can show with the two sides swapped:
 * then the layout moves once when it loads.
 */
export function imageSize(base64: string): [number, number] | undefined {
  let b: string;
  try {
    // The JPEG size is after the EXIF data, which can be long. 64 KB of base64 (a multiple of 4) is 48 KB of data.
    b = atob(base64.slice(0, 65536));
  } catch {
    return undefined;
  }
  const u = (i: number) => b.charCodeAt(i);
  const ok = (w: number, h: number): [number, number] | undefined => (w > 0 && h > 0 ? [w, h] : undefined);
  if (b.startsWith("\x89PNG") && b.slice(12, 16) === "IHDR") {
    return ok(((u(16) << 24) | (u(17) << 16) | (u(18) << 8) | u(19)) >>> 0, ((u(20) << 24) | (u(21) << 16) | (u(22) << 8) | u(23)) >>> 0);
  }
  if (b.startsWith("GIF8")) return ok(u(6) | (u(7) << 8), u(8) | (u(9) << 8));
  if (b.startsWith("RIFF") && b.slice(8, 12) === "WEBP") {
    const chunk = b.slice(12, 16);
    if (chunk === "VP8X") return ok(1 + (u(24) | (u(25) << 8) | (u(26) << 16)), 1 + (u(27) | (u(28) << 8) | (u(29) << 16)));
    if (chunk === "VP8 ") return ok((u(26) | (u(27) << 8)) & 0x3fff, (u(28) | (u(29) << 8)) & 0x3fff);
    if (chunk === "VP8L") return ok(1 + (((u(22) & 0x3f) << 8) | u(21)), 1 + (((u(24) & 0xf) << 10) | (u(23) << 2) | ((u(22) & 0xc0) >> 6)));
    return undefined;
  }
  if (u(0) === 0xff && u(1) === 0xd8) {
    // JPEG: walk the segments to the first start of frame (SOF0–SOF15, except DHT, JPG and DAC).
    let i = 2;
    while (i + 9 < b.length) {
      if (u(i) !== 0xff) return undefined;
      const marker = u(i + 1);
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return ok((u(i + 7) << 8) | u(i + 8), (u(i + 5) << 8) | u(i + 6));
      }
      i += 2 + ((u(i + 2) << 8) | u(i + 3));
    }
  }
  return undefined;
}
