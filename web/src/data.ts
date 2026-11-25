import catalog from "./catalog.json";
import looks from "./looks.json";

export interface Source {
  id: string;
  name: string;
  credit: string;
  link?: string;
  full: string;
  thumb: string;
  /** 100 numbers describing the image's look. Missing until measured for user images. */
  look?: ArrayLike<number>;
  /** Present on images the visitor added. */
  own?: ImageBitmap;
}

type Entry = { id: string; name: string; credit: string; link?: string };
type Looks = { photos: Record<string, number[]>; styles: Record<string, number[]> };

const build = (kind: "photos" | "styles") =>
  (catalog[kind] as Entry[]).map(
    (e): Source => ({
      ...e,
      full: `/${kind}/${e.id}.jpg`,
      thumb: `/thumbs/${kind}-${e.id}.webp`,
      look: (looks as Looks)[kind][e.id],
    }),
  );

export const photos = build("photos");
export const styles = build("styles");
export const galleryFull = (photo: string, style: string) => `/gallery/${photo}--${style}.webp`;
export const galleryThumb = (photo: string, style: string) => `/thumbs/${photo}--${style}.webp`;
