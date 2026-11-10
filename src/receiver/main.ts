import './receiver.css';
import Peer, { type DataConnection } from 'peerjs';
import QRCode from 'qrcode';
import { AgentBridge } from './agent';
import { PdfDeck } from './pdf';
import type { HostMsg, Mode, RemoteMsg } from '../shared/protocol';
import { keepAwake, newCode, normalizeCode, peerId, peerOptions, remoteUrl, store } from '../shared/peer';

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

const CODE_KEY = 'cfx.hostCode';
let code = normalizeCode(store.get(CODE_KEY) ?? '') ?? newCode();
let peer: Peer | null = null;
let idTakenRetries = 0;
const conns = new Map<DataConnection, { lastSeen: number }>();

async function showCode(): Promise<void> {
  store.set(CODE_KEY, code);
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
      conns.set(conn, { lastSeen: Date.now() });
      renderDevices();
      sendState(conn);
      toast('Teléfono conectado');
    });
    conn.on('data', (data) => {
      const meta = conns.get(conn);
      if (meta) meta.lastSeen = Date.now();
      handle(conn, data as RemoteMsg);
    });
    const drop = () => {
      if (conns.delete(conn)) renderDevices();
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
  if (changed) renderDevices();
}, 2000);

function renderDevices(): void {
  const n = conns.size;
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
  return { t: 'state', mode: currentMode(), page: deck.page, total: deck.total, aspect: window.innerWidth / window.innerHeight };
}

function sendState(target?: DataConnection): void {
  const msg = stateMsg();
  if (target) target.send(msg);
  else for (const c of conns.keys()) c.send(msg);
}

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
  const mode = currentMode();
  const toAgent = mode === 'agent';
  switch (msg.t) {
    case 'hello':
      sendState(conn);
      break;
    case 'ping':
      conn.send({ t: 'pong', id: msg.id } satisfies HostMsg);
      break;
    case 'key':
      if (toAgent) agent.send(msg);
      else navigate(msg.k === 'next' ? 1 : -1);
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
const agent = new AgentBridge((connected) => {
  renderAgent();
  if (connected) toast('Agente conectado: el teléfono controla esta computadora');
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
    store.set(AGENT_KEY, null);
  } else {
    agent.enable();
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
if (store.get(AGENT_KEY) === '1') agent.enable();
renderAgent();
window.addEventListener('beforeunload', () => peer?.destroy());
