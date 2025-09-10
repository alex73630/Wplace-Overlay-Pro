import { createCanvas, canvasToBlob, blobToImage, loadImage } from './canvas';
import { MINIFY_SCALE, MINIFY_SCALE_SYMBOL, TILE_SIZE, MAX_OVERLAY_DIM } from './constants';
import { imageDecodeCache, overlayCache, tooLargeOverlays, paletteDetectionCache, baseMinifyCache, clearOverlayCache, overlayImageDataCache, LRUCache } from './cache';
import { showToast } from './toast';
import { config, saveConfig, type OverlayItem } from './store';
import { WPLACE_FREE, WPLACE_PAID, SYMBOL_TILES, SYMBOL_W, SYMBOL_H } from './palette';
import { getUpdateUI, ensureHook } from './hook';

// --- RLE Optimization: Types and Cache ---
type Run = { colorIndex: number; length: number };
type RLEData = Run[][];
const overlayRLECache = new LRUCache<string, RLEData>(50); // Cache for run-length encoded overlay data

const ALL_COLORS = [...WPLACE_FREE, ...WPLACE_PAID];
const colorIndexMap = new Map<string, number>();
ALL_COLORS.forEach((c, i) => colorIndexMap.set(c.join(','), i));

const LUT_SIZE = 32;
const LUT_SHIFT = 8 - Math.log2(LUT_SIZE);
const colorLUT = new Uint8Array(LUT_SIZE * LUT_SIZE * LUT_SIZE);
const symbolCache = new Map<number, OffscreenCanvas | HTMLCanvasElement>();

// (buildColorLUT, findColorIndexLUT, findClosestColorIndex, getPreRenderedSymbol functions are unchanged)
function buildColorLUT() {
  for (let r = 0; r < LUT_SIZE; r++) {
    for (let g = 0; g < LUT_SIZE; g++) {
      for (let b = 0; b < LUT_SIZE; b++) {
        const realR = (r << LUT_SHIFT) | ((1 << LUT_SHIFT) - 1);
        const realG = (g << LUT_SHIFT) | ((1 << LUT_SHIFT) - 1);
        const realB = (b << LUT_SHIFT) | ((1 << LUT_SHIFT) - 1);
        const index = findClosestColorIndex(realR, realG, realB);
        colorLUT[r * LUT_SIZE * LUT_SIZE + g * LUT_SIZE + b] = index;
      }
    }
  }
}
function findColorIndexLUT(r: number, g: number, b: number): number {
  const lutR = r >> LUT_SHIFT;
  const lutG = g >> LUT_SHIFT;
  const lutB = b >> LUT_SHIFT;
  return colorLUT[lutR * LUT_SIZE * LUT_SIZE + lutG * LUT_SIZE + lutB];
}
function findClosestColorIndex(r: number, g: number, b: number) {
  let minDistance = Infinity;
  let index = 0;
  for (let i = 0; i < ALL_COLORS.length; i++) {
    const color = ALL_COLORS[i];
    const distance = Math.sqrt(
      Math.pow(r - color[0], 2) +
      Math.pow(g - color[1], 2) +
      Math.pow(b - color[2], 2)
    )
    if (distance < minDistance) {
      minDistance = distance;
      index = i;
    }
  }
  return index;
}
function getPreRenderedSymbol(colorIndex: number): OffscreenCanvas | HTMLCanvasElement | null {
    const cachedSymbol = symbolCache.get(colorIndex);
    if (cachedSymbol) {
        return cachedSymbol;
    }

    if (colorIndex >= SYMBOL_TILES.length) return null;
    const scale = MINIFY_SCALE_SYMBOL;
    const canvas = createCanvas(scale, scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    if (!ctx) return null;
    const symbol = SYMBOL_TILES[colorIndex];
    const paletteColor = ALL_COLORS[colorIndex];
    ctx.fillStyle = `rgb(${paletteColor[0]}, ${paletteColor[1]}, ${paletteColor[2]})`;
    const centerX = (scale - SYMBOL_W) >> 1;
    const centerY = (scale - SYMBOL_H) >> 1;
    for (let sy = 0; sy < SYMBOL_H; sy++) {
        for (let sx = 0; sx < SYMBOL_W; sx++) {
            const bit_idx = sy * SYMBOL_W + sx;
            if ((symbol >>> bit_idx) & 1) {
                ctx.fillRect(sx + centerX, sy + centerY, 1, 1);
            }
        }
    }
    symbolCache.set(colorIndex, canvas);
    return canvas;
}

buildColorLUT();

// --- RLE Optimization: Function to generate RLE data from ImageData ---
function generateRLEData(imageData: ImageData, isPalettePerfect: boolean): RLEData {
    const { width, height, data } = imageData;
    const rleData: RLEData = [];

    for (let y = 0; y < height; y++) {
        const row: Run[] = [];
        let currentRun: Run | null = null;

        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];

            // Treat transparent or #deface as "no color" (index -1)
            const colorIndex = (a <= 128 || (r === 0xde && g === 0xfa && b === 0xce))
                ? -1
                : (isPalettePerfect ? (colorIndexMap.get(`${r},${g},${b}`) ?? -1) : findColorIndexLUT(r, g, b));

            if (currentRun && currentRun.colorIndex === colorIndex) {
                currentRun.length++;
            } else {
                if (currentRun) row.push(currentRun);
                currentRun = { colorIndex, length: 1 };
            }
        }
        if (currentRun) row.push(currentRun);
        rleData.push(row);
    }
    return rleData;
}


