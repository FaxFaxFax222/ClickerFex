import './remote.css';
import Peer, { type DataConnection } from 'peerjs';
import type { HostMsg, Key, RemoteMsg } from '../shared/protocol';
import { AimTracker, OneEuro, type Aim } from './aim';
import { keepAwake, normalizeCode, peerId, peerOptions, store } from '../shared/peer';

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const el = {
  connect: $<HTMLFormElement>('#connect'),
  codeInput: $<HTMLInputElement>('#code-input'),
  codeError: $('#code-error'),
  hostHint: $('#host-hint'),
  app: $('#app'),
  status: $('#status'),
  statusText: $('#status-text'),
  counter: $('#counter'),
  pad: $('#pad'),
  laserBtn: $<HTMLButtonElement>('#laser-btn'),
  laserLabel: $('#laser-label'),
  prev: $<HTMLButtonElement>('#prev'),
  next: $<HTMLButtonElement>('#next'),
  menu: $<HTMLDialogElement>('#menu'),
  menuBtn: $('#menu-btn'),
  menuCode: $('#menu-code'),
  padSens: $<HTMLInputElement>('#pad-sens'),
  padOut: $('#pad-out'),
  laserSens: $<HTMLInputElement>('#laser-sens'),
  laserOut: $('#laser-out'),
  laserToggle: $<HTMLInputElement>('#laser-toggle'),
  disconnect: $('#disconnect'),
  kbdBtn: $<HTMLButtonElement>('#kbd-btn'),
  kbd: $<HTMLDialogElement>('#kbd'),
  kbdClose: $('#kbd-close'),
  kbdText: $<HTMLTextAreaElement>('#kbd-text'),
  kbdSend: $('#kbd-send'),
  mic: $<HTMLButtonElement>('#mic'),
  micLabel: $('#mic-label'),
  micCaption: $('#mic-caption'),
};

const haptic = (ms = 12) => navigator.vibrate?.(ms);
const capture = (node: Element, id: number) => {
  try {
    node.setPointerCapture(id);
  } catch {
    /* pointer already gone */
  }
};

// ---------------------------------------------------------------- settings

const settings = {
  pad: Number(store.get('cfx.padSens') ?? 1.4),
  fov: Number(store.get('cfx.laserFov') ?? 30), // degrees the screen spans from the presenter
  laserToggle: store.get('cfx.laserToggle') === '1',
};

function bindSettings(): void {
  el.padSens.value = String(settings.pad);
  el.laserSens.value = String(settings.fov);
  el.laserToggle.checked = settings.laserToggle;
  const render = () => {
    el.padOut.textContent = `${settings.pad.toFixed(1)}×`;
    el.laserOut.textContent = `${settings.fov.toFixed(0)}°`;
    el.laserLabel.textContent = laserOn ? 'Láser activo' : settings.laserToggle ? 'Tocá para láser' : 'Mantené para láser';
  };
  el.padSens.addEventListener('input', () => {
    settings.pad = Number(el.padSens.value);
    store.set('cfx.padSens', el.padSens.value);
    render();
  });
  el.laserSens.addEventListener('input', () => {
    settings.fov = Number(el.laserSens.value);
    store.set('cfx.laserFov', el.laserSens.value);
    render();
  });
  el.laserToggle.addEventListener('change', () => {
    settings.laserToggle = el.laserToggle.checked;
    store.set('cfx.laserToggle', settings.laserToggle ? '1' : null);
    if (laserOn) setLaser(false);
    render();
  });
  renderLaserLabel = render;
  render();
}
let renderLaserLabel = () => {};

// ---------------------------------------------------------------- connection

const CODE_KEY = 'cfx.lastCode';
let code = '';
let peer: Peer | null = null;
let conn: DataConnection | null = null;
let connected = false;
let lastPong = 0;
let pingId = 0;
let redialTimer: number | undefined;
let aspect = 16 / 9;
let releaseWake: (() => void) | null = null;

function setStatus(text: string, tone: 'ok' | 'warn' | 'err'): void {
  el.status.dataset.tone = tone;
  el.statusText.textContent = text;
}

function send(msg: RemoteMsg): void {
  if (connected && conn?.open) conn.send(msg);
}

function start(newCode: string): void {
  code = newCode;
  store.set(CODE_KEY, code);
  history.replaceState(null, '', `#${code}`);
  el.connect.hidden = true;
  el.app.hidden = false;
  el.menuCode.textContent = `Vinculado a la computadora ${code}`;
  releaseWake ??= keepAwake();
  openPeer();
}

