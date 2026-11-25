// One-at-a-time job queue in front of the worker. Jobs asked for in the viewer
// jump ahead of cells waiting to be filled in the table.
import type { Reply, Request } from "./worker";

type Result = Extract<Reply, { kind: "described" | "stylized" }>;
// Omit over a union has to be distributed by hand.
type Body = Request extends infer R ? (R extends Request ? Omit<R, "id"> : never) : never;

interface Job {
  body: () => Body | Promise<Body>;
  urgent: boolean;
  signal?: AbortSignal;
  onStart?: () => void;
  onProgress?: (fraction: number) => void;
  resolve: (r: Result) => void;
  reject: (e: unknown) => void;
}

let worker: Worker | undefined;
let seq = 0;
let busy = false;
const queue: Job[] = [];

function start() {
  worker ??= new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return worker;
}

async function ask(job: Job): Promise<Result> {
  const body = await job.body();
  const w = start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const done = () => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
    };
    const onMessage = ({ data }: MessageEvent<Reply>) => {
      if (data.id !== id) return;
      if (data.kind === "progress") return job.onProgress?.(data.fraction);
      done();
      if (data.kind === "error") reject(new Error(data.message));
      else resolve(data);
    };
    const onError = (e: ErrorEvent) => {
      done();
      w.terminate();
      worker = undefined;
      reject(new Error(e.message || "The painter stopped unexpectedly."));
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    w.postMessage({ ...body, id });
  });
}

async function pump() {
  if (busy) return;
  busy = true;
  for (let job = queue.shift(); job; job = queue.shift()) {
    if (job.signal?.aborted) {
      job.reject(new DOMException("Cancelled", "AbortError"));
      continue;
    }
    job.onStart?.();
    try {
      job.resolve(await ask(job));
    } catch (e) {
      job.reject(e);
    }
  }
  busy = false;
}

type Options = Pick<Job, "signal" | "onStart" | "onProgress"> & { urgent?: boolean };

function enqueue(body: Job["body"], { urgent = false, ...rest }: Options): Promise<Result> {
  return new Promise((resolve, reject) => {
    const job: Job = { body, urgent, resolve, reject, ...rest };
    const at = urgent ? queue.findIndex((j) => !j.urgent) : -1;
    if (at >= 0) queue.splice(at, 0, job);
    else queue.push(job);
    void pump();
  });
}

export async function describe(img: ImageData, o: Options = {}) {
  const r = await enqueue(() => ({ kind: "describe", img }), o);
  return (r as Extract<Result, { kind: "described" }>).look;
}

/** `input` is called only when the job reaches the front, so waiting jobs hold no pixels. */
export async function stylize(input: () => Promise<{ img: ImageData; look: ArrayLike<number> }>, o: Options = {}) {
  const r = await enqueue(async () => ({ kind: "stylize", ...(await input()) }), o);
  return r as Extract<Result, { kind: "stylized" }>;
}

export const waiting = () => queue.length;
