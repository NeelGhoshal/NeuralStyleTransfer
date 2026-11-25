// Runs every photo x painting pair through the site's own engine and saves the
// results, thumbnails and style vectors. Rerun after editing src/catalog.json.
//
//   npm i --no-save puppeteer-core && npm run prerun
//
// CHROME can point at a Chrome/Chromium binary. Style vectors come from Magenta's
// full Inception describer; the site ships the smaller one for visitors' own images.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { createServer } from "vite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");
const FULL =
  "https://raw.githubusercontent.com/reiinakano/arbitrary-image-stylization-tfjs/master/saved_model_style_inception_js/";
const chrome = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const catalog = JSON.parse(fs.readFileSync(path.join(root, "src/catalog.json"), "utf8"));
for (const d of ["gallery", "thumbs"]) fs.mkdirSync(path.join(pub, d), { recursive: true });

const server = await createServer({ root, server: { port: 5199 }, logLevel: "warn" });
await server.listen();
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-gpu", "--ignore-gpu-blocklist"],
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
page.on("console", (m) => ["error", "warn"].includes(m.type()) && console.log("page:", m.text()));
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.setRequestInterception(true);
page.on("request", async (req) => {
  const m = new URL(req.url()).pathname.match(/^\/models\/style\/(.+)$/);
  if (!m) return req.continue();
  const r = await fetch(FULL + m[1]);
  if (!r.ok) return req.abort();
  req.respond({
    body: Buffer.from(await r.arrayBuffer()),
    contentType: m[1].endsWith(".json") ? "application/json" : "application/octet-stream",
  });
});
await page.goto("http://localhost:5199/prerun.html");
await page.waitForFunction("window.isReady", { timeout: 60_000 });
console.log("backend:", await page.evaluate(() => window.engine.ready()));

const save = (file, dataUrl) => fs.writeFileSync(path.join(pub, file), Buffer.from(dataUrl.split(",")[1], "base64"));
const look = (url) => page.evaluate((u) => window.look(u, 256), url);
const resize = (src, max, q) => page.evaluate((s, m, q) => window.resize(s, m, q), src, max, q);

const looks = { photos: {}, styles: {} };
for (const kind of ["photos", "styles"])
  for (const { id } of catalog[kind]) {
    const url = `/${kind}/${id}.jpg`;
    looks[kind][id] = (await look(url)).map((n) => +n.toFixed(5));
    save(`thumbs/${kind}-${id}.webp`, await resize(url, 420, 0.82));
  }
fs.writeFileSync(path.join(root, "src/looks.json"), JSON.stringify(looks) + "\n");

for (const p of catalog.photos)
  for (const s of catalog.styles) {
    const t = Date.now();
    const png = await page.evaluate((u, l) => window.paintTo(u, l, 768), `/photos/${p.id}.jpg`, looks.styles[s.id]);
    save(`gallery/${p.id}--${s.id}.webp`, await resize(png, 768, 0.84));
    save(`thumbs/${p.id}--${s.id}.webp`, await resize(png, 420, 0.78));
    console.log(`${p.id} x ${s.id}: ${Date.now() - t} ms`);
  }
console.log("backend at end:", await page.evaluate(() => window.engine.ready()));
await browser.close();
await server.close();
process.exit(0);
