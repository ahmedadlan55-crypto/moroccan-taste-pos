'use strict';
// close/d-images — product image write validation. Storage stays a base64
// data-URL in menu.image_data (legacy-compatible, no new infra), but the write
// is no longer free-form: the ERP client downscales to ≤512px JPEG q0.8 before
// saving, so a decoded payload over 300KB — or anything that is not a
// JPEG/PNG/WebP data-URL — is a bug or abuse, never a legitimate save.
// '' (and null) still clear the image; absent leaves it untouched (PUT).
//
// Extracted verbatim out of routes/menu.js (bilingual-i18n-images / Owner C)
// so routes/product-images.js can reuse the exact same contract instead of a
// second, potentially-drifting copy.
const IMAGE_MAX_BYTES = 300 * 1024;
const IMAGE_DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
function imageDataError(imageData) {
  if (typeof imageData === 'undefined' || imageData === null || imageData === '') return null;
  if (typeof imageData !== 'string' || !IMAGE_DATA_URL_RE.test(imageData)) {
    return 'صيغة الصورة غير مدعومة — المسموح: JPEG أو PNG أو WebP بصيغة data:image/...;base64';
  }
  const b64 = imageData.slice(imageData.indexOf(',') + 1);
  const padding = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
  const decodedBytes = (b64.length * 3) / 4 - padding; // size math — no decode round-trip
  if (decodedBytes > IMAGE_MAX_BYTES) {
    return 'حجم الصورة كبير جدًا — الحد الأقصى 300 كيلوبايت بعد الضغط. صغِّر الصورة وأعد المحاولة';
  }
  return null;
}

module.exports = { IMAGE_MAX_BYTES, IMAGE_DATA_URL_RE, imageDataError };
