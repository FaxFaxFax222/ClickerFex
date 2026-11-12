import './receiver.css';
import Peer, { type DataConnection } from 'peerjs';
import QRCode from 'qrcode';
import { AgentBridge } from './agent';
import { PdfDeck } from './pdf';
import { KeepAwakeInBackground } from './background';
import type { HostMsg, Mode, MotionMsg, RemoteMsg } from '../shared/protocol';
import { isHex, keyId, pairingNumber, proof, randomHex, sameHex, sha256Hex } from '../shared/auth';
import { keepAwake, motionChannel, newCode, normalizeCode, peerId, peerOptions, remoteUrl, store } from '../shared/peer';

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const el = {
  qr: $<HTMLCanvasElement>('#qr'),
  qrMini: $<HTMLCanvasElement>('#qr-mini'),
  code: $('#code'),
  codeMini: $('#code-mini'),
  pairHost: $('#pair-host'),
  peerStatus: $('#peer-status'),
  devices: $('#devices'),
  file: $<HTMLInputElement>('#file'),
  drop: $('#drop'),
  agentBtn: $<HTMLButtonElement>('#agent-btn'),
  agentStatus: $('#agent-status'),
  stage: $('#stage'),
  slide: $<HTMLCanvasElement>('#slide'),
  hud: $('#hud'),
  hudPage: $('#hud-page'),
  hudDevices: $('#hud-devices'),
  miniQr: $('#mini-qr'),
  laser: $('#laser'),
  cursor: $<SVGElement>('#vcursor'),
  toast: $('#toast'),
  rotate: $<HTMLButtonElement>('#rotate'),
  forget: $<HTMLButtonElement>('#forget'),
  approve: $('#approve'),
  approveName: $('#approve-name'),
  approveNumber: $('#approve-number'),
  approveYes: $<HTMLButtonElement>('#approve-yes'),
  approveNo: $<HTMLButtonElement>('#approve-no'),
};

function setStatus(node: HTMLElement, text: string, tone: 'ok' | 'warn' | 'off' | 'err'): void {
  node.dataset.tone = tone;
  node.querySelector('.status-text')!.textContent = text;
}

let toastTimer: number | undefined;
function toast(text: string): void {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.toast.hidden = true), 2600);
}

// ---------------------------------------------------------------- pairing

// The pairing code lives for one browser session: a reload keeps it (phones reconnect by themselves),
// closing the tab or the browser retires it, so a code seen or photographed earlier stops working.
const CODE_KEY = 'cfx.hostCode';
const session = {
  get(key: string): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* storage blocked: the code just changes on reload */
    }
  },
};
store.set(CODE_KEY, null); // older versions kept the code forever in localStorage
let code = normalizeCode(session.get(CODE_KEY) ?? '') ?? newCode();
let peer: Peer | null = null;
let idTakenRetries = 0;

/** A phone is obeyed only once `ok`: its secret is on the trusted list, or someone approved it on this computer. */
type PhoneMeta = {
  lastSeen: number;
  ok: boolean;
  name: string;
  nonce: string; // challenge sent to this connection
  commit: string; // hash of the key the phone may enrol with, received before it saw the nonce
  key: string; // offered by a phone that is waiting for approval
  number: string; // shown on both screens while it waits
  asking: boolean;
  askedAt: number;
  proved: boolean; // one proof attempt per connection
  lposSeq: number; // newest laser position applied
};
const conns = new Map<DataConnection, PhoneMeta>();

async function showCode(): Promise<void> {
  session.set(CODE_KEY, code);
  el.code.textContent = code.split('').join(' ');
  el.codeMini.textContent = code;
  el.pairHost.textContent = `${location.host}${import.meta.env.DEV ? '/remote.html' : '/remote'}`;
  const url = remoteUrl(code);
  const opts = { margin: 0, color: { dark: '#0b0b0c', light: '#ffffff' } };
  await QRCode.toCanvas(el.qr, url, { ...opts, width: 232 });
  await QRCode.toCanvas(el.qrMini, url, { ...opts, width: 160 });
}

