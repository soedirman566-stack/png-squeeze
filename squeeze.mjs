// squeeze.mjs — a lossless PNG recompressor: decode to RGBA, reduce the colour
// type when the pixels allow it exactly, filter every row adaptively, and
// deflate with the best of a fixed set of zlib configurations. Every choice is
// a function of the input bytes only, so runs are byte-for-byte repeatable.

import { deflateSync, inflateSync } from 'node:zlib';

/* ------------------------------------------------------------------ CRC-32 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ----------------------------------------------------------------- decoder */

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode any PNG the contest reads (8-bit, non-interlaced) to RGBA bytes. */
export function decodeToRgba(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      header = {
        width: view.getUint32(at + 8),
        height: view.getUint32(at + 12),
        depth: data[8],
        colourType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (!header || header.depth !== 8 || header.interlace !== 0) throw new Error('unsupported PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))), {
    maxOutputLength: height * (stride + 1) + 1,
  });
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    else if (ft === 2) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    else if (ft === 3) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error('bad filter ' + ft);
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = palette[e * 3]; rgba[d + 1] = palette[e * 3 + 1]; rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { rgba, width, height };
}

/* ---------------------------------------------------------------- analysis */

/**
 * One pass over the pixels: is the image grey? what alphas occur? how many
 * distinct RGBA quads (counted exactly up to 257, then just "many")? When
 * alpha is binary (only 0 and 255), do all transparent pixels share one RGB,
 * and does any opaque pixel use that same RGB?
 */
export function analyse(rgba) {
  const counts = new Map();
  let many = false;
  let grey = true;
  let alphaVaried = false;
  let alphaBinary = true;
  let seenTransparent = false;
  let seenOpaque = false;
  let transRgb = -1;
  let transRgbConflict = false;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];
    if (r !== g || g !== b) grey = false;
    if (a === 0) {
      seenTransparent = true;
      const rgb = (r << 16) | (g << 8) | b;
      if (transRgb === -1) transRgb = rgb;
      else if (transRgb !== rgb) transRgbConflict = true;
    } else if (a === 255) seenOpaque = true;
    else { alphaVaried = true; alphaBinary = false; }
    if (!many) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      const c = counts.get(key);
      if (c === undefined) {
        if (counts.size >= 256) { many = true; counts.clear(); }
        else counts.set(key, 1);
      } else counts.set(key, c + 1);
    }
  }
  if (seenTransparent && seenOpaque && transRgb >= 0 && !transRgbConflict && !alphaVaried) {
    // the tRNS trick needs the transparent RGB to be absent from opaque pixels
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] === 255 && ((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]) === transRgb) {
        transRgbConflict = true;
        break;
      }
    }
  }
  return {
    counts: many ? null : counts,
    grey,
    alphaVaried,
    alphaBinary: alphaBinary && seenTransparent,
    allOpaque: !seenTransparent && !alphaVaried,
    transRgb: transRgbConflict ? -1 : transRgb,
  };
}

/* ------------------------------------------------------- candidate encodings */

/** Palette plan: entries with alpha < 255 first (so tRNS stays short), each
 *  group ordered by `order` — descending frequency, or ascending luminance
 *  (neighbouring indices then name similar colours, which filters and the
 *  deflater both like). Returns samples + PLTE + tRNS bytes. */
function palettePlan(rgba, counts, order) {
  const entries = [...counts.entries()].map(([key, count]) => ({
    r: (key >>> 24) & 255, g: (key >>> 16) & 255, b: (key >>> 8) & 255, a: key & 255, count,
  }));
  const lum = (e) => 299 * e.r + 587 * e.g + 114 * e.b;
  entries.sort((x, y) => (x.a === 255) - (y.a === 255)
    || (order === 'luminance' ? lum(x) - lum(y) : y.count - x.count));
  const indexOf = new Map();
  entries.forEach((e, idx) => indexOf.set(((e.r << 24) | (e.g << 16) | (e.b << 8) | e.a) >>> 0, idx));
  const n = rgba.length / 4;
  const samples = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    samples[i] = indexOf.get(((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0);
  }
  const plte = new Uint8Array(entries.length * 3);
  entries.forEach((e, idx) => { plte[idx * 3] = e.r; plte[idx * 3 + 1] = e.g; plte[idx * 3 + 2] = e.b; });
  let trns = null;
  let lastAlpha = -1;
  entries.forEach((e, idx) => { if (e.a !== 255) lastAlpha = idx; });
  if (lastAlpha >= 0) {
    trns = new Uint8Array(lastAlpha + 1);
    entries.forEach((e, idx) => { if (idx <= lastAlpha) trns[idx] = e.a; });
  }
  return { colourType: 3, bpp: 1, samples, plte, trns };
}

function greySamples(rgba) {
  const n = rgba.length / 4;
  const out = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) out[i] = rgba[d];
  return out;
}