function stop(): void {
  clearTimeout(redialTimer);
  connected = false;
  conn?.close();
  conn = null;
  peer?.destroy();
  peer = null;
  releaseWake?.();
  releaseWake = null;
  store.set(CODE_KEY, null);
  history.replaceState(null, '', location.pathname);
  el.app.hidden = true;
  showConnect('');
}

function openPeer(): void {
  peer?.destroy();
  setStatus('Conectando…', 'warn');
  const p = new Peer(peerOptions());
  peer = p;
  p.on('open', () => dial());
  p.on('disconnected', () => {
    if (p === peer && !p.destroyed) window.setTimeout(() => !p.destroyed && p.reconnect(), 1000);
  });
  p.on('error', (err) => {
    if (p !== peer) return;
    const type = (err as { type?: string }).type;
    if (type === 'peer-unavailable') {
      setStatus(`Esperando a la computadora ${code}…`, 'warn');
      scheduleRedial(2000);
    } else if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      setStatus('Sin conexión. Reintentando…', 'err');
      window.setTimeout(() => p === peer && openPeer(), 2500);
    } else if (type === 'browser-incompatible') {
      setStatus('Navegador sin WebRTC', 'err');
    }
  });
}

function dial(): void {
  if (!peer || peer.destroyed || peer.disconnected) return;
  clearTimeout(redialTimer);
  conn?.close();
  const c = peer.connect(peerId(code), { reliable: true, serialization: 'json' });
  conn = c;
  c.on('open', () => {
    if (c !== conn) return;
    connected = true;
    lastPong = Date.now();
    setStatus('Conectado', 'ok');
    haptic(30);
    c.send({ t: 'hello', v: 1 } satisfies RemoteMsg);
  });
  c.on('data', (data) => {
    if (c !== conn) return;
    onHost(data as HostMsg);
  });
  const lost = () => {
    if (c !== conn) return;
    if (connected) setStatus('Reconectando…', 'warn');
    connected = false;
    scheduleRedial(1200);
  };
  c.on('close', lost);
  c.on('error', lost);
}

function scheduleRedial(ms: number): void {
  clearTimeout(redialTimer);
  redialTimer = window.setTimeout(dial, ms);
}

function onHost(msg: HostMsg): void {
  switch (msg.t) {
    case 'pong':
      lastPong = Date.now();
      break;
    case 'state':
      aspect = msg.aspect || aspect;
      el.counter.textContent = msg.mode === 'pdf' ? `${msg.page} / ${msg.total}` : msg.mode === 'agent' ? 'Modo sistema' : '';
      // Typing/dictation needs the desktop agent: only offered in system mode.
      el.kbdBtn.hidden = msg.mode !== 'agent';
      if (msg.mode !== 'agent' && el.kbd.open) closeKeyboard();
      setStatus(msg.mode === 'idle' ? 'Conectado · elegí un modo en la PC' : 'Conectado', 'ok');
      break;
  }
}

// Heartbeat: data channels can stay "open" long after the laptop disappears.
window.setInterval(() => {
  if (!connected) return;
  send({ t: 'ping', id: ++pingId });
  if (Date.now() - lastPong > 6000) {
    connected = false;
    setStatus('Reconectando…', 'warn');
    dial();
  }
}, 2000);

// Android suspends the page with the screen off; reconnect immediately on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && code && !connected) {
    if (!peer || peer.destroyed) openPeer();
    else if (peer.disconnected) peer.reconnect();
    else dial();
  }
  if (document.visibilityState === 'hidden') {
    if (laserOn) setLaser(false);
    if (listening) stopDictation();
    tracker.pause();
  }
});

// ---------------------------------------------------------------- buttons

function bindNav(button: HTMLButtonElement, k: 'next' | 'prev'): void {
  // pointerdown instead of click: ~100 ms less latency and no double-tap zoom delay.
  button.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    button.classList.add('pressed');
    haptic(k === 'next' ? 18 : 12);
    send({ t: 'key', k });
  });
  const up = () => button.classList.remove('pressed');
  button.addEventListener('pointerup', up);
  button.addEventListener('pointercancel', up);
  button.addEventListener('pointerleave', up);
}
bindNav(el.next, 'next');
bindNav(el.prev, 'prev');

// ---------------------------------------------------------------- touchpad

type Touch = { x: number; y: number; t: number };
const touches = new Map<number, Touch>();
let gesture = { start: 0, maxFingers: 0, travel: 0 };
const acc = { mx: 0, my: 0, scroll: 0 };

