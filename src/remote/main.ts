import './remote.css';
import Peer, { type DataConnection } from 'peerjs';
import type { HoldKey, HostMsg, Key, Mode, RemoteMsg } from '../shared/protocol';
import { AimTracker, OneEuro, motionPermissionPending, requestMotionPermission, type Aim } from './aim';
import { isHex, keyId, pairingNumber, proof, randomHex, sha256Hex } from '../shared/auth';
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
  padFlash: $('#pad-flash'),
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
  menuClose: $('#menu-close'),
  tourSwap: $<HTMLInputElement>('#tour-swap'),
  lookSpeed: $<HTMLInputElement>('#look-speed'),
  lookOut: $('#look-out'),
  modeClicker: $<HTMLButtonElement>('#mode-clicker'),
  modeTour: $<HTMLButtonElement>('#mode-tour'),
  clicker: $('#clicker'),
  tour: $('#tour'),
  tourNotice: $('#tour-notice'),
  look: $('#look'),
  walk: $('#walk'),
  zoom: $('#zoom'),
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
  tourSwap: store.get('cfx.tourSwap') === '1',
  look: Number(store.get('cfx.lookSpeed') ?? 0.5), // share of Matterport's full turning speed
};

function bindSettings(): void {
  el.padSens.value = String(settings.pad);
  el.laserSens.value = String(settings.fov);
  el.laserToggle.checked = settings.laserToggle;
  const render = () => {
    el.padOut.textContent = `${settings.pad.toFixed(1)}×`;
    el.laserOut.textContent = `${settings.fov.toFixed(0)}°`;
    el.lookOut.textContent = `${Math.round(settings.look * 100)}%`;
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
  el.lookSpeed.value = String(settings.look);
  el.lookSpeed.addEventListener('input', () => {
    settings.look = Number(el.lookSpeed.value);
    store.set('cfx.lookSpeed', el.lookSpeed.value);
    render();
  });
  el.tourSwap.checked = settings.tourSwap;
  el.tour.toggleAttribute('data-swap', settings.tourSwap);
  el.tourSwap.addEventListener('change', () => {
    settings.tourSwap = el.tourSwap.checked;
    store.set('cfx.tourSwap', settings.tourSwap ? '1' : null);
    el.tour.toggleAttribute('data-swap', settings.tourSwap);
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
let admitted = false; // the computer accepted this phone on the current link
let denied = false;

// One key per computer that approved this phone, by the computer's public id. Keys are never sent again
// after approval: the phone only proves it holds them (see shared/auth.ts).
const HOSTS_KEY = 'cfx.hosts';
const MAX_HOSTS = 30;
store.set('cfx.deviceId', null); // first scheme: one secret sent to every computer
function knownHosts(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(store.get(HOSTS_KEY) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}
let enrolling: { host: string; key: string } | null = null; // offered on this link, kept only if admitted
let offerKey = ''; // made per link and committed to in `hello`, before the computer's nonce is known
let pairNumber = '';
let dialledCode = '';

async function onChallenge(c: DataConnection, host: unknown, nonce: unknown): Promise<void> {
  if (!isHex(host, 32) || !isHex(nonce, 32) || admitted) return;
  const hosts = knownHosts();
  const key = Object.hasOwn(hosts, host) ? hosts[host] : undefined;
  let reply: RemoteMsg;
  if (key && isHex(key, 64)) {
    reply = { t: 'prove', kid: await keyId(key), mac: await proof(key, nonce, dialledCode) };
  } else {
    enrolling = { host, key: offerKey };
    pairNumber = await pairingNumber(offerKey, nonce, dialledCode);
    reply = { t: 'enrol', key: offerKey };
  }
  if (c === conn && c.open) c.send(reply);
}

function rememberHost(): void {
  if (!enrolling) return;
  const hosts = knownHosts();
  delete hosts[enrolling.host];
  hosts[enrolling.host] = enrolling.key; // most recent last
  const ids = Object.keys(hosts);
  for (const old of ids.slice(0, Math.max(ids.length - MAX_HOSTS, 0))) delete hosts[old];
  store.set(HOSTS_KEY, JSON.stringify(hosts));
  enrolling = null;
}

const ua = navigator.userAgent;
const deviceName = /iPhone/.test(ua) ? 'Un iPhone' : /iPad/.test(ua) ? 'Un iPad' : /Android/.test(ua) ? 'Un teléfono Android' : 'Un dispositivo';
let hostMode: Mode = 'idle';
let hostTour = false; // the desktop agent is recent enough to hold keys
let hostDrag = false; // ...and to hold the mouse button
let hostGestures = false; // the desktop agent knows the app switcher

function setStatus(text: string, tone: 'ok' | 'warn' | 'err'): void {
  el.status.dataset.tone = tone;
  el.statusText.textContent = text;
}

function send(msg: RemoteMsg): void {
  if (connected && conn?.open) conn.send(msg);
}

function start(newCode: string): void {
  code = newCode;
  denied = false;
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
  endDrag();
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
  dialledCode = code;
  const c = peer.connect(peerId(code), { reliable: true, serialization: 'json' });
  conn = c;
  c.on('open', () => {
    if (c !== conn) return;
    connected = true;
    admitted = false;
    lastPong = Date.now();
    setStatus('Vinculando…', 'warn');
    enrolling = null;
    pairNumber = '';
    offerKey = randomHex(32);
    void sha256Hex(offerKey).then((commit) => {
      if (c === conn && c.open) c.send({ t: 'hello', v: 4, name: deviceName, commit } satisfies RemoteMsg);
    });
  });
  c.on('data', (data) => {
    if (c !== conn) return;
    onHost(data as HostMsg);
  });
  const lost = () => {
    if (c !== conn) return;
    connected = false;
    endDrag();
    if (denied) return;
    setStatus('Reconectando…', 'warn');
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
    case 'challenge':
      if (conn) void onChallenge(conn, msg.host, msg.nonce);
      break;
    case 'auth':
      if (msg.state === 'pending') {
        setStatus(pairNumber ? `Aceptá en la PC si muestra ${pairNumber}` : 'Aceptá este teléfono en la computadora', 'warn');
      } else if (msg.state === 'unknown') {
        // The computer lost its record of this phone, or something answered in its name.
        denied = true;
        clearTimeout(redialTimer);
        setStatus('No reconocido: usá "Olvidar teléfonos" en la PC', 'err');
      } else {
        // Don't keep knocking: the person at the computer said no.
        denied = true;
        clearTimeout(redialTimer);
        setStatus('La computadora rechazó este teléfono', 'err');
      }
      break;
    case 'code': {
      const next = normalizeCode(String(msg.code));
      if (!admitted || !next) break;
      code = next;
      store.set(CODE_KEY, code);
      history.replaceState(null, '', `#${code}`);
      el.menuCode.textContent = `Vinculado a la computadora ${code}`;
      break; // the computer now drops this link; the redial uses the new code
    }
    case 'state':
      if (!admitted) {
        admitted = true;
        rememberHost();
        haptic(30);
      }
      aspect = msg.aspect || aspect;
      hostMode = msg.mode;
      hostTour = msg.tour === true;
      hostDrag = msg.drag === true;
      if (dragging && (msg.mode !== 'agent' || !hostDrag)) endDrag();
      hostGestures = msg.gestures === true;
      if (!hostGestures || msg.mode !== 'agent') closeSwitcher();
      renderTourNotice();
      el.counter.textContent = msg.mode === 'pdf' ? `${msg.page} / ${msg.total}` : '';
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
  if (Date.now() - lastPong > 6000 && !denied) {
    connected = false;
    setStatus('Reconectando…', 'warn');
    dial();
  }
}, 2000);

// Android suspends the page with the screen off; reconnect immediately on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && code && !connected && !denied) {
    if (!peer || peer.destroyed) openPeer();
    else if (peer.disconnected) peer.reconnect();
    else dial();
  }
  if (document.visibilityState === 'hidden') {
    if (laserOn) setLaser(false);
    if (listening) stopDictation();
    tracker.pause();
    releaseTour();
    stopKeyRepeat();
    endDrag();
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
// three: a 3-finger gesture took over; pointer and scroll stay still until every finger lifts.
let gesture = { start: 0, maxFingers: 0, travel: 0, three: false };
const acc = { mx: 0, my: 0, scroll: 0 };

// Drag: one finger held still for DRAG_HOLD_MS presses the left button; moving drags; lifting drops.
// Lifting starts a short grace period so the finger can be repositioned on a small pad mid-drag;
// a tap during it drops at once. The phone re-confirms the held button so the agent never leaves it stuck.
const DRAG_HOLD_MS = 450;
const DRAG_SLOP_PX = 8; // finger wobble tolerated while waiting for the hold
const DRAG_GRACE_MS = 500;
const DRAG_REFRESH_MS = 250; // agent lets go after 1 s without confirmation
let holdTimer: number | undefined;
let graceTimer: number | undefined;
let dragRefresh: number | undefined;
let dragging = false;
let regrab = false; // current touch resumed a drag during the grace period

function startDrag(): void {
  if (!(hostMode === 'agent' && hostDrag)) {
    if (hostMode === 'agent') flashPad('Actualizá el agente para arrastrar');
    return;
  }
  dragging = true;
  send({ t: 'drag', on: true });
  dragRefresh = window.setInterval(() => send({ t: 'drag', on: true }), DRAG_REFRESH_MS);
  el.pad.classList.add('dragging');
  haptic(30);
}

function endDrag(): void {
  clearTimeout(holdTimer);
  clearTimeout(graceTimer);
  if (!dragging) return;
  dragging = false;
  clearInterval(dragRefresh);
  flushMove(); // the drop lands where the finger left the cursor
  send({ t: 'drag', on: false });
  el.pad.classList.remove('dragging', 'grace');
  haptic(12);
}

let flashTimer: number | undefined;
function flashPad(text: string): void {
  el.padFlash.textContent = text;
  el.pad.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => el.pad.classList.remove('flash'), 1800);
}

// ---- 3-finger swipe: app switcher, as on a Windows touchpad.
// Moving opens it (Alt+Tab), every further STEP px moves the highlight, lifting picks the app.
const SWITCH_OPEN_PX = 28;
const SWITCH_STEP_PX = 70;
const SWITCH_KEEP_MS = 300;
const swipe = { x: 0, y: 0, open: false, keep: 0, warned: false };

function openSwitcher(): void {
  swipe.open = true;
  swipe.x = swipe.y = 0; // steps count from where it opened
  send({ t: 'switcher', a: 'open' });
  swipe.keep = window.setInterval(() => send({ t: 'switcher', a: 'keep' }), SWITCH_KEEP_MS);
  haptic(15);
}

function closeSwitcher(): void {
  if (!swipe.open) return;
  swipe.open = false;
  clearInterval(swipe.keep);
  send({ t: 'switcher', a: 'close' });
}

function trackSwipe(dx: number, dy: number): void {
  swipe.x += dx;
  swipe.y += dy;
  if (!swipe.open) {
    if (Math.hypot(swipe.x, swipe.y) < SWITCH_OPEN_PX) return;
    if (!hostGestures || hostMode !== 'agent') {
      if (swipe.warned) return;
      swipe.warned = true;
      haptic(40);
      setStatus(hostMode !== 'agent' ? 'Gestos: solo en modo sistema' : 'Gestos: actualizá el agente de la computadora', 'warn');
      return;
    }
    openSwitcher();
    return;
  }
  // One axis at a time, so a slightly diagonal swipe doesn't also jump rows.
  const horizontal = Math.abs(swipe.x) >= Math.abs(swipe.y);
  const along = horizontal ? swipe.x : swipe.y;
  if (Math.abs(along) < SWITCH_STEP_PX) return;
  const a = horizontal ? (along > 0 ? 'right' : 'left') : along > 0 ? 'down' : 'up';
  send({ t: 'switcher', a });
  haptic(6);
  if (horizontal) swipe.x -= Math.sign(along) * SWITCH_STEP_PX;
  else swipe.y -= Math.sign(along) * SWITCH_STEP_PX;
}

el.pad.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  capture(el.pad, e.pointerId);
  if (touches.size === 0) {
    gesture = { start: performance.now(), maxFingers: 0, travel: 0, three: false };
    regrab = dragging;
    if (dragging) {
      clearTimeout(graceTimer);
      el.pad.classList.remove('grace');
    } else {
      holdTimer = window.setTimeout(startDrag, DRAG_HOLD_MS);
    }
  } else {
    clearTimeout(holdTimer); // a second finger means scroll or right click, not a drag
  }
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
  gesture.maxFingers = Math.max(gesture.maxFingers, touches.size);
  if (touches.size >= 3 && !gesture.three) {
    gesture.three = true;
    swipe.x = swipe.y = 0;
    swipe.warned = false;
    acc.mx = acc.my = acc.scroll = 0; // drop what the first fingers started
  }
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
  if (gesture.travel > DRAG_SLOP_PX) clearTimeout(holdTimer);

  if (gesture.three) {
    if (touches.size >= 3) trackSwipe(dx / touches.size, dy / touches.size); // each finger reports; average
  } else if (touches.size === 1) {
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
  if (touches.size < 3) closeSwitcher(); // the first finger to lift picks the app, like Windows
  if (touches.size > 0) return;
  clearTimeout(holdTimer);
  el.pad.classList.remove('active');
  const duration = performance.now() - gesture.start;
  const tap = gesture.travel < 10 && duration < 280;
  if (dragging) {
    if (regrab && tap) {
      endDrag(); // tap during the grace period: drop now
    } else {
      el.pad.classList.add('grace');
      graceTimer = window.setTimeout(endDrag, DRAG_GRACE_MS);
    }
    return;
  }
  if (tap) {
    send({ t: 'click', b: gesture.maxFingers >= 2 ? 'right' : 'left' });
    haptic(10);
    el.pad.classList.add('tap');
    window.setTimeout(() => el.pad.classList.remove('tap'), 120);
  }
}
el.pad.addEventListener('pointerup', endTouch);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) closeSwitcher(); // never leave Alt down on the computer
});
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

let permissionTap = false;

el.laserBtn.addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  capture(el.laserBtn, e.pointerId);
  if (motionPermissionPending()) {
    // iOS: the permission prompt can only open when the finger lifts (handled below).
    permissionTap = true;
    el.laserLabel.textContent = 'Soltá para habilitar el sensor';
    return;
  }
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

const askMotionPermission = () => {
  if (!permissionTap) return;
  permissionTap = false;
  void requestMotionPermission().then((granted) => {
    el.laserLabel.textContent = granted
      ? 'Listo: mantené para láser'
      : 'Permiso denegado: cerrá Safari del todo y volvé a abrir la página';
  });
};
el.laserBtn.addEventListener('touchend', askMotionPermission);
el.laserBtn.addEventListener('click', askMotionPermission);

// ---------------------------------------------------------------- send loop (one batch per frame)

let lastFlush = performance.now();
function flushMove(): void {
  if (!connected) return;
  const mx = Math.trunc(acc.mx), my = Math.trunc(acc.my);
  if (mx || my) {
    send({ t: 'move', dx: mx, dy: my });
    acc.mx -= mx;
    acc.my -= my;
  }
}
function flush(): void {
  const now = performance.now();
  if (connected) {
    flushMove();
    if (zoomRate) {
      // Wheel up zooms in. Full deflection = 10 wheel notches per second (40 px each).
      acc.scroll -= zoomRate * Math.abs(zoomRate) * 400 * Math.min((now - lastFlush) / 1000, 0.05);
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
  lastFlush = now;
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
// Keys marked data-repeat (backspace) repeat while held, like a real keyboard.
let stopKeyRepeat = () => {};
for (const btn of el.kbd.querySelectorAll<HTMLButtonElement>('[data-key]')) {
  const k = btn.dataset.key as Key;
  if (!('repeat' in btn.dataset)) {
    btn.addEventListener('click', () => {
      send({ t: 'key', k });
      haptic(10);
    });
    continue;
  }
  let delay: number | undefined;
  let interval: number | undefined;
  const end = () => {
    clearTimeout(delay);
    clearInterval(interval);
    btn.classList.remove('pressed');
  };
  stopKeyRepeat = end;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // keeps the phone keyboard open if the text box had focus
    capture(btn, e.pointerId);
    end();
    btn.classList.add('pressed');
    send({ t: 'key', k });
    haptic(10);
    delay = window.setTimeout(() => {
      haptic(6);
      interval = window.setInterval(() => send({ t: 'key', k }), 50);
    }, 380);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) btn.addEventListener(type, end);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') send({ t: 'key', k });
  });
}
el.kbd.addEventListener('close', () => stopKeyRepeat());

// ---------------------------------------------------------------- tour mode (joystick for 3D walkthroughs)

type Dir = 'up' | 'down' | 'left' | 'right';
const DIRS: readonly Dir[] = ['up', 'down', 'left', 'right'];

// In an upright viewport the tour surface is drawn rotated 90deg clockwise (see remote.css).
const uprightViewport = window.matchMedia('(orientation: portrait)');

/** Finger position relative to the node's centre, in the node's own (unrotated) axes. */
function localOffset(e: PointerEvent, node: HTMLElement): { x: number; y: number } {
  const r = node.getBoundingClientRect();
  const sx = e.clientX - (r.left + r.width / 2);
  const sy = e.clientY - (r.top + r.height / 2);
  return uprightViewport.matches ? { x: sy, y: -sx } : { x: sx, y: sy };
}

const PULSE_ON_MS = 45;
const HOLD_REFRESH_MS = 120;

/**
 * A thumb surface that holds up to two keys on the computer, by direction (8-way).
 * Keys only know on/off, so speed below 100% is made by pulsing them: `speed` is the share of time they are down.
 */
class DirControl {
  readonly held = new Set<HoldKey>();
  private pointer: number | null = null;
  private deflection = 0; // 0 at the dead zone's edge, 1 at the rim
  private timer: number | undefined;
  private offTimer: number | undefined;
  private readonly knob: HTMLElement | null;

  constructor(
    private readonly node: HTMLElement,
    private readonly keys: Record<Dir, HoldKey>,
    private readonly deadzone: number,
    private readonly speed: (deflection: number) => number = () => 1,
  ) {
    this.knob = node.querySelector<HTMLElement>('.knob');
    node.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.pointer !== null) return;
      this.pointer = e.pointerId;
      capture(node, e.pointerId);
      node.classList.add('active');
      this.track(e);
    });
    node.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.pointer) this.track(e);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === this.pointer) this.release();
    };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
    node.addEventListener('lostpointercapture', end);
  }

  private track(e: PointerEvent): void {
    const radius = this.node.offsetWidth / 2;
    const p = localOffset(e, this.node);
    let x = p.x / radius;
    let y = p.y / radius;
    const mag = Math.hypot(x, y);
    if (mag > 1) {
      x /= mag;
      y /= mag;
    }
    if (this.knob) this.knob.style.transform = `translate(${x * radius * 0.56}px, ${y * radius * 0.56}px)`;
    this.deflection = Math.min(Math.max((mag - this.deadzone) / (1 - this.deadzone), 0), 1);
    const want = new Set<Dir>();
    if (mag > this.deadzone) {
      // 8-way: an axis counts when it carries more than sin(22.5deg) of the deflection.
      const cut = 0.383 * Math.min(mag, 1);
      if (y < -cut) want.add('up');
      if (y > cut) want.add('down');
      if (x < -cut) want.add('left');
      if (x > cut) want.add('right');
    }
    this.apply(want);
  }

  private apply(want: Set<Dir>): void {
    let pressed = false;
    for (const d of DIRS) {
      const key = this.keys[d];
      const on = want.has(d);
      this.node.classList.toggle(`d-${d}`, on);
      if (on === this.held.has(key)) continue;
      if (on) {
        this.held.add(key);
        pressed = true;
      } else {
        this.held.delete(key);
        send({ t: 'hold', k: key, on: false });
      }
    }
    if (pressed) {
      haptic(8);
      this.beat(); // new direction takes effect now, not at the next pulse
    }
  }

  /** One pulse: keys down, then (below full speed) up again after PULSE_ON_MS. Re-arms itself while keys are held.
   *  At full speed it doubles as the refresh the agent needs to keep a key down. */
  private beat = (): void => {
    clearTimeout(this.timer);
    clearTimeout(this.offTimer);
    this.timer = undefined;
    if (!this.held.size) return;
    const keys = [...this.held];
    for (const k of keys) send({ t: 'hold', k, on: true });
    const duty = this.speed(this.deflection);
    if (duty >= 0.95) {
      this.timer = window.setTimeout(this.beat, HOLD_REFRESH_MS);
      return;
    }
    this.offTimer = window.setTimeout(() => {
      for (const k of keys) send({ t: 'hold', k, on: false });
    }, PULSE_ON_MS);
    this.timer = window.setTimeout(this.beat, PULSE_ON_MS / Math.max(duty, 0.05));
  };

  release(): void {
    this.pointer = null;
    this.deflection = 0;
    this.node.classList.remove('active');
    if (this.knob) this.knob.style.transform = '';
    clearTimeout(this.timer);
    clearTimeout(this.offTimer);
    this.timer = undefined;
    for (const k of this.held) send({ t: 'hold', k, on: false });
    this.held.clear();
    for (const d of DIRS) this.node.classList.remove(`d-${d}`);
  }
}