function greyAlphaSamples(rgba) {
  const n = rgba.length / 4;
  const out = new Uint8Array(n * 2);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += 2) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
  return out;
}

function rgbSamples(rgba) {
  const n = rgba.length / 4;
  const out = new Uint8Array(n * 3);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += 3) {
    out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2];
  }
  return out;
}

function trnsForRgb(rgb) {
  return Uint8Array.of(0, (rgb >> 16) & 255, 0, (rgb >> 8) & 255, 0, rgb & 255);
}

/** Every colour-type plan that reproduces the pixels exactly, cheapest first
 *  by raw size. The caller compresses each and keeps the smallest file. */
export function plansFor(rgba, info) {
  const plans = [];
  if (info.counts !== null) {
    plans.push(palettePlan(rgba, info.counts, 'count'));
    plans.push(palettePlan(rgba, info.counts, 'luminance'));
  }
  if (info.grey) {
    if (info.allOpaque) plans.push({ colourType: 0, bpp: 1, samples: greySamples(rgba), plte: null, trns: null });
    else if (info.alphaBinary && info.transRgb >= 0) {
      const g = (info.transRgb >> 16) & 255;
      plans.push({ colourType: 0, bpp: 1, samples: greySamples(rgba), plte: null, trns: Uint8Array.of(0, g) });
    } else if (info.alphaVaried || info.alphaBinary) {
      plans.push({ colourType: 4, bpp: 2, samples: greyAlphaSamples(rgba), plte: null, trns: null });
    }
  }
  if (info.allOpaque && !info.grey) {
    plans.push({ colourType: 2, bpp: 3, samples: rgbSamples(rgba), plte: null, trns: null });
  } else if (info.alphaBinary && info.transRgb >= 0 && !info.grey) {
    plans.push({ colourType: 2, bpp: 3, samples: rgbSamples(rgba), plte: null, trns: trnsForRgb(info.transRgb) });
  }
  if (plans.length === 0 || info.alphaVaried) {
    plans.push({ colourType: 6, bpp: 4, samples: rgba, plte: null, trns: null });
  }
  return plans;
}

/* ---------------------------------------------------------------- filtering */

function filterRowInto(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  else if (type === 2) for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  else if (type === 3) for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  else for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    out[i] = cur[i] - paeth(a, b, c);
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/** How many distinct adjacent byte pairs a row holds: rows whose bytes form
 *  few distinct pairs give the deflater long, repeated matches. */
function makePairCounter() {
  const seen = new Int32Array(65536);
  let stamp = 0;
  return (row) => {
    stamp++;
    let n = 0;
    for (let i = 1; i < row.length; i++) {
      const pair = (row[i - 1] << 8) | row[i];
      if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
    }
    return n;
  };
}

/**
 * The image's filtered data under one `choice`: a filter type 0..4 for
 * every row, 'minsum' / 'pairs' for per-row choice by that cost, or 'brute'
 * for per-row choice by actually deflating each trial row (filter byte
 * included) against the 32 KiB of stream already chosen, at level 4 — the
 * cost model that tracks the real deflater most closely. Ties go to the
 * lower filter type. Every choice is a function of the samples only.
 */
export function filterImage(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  if (typeof choice === 'number') {
    for (let y = 0; y < height; y++) {
      const cur = samples.subarray(y * stride, (y + 1) * stride);
      const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
      raw[y * (stride + 1)] = choice;
      filterRowInto(choice, cur, prev, bpp, raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    }
    return raw;
  }
  const trials = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const headed = Array.from({ length: 5 }, (_, t) => { const r = new Uint8Array(stride + 1); r[0] = t; return r; });
  const pairCost = makePairCounter();
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    let type = 0;
    let best = Infinity;
    if (choice === 'brute') {
      const before = raw.subarray(Math.max(0, at - 32768), at);
      const dict = before.length === 0 ? null : Buffer.from(before);
      for (let t = 0; t < 5; t++) {
        filterRowInto(t, cur, prev, bpp, headed[t].subarray(1));
        const opts = dict === null ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: dict };
        const cost = deflateSync(headed[t], opts).length;
        if (cost < best) { best = cost; type = t; }
      }
      raw.set(headed[type], at);
    } else {
      for (let t = 0; t < 5; t++) {
        filterRowInto(t, cur, prev, bpp, trials[t]);
        const cost = choice === 'pairs' ? pairCost(trials[t]) : signedSum(trials[t]);
        if (cost < best) { best = cost; type = t; }
      }
      raw[at] = type;
      raw.set(trials[type], at + 1);
    }
  }
  return raw;
}