el.pad.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  capture(el.pad, e.pointerId);
  if (touches.size === 0) gesture = { start: performance.now(), maxFingers: 0, travel: 0 };
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
  gesture.maxFingers = Math.max(gesture.maxFingers, touches.size);
  el.pad.classList.add('active');
});

el.pad.addEventListener('pointermove', (e) => {
  const prev = touches.get(e.pointerId);
  if (!prev) return;
  const now = performance.now();
  const dx = e.clientX - prev.x;
  const dy = e.clientY - prev.y;
  const dt = Math.max(now - prev.t, 1);
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: now });
  gesture.travel += Math.hypot(dx, dy);

  if (touches.size === 1) {
    // Pointer acceleration: slow moves stay precise, fast flicks cross the screen.
    const speed = Math.hypot(dx, dy) / dt; // px per ms
    const gain = settings.pad * (1 + Math.min(speed * 1.6, 3));
    acc.mx += dx * gain;
    acc.my += dy * gain;
  } else if (touches.size === 2) {
    acc.scroll += dy / 2; // each finger reports; average them
  }
});

function endTouch(e: PointerEvent): void {
  if (!touches.delete(e.pointerId)) return;
  if (touches.size > 0) return;
  el.pad.classList.remove('active');
  const duration = performance.now() - gesture.start;
  if (gesture.travel < 10 && duration < 280) {
    send({ t: 'click', b: gesture.maxFingers >= 2 ? 'right' : 'left' });
    haptic(10);
    el.pad.classList.add('tap');
    window.setTimeout(() => el.pad.classList.remove('tap'), 120);
  }
}
el.pad.addEventListener('pointerup', endTouch);
el.pad.addEventListener('pointercancel', endTouch);

// ---------------------------------------------------------------- laser (absolute pointing)

let laserOn = false;
let center: Aim | null = null; // direction the phone pointed when the laser was pressed = screen centre
const fx = new OneEuro();
const fy = new OneEuro();
let pending: { x: number; y: number } | null = null;

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

const tracker = new AimTracker((aim) => {
  if (!laserOn) return;
  if (!center) center = aim;
  // Angle-to-screen mapping: the screen spans `fov` degrees horizontally from where you stand.
  const fovH = (settings.fov * Math.PI) / 180;
  const fovV = fovH / aspect;
  const now = performance.now();
  const x = fx.filter(0.5 - wrapPi(aim.yaw - center.yaw) / fovH, now);
  const y = fy.filter(0.5 - (aim.pitch - center.pitch) / fovV, now);
  pending = { x: Math.min(Math.max(x, 0), 1), y: Math.min(Math.max(y, 0), 1) };
});

function setLaser(on: boolean): void {
  if (on === laserOn) return;
  laserOn = on;
  center = null;
  pending = null;
  fx.reset();
  fy.reset();
  el.laserBtn.classList.toggle('on', on);
  renderLaserLabel();
  send({ t: 'laser', on });
  if (on) {
    haptic(20);
    window.setTimeout(() => {
      if (laserOn && !tracker.hasData) el.laserLabel.textContent = 'El sensor de orientación no envía datos';
    }, 1500);
  }
}

el.laserBtn.addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  capture(el.laserBtn, e.pointerId);
  const wantOn = settings.laserToggle ? !laserOn : true;
  if (wantOn && !(await tracker.start())) {
    el.laserLabel.textContent = 'Sin sensor de orientación';
    return;
  }
  setLaser(wantOn);
});
const laserUp = () => {
  if (!settings.laserToggle) setLaser(false);
};
el.laserBtn.addEventListener('pointerup', laserUp);
el.laserBtn.addEventListener('pointercancel', laserUp);
el.laserBtn.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------- send loop (one batch per frame)

function flush(): void {
  if (connected) {
    const mx = Math.trunc(acc.mx), my = Math.trunc(acc.my);
    if (mx || my) {
      send({ t: 'move', dx: mx, dy: my });
      acc.mx -= mx;
      acc.my -= my;
    }
    const sc = Math.trunc(acc.scroll);
    if (sc) {
      send({ t: 'scroll', dy: sc });
      acc.scroll -= sc;
    }
    if (laserOn && pending) {
      send({ t: 'lpos', x: +pending.x.toFixed(4), y: +pending.y.toFixed(4) });
      pending = null;
    }
  } else {
    acc.mx = acc.my = acc.scroll = 0;
  }
  requestAnimationFrame(flush);
}
requestAnimationFrame(flush);

