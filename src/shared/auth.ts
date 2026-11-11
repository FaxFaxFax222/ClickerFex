/**
 * Phone <-> computer recognition.
 *
 * When a phone is approved it hands the computer a random key made for that computer alone. From then on
 * the key never travels again: the phone proves it holds it by signing the computer's one-time nonce
 * together with the pairing code it dialled. A page that impersonates the computer therefore learns
 * nothing reusable, and cannot relay the proof either, because it cannot sit on the real computer's code.
 *
 * Approval itself is checked by eye: phone and computer each show a 4-digit number derived from the key,
 * the computer's nonce and the pairing code. The phone commits to its key (a hash, in `hello`) before it
 * sees the nonce, so someone sitting in the middle, or a second phone racing to be approved in the
 * owner's place, cannot steer its own number to match the one on the owner's phone.
 */

const HEX_RE = /^[0-9a-f]+$/;

export const isHex = (v: unknown, chars: number): v is string => typeof v === 'string' && v.length === chars && HEX_RE.test(v);

export function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hmacHex(keyHex: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', hexBytes(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Public label of a key, so the computer can find it without the key being sent. */
export const keyId = async (keyHex: string) => (await hmacHex(keyHex, 'clickerfex key id')).slice(0, 16);

export const proof = (keyHex: string, nonce: string, code: string) => hmacHex(keyHex, `clickerfex proof|${nonce}|${code}`);

export async function sha256Hex(hex: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', hexBytes(hex)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The number both screens show while a phone waits for approval. */
export async function pairingNumber(keyHex: string, nonce: string, code: string): Promise<string> {
  const mac = await hmacHex(keyHex, `clickerfex number|${nonce}|${code}`);
  return String(parseInt(mac.slice(0, 12), 16) % 10000).padStart(4, '0');
}

/** Compares without stopping at the first difference. */
export function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