function startPeer(): void {
  peer?.destroy();
  setStatus(el.peerStatus, 'Conectando al servidor de enlace…', 'warn');
  const p = new Peer(peerId(code), peerOptions());
  peer = p;

  p.on('open', () => {
    idTakenRetries = 0;
    setStatus(el.peerStatus, 'Listo para vincular', 'ok');
  });

  p.on('connection', (conn) => {
    conn.on('open', () => {
      conns.set(conn, { lastSeen: Date.now(), ok: false, name: '', nonce: '', commit: '', key: '', number: '', asking: false, askedAt: 0, proved: false, lposSeq: -1 });
      listenMotion(conn);
    });
    conn.on('data', (data) => {
      const meta = conns.get(conn);
      if (meta) meta.lastSeen = Date.now();
      handle(conn, data as RemoteMsg);
    });
    const drop = () => {
      const meta = conns.get(conn);
      if (!meta) return;
      conns.delete(conn);
      renderDevices();
      renderApproval();
      if (meta.ok && laser.on) route({ t: 'laser', on: false }); // phone vanished mid-laser: don't leave the dot on
    };
    conn.on('close', drop);
    conn.on('error', drop);
  });

  p.on('disconnected', () => {
    if (p !== peer || p.destroyed) return;
    setStatus(el.peerStatus, 'Reconectando…', 'warn');
    window.setTimeout(() => !p.destroyed && p.reconnect(), 1500);
  });

  p.on('error', (err) => {
    if (p !== peer) return;
    const type = (err as { type?: string }).type;
    if (type === 'unavailable-id') {
      // Usually our own previous tab/reload still registered on the broker. Wait, then rotate code.
      if (++idTakenRetries <= 2) {
        setStatus(el.peerStatus, 'Liberando código anterior…', 'warn');
        window.setTimeout(startPeer, 2500);
      } else {
        idTakenRetries = 0;
        code = newCode();
        void showCode();
        startPeer();
      }
      return;
    }
    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      setStatus(el.peerStatus, 'Sin conexión al servidor de enlace. Reintentando…', 'err');
      window.setTimeout(startPeer, 3000);
      return;
    }
    if (type === 'browser-incompatible') {
      setStatus(el.peerStatus, 'Este navegador no soporta WebRTC', 'err');
    }
  });
}

// PeerJS does not always notice a phone that vanished (screen off, Wi-Fi drop). Phones ping every 2 s.
window.setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [conn, meta] of conns) {
    if (now - meta.lastSeen > 7000) {
      conns.delete(conn);
      conn.close();
      changed = true;
    }
  }
  if (changed) {
    renderDevices();
    renderApproval();
  }
}, 2000);

function renderDevices(): void {
  const n = [...conns.values()].filter((m) => m.ok).length;
  setStatus(el.devices, n === 0 ? 'Sin teléfono vinculado' : n === 1 ? '1 teléfono vinculado' : `${n} teléfonos vinculados`, n ? 'ok' : 'off');
  el.hudDevices.textContent = n === 1 ? '1 teléfono' : `${n} teléfonos`;
  el.hudDevices.dataset.tone = n ? 'ok' : 'off';
}

function currentMode(): Mode {
  if (deck.total > 0) return 'pdf';
  if (agent.connected) return 'agent';
  return 'idle';
}

function stateMsg(): HostMsg {
  return {
    t: 'state',
    mode: currentMode(),
    page: deck.page,
    total: deck.total,
    aspect: window.innerWidth / window.innerHeight,
    tour: agent.version >= 2,
    fast: true,
    gestures: agent.version >= 4,
  };
}

function sendState(target?: DataConnection): void {
  const msg = stateMsg();
  if (target) target.send(msg);
  else for (const [c, meta] of conns) if (meta.ok) c.send(msg);
}

// ---------------------------------------------------------------- phone approval

const TRUSTED_KEY = 'cfx.trusted2';
const HOST_KEY = 'cfx.hostId';
const MAX_TRUSTED = 50;
const MAX_WAITING = 3;
store.set('cfx.trusted', null); // first scheme kept phone secrets that travelled on every connection