// ---------------------------------------------------------------- type & dictate (system mode)

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};
const RecognitionCtor = ((window as unknown as Record<string, unknown>).SpeechRecognition ??
  (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as (new () => Recognition) | undefined;

let recognition: Recognition | null = null;
let dictatedSomething = false; // reset per sheet opening: a new text field starts without a leading space
let listening = false;

function renderMic(): void {
  el.mic.classList.toggle('listening', listening);
  el.micLabel.textContent = listening ? 'Escuchando… tocá para parar' : 'Tocá para dictar';
}

function startDictation(): void {
  if (!RecognitionCtor) return;
  if (!recognition) {
    const r = new RecognitionCtor();
    r.lang = navigator.language?.startsWith('es') ? navigator.language : 'es-AR';
    // Single-utterance sessions restarted on end: Chrome Android duplicates results in continuous mode.
    r.continuous = false;
    r.interimResults = true;
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0].transcript.trim();
        if (!text) continue;
        if (res.isFinal) {
          // Space goes before the next phrase, never before punctuation ("aplicación ," -> "aplicación,").
          const glue = dictatedSomething && !/^[,.;:!?)\]}»”…]/.test(text) ? ' ' : '';
          send({ t: 'text', s: glue + text });
          dictatedSomething = true;
          el.micCaption.textContent = `✓ ${text}`;
          haptic(15);
        } else {
          interim += text;
        }
      }
      if (interim) el.micCaption.textContent = interim;
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        listening = false;
        el.micCaption.textContent = 'Permiso de micrófono denegado (ajustes del sitio en Chrome)';
      } else if (e.error === 'network') {
        listening = false;
        el.micCaption.textContent = 'El dictado necesita conexión a internet';
      }
      renderMic();
    };
    r.onend = () => {
      if (listening) {
        try {
          r.start();
        } catch {
          listening = false;
          renderMic();
        }
      }
    };
    recognition = r;
  }
  listening = true;
  el.micCaption.textContent = '';
  try {
    recognition.start();
  } catch {
    /* already running */
  }
  renderMic();
}

function stopDictation(): void {
  listening = false;
  recognition?.stop();
  renderMic();
}

function openKeyboard(): void {
  dictatedSomething = false;
  el.kbd.showModal();
  if (!RecognitionCtor) {
    el.mic.hidden = true;
    el.micCaption.textContent = 'Dictado no disponible en este navegador: usá el micrófono del teclado del teléfono.';
  }
}

function closeKeyboard(): void {
  stopDictation();
  el.kbdText.blur();
  if (el.kbd.open) el.kbd.close();
}

function sendTyped(): void {
  const text = el.kbdText.value;
  if (!text) return;
  send({ t: 'text', s: text });
  el.kbdText.value = '';
  haptic(15);
}

el.kbdBtn.addEventListener('click', openKeyboard);
el.kbdClose.addEventListener('click', closeKeyboard);
el.kbd.addEventListener('close', stopDictation);
el.mic.addEventListener('click', () => (listening ? stopDictation() : startDictation()));
el.kbdSend.addEventListener('click', sendTyped);
el.kbdText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTyped();
  }
});
for (const btn of el.kbd.querySelectorAll<HTMLButtonElement>('[data-key]')) {
  btn.addEventListener('click', () => {
    send({ t: 'key', k: btn.dataset.key as Key });
    haptic(10);
  });
}

// ---------------------------------------------------------------- menu / connect screen

el.menuBtn.addEventListener('click', () => el.menu.showModal());
el.disconnect.addEventListener('click', () => {
  el.menu.close();
  stop();
});

function showConnect(prefill: string): void {
  el.connect.hidden = false;
  el.codeInput.value = prefill;
  el.hostHint.textContent = location.host;
  el.codeError.hidden = true;
  if (!prefill) el.codeInput.focus();
}

el.codeInput.addEventListener('input', () => {
  el.codeInput.value = el.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  el.codeError.hidden = true;
});

el.connect.addEventListener('submit', (e) => {
  e.preventDefault();
  const c = normalizeCode(el.codeInput.value);
  if (!c) {
    el.codeError.hidden = false;
    return;
  }
  el.codeInput.blur();
  start(c);
});

// Block the browser's own gestures (pull-to-refresh, pinch, long-press menus) on the control surface.
for (const type of ['touchmove', 'gesturestart', 'contextmenu'] as const) {
  el.app.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

// ---------------------------------------------------------------- boot

bindSettings();
const fromHash = normalizeCode(location.hash.slice(1));
if (fromHash) start(fromHash);
else showConnect(normalizeCode(store.get(CODE_KEY) ?? '') ?? '');
