import "@fontsource-variable/familjen-grotesk";
import "./style.css";
import * as painter from "./client";
import { photos, styles, galleryFull, galleryThumb, type Source } from "./data";
import { mix } from "./mix";
import { loadImage, toCanvas, toImageData } from "./images";

type Kind = "photo" | "style";
type State = "ready" | "waiting" | "painting" | "failed";
interface Cell {
  photo: Source;
  style: Source;
  state: State;
  full?: string;
  thumb?: string;
  /** How the current image was made; undefined means it came pre-run. */
  made?: { ms: number; backend: string; strength: number; size: number };
  el?: HTMLTableCellElement;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const LOOK_SIZE = 256; // the describer was trained at this size; larger washes out colour
const CELL_SIZE = 512;
const SIZES = [384, 512, 768, 1024];
const MAX_SOURCE = 1600;

const list = { photo: photos, style: styles };
const cells = new Map<string, Cell>();
const removed = new Map<string, AbortController>();
/** A visitor's painting is "your painting" mid-sentence; titles keep their capitals. */
const titleOf = (p: Source, s: Source) => `${p.name} as ${s.own ? s.name.toLowerCase() : s.name}`;
const key = (p: Source, s: Source) => `${p.id}--${s.id}`;

for (const p of photos)
  for (const s of styles)
    cells.set(key(p, s), { photo: p, style: s, state: "ready", full: galleryFull(p.id, s.id), thumb: galleryThumb(p.id, s.id) });

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
}

/* ---------- table ---------- */

function head(src: Source, kind: Kind) {
  const th = h("th", { scope: kind === "photo" ? "row" : "col" });
  th.append(
    h("div", { className: "src" }, h("img", { src: src.thumb, alt: "" })),
    h("span", { className: "src-name" }, src.name),
  );
  if (src.own) {
    const b = h("button", { className: "remove", type: "button" }, "Remove");
    b.setAttribute("aria-label", `Remove ${src.name}`);
    b.onclick = () => remove(src, kind);
    th.append(b);
  }
  return th;
}

function corner() {
  const td = h("td", { className: "corner" });
  for (const [kind, text] of [["style", "Painting"], ["photo", "Photo"]] as const) {
    const b = h("button", { type: "button", className: `add add-${kind}` }, h("span", {}, "Add"), text);
    b.dataset.add = kind;
    td.append(b);
  }
  return td;
}

function paintCell(cell: Cell) {
  const { photo, style, el } = cell;
  if (!el) return;
  el.dataset.state = cell.state;
  const title = titleOf(photo, style);
  const b = h("button", { type: "button", className: "cell" });
  b.setAttribute(
    "aria-label",
    { ready: title, waiting: `${title}, waiting`, painting: `${title}, painting now`, failed: `${title}, failed. Try again` }[cell.state],
  );
  if (cell.thumb) b.append(h("img", { src: cell.thumb, alt: "", loading: "lazy", decoding: "async" }));
  else if (cell.state === "failed") b.append(h("span", {}, "Try again"));
  else b.append(h("span", {}, cell.state === "painting" ? "Painting" : "Waiting"));
  b.onclick = () => (cell.state === "failed" && !cell.thumb ? void fill(cell) : open(cell));
  const focused = el.contains(document.activeElement);
  el.replaceChildren(b);
  if (focused) b.focus({ preventScroll: true });
}

function render() {
  const top = h("tr", {}, corner(), ...styles.map((s) => head(s, "style")));
  $("thead").replaceChildren(top);
  $("tbody").replaceChildren(
    ...photos.map((p) =>
      h(
        "tr",
        {},
        head(p, "photo"),
        ...styles.map((s) => {
          const cell = cells.get(key(p, s))!;
          cell.el = h("td");
          paintCell(cell);
          return cell.el;
        }),
      ),
    ),
  );
  const table = $("table");
  table.style.setProperty("--cols", String(styles.length));
  words();
}

const ONES =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
function number(n: number): string {
  if (n < 20) return ONES[n];
  if (n > 99) return String(n);
  return TENS[Math.floor(n / 10) - 2] + (n % 10 ? `-${ONES[n % 10]}` : "");
}
function words() {
  const first = number(photos.length);
  $("h1").replaceChildren(
    h("span", {}, `${first[0].toUpperCase()}${first.slice(1)} photos, `),
    h("span", {}, `${number(styles.length)} paintings, `),
    h("span", {}, `${number(photos.length * styles.length)} results.`),
  );
}