/** This computer's public id. Phones keep one key per id, so a new id makes every phone a stranger again. */
let hostId = store.get(HOST_KEY) ?? '';
if (!isHex(hostId, 32)) {
  hostId = randomHex(16);
  store.set(HOST_KEY, hostId);
}

type Trusted = Record<string, { k: string; name: string }>; // key id -> key

function trusted(): Trusted {
  try {
    const v: unknown = JSON.parse(store.get(TRUSTED_KEY) ?? '{}');
    return v && typeof v === 'object' ? (v as Trusted) : {};
  } catch {
    return {};
  }
}

async function trust(key: string, name: string): Promise<void> {
  const all = trusted();
  all[await keyId(key)] = { k: key, name };
  const ids = Object.keys(all);
  for (const old of ids.slice(0, Math.max(ids.length - MAX_TRUSTED, 0))) delete all[old];
  store.set(TRUSTED_KEY, JSON.stringify(all));
  renderTrusted();
}

function renderTrusted(): void {
  const n = Object.keys(trusted()).length;
  el.forget.hidden = n === 0;
  el.forget.textContent = n === 1 ? 'Olvidar 1 teléfono autorizado' : `Olvidar ${n} teléfonos autorizados`;
}

/** Phones waiting for a decision, in the order they asked (not the order they connected). */
const waiting = (): [DataConnection, PhoneMeta][] =>
  [...conns].filter(([, m]) => !m.ok && m.asking).sort((a, b) => a[1].askedAt - b[1].askedAt);

function admit(conn: DataConnection, meta: PhoneMeta): void {
  meta.ok = true;
  meta.asking = false;
  renderDevices();
  sendState(conn);
  toast('Teléfono conectado');
}

function reject(conn: DataConnection, state: 'denied' | 'unknown' = 'denied'): void {
  conn.send({ t: 'auth', state } satisfies HostMsg);
  conns.delete(conn);
  window.setTimeout(() => conn.close(), 300); // let the verdict reach the phone first
}

function onHello(conn: DataConnection, meta: PhoneMeta, msg: Extract<RemoteMsg, { t: 'hello' }>): void {
  if (meta.ok) {
    sendState(conn);
    return;
  }
  if (meta.nonce || !isHex(msg.commit, 64)) return; // one challenge per connection, only after the phone committed
  meta.commit = msg.commit;
  meta.name = (typeof msg.name === 'string' ? msg.name.replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 24) : '') || 'Un teléfono';
  meta.nonce = randomHex(16);
  conn.send({ t: 'challenge', host: hostId, nonce: meta.nonce } satisfies HostMsg);
}

/** A phone approved earlier: it must sign this connection's nonce and the code it dialled. */
async function onProve(conn: DataConnection, meta: PhoneMeta, msg: Extract<RemoteMsg, { t: 'prove' }>): Promise<void> {
  if (meta.ok || !meta.nonce || meta.proved) return;
  meta.proved = true;
  const entry = isHex(msg.kid, 16) && Object.hasOwn(trusted(), msg.kid) ? trusted()[msg.kid] : undefined;
  const good = !!entry && isHex(entry.k, 64) && isHex(msg.mac, 64) && sameHex(msg.mac, await proof(entry.k, meta.nonce, code));
  if (!conns.has(conn)) return; // gone while we were checking
  if (good) admit(conn, meta);
  else reject(conn, 'unknown');
}

/** A phone this computer has never approved: ask the person at the computer. */
async function onEnrol(conn: DataConnection, meta: PhoneMeta, msg: Extract<RemoteMsg, { t: 'enrol' }>): Promise<void> {
  if (meta.ok || !meta.nonce || meta.asking || meta.key || !isHex(msg.key, 64)) return;
  meta.key = msg.key; // one offer per connection
  const committed = sameHex(await sha256Hex(msg.key), meta.commit);
  const number = await pairingNumber(msg.key, meta.nonce, code);
  if (!conns.has(conn)) return; // gone while we were checking
  if (!committed || waiting().length >= MAX_WAITING) {
    reject(conn);
    return;
  }
  meta.number = number;
  meta.asking = true;
  meta.askedAt = performance.now();
  conn.send({ t: 'auth', state: 'pending' } satisfies HostMsg);
  renderApproval();
}

