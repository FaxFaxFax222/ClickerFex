import type { DataConnection, PeerOptions } from 'peerjs';

/** Namespace on the shared PeerJS broker. Bump if the protocol breaks. */
export const PEER_PREFIX = 'clickerfex-v1-';

// No 0/O/1/I/L: codes get read aloud and typed on phones.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;

export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export function normalizeCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!ALPHABET.includes(ch)) return null;
  return code;
}

export const peerId = (code: string) => PEER_PREFIX + code;

/**
 * Default: PeerJS public broker (signaling only; slide data goes peer-to-peer).
 * Self-host with `npx peerjs --port 9000` and set VITE_PEER_* to remove that dependency.
 */
export function peerOptions(): PeerOptions {
  const env = import.meta.env;
  const host = env.VITE_PEER_HOST as string | undefined;
  if (!host) return { debug: 1 };
  return {
    host,
    port: Number(env.VITE_PEER_PORT ?? 443),
    path: (env.VITE_PEER_PATH as string | undefined) ?? '/',
    secure: env.VITE_PEER_SECURE !== 'false',
    debug: 1,
  };
}

export function remoteUrl(code: string): string {
  const path = import.meta.env.DEV ? '/remote.html' : '/remote';
  return `${location.origin}${path}#${code}`;
}

export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* private mode: non-critical */
    }
  },
};

/** Keeps the screen awake. Re-acquired on tab focus because the browser drops it. */
export function keepAwake(): () => void {
  let lock: WakeLockSentinel | null = null;
  let active = true;
  const acquire = async () => {
    if (!active || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
    try {
      lock = await navigator.wakeLock.request('screen');
    } catch {
      /* denied or unsupported */
    }
  };
  const onVis = () => void acquire();
  document.addEventListener('visibilitychange', onVis);
  void acquire();
  return () => {
    active = false;
    document.removeEventListener('visibilitychange', onVis);
    void lock?.release();
    lock = null;
  };
}

/**
 * Second data channel on the same link, for pointer motion only. The main channel is ordered and
 * retransmits, so one lost Wi-Fi packet holds back everything behind it and the cursor stutters.
 * This one delivers whatever arrives, at once: a lost movement is replaced by the next one 16 ms later.
 * Both ends declare it with the same id, so nothing extra is negotiated.
 */
export function motionChannel(conn: DataConnection): RTCDataChannel | null {
  try {
    return conn.peerConnection.createDataChannel('cfx-motion', { negotiated: true, id: 100, ordered: false, maxRetransmits: 0 });
  } catch {
    return null; // the link works without it, on the main channel
  }
}
