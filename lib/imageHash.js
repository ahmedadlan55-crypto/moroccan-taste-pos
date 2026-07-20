/**
 * lib/imageHash.js — perceptual-hash helper for the image sourcing
 * pipeline (lib/image-sourcing-worker.js).
 *
 * Implements a real dHash (difference hash): decode the image, downscale
 * to 9x8 grayscale pixels, compare each pixel to its right-hand neighbor
 * (8 comparisons x 8 rows = 64 bits), pack into 16 hex chars — matches
 * the image_candidates.phash CHAR(16) column. Two images of the same
 * dish photographed/re-encoded differently typically land within a few
 * bits of Hamming distance of each other; unrelated images land near 32.
 *
 * Requires `sharp` for image decode + resize + grayscale + EXIF-strip.
 * `sharp` is NOT currently present in node_modules in this environment
 * (npm install was out of scope for this change) — it has been added to
 * package.json as a new dependency, and this module requires it lazily
 * and defensively so requiring this file never crashes the process; it
 * only throws IMAGE_DECODE_UNAVAILABLE when a hash is actually requested
 * before `npm install` has run. See isAvailable().
 *
 * Owner D — bilingual-i18n-images.
 */
'use strict';

let sharp = null;
try {
  // eslint-disable-next-line global-require
  sharp = require('sharp');
} catch (e) {
  sharp = null;
}

const HASH_W = 9; // one extra column so every row has 8 left-right pairs
const HASH_H = 8;

function isAvailable() {
  return !!sharp;
}

/**
 * Decode `buffer` (PNG/JPEG/WebP bytes), downscale to a tiny grayscale
 * bitmap, and compute a 64-bit dHash. Returns a 16-char lowercase hex
 * string. Throws IMAGE_DECODE_UNAVAILABLE if sharp isn't installed, or
 * the underlying decode error if the bytes aren't a decodable image.
 */
async function computeDHash(buffer) {
  if (!sharp) {
    throw new Error('IMAGE_DECODE_UNAVAILABLE: sharp is not installed (run npm install)');
  }
  const { data } = await sharp(buffer)
    .rotate() // apply EXIF orientation before resize, then strip metadata on output
    .resize(HASH_W, HASH_H, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = '';
  for (let y = 0; y < HASH_H; y++) {
    for (let x = 0; x < HASH_W - 1; x++) {
      const i = y * HASH_W + x;
      bits += data[i] < data[i + 1] ? '1' : '0';
    }
  }
  // 64 bits -> 16 hex chars
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/**
 * Re-encode `buffer` stripped of EXIF/metadata, normalized to a sane max
 * dimension. Used before persisting an approved candidate so nothing
 * ships a camera GPS tag or a 12MP source photo to the POS/menu UI.
 * Not required by the pending-review path in this worker, but exposed
 * for the (separately owned) approval/apply endpoint to reuse.
 */
async function reencodeStripped(buffer, mime) {
  if (!sharp) {
    throw new Error('IMAGE_DECODE_UNAVAILABLE: sharp is not installed (run npm install)');
  }
  let pipeline = sharp(buffer).rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true });
  if (mime === 'image/png') pipeline = pipeline.png({ compressionLevel: 9 });
  else if (mime === 'image/webp') pipeline = pipeline.webp({ quality: 85 });
  else pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
  return pipeline.toBuffer();
}

/** Hamming distance between two same-length hex strings (bit-level). */
function hammingDistanceHex(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { dist += x & 1; x >>= 1; }
  }
  return dist;
}

module.exports = {
  computeDHash,
  reencodeStripped,
  hammingDistanceHex,
  isAvailable
};