// The request on screen. A click decides this one and no other: a phone that asks later can never slide
// under a click meant for the request the person just checked.
let shown: DataConnection | null = null;
let armTimer: number | undefined;
const ARM_DELAY_MS = 1200;

function renderApproval(): void {
  const queue = waiting();
  const current = queue.find(([c]) => c === shown) ?? queue[0];
  el.approve.hidden = !current;
  if (!current) {
    shown = null;
    return;
  }
  const [conn, meta] = current;
  el.approveName.textContent = meta.name;
  el.approveNumber.textContent = meta.number;
  if (conn === shown) return;
  shown = conn;
  // A different request appeared: buttons stay dead for a moment so a click already on its way is not spent on it.
  el.approveYes.disabled = el.approveNo.disabled = true;
  clearTimeout(armTimer);
  armTimer = window.setTimeout(() => (el.approveYes.disabled = el.approveNo.disabled = false), ARM_DELAY_MS);
}

function decide(allow: boolean): void {
  const conn = shown;
  const meta = conn && conns.get(conn);
  if (!conn || !meta || meta.ok || !meta.asking || el.approveYes.disabled) return;
  shown = null;
  if (allow) {
    void trust(meta.key, meta.name);
    admit(conn, meta);
  } else {
    reject(conn);
  }
  renderApproval();
}
el.approveYes.addEventListener('click', () => decide(true));
el.approveNo.addEventListener('click', () => decide(false));

el.forget.addEventListener('click', () => {
  store.set(TRUSTED_KEY, null);
  hostId = randomHex(16); // phones still holding a key for the old id start over instead of proving to nobody
  store.set(HOST_KEY, hostId);
  renderTrusted();
  rotateCode(); // also drops the phones connected right now
  toast('Teléfonos olvidados: van a pedir permiso de nuevo');
});

/** New pairing code. Approved phones that are connected are told and follow by themselves. */
function rotateCode(): void {
  const next = newCode();
  for (const [c, meta] of conns) if (meta.ok) c.send({ t: 'code', code: next } satisfies HostMsg);
  code = next;
  void showCode();
  // Give the announcement time to leave before the old identity is torn down.
  window.setTimeout(() => {
    conns.clear();
    renderDevices();
    renderApproval();
    startPeer();
  }, 400);
}
el.rotate.addEventListener('click', () => {
  rotateCode();
  toast('Código nuevo: el anterior ya no sirve');
});

// ---------------------------------------------------------------- pointer overlays

const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
const laser = { on: false, x: 0.5, y: 0.5, rx: 0.5, ry: 0.5 };
let cursorTimer: number | undefined;

function showCursor(): void {
  el.cursor.classList.add('on');
  clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => el.cursor.classList.remove('on'), 2500);
}

