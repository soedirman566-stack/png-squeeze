// png-squeeze: rewrite every screenshot in the input set as the smallest
// lossless PNG we can build. For each /input/<id>/image.png (a stored RGBA
// PNG of a 1280x720 screenshot) we decode it to pixels, reduce the PNG
// colour type whenever the pixels allow that exactly (palette for few
// colours, grey for grey images, RGB when alpha is all opaque, a tRNS key
// when transparency is a single colour), filter each row adaptively, and
// deflate at level 9 — keeping whichever exact encoding comes out fewest
// bytes. /output/<id>/image.png is the answer; the output directory is only
// ever created and written into, never cleared.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeToRgba, squeezePng } from './squeeze.mjs';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Answer every instance in the set, in sorted order so the run's work (and
// its outputs) never depend on directory listing order.
for (const id of readdirSync(INPUT_DIR).sort()) {
  const stored = new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png')));
  const { rgba, width, height } = decodeToRgba(stored);
  const squeezed = squeezePng(rgba, width, height);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), squeezed);
}