// Point out which photo and painting the hovered cell is made from.
function point(e: Event) {
  const td = (e.target as HTMLElement).closest?.("td[data-state]") as HTMLTableCellElement | null;
  document.querySelectorAll("th.on").forEach((x) => x.classList.remove("on"));
  if (!td) return;
  (td.parentElement as HTMLTableRowElement).cells[0].classList.add("on");
  ($("thead tr") as HTMLTableRowElement).cells[td.cellIndex].classList.add("on");
}
$("table").addEventListener("pointerover", point);
$("table").addEventListener("focusin", point);
$("table").addEventListener("pointerleave", point);

/* ---------- running the network ---------- */

const imageOf = async (s: Source) => s.own ?? (await loadImage(s.full));

async function lookOf(s: Source, o: { urgent?: boolean; signal?: AbortSignal; onProgress?: (f: number) => void } = {}) {
  s.look ??= await painter.describe(toImageData(await imageOf(s), LOOK_SIZE), o);
  return s.look;
}

const blobUrl = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<string>((res, rej) =>
    c.toBlob((b) => (b ? res(URL.createObjectURL(b)) : rej(new Error("The result could not be saved."))), type, q),
  );

interface RunOptions {
  size: number;
  strength: number;
  urgent?: boolean;
  signal?: AbortSignal;
  onStart?: () => void;
  onProgress?: (f: number) => void;
}

async function run(cell: Cell, o: RunOptions) {
  let look = await lookOf(cell.style, o);
  if (o.strength < 1) look = mix(await lookOf(cell.photo, o), look, o.strength);
  const r = await painter.stylize(
    async () => ({ img: toImageData(await imageOf(cell.photo), o.size, 4), look }),
    o,
  );
  if (o.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const c = toCanvas(r.img);
  const old = [cell.full, cell.thumb];
  cell.full = await blobUrl(c, "image/png");
  cell.thumb = await blobUrl(toCanvas(toImageData(c, 420)), "image/jpeg", 0.85);
  for (const u of old) if (u?.startsWith("blob:")) URL.revokeObjectURL(u);
  cell.made = { ms: r.ms, backend: r.backend, strength: o.strength, size: o.size };
  return cell;
}

let failures = 0;
async function fill(cell: Cell) {
  const signal = signalFor(cell);
  cell.state = "waiting";
  paintCell(cell);
  try {
    await run(cell, {
      size: CELL_SIZE,
      strength: 1,
      signal,
      onStart: () => {
        cell.state = "painting";
        paintCell(cell);
        toast(leftText());
      },
      onProgress: (f) => toast(`Downloading the network: ${Math.round(f * 100)}%`),
    });
    cell.state = "ready";
  } catch (e) {
    if (signal.aborted) return;
    cell.state = "failed";
    failures++;
    console.error(e);
  }
  paintCell(cell);
  if (current === cell) show();
  const left = [...cells.values()].filter((c) => c.state === "waiting" || c.state === "painting").length;
  if (left) toast(leftText());
  else if (failures) {
    toast("Some squares couldn’t be painted. Check your connection, then select them to try again.", true);
    failures = 0;
  } else toast("");
}

function leftText() {
  const left = [...cells.values()].filter((c) => c.state === "waiting" || c.state === "painting").length;
  return left === 1 ? "Painting the last square" : `Painting, ${left} squares left`;
}

function signalFor(cell: Cell) {
  const a = [cell.photo, cell.style].filter((s) => s.own).map((s) => removed.get(s.id)!.signal);
  return a.length ? AbortSignal.any(a) : new AbortController().signal;
}

/* ---------- adding and removing images ---------- */

let ownCount = { photo: 0, style: 0 };

async function add(file: File, kind: Kind) {
  let bitmap: ImageBitmap;
  try {
    const raw = await createImageBitmap(file, { imageOrientation: "from-image" });
    if (Math.min(raw.width, raw.height) < 32) return toast("That image is too small. Use one at least 32 pixels wide and tall.", true);
    bitmap = await createImageBitmap(toCanvas(toImageData(raw, MAX_SOURCE)));
    raw.close();
  } catch {
    return toast(`“${file.name}” couldn’t be read as an image. Use a JPG, PNG or WebP file.`, true);
  }
  const n = ++ownCount[kind];
  const label = kind === "photo" ? "Your photo" : "Your painting";
  const src: Source = {
    id: `own-${kind}-${n}`,
    name: n > 1 ? `${label} ${n}` : label,
    credit: "Added by you",
    full: await blobUrl(toCanvas(toImageData(bitmap, 1024)), "image/jpeg", 0.92),
    thumb: await blobUrl(toCanvas(toImageData(bitmap, 420)), "image/jpeg", 0.85),
    own: bitmap,
  };
  removed.set(src.id, new AbortController());
  list[kind].unshift(src);
  const fresh: Cell[] = [];
  for (const other of kind === "photo" ? styles : photos) {
    const [photo, style] = kind === "photo" ? [src, other] : [other, src];
    const cell: Cell = { photo, style, state: "waiting" };
    cells.set(key(photo, style), cell);
    fresh.push(cell);
  }
  render();
  $(".table-wrap").scrollTo({ left: 0 });
  $("#table").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  toast(leftText());
  if (kind === "style") {
    // Measure the painting once, before its whole column is queued.
    try {
      await lookOf(src, { signal: removed.get(src.id)!.signal, onProgress: (f) => toast(`Reading your painting: ${Math.round(f * 100)}%`) });
    } catch (e) {
      console.error(e); // each cell retries and reports for itself
    }
    if (removed.get(src.id)!.signal.aborted) return;
  }
  // A row and column added together share a cell; only queue it once.
  for (const c of fresh) void fill(c);
}

function remove(src: Source, kind: Kind) {
  removed.get(src.id)?.abort();
  const arr = list[kind];
  arr.splice(arr.indexOf(src), 1);
  for (const [k, c] of cells)
    if (c.photo === src || c.style === src) {
      for (const u of [c.full, c.thumb]) if (u?.startsWith("blob:")) URL.revokeObjectURL(u);
      cells.delete(k);
    }
  URL.revokeObjectURL(src.full);
  URL.revokeObjectURL(src.thumb);
  src.own?.close();
  render();
  if (![...cells.values()].some((c) => c.state === "waiting" || c.state === "painting")) toast("");
}

const fileInput = $<HTMLInputElement>("#file");
let pending: Kind = "photo";
document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-add]");
  if (!b) return;
  pending = b.dataset.add as Kind;
  fileInput.value = "";
  fileInput.click();
});
fileInput.onchange = () => {
  const f = fileInput.files?.[0];
  if (f) void add(f, pending);
};