function frame(): void {
  el.cursor.style.transform = `translate3d(${pointer.x}px, ${pointer.y}px, 0)`;
  if (laser.on) {
    // Light smoothing removes sensor jitter without perceptible lag at 60 fps.
    laser.rx += (laser.x - laser.rx) * 0.55;
    laser.ry += (laser.y - laser.ry) * 0.55;
    el.laser.style.transform = `translate3d(${laser.rx * window.innerWidth}px, ${laser.ry * window.innerHeight}px, 0)`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- command routing

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

function handle(conn: DataConnection, msg: RemoteMsg): void {
  const meta = conns.get(conn);
  if (!meta) return;
  if (msg.t === 'ping') conn.send({ t: 'pong', id: msg.id } satisfies HostMsg);
  else if (msg.t === 'hello') onHello(conn, meta, msg);
  else if (msg.t === 'prove') void onProve(conn, meta, msg);
  else if (msg.t === 'enrol') void onEnrol(conn, meta, msg);
  else if (meta.ok) route(msg); // nothing else is obeyed from a phone that was not approved
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Pointer motion on its own channel (see motionChannel). Same rule as everywhere: only from an approved phone. */
function listenMotion(conn: DataConnection): void {
  const ch = motionChannel(conn);
  if (!ch) return;
  ch.onmessage = (e) => {
    const meta = conns.get(conn);
    if (!meta?.ok || typeof e.data !== 'string') return;
    meta.lastSeen = Date.now();
    let msg: MotionMsg;
    try {
      msg = JSON.parse(e.data) as MotionMsg;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'move') {
      if (finite(msg.dx) && finite(msg.dy)) route({ t: 'move', dx: msg.dx, dy: msg.dy });
    } else if (msg.t === 'scroll') {
      if (finite(msg.dy)) route({ t: 'scroll', dy: msg.dy });
    } else if (msg.t === 'lpos') {
      if (!finite(msg.x) || !finite(msg.y) || !finite(msg.n) || msg.n <= meta.lposSeq) return; // arrived after a newer one
      meta.lposSeq = msg.n;
      route({ t: 'lpos', x: msg.x, y: msg.y });
    }
  };
}

function route(msg: Exclude<RemoteMsg, { t: 'hello' | 'ping' | 'prove' | 'enrol' }>): void {
  const mode = currentMode();
  const toAgent = mode === 'agent';
  switch (msg.t) {
    case 'key':
      if (toAgent) agent.send(msg);
      else if (msg.k === 'next' || msg.k === 'prev') navigate(msg.k === 'next' ? 1 : -1);
      break;
    case 'text':
    case 'hold':
    case 'switcher':
      if (toAgent) agent.send(msg);
      break;
    case 'move':
      if (toAgent) {
        agent.send(msg);
      } else {
        pointer.x = Math.min(Math.max(pointer.x + msg.dx, 0), window.innerWidth - 1);
        pointer.y = Math.min(Math.max(pointer.y + msg.dy, 0), window.innerHeight - 1);
        showCursor();
      }
      break;
    case 'click':
      if (toAgent) agent.send(msg);
      else virtualClick(msg.b);
      break;
    case 'scroll':
      if (toAgent) agent.send(msg);
      break;
    case 'laser':
      laser.on = msg.on;
      if (msg.on) {
        laser.x = laser.rx = 0.5;
        laser.y = laser.ry = 0.5;
      }
      if (toAgent) {
        agent.send(msg);
        if (msg.on) agent.send({ t: 'lpos', x: 0.5, y: 0.5 });
      } else {
        el.laser.classList.toggle('on', msg.on);
      }
      break;
    case 'lpos':
      laser.x = clamp01(msg.x);
      laser.y = clamp01(msg.y);
      if (toAgent) agent.send({ t: 'lpos', x: laser.x, y: laser.y });
      break;
  }
}

function navigate(delta: number): void {
  if (deck.total && deck.go(delta)) {
    renderPage();
    sendState();
  }
}

/** In PDF mode a click behaves like in a slideshow: left advances, right goes back; UI under the cursor gets the click. */
function virtualClick(button: 'left' | 'right'): void {
  showCursor();
  const target = document.elementFromPoint(pointer.x, pointer.y) as HTMLElement | null;
  if (target?.closest('#approve')) return; // approving a phone takes a person at the computer, not another phone
  const onSlide = !target || target === el.slide || target === el.stage || target === document.body;
  if (deck.total && onSlide) {
    navigate(button === 'left' ? 1 : -1);
  } else if (button === 'left') {
    target?.click();
  }
}

// ---------------------------------------------------------------- PDF mode

const deck = new PdfDeck(el.slide);
let releaseWake: (() => void) | null = null;

async function openPdf(file: File): Promise<void> {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    toast('Ese archivo no es un PDF');
    return;
  }
  try {
    await deck.open(await file.arrayBuffer());
  } catch (e) {
    console.error(e);
    toast('No se pudo abrir el PDF');
    return;
  }
  document.body.className = 'present';
  el.stage.hidden = false;
  el.hud.hidden = false;
  releaseWake ??= keepAwake();
  renderPage();
  renderAgent();
  sendState();
  pokeHud();
}

async function closePdf(): Promise<void> {
  await deck.close();
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  document.body.className = 'setup';
  el.stage.hidden = true;
  el.hud.hidden = true;
  el.miniQr.hidden = true;
  el.file.value = '';
  releaseWake?.();
  releaseWake = null;
  renderAgent();
  sendState();
}

function renderPage(): void {
  el.hudPage.textContent = `${deck.page} / ${deck.total}`;
}

el.file.addEventListener('change', () => {
  const f = el.file.files?.[0];
  if (f) void openPdf(f);
});
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    el.file.click();
  }
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.drop.classList.add('drag');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) el.drop.classList.remove('drag');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  el.drop.classList.remove('drag');
  const f = e.dataTransfer?.files?.[0];
  if (f) void openPdf(f);
});

