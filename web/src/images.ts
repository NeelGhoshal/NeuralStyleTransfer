/** Draw any image source into ImageData with its long side at most `max`. */
export function toImageData(src: ImageBitmap | HTMLImageElement | HTMLCanvasElement, max: number, multiple = 1): ImageData {
  const sw = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
  const sh = src instanceof HTMLImageElement ? src.naturalHeight : src.height;
  const k = Math.min(1, max / Math.max(sw, sh));
  const fit = (n: number) => Math.max(16, Math.round((n * k) / multiple) * multiple);
  const c = document.createElement("canvas");
  c.width = fit(sw);
  c.height = fit(sh);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff"; // transparent PNGs get a white ground
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

export function toCanvas(d: ImageData) {
  const c = document.createElement("canvas");
  c.width = d.width;
  c.height = d.height;
  c.getContext("2d")!.putImageData(d, 0, 0);
  return c;
}

export async function loadImage(url: string) {
  const i = new Image();
  i.src = url;
  await i.decode();
  return i;
}