const drop = $("#drop");
let depth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
const endDrop = () => {
  depth = 0;
  drop.hidden = true;
  drop.querySelectorAll(".over").forEach((x) => x.classList.remove("over"));
};
addEventListener("dragenter", (e) => {
  if (!hasFiles(e) || viewer.open) return;
  depth++;
  drop.hidden = false;
});
addEventListener("dragleave", () => {
  if (depth && --depth === 0) endDrop();
});
addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const zone = (e.target as HTMLElement).closest?.("[data-drop]");
  drop.querySelectorAll("[data-drop]").forEach((z) => z.classList.toggle("over", z === zone));
});
addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const zone = (e.target as HTMLElement).closest?.<HTMLElement>("[data-drop]");
  const f = e.dataTransfer!.files[0];
  endDrop();
  if (f && zone) void add(f, zone.dataset.drop as Kind);
});

/* ---------- toast ---------- */

function toast(text: string, dismissible = false) {
  $("#toast").hidden = !text;
  $("#toast-text").textContent = text;
  $("#toast").classList.toggle("busy", !dismissible);
  $("#toast-close").hidden = !dismissible;
}
$("#toast-close").onclick = () => toast("");

/* ---------- viewer ---------- */

const viewer = $<HTMLDialogElement>("#viewer");
const strength = $<HTMLInputElement>("#v-strength");
const wipe = $<HTMLInputElement>("#v-wipe");
let current: Cell | undefined;
let running = false;

$("#v-sizes").append(
  ...SIZES.map((n) => {
    const i = h("input", { type: "radio", name: "size", value: String(n), checked: n === 768 });
    return h("label", {}, i, h("span", {}, String(n)));
  }),
);
const sizeInputs = () => [...document.querySelectorAll<HTMLInputElement>("#v-sizes input")];
const setSize = (n: number) => sizeInputs().forEach((i) => (i.checked = +i.value === n));

function open(cell: Cell) {
  current = cell;
  wipe.value = "0";
  strength.value = String(Math.round((cell.made?.strength ?? 1) * 100));
  setSize(cell.made?.size ?? (cell.full ? 768 : CELL_SIZE));
  show();
  if (!viewer.open) viewer.showModal();
  const own = cell.photo.own || cell.style.own;
  history.replaceState(null, "", own ? location.pathname : `#${key(cell.photo, cell.style)}`);
}

function status(text: string, busy = false) {
  const s = $("#v-status");
  s.textContent = text;
  s.classList.toggle("busy", busy);
}

