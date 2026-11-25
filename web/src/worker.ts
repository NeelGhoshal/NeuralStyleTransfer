import { describe, ready, stylize } from "./engine";

export type Request =
  | { id: number; kind: "describe"; img: ImageData }
  | { id: number; kind: "stylize"; img: ImageData; look: ArrayLike<number> };

export type Reply =
  | { id: number; kind: "progress"; fraction: number }
  | { id: number; kind: "described"; look: Float32Array }
  | { id: number; kind: "stylized"; img: ImageData; ms: number; backend: string }
  | { id: number; kind: "error"; message: string };

const send = (r: Reply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(r, transfer);

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  const { id } = data;
  const progress = (_: string, fraction: number) => send({ id, kind: "progress", fraction });
  try {
    if (data.kind === "describe") {
      send({ id, kind: "described", look: await describe(data.img, progress) });
    } else {
      const t = performance.now();
      const img = await stylize(data.img, data.look, progress);
      send({ id, kind: "stylized", img, ms: performance.now() - t, backend: await ready() }, [img.data.buffer]);
    }
  } catch (e) {
    send({ id, kind: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