export function extractPixelCoords(pixelUrl: string) {
  try {
    const u = new URL(pixelUrl);
    const parts = u.pathname.split('/');
    const sp = new URLSearchParams(u.search);
    return {
      chunk1: parseInt(parts[3], 10),
      chunk2: parseInt(parts[4], 10),
      posX: parseInt(sp.get('x') || '0', 10),
      posY: parseInt(sp.get('y') || '0', 10)
    };
  } catch {
    return { chunk1: 0, chunk2: 0, posX: 0, posY: 0 };
  }
}
export function matchTileUrl(urlStr: string) {
  try {
    const u = new URL(urlStr, location.href);
    if (u.hostname !== 'backend.wplace.live' || !u.pathname.startsWith('/files/')) return null;
    const m = u.pathname.match(/\/(\d+)\/(\d+)\.png$/i);
    if (!m) return null;
    return { chunk1: parseInt(m[1], 10), chunk2: parseInt(m[2], 10) };
  } catch { return null; }
}
export function matchPixelUrl(urlStr: string) {
  try {
    const u = new URL(urlStr, location.href);
    if (u.hostname !== 'backend.wplace.live') return null;
    const m = u.pathname.match(/\/s0\/pixel\/(\d+)\/(\d+)$/);
    if (!m) return null;
    const sp = u.searchParams;
    return { normalized: `https://backend.wplace.live/s0/pixel/${m[1]}/${m[2]}?x=${sp.get('x')||0}&y=${sp.get('y')||0}` };
  } catch { return null; }
}
export function rectIntersect(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number) {
  const x = Math.max(ax, bx), y = Math.max(ay, by);
  const r = Math.min(ax + aw, bx + bw), b = Math.min(ay + ah, by + bh);
  const w = Math.max(0, r - x), h = Math.max(0, b - y);
  return { x, y, w, h };
}
function isPalettePerfectImage(img: HTMLImageElement): boolean {
  const key = img.src;
  const cached = paletteDetectionCache.get(key);
  if (cached !== undefined) return cached;
  const canvas = createCanvas(img.width, img.height) as any;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  if (!ctx) throw new Error('Failed to get 2D context');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
    if (a === 0) continue;
    if (r === 0xde && g === 0xfa && b === 0xce) continue;
    const colorKey = `${r},${g},${b}`;
    if (!colorIndexMap.has(colorKey)) {
      paletteDetectionCache.set(key, false);
      return false;
    }
  }
  paletteDetectionCache.set(key, true);
  return true;
}
export async function decodeOverlayImage(imageBase64: string | null) {
  if (!imageBase64) return null;
  const key = imageBase64;
  const cached = imageDecodeCache.get(key);
  if (cached) return cached;
  const img = await loadImage(imageBase64);
  imageDecodeCache.set(key, img);
  return img;
}
export function overlaySignature(ov: {
  imageBase64: string | null,
  pixelUrl: string | null,
  offsetX: number,
  offsetY: number,
  opacity: number,
}, isPalettePerfect?: boolean) {
  const imgKey = ov.imageBase64 ? `${ov.imageBase64.slice(0, 64)}:${ov.imageBase64.length}` : 'none';
  const perfectFlag = isPalettePerfect !== undefined ? (isPalettePerfect ? 'P' : 'I') : 'U';
  return [imgKey, ov.pixelUrl || 'null', ov.offsetX, ov.offsetY, ov.opacity, perfectFlag].join('|');
}
async function getCachedOverlayImageData(img: HTMLImageElement, overlayId: string): Promise<ImageData> {
  const cacheKey = `${overlayId}:${img.width}x${img.height}`;
  const cached = overlayImageDataCache.get(cacheKey);
  if (cached) return cached;
  const canvas = createCanvas(img.width, img.height) as any;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  if (!ctx) throw new Error('Failed to get 2D context');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  overlayImageDataCache.set(cacheKey, imageData);
  return imageData;
}