let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    void deck.draw();
    sendState();
  }, 120);
});

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => toast('Pantalla completa bloqueada'));
}

let hudTimer: number | undefined;
function pokeHud(): void {
  document.body.classList.add('hud-on');
  clearTimeout(hudTimer);
  hudTimer = window.setTimeout(() => document.body.classList.remove('hud-on'), 2500);
}
window.addEventListener('mousemove', () => {
  if (deck.total) pokeHud();
});

$('#hud-fs').addEventListener('click', toggleFullscreen);
$('#hud-close').addEventListener('click', () => void closePdf());
$('#hud-qr').addEventListener('click', () => (el.miniQr.hidden = !el.miniQr.hidden));

window.addEventListener('keydown', (e) => {
  if (!deck.total || e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
    case ' ':
    case 'Enter':
      e.preventDefault();
      navigate(1);
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
    case 'Backspace':
      e.preventDefault();
      navigate(-1);
      break;
    case 'Home':
      navigate(-deck.total);
      break;
    case 'End':
      navigate(deck.total);
      break;
    case 'f':
    case 'F':
      toggleFullscreen();
      break;
    case 'q':
    case 'Q':
      el.miniQr.hidden = !el.miniQr.hidden;
      break;
  }
});

// ---------------------------------------------------------------- agent (system mode)

const AGENT_KEY = 'cfx.agent';
let agentWasConnected = false;
const background = new KeepAwakeInBackground();
const agent = new AgentBridge((connected) => {
  renderAgent();
  if (connected && !agentWasConnected) toast('Agente conectado: el teléfono controla esta computadora');
  agentWasConnected = connected;
  sendState();
});

function renderAgent(): void {
  if (agent.connected) {
    setStatus(el.agentStatus, deck.total ? 'Conectado (en pausa mientras hay un PDF abierto)' : 'Conectado', 'ok');
    el.agentBtn.textContent = 'Desconectar';
  } else if (agent.enabled) {
    setStatus(el.agentStatus, 'Buscando agente en localhost:8765…', 'warn');
    el.agentBtn.textContent = 'Cancelar';
  } else {
    setStatus(el.agentStatus, 'Desconectado', 'off');
    el.agentBtn.textContent = 'Conectar agente';
  }
}

el.agentBtn.addEventListener('click', () => {
  if (agent.enabled) {
    agent.disable();
    background.stop();
    store.set(AGENT_KEY, null);
  } else {
    agent.enable();
    background.start();
    store.set(AGENT_KEY, '1');
  }
  renderAgent();
});

// ---------------------------------------------------------------- boot

// Highlight the download that matches this computer.
const ua = navigator.userAgent;
const osLink = /Windows/.test(ua) ? '#dl-win' : /Mac OS X|Macintosh/.test(ua) ? '#dl-mac' : null;
if (osLink) $(osLink).classList.add('primary-os');

// Holding a Web Lock keeps Chrome from freezing this tab while it sits behind PowerPoint or another tab.
navigator.locks?.request('clickerfex-keepalive', () => new Promise<void>(() => {})).catch(() => {});

void showCode();
startPeer();
renderDevices();
renderTrusted();
if (store.get(AGENT_KEY) === '1') {
  agent.enable();
  background.start();
}
renderAgent();
window.addEventListener('beforeunload', () => peer?.destroy());