// Matterport: WASD walks, IJKL turns the camera.
const tourControls = [
  new DirControl(el.walk, { up: 'w', down: 's', left: 'a', right: 'd' }, 0.2),
  // Camera: the rim gives the speed chosen in settings, the inner ring down to 35% of it.
  new DirControl(el.look, { up: 'i', down: 'k', left: 'j', right: 'l' }, 0.3, (d) => settings.look * (0.35 + 0.65 * d)),
];

// Zoom lever: springs back to the centre; deflection = mouse-wheel speed.
let zoomRate = 0; // -1..1, right = zoom in
let zoomPointer: number | null = null;
const leverKnob = el.zoom.querySelector<HTMLElement>('.lever-knob')!;

function trackZoom(e: PointerEvent): void {
  const travel = (el.zoom.offsetWidth - leverKnob.offsetWidth) / 2 - 6;
  const offset = Math.min(Math.max(localOffset(e, el.zoom).x, -travel), travel);
  leverKnob.style.transform = `translateX(${offset}px)`;
  const v = offset / travel;
  zoomRate = Math.abs(v) < 0.15 ? 0 : v;
}
function endZoom(): void {
  zoomPointer = null;
  zoomRate = 0;
  leverKnob.style.transform = '';
  el.zoom.classList.remove('active');
}
el.zoom.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (zoomPointer !== null) return;
  zoomPointer = e.pointerId;
  capture(el.zoom, e.pointerId);
  el.zoom.classList.add('active');
  haptic(8);
  trackZoom(e);
});
el.zoom.addEventListener('pointermove', (e) => {
  if (e.pointerId === zoomPointer) trackZoom(e);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
  el.zoom.addEventListener(type, (e) => {
    if (e.pointerId === zoomPointer) endZoom();
  });
}

function releaseTour(): void {
  for (const c of tourControls) c.release();
  endZoom();
}

function renderTourNotice(): void {
  const text =
    hostMode !== 'agent'
      ? 'El recorrido necesita el modo sistema: abrí el agente en la computadora y tocá "Conectar agente".'
      : !hostTour
        ? 'El agente de la computadora es una versión anterior. Descargalo de nuevo desde la página de ClickerFex para usar el recorrido.'
        : '';
  el.tourNotice.textContent = text;
  el.tourNotice.hidden = !text;
}

type UiMode = 'clicker' | 'tour';
function setUiMode(mode: UiMode): void {
  store.set('cfx.uiMode', mode === 'tour' ? 'tour' : null);
  el.app.dataset.mode = mode;
  el.clicker.hidden = mode !== 'clicker';
  el.tour.hidden = mode !== 'tour';
  el.modeClicker.setAttribute('aria-selected', String(mode === 'clicker'));
  el.modeTour.setAttribute('aria-selected', String(mode === 'tour'));
  if (laserOn) setLaser(false);
  releaseTour();
  endDrag();
}
el.modeClicker.addEventListener('click', () => setUiMode('clicker'));
el.modeTour.addEventListener('click', () => setUiMode('tour'));

// ---------------------------------------------------------------- menu / connect screen

el.menuBtn.addEventListener('click', () => el.menu.showModal());
el.menuClose.addEventListener('click', () => el.menu.close());
// Tapping the dimmed area above a sheet closes it.
for (const sheet of [el.menu, el.kbd]) {
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.close();
  });
}
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
setUiMode(store.get('cfx.uiMode') === 'tour' ? 'tour' : 'clicker');
renderTourNotice();
const fromHash = normalizeCode(location.hash.slice(1));
if (fromHash) start(fromHash);
else showConnect(normalizeCode(store.get(CODE_KEY) ?? '') ?? '');
