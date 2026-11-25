// The style transfer network itself. Runs inside a worker (see worker.ts), and
// directly in a page for scripts/prerun.mjs.
//
// Two models, both from Magenta's arbitrary image stylization:
//   style        painting -> 100 numbers that describe its look
//   transformer  photo + those 100 numbers -> repainted photo
import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-webgl";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import { loadGraphModel, type GraphModel } from "@tensorflow/tfjs-converter";
import wasmUrl from "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url";
import wasmSimdUrl from "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url";
import wasmThreadedUrl from "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm?url";

export type ModelName = "style" | "transformer";
export type Progress = (model: ModelName, fraction: number) => void;

// The default im2col convolution needs a (9*9*32) x pixels texture for this
// model's outer layers, which overflows texture limits. Convolve directly.
tf.env().set("WEBGL_CONV_IM2COL", false);
// Pass tensor shapes as uniforms so a new image size reuses compiled shaders.
tf.env().set("WEBGL_USE_SHAPES_UNIFORMS", true);

const models: Partial<Record<ModelName, Promise<GraphModel>>> = {};
let backend: Promise<string> | undefined;

async function useWasm() {
  // Only one file is ever fetched; tfjs picks it by feature detection.
  setWasmPaths({
    "tfjs-backend-wasm.wasm": wasmUrl,
    "tfjs-backend-wasm-simd.wasm": wasmSimdUrl,
    "tfjs-backend-wasm-threaded-simd.wasm": wasmThreadedUrl,
  });
  if (!(await tf.setBackend("wasm"))) throw new Error("This browser supports neither WebGL nor WebAssembly.");
  return "wasm";
}

/** GPU when available, otherwise WebAssembly. */
export function ready(): Promise<string> {
  backend ??= (async () => {
    try {
      if (await tf.setBackend("webgl")) {
        await tf.ready();
        return "webgl";
      }
    } catch {
      // fall through to wasm
    }
    return useWasm();
  })();
  return backend;
}

async function model(name: ModelName, onProgress?: Progress) {
  await ready();
  models[name] ??= loadGraphModel(`${import.meta.env.BASE_URL}models/${name}/model.json`, {
    onProgress: (f) => onProgress?.(name, f),
  }).catch((e) => {
    delete models[name]; // allow a retry after a network failure
    throw e;
  });
  return models[name]!;
}

const toTensor = (img: ImageData) =>
  tf.tidy(() => {
    const rgb = tf.browser.fromPixels(img);
    return tf.expandDims(tf.div(tf.cast(rgb, "float32"), 255), 0) as tf.Tensor4D;
  });

/** Describe an image's look as 100 numbers. */
export async function describe(img: ImageData, onProgress?: Progress): Promise<Float32Array> {
  const net = await model("style", onProgress);
  const out = tf.tidy(() => net.predict(toTensor(img)) as tf.Tensor);
  const data = (await out.data()) as Float32Array;
  out.dispose();
  return data;
}

async function paint(img: ImageData, look: ArrayLike<number>, onProgress?: Progress) {
  const net = await model("transformer", onProgress);
  const out = tf.tidy(() => {
    const vec = tf.tensor4d(Array.from(look), [1, 1, 1, 100]);
    return tf.squeeze(net.predict([toTensor(img), vec]) as tf.Tensor, [0]) as tf.Tensor3D;
  });
  const [h, w] = out.shape;
  const rgb = await out.data();
  out.dispose();
  return { rgb, w, h };
}

/** Some mobile GPUs overflow at half precision and return flat or NaN output. */
function looksBroken(rgb: ArrayLike<number>) {
  let min = Infinity;
  let max = -Infinity;
  const step = Math.max(1, Math.floor(rgb.length / 4096));
  for (let i = 0; i < rgb.length; i += step) {
    const v = rgb[i];
    if (!Number.isFinite(v)) return true;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min < 0.02;
}

export async function stylize(img: ImageData, look: ArrayLike<number>, onProgress?: Progress): Promise<ImageData> {
  let res = await paint(img, look, onProgress);
  if (looksBroken(res.rgb) && (await ready()) === "webgl") {
    // Reload on the CPU and stay there.
    console.warn("WebGL returned an unusable image; switching to WebAssembly.");
    backend = useWasm();
    await backend;
    delete models.style;
    delete models.transformer;
    res = await paint(img, look, onProgress);
  }
  const { rgb, w, h } = res;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; j < px.length; i += 3, j += 4) {
    px[j] = rgb[i] * 255;
    px[j + 1] = rgb[i + 1] * 255;
    px[j + 2] = rgb[i + 2] * 255;
    px[j + 3] = 255;
  }
  return new ImageData(px, w, h);
}
