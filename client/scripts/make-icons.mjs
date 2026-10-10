/**
 * Regenerates every app icon from assets/icon-source.png (AI-generated, "tractor crawler"):
 * Android launcher (legacy, round, adaptive), notification silhouette and splash screens, plus the web
 * favicon, logo and touch icon. Run from client/: node scripts/make-icons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = `${CLIENT}/assets/icon-source.png`;
const RES = `${CLIENT}/android/app/src/main/res`;
const PUBLIC = `${CLIENT}/public`;

// Gradient background extrapolated from colours sampled just inside the circle, away from the artwork.
const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
const px = (x, y) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
const grid = [[px(250, 250), px(512, 130), px(774, 250)], [px(110, 420), null, px(914, 420)], [px(250, 860), px(512, 900), px(774, 860)]];
grid[1][1] = grid[0][1].map((v, k) => Math.round((v + grid[2][1][k]) / 2));
const tiny = Buffer.from(grid.flat().flat());
const background = (size) => sharp(tiny, { raw: { width: 3, height: 3, channels: 3 } }).resize(size, size, { kernel: "cubic" }).png().toBuffer();

// The circle, with a soft edge so it melts into that background.
const R = 506;
const featherMask = await sharp(Buffer.from(`<svg width="1024" height="1024"><circle cx="512" cy="512" r="${R}" fill="#fff"/></svg>`)).blur(8).png().toBuffer();
const circle = await sharp(SRC).ensureAlpha().composite([{ input: featherMask, blend: "dest-in" }]).png().toBuffer();

/**
 * Square full-bleed image with the circle's artwork at `f` of the side: every pixel outside the circle repeats the
 * colour just inside the rim along the same radius, so the gradient continues with no visible edge.
 */
async function extended(f) {
  const C = Math.round(1024 / f), c = C / 2, rim = R * 0.93;
  const out = Buffer.alloc(C * C * 3);
  for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
    let dx = x - c, dy = y - c;
    const r = Math.hypot(dx, dy);
    if (r > rim) (dx *= rim / r), (dy *= rim / r);
    const [cr, cg, cb] = px(Math.min(1023, Math.max(0, Math.round(512 + dx))), Math.min(1023, Math.max(0, Math.round(512 + dy))));
    const o = (y * C + x) * 3;
    out[o] = cr; out[o + 1] = cg; out[o + 2] = cb;
  }
  return sharp(out, { raw: { width: C, height: C, channels: 3 } }).png().toBuffer();
}
const FG = 0.72; // artwork ≈ 0.70 × 0.72 = 50% of the adaptive canvas — well inside the 61% safe zone
const LEGACY = 0.88;
const adaptiveFull = await extended(FG);
const legacyFull = await extended(LEGACY);
const full = (size) => sharp(legacyFull).resize(size, size).png().toBuffer();
const transparent = (size) => sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();

const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const roundMask = (s) => Buffer.from(`<svg width="${s}" height="${s}"><circle cx="${s / 2}" cy="${s / 2}" r="${s / 2}"/></svg>`);
for (const [d, k] of Object.entries(dens)) {
  const dir = `${RES}/mipmap-${d}`;
  const l = Math.round(48 * k), a = Math.round(108 * k);
  await sharp(await full(l)).toFile(`${dir}/ic_launcher.png`);
  await sharp(await full(l)).composite([{ input: roundMask(l), blend: "dest-in" }]).toFile(`${dir}/ic_launcher_round.png`);
  // The whole picture is the background layer (seamless); the foreground layer is empty.
  await sharp(adaptiveFull).resize(a, a).toFile(`${dir}/ic_launcher_background.png`);
  await sharp(await transparent(a)).toFile(`${dir}/ic_launcher_foreground.png`);
}

// Notification icon: white tractor silhouette (Android shows only the alpha channel).
const tractor = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="#fff">
  <path d="M5 6h6.5a1 1 0 0 1 1 .8L13.4 11H16a1 1 0 0 1 1 1v3h-2.2a4.5 4.5 0 0 0-8.6 0H3.5a.5.5 0 0 1-.5-.5V12a1 1 0 0 1 1-1h1z M7 8v3h4.3l-.6-3z"/>
  <rect x="17.5" y="9.5" width="5" height="4.5" rx=".7"/><rect x="16.5" y="14" width="6.5" height="1.2" rx=".4"/>
  <circle cx="10.5" cy="16.5" r="3.2"/><circle cx="20" cy="17.6" r="1.8"/>
  <rect x="4.6" y="3.5" width="1.4" height="3.5" rx=".5"/></g>
  <circle cx="10.5" cy="16.5" r="1.2" fill="#000"/></svg>`);
const statSvg = await sharp(tractor, { density: 1200 }).png().toBuffer();
// punch the hub hole: anything dark becomes transparent
const statClean = await sharp(statSvg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
for (let i = 0; i < statClean.data.length; i += 4) if (statClean.data[i] < 128) statClean.data[i + 3] = 0;
const stat = await sharp(statClean.data, { raw: statClean.info }).png().toBuffer();
for (const [d, k] of Object.entries(dens)) await sharp(stat).resize(Math.round(24 * k)).toFile(`${RES}/drawable-${d}/ic_stat_specharvest.png`);

// Splash: the round logo centred on the app's light background.
const logo = await sharp(SRC).composite([{ input: featherMask, blend: "dest-in" }]).png().toBuffer();
for (const dir of fs.readdirSync(RES).filter((x) => x.startsWith("drawable"))) {
  const file = `${RES}/${dir}/splash.png`;
  if (!fs.existsSync(file)) continue;
  const { width, height } = await sharp(file).metadata();
  const l = await sharp(logo).resize(Math.round(Math.min(width, height) * 0.38)).png().toBuffer();
  await sharp({ create: { width, height, channels: 4, background: "#fafaf9" } }).composite([{ input: l, gravity: "center" }]).png().toFile(file + ".tmp");
  fs.renameSync(file + ".tmp", file);
}
// Web: the round logo (header, sign-in, favicon, browser notifications) and a full-bleed touch icon.
const round = (size) => sharp(logo).resize(size, size).png();
await round(64).toFile(`${PUBLIC}/favicon.png`);
await round(256).toFile(`${PUBLIC}/logo.png`);
await round(192).toFile(`${PUBLIC}/icon-192.png`);
await sharp(await full(180)).toFile(`${PUBLIC}/apple-touch-icon.png`);
console.log("icons written");
