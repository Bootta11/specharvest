/**
 * Regenerates every app icon from assets/icon-source.png (AI-generated, "tractor crawler"):
 * Android launcher (legacy, round, adaptive), notification silhouette and splash screens, plus the web
 * favicon, logo and touch icon. Run from client/: node scripts/make-icons.mjs
 *
 * Two kinds of source work:
 * - an opaque round badge (artwork inside a circle on a gradient): the gradient is extended to full bleed;
 * - a transparent cut-out (artwork only): it becomes the adaptive foreground over a solid ICON_BG colour.
 * ICON_SRC overrides the source path, e.g. ICON_SRC=/path/T07.png ICON_BG=#ffffff node scripts/make-icons.mjs
 * (ICON_BG="#3a3f47,#0b0c0e" gives a diagonal gradient; ICON_SCALE=0.7 enlarges the artwork on the launcher icon).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.ICON_SRC || `${CLIENT}/assets/icon-source.png`;
const RES = `${CLIENT}/android/app/src/main/res`;
const PUBLIC = `${CLIENT}/public`;

const cutout = !(await sharp(SRC).stats()).isOpaque;
const transparent = (size) => sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
const circleMask = (s) => Buffer.from(`<svg width="${s}" height="${s}"><circle cx="${s / 2}" cy="${s / 2}" r="${s / 2}"/></svg>`);

/**
 * Per source kind: `full(size)` square full-bleed icon, `adaptive(size)` the two adaptive layers, `logo` the round
 * logo (transparent outside the circle) and `splashArt` what the splash screen centres.
 */
const icon = cutout ? await cutoutIcon() : await badgeIcon();

async function cutoutIcon() {
  // One colour, or two comma-separated colours for a top-left → bottom-right gradient.
  const [from, to = from] = (process.env.ICON_BG || "#ffffff").split(",").map((c) => c.trim());
  const solid = (size) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/></svg>`));
  const art = async (size, f) => sharp(await transparent(size))
    .composite([{ input: await sharp(SRC).resize(Math.round(size * f), Math.round(size * f), { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(), gravity: "center" }])
    .png().toBuffer();
  const SCALE = Number(process.env.ICON_SCALE) || 0.6;
  const onBg = async (size, f) => solid(size).composite([{ input: await art(size, f) }]).png().toBuffer();
  const logoSquare = await onBg(1024, 0.74);
  return {
    full: (size) => onBg(size, 0.8),
    // ICON_SCALE: artwork box as a share of the adaptive canvas; 0.6 × the trimmed source (≈ 0.84) ≈ 50%, inside the 61% safe zone
    adaptive: async (size) => ({ background: await solid(size).png().toBuffer(), foreground: await art(size, SCALE) }),
    logo: await sharp(logoSquare).composite([{ input: circleMask(1024), blend: "dest-in" }]).png().toBuffer(),
    splashArt: await art(1024, 1),
  };
}

async function badgeIcon() {
  // Gradient background extrapolated from colours sampled just inside the circle, away from the artwork.
  const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };

  // The circle, with a soft edge so it melts into that background.
  const R = 506;
  const featherMask = await sharp(Buffer.from(`<svg width="1024" height="1024"><circle cx="512" cy="512" r="${R}" fill="#fff"/></svg>`)).blur(8).png().toBuffer();

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
  const adaptiveFull = await extended(0.72); // artwork ≈ 0.70 × 0.72 = 50% of the adaptive canvas — well inside the 61% safe zone
  const legacyFull = await extended(0.88);
  const logo = await sharp(SRC).composite([{ input: featherMask, blend: "dest-in" }]).png().toBuffer();
  return {
    full: (size) => sharp(legacyFull).resize(size, size).png().toBuffer(),
    // The whole picture is the background layer (seamless); the foreground layer is empty.
    adaptive: async (size) => ({ background: await sharp(adaptiveFull).resize(size, size).png().toBuffer(), foreground: await transparent(size) }),
    logo,
    splashArt: logo,
  };
}

const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(dens)) {
  const dir = `${RES}/mipmap-${d}`;
  const l = Math.round(48 * k), a = Math.round(108 * k);
  await sharp(await icon.full(l)).toFile(`${dir}/ic_launcher.png`);
  await sharp(await icon.full(l)).composite([{ input: circleMask(l), blend: "dest-in" }]).toFile(`${dir}/ic_launcher_round.png`);
  const layers = await icon.adaptive(a);
  await sharp(layers.background).toFile(`${dir}/ic_launcher_background.png`);
  await sharp(layers.foreground).toFile(`${dir}/ic_launcher_foreground.png`);
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

// Splash: the logo centred on the app's light background.
for (const dir of fs.readdirSync(RES).filter((x) => x.startsWith("drawable"))) {
  const file = `${RES}/${dir}/splash.png`;
  if (!fs.existsSync(file)) continue;
  const { width, height } = await sharp(file).metadata();
  const l = await sharp(icon.splashArt).resize(Math.round(Math.min(width, height) * 0.38)).png().toBuffer();
  await sharp({ create: { width, height, channels: 4, background: "#fafaf9" } }).composite([{ input: l, gravity: "center" }]).png().toFile(file + ".tmp");
  fs.renameSync(file + ".tmp", file);
}
// Web: the round logo (header, sign-in, favicon, browser notifications) and a full-bleed touch icon.
const round = (size) => sharp(icon.logo).resize(size, size).png();
await round(64).toFile(`${PUBLIC}/favicon.png`);
await round(256).toFile(`${PUBLIC}/logo.png`);
await round(192).toFile(`${PUBLIC}/icon-192.png`);
await sharp(await icon.full(180)).toFile(`${PUBLIC}/apple-touch-icon.png`);
console.log(`icons written (${cutout ? "cut-out" : "badge"} source)`);