/* ------------------------------------------------------------------ writing */

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function ihdr(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function pngFile(width, height, plan, zlibStream) {
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', ihdr(width, height, plan.colourType))];
  if (plan.plte) parts.push(chunk('PLTE', plan.plte));
  if (plan.trns) parts.push(chunk('tRNS', plan.trns));
  parts.push(chunk('IDAT', zlibStream), chunk('IEND', new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The same PNG with its IDAT payload replaced by another zlib stream. */
function swapIdat(png, stream) {
  const parts = [png.subarray(0, 8)];
  let at = 8;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  while (at < png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7]);
    parts.push(type === 'IDAT' ? chunk('IDAT', stream) : png.subarray(at, at + 12 + len));
    at += 12 + len;
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* ------------------------------------------------------------------ squeeze */

// The screening configuration (a fast level-6 pass that ranks the candidate
// streams), the final configuration the best streams are re-deflated with,
// and the alternates the champion is retried with. Smaller memLevel makes
// zlib flush blocks more often, which suits screenshots (their content
// changes character from region to region); which setting wins varies by
// image, so the finished size decides.
const SCREEN_CFG = { level: 6, memLevel: 8, strategy: 0 };
const FINAL_CFG = { level: 9, memLevel: 6, strategy: 0 };
const RETRY_CFGS = [
  { level: 9, memLevel: 7, strategy: 0 },
  { level: 9, memLevel: 8, strategy: 1 },
];
// The filterings screened for a plan. 'brute' (a deflate per trial row) is
// only run on multi-byte pixels, where rows are wide enough for its cost
// model to pay for its overhead; one-byte rows are decided by the cheap
// heuristics and the fixed filters.
const FILTER_CHOICES_WIDE = [0, 1, 2, 4, 'minsum', 'pairs', 'brute'];
const FILTER_CHOICES_NARROW = [0, 1, 2, 4, 'minsum', 'pairs'];

/**
 * The smallest exact PNG of the image we can build. Every colour-type plan
 * is filtered every way in its choice set and screened with a level-6
 * deflate; the two best streams are re-deflated at level 9, and the
 * champion is retried under RETRY_CFGS. All comparisons are on finished
 * byte counts, so the output is deterministic.
 */
export function squeezePng(rgba, width, height) {
  const info = analyse(rgba);
  const plans = plansFor(rgba, info);
  const screened = [];
  for (const plan of plans) {
    const choices = plan.bpp >= 2 ? FILTER_CHOICES_WIDE : FILTER_CHOICES_NARROW;
    for (const choice of choices) {
      const raw = filterImage(plan.samples, width, height, plan.bpp, choice);
      const size = deflateSync(raw, SCREEN_CFG).length;
      screened.push({ plan, raw, size });
    }
  }
  screened.sort((a, b) => a.size - b.size);
  let best = null;
  let bestRaw = null;
  for (const { plan, raw } of screened.slice(0, 3)) {
    const file = pngFile(width, height, plan, new Uint8Array(deflateSync(raw, FINAL_CFG)));
    if (best === null || file.length < best.length) { best = file; bestRaw = raw; }
  }
  for (const cfg of RETRY_CFGS) {
    const alt = swapIdat(best, new Uint8Array(deflateSync(bestRaw, cfg)));
    if (alt.length < best.length) best = alt;
  }
  return best;
}
