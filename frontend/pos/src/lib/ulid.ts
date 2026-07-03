/**
 * ULID — Crockford base32, 48-bit time + 80-bit random, monotonic within the
 * same millisecond (random part incremented) so same-ms ids still sort in
 * generation order. Matches the server's ULID_RE (/^[0-9A-Za-z_-]{10,40}$/).
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford (no I,L,O,U)

let lastTime = -1;
let lastRandom: number[] = [];

function randomWords(): number[] {
  const bytes = new Uint8Array(10);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 10; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // 80 bits → 16 base32 digits (5 bits each)
  const digits: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      digits.push((acc >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  return digits.slice(0, 16);
}

function incrementRandom(digits: number[]): number[] {
  const out = digits.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] < 31) {
      out[i]++;
      return out;
    }
    out[i] = 0;
  }
  return out; // overflow wraps (astronomically unlikely within one ms)
}

export function ulid(now: number = Date.now()): string {
  let random: number[];
  if (now === lastTime) {
    random = incrementRandom(lastRandom);
  } else {
    random = randomWords();
  }
  lastTime = now;
  lastRandom = random;

  // 48-bit time → 10 base32 digits, most significant first.
  let t = now;
  const timeDigits = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeDigits[i] = ALPHABET[t % 32];
    t = Math.floor(t / 32);
  }
  return timeDigits.join("") + random.map((d) => ALPHABET[d]).join("");
}