export async function buildOverlayDataForChunkUnified(
  ov: {
    id: string, name: string, enabled: boolean,
    imageBase64: string | null, pixelUrl: string | null,
    offsetX: number, offsetY: number, opacity: number
  },
  targetChunk1: number,
  targetChunk2: number,
  mode: 'behind' | 'above' | 'minify'
) {
  if (!ov?.enabled || !ov.imageBase64 || !ov.pixelUrl) return null;
  if (tooLargeOverlays.has(ov.id)) return null;

  const img = await decodeOverlayImage(ov.imageBase64);
  if (!img) return null;

  const wImg = img.width, hImg = img.height;
  if (wImg >= MAX_OVERLAY_DIM || hImg >= MAX_OVERLAY_DIM) {
    tooLargeOverlays.add(ov.id);
    showToast(`Overlay "${ov.name}" skipped: image too large (must be smaller than ${MAX_OVERLAY_DIM}×${MAX_OVERLAY_DIM}; got ${wImg}×${hImg}).`);
    return null;
  }

  const base = extractPixelCoords(ov.pixelUrl);
  if (!Number.isFinite(base.chunk1) || !Number.isFinite(base.chunk2)) return null;

  const drawX = (base.chunk1 * TILE_SIZE + base.posX + ov.offsetX) - (targetChunk1 * TILE_SIZE);
  const drawY = (base.chunk2 * TILE_SIZE + base.posY + ov.offsetY) - (targetChunk2 * TILE_SIZE);

  const isPalettePerfect = isPalettePerfectImage(img);
  const sig = overlaySignature(ov, isPalettePerfect);
  const cacheKey = `ov:${ov.id}|sig:${sig}|tile:${targetChunk1},${targetChunk2}|mode:${mode}:${config.minifyStyle}`;
  const cached = overlayCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (mode !== 'minify') {
    // This part for 'behind' and 'above' modes is unchanged
    const isect = rectIntersect(0, 0, TILE_SIZE, TILE_SIZE, drawX, drawY, wImg, hImg);
    if (isect.w === 0 || isect.h === 0) { overlayCache.set(cacheKey, null); return null; }
    const canvas = createCanvas(isect.w, isect.h) as any;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    if (!ctx) throw new Error('Failed to get 2D context');
    ctx.drawImage(img as any, isect.x - drawX, isect.y - drawY, isect.w, isect.h, 0, 0, isect.w, isect.h);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = `rgba(255, 255, 255, ${1 - ov.opacity})`;
    ctx.fillRect(0, 0, isect.w, isect.h);
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = `rgba(255, 255, 255, 1)`;
    ctx.fillRect(0, 0, isect.w, isect.h);
    const imageData = ctx.getImageData(0, 0, isect.w, isect.h);
    const result = { imageData, dx: isect.x, dy: isect.y, scaled: false };
    overlayCache.set(cacheKey, result);
    return result;

  } else { // --- RLE Optimized Minify Rendering ---
    const scale = config.minifyStyle === 'symbols' ? MINIFY_SCALE_SYMBOL : MINIFY_SCALE;
    const tileScaledW = TILE_SIZE * scale;
    const tileScaledH = TILE_SIZE * scale;
    const drawXScaled = Math.round(drawX * scale);
    const drawYScaled = Math.round(drawY * scale);
    const wImgScaled = wImg * scale;
    const hImgScaled = hImg * scale;

    const isect = rectIntersect(0, 0, tileScaledW, tileScaledH, drawXScaled, drawYScaled, wImgScaled, hImgScaled);
    if (isect.w === 0 || isect.h === 0) { overlayCache.set(cacheKey, null); return null; }

    // Get or generate RLE data for the overlay
    const rleCacheKey = `${ov.id}:${sig}`;
    let rleData = overlayRLECache.get(rleCacheKey);
    if (!rleData) {
        const originalImageData = await getCachedOverlayImageData(img, ov.id);
        rleData = generateRLEData(originalImageData, isPalettePerfect);
        overlayRLECache.set(rleCacheKey, rleData);
    }
    
    const outCanvas = createCanvas(isect.w, isect.h) as any;
    const outCtx = outCanvas.getContext('2d') as CanvasRenderingContext2D;
    if (!outCtx) throw new Error('Failed to get 2D context');

    // Calculate the range of source image rows to iterate over
    const startY = Math.max(0, Math.floor((isect.y - drawYScaled) / scale));
    const endY = Math.min(hImg, Math.ceil((isect.y + isect.h - drawYScaled) / scale));

    for (let y = startY; y < endY; y++) {
        const rowRLE = rleData[y];
        let currentX = 0;
        const outY = drawYScaled + y * scale - isect.y;

        for (const run of rowRLE) {
            if (run.colorIndex !== -1) {
                const runStartImgX = currentX;
                const runEndImgX = currentX + run.length;

                // Find intersection of this run with the visible tile area
                const visibleStartImgX = Math.max(runStartImgX, Math.floor((isect.x - drawXScaled) / scale));
                const visibleEndImgX = Math.min(runEndImgX, Math.ceil((isect.x + isect.w - drawXScaled) / scale));

                if (visibleEndImgX > visibleStartImgX) {
                    const visibleLength = visibleEndImgX - visibleStartImgX;
                    const outX = drawXScaled + visibleStartImgX * scale - isect.x;
                    
                    if (config.minifyStyle === 'symbols') {
                        const symbolCanvas = getPreRenderedSymbol(run.colorIndex);
                        if (symbolCanvas) {
                            const pattern = outCtx.createPattern(symbolCanvas, 'repeat');
                            if (pattern) {
                                outCtx.fillStyle = pattern;
                                // We need to translate the context so the pattern aligns with the grid
                                outCtx.save();
                                outCtx.translate(outX, outY);
                                outCtx.fillRect(0, 0, visibleLength * scale, scale);
                                outCtx.restore();
                            }
                        }
                    } else { // 'dots'
                        const color = ALL_COLORS[run.colorIndex];
                        outCtx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
                        const center = Math.floor(scale / 2);
                        for (let i = 0; i < visibleLength; i++) {
                            outCtx.fillRect(outX + i * scale + center, outY + center, 1, 1);
                        }
                    }
                }
            }
            currentX += run.length;
        }
    }
    
    const imageData = outCtx.getImageData(0, 0, isect.w, isect.h);
    const result = { imageData, dx: isect.x, dy: isect.y, scaled: true, scale };
    overlayCache.set(cacheKey, result);
    return result;
  }
}