function show() {
  const c = current;
  if (!c) return;
  $("#v-title").textContent = titleOf(c.photo, c.style);
  const pair = (label: string, s: Source) => [
    h("dt", {}, label),
    h("dd", {}, h("img", { src: s.thumb, alt: "" }), h("span", {}, h("b", {}, s.name), h("small", {}, s.credit))),
  ];
  $("#v-pair").replaceChildren(...pair("Photo", c.photo), ...pair("Painting", c.style));
  const after = $<HTMLImageElement>("#v-after");
  const before = $<HTMLImageElement>("#v-before");
  after.src = c.full ?? c.photo.full;
  after.alt = c.full ? `${c.photo.name} repainted in the style of ${c.style.name}` : `${c.photo.name}, not repainted yet`;
  before.src = c.photo.full;
  before.alt = "";
  $("#v-compare").classList.toggle("no-result", !c.full);
  const save = $<HTMLAnchorElement>("#v-save");
  save.hidden = !c.full;
  if (c.full) {
    save.href = c.full;
    save.download = `${c.photo.id}-${c.style.id}.${c.made ? "png" : "webp"}`;
  }
  drawWipe();
  drawStrength();
  if (!running) describeState();
}

function describeState() {
  const c = current!;
  if (c.state === "waiting" || c.state === "painting") status("In the queue. It will appear here when it’s done.", true);
  else if (!c.full) status("Not painted yet.");
  else if (c.made) {
    const where = c.made.backend === "webgl" ? "graphics card" : "processor";
    status(`Painted in ${(c.made.ms / 1000).toFixed(1)} s on your ${where}.`);
  } else status("Already painted. Change the strength or size and repaint to run it yourself.");
}

function drawWipe() {
  $("#v-compare").style.setProperty("--wipe", `${wipe.value}%`);
}
function drawStrength() {
  $("#v-strength-out").textContent = `${strength.value}%`;
}
wipe.oninput = drawWipe;
strength.oninput = drawStrength;

$<HTMLFormElement>("#v-form").onsubmit = async (e) => {
  e.preventDefault();
  const cell = current;
  if (!cell || running) return;
  running = true;
  const btn = $<HTMLButtonElement>("#v-run");
  btn.setAttribute("aria-disabled", "true");
  const say = (t: string) => current === cell && status(t, true);
  say("Starting. The first run takes longest.");
  let failed = "";
  try {
    await run(cell, {
      size: +(sizeInputs().find((i) => i.checked)?.value ?? CELL_SIZE),
      strength: +strength.value / 100,
      urgent: true,
      signal: signalFor(cell),
      onStart: () => say("Painting"),
      onProgress: (f) => say(f < 1 ? `Downloading the network: ${Math.round(f * 100)}%` : "Painting"),
    });
    cell.state = cell.state === "failed" ? "ready" : cell.state;
    wipe.value = "0";
  } catch (err) {
    console.error(err);
    failed = /fetch|network|load/i.test(String(err))
      ? "The network couldn’t be downloaded. Check your connection and repaint."
      : "This run failed. Choose a smaller size and repaint.";
  }
  running = false;
  btn.removeAttribute("aria-disabled");
  paintCell(cell);
  show();
  if (failed && current === cell) status(failed);
};

function step(kind: Kind, by: number) {
  if (!current) return;
  const arr = list[kind];
  const i = arr.indexOf(current[kind]);
  const next = arr[(i + by + arr.length) % arr.length];
  const photo = kind === "photo" ? next : current.photo;
  const style = kind === "style" ? next : current.style;
  open(cells.get(key(photo, style))!);
}
viewer.querySelectorAll<HTMLElement>("[data-step]").forEach((b) => (b.onclick = () => step(b.dataset.step as Kind, 1)));
viewer.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).matches("input") || e.ctrlKey || e.metaKey || e.altKey) return;
  const move = { ArrowRight: ["style", 1], ArrowLeft: ["style", -1], ArrowDown: ["photo", 1], ArrowUp: ["photo", -1] }[e.key];
  if (!move) return;
  e.preventDefault();
  step(move[0] as Kind, move[1] as number);
});
$("#v-close").onclick = () => viewer.close();
viewer.addEventListener("click", (e) => e.target === viewer && viewer.close());
viewer.addEventListener("close", () => {
  const el = current?.el?.querySelector<HTMLElement>("button");
  current = undefined;
  history.replaceState(null, "", location.pathname);
  el?.focus({ preventScroll: true });
});

/* ---------- start ---------- */

for (const s of [...photos, ...styles])
  $("#credits").append(
    h("li", {}, s.link ? h("a", { href: s.link }, s.name) : s.name, `, ${s.credit.replace(/^From/, "from")}`),
  );
render();
const linked = cells.get(location.hash.slice(1));
if (linked) open(linked);
