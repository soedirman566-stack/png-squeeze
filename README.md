[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/soedirman566-stack/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/soedirman566-stack/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

# png-squeeze

A lossless PNG recompressor for the make.fun png-squeeze-01 bounty: each
1280×720 screenshot goes in as a stored RGBA PNG (~3.7 MB) and comes out as
the smallest valid PNG that decodes to exactly the same pixels — every
channel of every pixel, transparent pixels' colours included.

Approach, all of it exact and deterministic (choices depend only on the
input bytes, never on the clock):

- **Colour-type reduction.** One analysis pass over the pixels decides which
  encodings reproduce the image exactly: a palette (colour type 3, entries
  ordered so the tRNS chunk stays short) when at most 256 distinct RGBA
  quads occur; grey (type 0) or grey+alpha (type 4) for grey images; RGB
  (type 2) when alpha is uniformly opaque; and RGB/grey with a tRNS key
  when transparency is a single colour that no opaque pixel uses. RGBA
  (type 6) remains the fallback.
- **Filtering, screened.** Each encoding's rows are written under every
  fixed filter and under per-row adaptive choice — by the classic minimum
  sum of |signed bytes|, by fewest distinct adjacent byte pairs, and, for
  multi-byte pixels, by brute force: each trial row is deflated against
  the 32 KiB of stream already chosen and the cheapest kept. Unfiltered
  rows are a first-class candidate: on flat and transparent content they
  leave long byte runs that the deflater matches far better than any
  filtered form.
- **Deflate, two phases.** All candidate streams are screened with a fast
  level-6 deflate; the best three are re-deflated at level 9, and the
  champion is retried under alternate memLevel/strategy settings (small
  memLevel flushes blocks more often, which suits screenshots whose
  content changes character from region to region). The smallest finished
  file (IHDR, PLTE, tRNS, one IDAT, IEND — nothing else) is written out.

`main.ts` is the entrypoint; `squeeze.mjs` holds the codec and compressor.
Node 22, built-in modules only.