// composeTileUnified is unchanged
export async function composeTileUnified(
  originalBlob: Blob,
  overlayDatas: Array<{ imageData: ImageData, dx: number, dy: number, scaled?: boolean } | null>,
  mode: 'behind' | 'above' | 'minify'
) {
  if (!overlayDatas || overlayDatas.length === 0) return originalBlob;
  const originalImage = await blobToImage(originalBlob) as any;
  if (mode === 'minify') {
    const scale = config.minifyStyle === 'symbols' ? MINIFY_SCALE_SYMBOL : MINIFY_SCALE;
    const w = originalImage.width, h = originalImage.height;
    const arrayBuffer = await originalBlob.arrayBuffer();
    const view = new DataView(arrayBuffer);
    const hash = view.getUint32(0, true) ^ view.getUint32(view.byteLength - 4, true);
    const baseCacheKey = `base:${originalBlob.size}:${hash}:${w}x${h}:${scale}:${config.minifyStyle}`;
    let scaledBaseImageData = baseMinifyCache.get(baseCacheKey);
    if (!scaledBaseImageData) {
      const baseCanvas = createCanvas(w * scale, h * scale) as any;
      const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      if (!baseCtx) throw new Error('Failed to get 2D context');
      baseCtx.imageSmoothingEnabled = false;
      baseCtx.drawImage(originalImage, 0, 0, w * scale, h * scale);
      scaledBaseImageData = baseCtx.getImageData(0, 0, w * scale, h * scale);
      baseMinifyCache.set(baseCacheKey, scaledBaseImageData);
    }
    const canvas = createCanvas(w * scale, h * scale) as any;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    if (!ctx) throw new Error('Failed to get 2D context');
    ctx.putImageData(scaledBaseImageData, 0, 0);
    for (const ovd of overlayDatas) {
      if (!ovd) continue;
      const temp = createCanvas(ovd.imageData.width, ovd.imageData.height) as any;
      const tctx = temp.getContext('2d') as CanvasRenderingContext2D;
      if (!tctx) continue;
      tctx.putImageData(ovd.imageData, 0, 0);
      ctx.drawImage(temp, ovd.dx, ovd.dy);
    }
    return await canvasToBlob(canvas);
  }
  const w = originalImage.width, h = originalImage.height;
  const canvas = createCanvas(w, h) as any;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  if (!ctx) throw new Error('Failed to get 2D context');
  const drawOverlays = () => {
    for (const ovd of overlayDatas) {
      if (!ovd) continue;
      const temp = createCanvas(ovd.imageData.width, ovd.imageData.height) as any;
      const tctx = temp.getContext('2d') as CanvasRenderingContext2D;
      if (!tctx) continue;
      tctx.putImageData(ovd.imageData, 0, 0);
      ctx.drawImage(temp, ovd.dx, ovd.dy);
    }
  };
  if (mode === 'behind') {
    drawOverlays();
    ctx.drawImage(originalImage, 0, 0);
  } else { // 'above'
    ctx.drawImage(originalImage, 0, 0);
    drawOverlays();
  }
  return await canvasToBlob(canvas);
}

export async function displayImageFromData(newOverlay: OverlayItem) {
  if (!config.overlays) {
    config.overlays = [];
  }
  config.overlays.push(newOverlay);
  await saveConfig();
  
  clearOverlayCache();
  overlayRLECache.clear();
  symbolCache.clear();
  ensureHook();

  const updateUI = getUpdateUI();
  if (updateUI) {
    updateUI();
  }
}