#!/usr/bin/env python3
"""ClickerFex desktop agent.

Turns commands from the ClickerFex web page (open in this computer's browser) into real
mouse and keyboard input, so the phone controls PowerPoint, Keynote, Google Slides or any app.

    pip install -r requirements.txt
    python clickerfex_agent.py

Listens only on localhost:8765 and only accepts the ClickerFex web origin, so other
websites you visit cannot drive your mouse.
"""

from __future__ import annotations

import argparse
import asyncio
import atexit
import ctypes
import json
import math
import platform
import re
import sys
import threading
import time
from typing import Callable

try:
    from pynput.keyboard import Controller as Keyboard, Key
    from pynput.mouse import Button, Controller as Mouse
    from websockets.asyncio.server import ServerConnection, serve
    from websockets.exceptions import ConnectionClosed
    from websockets.http11 import Request, Response
except ImportError as e:
    sys.exit(f"Faltan dependencias ({e}). Ejecutá:  pip install -r requirements.txt")

SYSTEM = platform.system()

# Exact production domain only: any "clickerfex-*.vercel.app" could be registered by someone else.
DEFAULT_ORIGINS = [r"https://clickerfex\.vercel\.app"]
# Only with --dev: otherwise any program serving a page on this computer's localhost could drive the mouse.
DEV_ORIGINS = [r"http://(localhost|127\.0\.0\.1)(:\d+)?"]

KEYS = {"next": Key.right, "prev": Key.left, "enter": Key.enter, "backspace": Key.backspace, "tab": Key.tab}
# Tour mode (3D walkthroughs such as Matterport): WASD walks, IJKL turns the camera.
HOLD_KEYS = frozenset("wasdijkl")
HOLD_TIMEOUT = 1.0  # the phone re-sends held keys ~8x/s; silence means it is gone
AGENT_VERSION = 3  # 2: held keys; 3: laser on the monitor under the cursor
SCROLL_PX_PER_NOTCH = 40
MAX_TEXT = 4000


def screen_size() -> tuple[int, int]:
    if SYSTEM == "Windows":
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)  # match pynput's physical pixels
        except Exception:
            pass
        u = ctypes.windll.user32
        return u.GetSystemMetrics(0), u.GetSystemMetrics(1)
    if SYSTEM == "Darwin":
        try:
            from Quartz import CGDisplayBounds, CGMainDisplayID  # ships with pynput on macOS

            b = CGDisplayBounds(CGMainDisplayID())
            return int(b.size.width), int(b.size.height)
        except Exception:
            pass
    try:
        import tkinter

        root = tkinter.Tk()
        root.withdraw()
        size = root.winfo_screenwidth(), root.winfo_screenheight()
        root.destroy()
        return size
    except Exception:
        return 1920, 1080


Area = tuple[int, int, int, int]  # left, top, width, height in the coordinates pynput's mouse uses


def monitor_at(x: float, y: float, fallback: Area, strict: bool = False) -> Area:
    """The monitor that contains the point (nearest one if none does); `fallback` where that can't be asked."""
    try:
        if SYSTEM == "Windows":
            from ctypes import wintypes

            class MONITORINFO(ctypes.Structure):
                _fields_ = [
                    ("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                    ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD),
                ]

            u = ctypes.WinDLL("user32", use_last_error=True)
            u.MonitorFromPoint.restype = ctypes.c_void_p
            u.MonitorFromPoint.argtypes = [wintypes.POINT, wintypes.DWORD]
            u.GetMonitorInfoW.restype = wintypes.BOOL
            u.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.POINTER(MONITORINFO)]
            info = MONITORINFO()
            info.cbSize = ctypes.sizeof(MONITORINFO)
            mon = u.MonitorFromPoint(wintypes.POINT(int(x), int(y)), 2)  # MONITOR_DEFAULTTONEAREST
            if not mon or not u.GetMonitorInfoW(mon, ctypes.byref(info)):
                raise OSError(f"GetMonitorInfo failed ({ctypes.get_last_error()})")
            r = info.rcMonitor
            return r.left, r.top, r.right - r.left, r.bottom - r.top
        if SYSTEM == "Darwin":
            from Quartz import CGDisplayBounds, CGGetActiveDisplayList

            err, displays, _count = CGGetActiveDisplayList(32, None, None)
            if err or not displays:
                raise OSError(f"CGGetActiveDisplayList failed ({err})")
            areas = []
            for d in displays:
                b = CGDisplayBounds(d)
                areas.append((int(b.origin.x), int(b.origin.y), int(b.size.width), int(b.size.height)))

            def distance(a: Area) -> float:
                dx = max(a[0] - x, 0, x - (a[0] + a[2] - 1))
                dy = max(a[1] - y, 0, y - (a[1] + a[3] - 1))
                return math.hypot(dx, dy)

            return min(areas, key=distance)
    except Exception as e:
        if strict:
            raise
        print(f"  aviso: no se pudo detectar el monitor ({e}); el láser usa la pantalla principal")
    return fallback


# ---------------------------------------------------------------------------- laser dot


class LaserVisual:
    """No visual: the plain cursor is the pointer. Used on Linux and as a fallback."""

    name = "cursor normal"

    def show(self) -> None: ...
    def move(self, x: float, y: float) -> None:
        """x, y: desktop position in the mouse's coordinates (any monitor)."""

    def hide(self) -> None: ...


def dot_pixels(size: int) -> bytes:
    """Straight-alpha BGRA, top-down: white-hot core, red dot, soft red glow."""
    c = size / 2
    r_dot = size * 0.2
    out = bytearray()
    for py in range(size):
        for px in range(size):
            d = math.hypot(px + 0.5 - c, py + 0.5 - c)
            # glow
            t = min(max((d - r_dot) / (c - r_dot), 0.0), 1.0)
            ga = 150 * (1 - t) ** 2 if d < c else 0
            red, green, blue, alpha = 255, 45, 32, ga
            # dot with 1px antialiased edge
            cover = min(max(r_dot + 0.5 - d, 0.0), 1.0)
            if cover > 0:
                core = min(max((r_dot * 0.45 - d) / (r_dot * 0.25), 0.0), 1.0)  # white centre
                dr, dg, db = 255, 45 + (210 * core), 32 + (223 * core)
                alpha = alpha * (1 - cover) + 255 * cover
                red, green, blue = dr, dg, db
            out += bytes((int(blue), int(green), int(red), int(alpha)))
    return bytes(out)


class WindowsCursorLaser(LaserVisual):
    """Swaps the system cursors for a red dot (visible over everything, incl. fullscreen PowerPoint).
    Restores the user's cursor scheme on release, disconnect, exit and on startup (heals a crash)."""

    name = "cursor rojo (Windows)"
    OCR_IDS = (32512, 32513, 32515, 32649, 32650)  # arrow, I-beam, cross, hand, app-starting
    SPI_SETCURSORS = 0x0057

    def __init__(self) -> None:
        from ctypes import wintypes

        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
        u, g, vp = self.user32, self.gdi32, ctypes.c_void_p
        u.GetDC.restype, u.GetDC.argtypes = vp, [vp]
        u.ReleaseDC.argtypes = [vp, vp]
        u.CreateIconIndirect.restype, u.CreateIconIndirect.argtypes = vp, [vp]
        u.SetSystemCursor.restype, u.SetSystemCursor.argtypes = wintypes.BOOL, [vp, wintypes.DWORD]
        u.SystemParametersInfoW.restype = wintypes.BOOL
        u.SystemParametersInfoW.argtypes = [wintypes.UINT, wintypes.UINT, vp, wintypes.UINT]
        g.CreateDIBSection.restype = vp
        g.CreateDIBSection.argtypes = [vp, vp, wintypes.UINT, ctypes.POINTER(vp), vp, wintypes.DWORD]
        g.CreateBitmap.restype = vp
        g.CreateBitmap.argtypes = [ctypes.c_int, ctypes.c_int, wintypes.UINT, wintypes.UINT, vp]
        g.DeleteObject.argtypes = [vp]

        class BITMAPINFOHEADER(ctypes.Structure):
            _fields_ = [
                ("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD),
            ]

        class ICONINFO(ctypes.Structure):
            _fields_ = [
                ("fIcon", wintypes.BOOL), ("xHotspot", wintypes.DWORD), ("yHotspot", wintypes.DWORD),
                ("hbmMask", vp), ("hbmColor", vp),
            ]

        self.BITMAPINFOHEADER, self.ICONINFO = BITMAPINFOHEADER, ICONINFO
        try:
            dpi = u.GetDpiForSystem()
        except Exception:
            dpi = 96
        self.size = max(32, round(48 * dpi / 96))
        self.pixels = dot_pixels(self.size)
        self.active = False
        self.restore()
        atexit.register(self.restore)
        cur = self._make_cursor()  # fail now (-> fallback) rather than mid-presentation
        if not cur:
            raise OSError(f"CreateIconIndirect failed ({ctypes.get_last_error()})")
        self.user32.DestroyCursor(ctypes.c_void_p(cur))

    def _make_cursor(self) -> int | None:
        s = self.size
        bi = self.BITMAPINFOHEADER(ctypes.sizeof(self.BITMAPINFOHEADER), s, -s, 1, 32, 0, 0, 0, 0, 0, 0)
        bits = ctypes.c_void_p()
        hdc = self.user32.GetDC(None)
        color = self.gdi32.CreateDIBSection(hdc, ctypes.byref(bi), 0, ctypes.byref(bits), None, 0)
        self.user32.ReleaseDC(None, hdc)
        if not color or not bits.value:
            return None
        ctypes.memmove(bits, self.pixels, len(self.pixels))
        mask_bytes = ctypes.create_string_buffer(((s + 15) // 16) * 2 * s)  # all zero: alpha decides
        mask = self.gdi32.CreateBitmap(s, s, 1, 1, mask_bytes)
        info = self.ICONINFO(False, s // 2, s // 2, mask, color)
        cur = self.user32.CreateIconIndirect(ctypes.byref(info))
        self.gdi32.DeleteObject(color)
        self.gdi32.DeleteObject(mask)
        return cur

    def show(self) -> None:
        if self.active:
            return
        self.active = True
        for ocr in self.OCR_IDS:
            cur = self._make_cursor()  # SetSystemCursor takes ownership: one handle per slot
            if cur:
                self.user32.SetSystemCursor(cur, ocr)

    def hide(self) -> None:
        if self.active:
            self.active = False
            self.restore()

    def restore(self) -> None:
        self.user32.SystemParametersInfoW(self.SPI_SETCURSORS, 0, None, 0)


class MacOverlayLaser(LaserVisual):
    """Click-through, always-on-top red dot window (also over fullscreen Keynote/PowerPoint Spaces).
    macOS forbids changing another app's cursor, so the real cursor is hidden while the dot shows.
    Must be driven from the main thread (AppKit)."""

    name = "punto rojo (macOS)"
    SIZE = 44.0

    def __init__(self) -> None:
        from AppKit import (
            NSApplication,
            NSBackingStoreBuffered,
            NSBezierPath,
            NSColor,
            NSGraphicsContext,
            NSMakeRect,
            NSScreen,
            NSScreenSaverWindowLevel,
            NSShadow,
            NSView,
            NSWindow,
        )

        app = NSApplication.sharedApplication()
        app.setActivationPolicy_(1)  # Accessory: no Dock icon, never steals focus from the presentation

        size = self.SIZE

        class ClickerFexDotView(NSView):
            def isOpaque(self):
                return False

            def drawRect_(self, _rect):
                c, r = size / 2, size * 0.2
                red = NSColor.colorWithCalibratedRed_green_blue_alpha_(1.0, 0.18, 0.12, 1.0)
                NSGraphicsContext.saveGraphicsState()
                glow = NSShadow.alloc().init()
                glow.setShadowColor_(NSColor.colorWithCalibratedRed_green_blue_alpha_(1.0, 0.18, 0.12, 0.9))
                glow.setShadowBlurRadius_(size * 0.3)
                glow.setShadowOffset_((0.0, 0.0))
                glow.set()
                red.set()
                NSBezierPath.bezierPathWithOvalInRect_(NSMakeRect(c - r, c - r, 2 * r, 2 * r)).fill()
                NSGraphicsContext.restoreGraphicsState()
                NSColor.colorWithCalibratedWhite_alpha_(1.0, 0.85).set()
                k = r * 0.38
                NSBezierPath.bezierPathWithOvalInRect_(NSMakeRect(c - k, c - k, 2 * k, 2 * k)).fill()

        win = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            NSMakeRect(0, 0, size, size), 0, NSBackingStoreBuffered, False
        )
        win.setOpaque_(False)
        win.setBackgroundColor_(NSColor.clearColor())
        win.setHasShadow_(False)
        win.setIgnoresMouseEvents_(True)
        win.setLevel_(NSScreenSaverWindowLevel)
        # canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary
        win.setCollectionBehavior_((1 << 0) | (1 << 4) | (1 << 6) | (1 << 8))
        win.setReleasedWhenClosed_(False)
        win.setContentView_(ClickerFexDotView.alloc().initWithFrame_(NSMakeRect(0, 0, size, size)))
        self.win = win
        self.screen_frame = NSScreen.screens()[0].frame()
        self.cursor_hidden = False
        self.offset = (0.0, 0.0)
        self._cg = self._load_cursor_api()

    @staticmethod
    def _load_cursor_api():
        """Lets a background app hide the cursor (private but long-stable CoreGraphics property)."""
        try:
            cg = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
            cf = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
            cf.CFStringCreateWithCString.restype = ctypes.c_void_p
            cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
            conn_fn = getattr(cg, "CGSMainConnectionID", None) or getattr(cg, "_CGSDefaultConnection")
            conn_fn.restype = ctypes.c_int
            cg.CGSSetConnectionProperty.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
            cg.CGMainDisplayID.restype = ctypes.c_uint32
            cg.CGDisplayHideCursor.argtypes = [ctypes.c_uint32]
            cg.CGDisplayShowCursor.argtypes = [ctypes.c_uint32]
            cg.CGCursorIsVisible.restype = ctypes.c_bool
            key = cf.CFStringCreateWithCString(None, b"SetsCursorInBackground", 0x08000100)
            true = ctypes.c_void_p.in_dll(cf, "kCFBooleanTrue")
            cid = conn_fn()
            cg.CGSSetConnectionProperty(cid, cid, key, true)
            return cg
        except Exception:
            return None

    def show(self) -> None:
        if self._cg and not self.cursor_hidden:
            self._cg.CGDisplayHideCursor(self._cg.CGMainDisplayID())
            self.cursor_hidden = True
            # If hiding was refused, park the dot over the arrow's body so it still reads as a dot.
            self.offset = (0.0, 0.0) if not self._cg.CGCursorIsVisible() else (5.0, 8.0)
        elif not self._cg:
            self.offset = (5.0, 8.0)
        self.win.orderFrontRegardless()

    def move(self, x: float, y: float) -> None:
        # Mouse coordinates grow downwards from the primary screen's top-left; AppKit's grow upwards from
        # its bottom-left. Both are in points and share the x axis, on every monitor.
        primary_h = self.screen_frame.size.height
        s = self.SIZE
        self.win.setFrameOrigin_((x - s / 2 + self.offset[0], primary_h - y - s / 2 - self.offset[1]))

    def hide(self) -> None:
        self.win.orderOut_(None)
        if self._cg and self.cursor_hidden:
            self._cg.CGDisplayShowCursor(self._cg.CGMainDisplayID())
            self.cursor_hidden = False


def run_mac_loop(stop: threading.Event) -> None:
    """Minimal AppKit loop on the main thread: draws the overlay and runs callAfter() jobs.
    Returns every 50 ms so Ctrl+C and `stop` are honoured."""
    import AppKit

    app = AppKit.NSApplication.sharedApplication()
    app.finishLaunching()
    mask = getattr(AppKit, "NSEventMaskAny", 0xFFFFFFFFFFFFFFFF)
    while not stop.is_set():
        event = app.nextEventMatchingMask_untilDate_inMode_dequeue_(
            mask, AppKit.NSDate.dateWithTimeIntervalSinceNow_(0.05), AppKit.NSDefaultRunLoopMode, True
        )
        if event is not None:
            app.sendEvent_(event)
        app.updateWindows()


def make_visual(strict: bool = False) -> LaserVisual:
    try:
        if SYSTEM == "Windows":
            return WindowsCursorLaser()
        if SYSTEM == "Darwin":
            return MacOverlayLaser()
    except Exception as e:
        if strict:
            raise
        print(f"  aviso: sin punto rojo ({e}); el láser usa el cursor normal")
    return LaserVisual()


# ---------------------------------------------------------------------------- input


class Injector:
    def __init__(
        self, width: int, height: int, visual: LaserVisual, ui: Callable[..., None], follow_monitor: bool = True
    ) -> None:
        self.mouse = Mouse()
        self.keyboard = Keyboard()
        self.primary: Area = (0, 0, width, height)
        self.area = self.primary  # where the laser points: the monitor the cursor was on when it was switched on
        self.follow_monitor = follow_monitor
        self.strict = False
        self.scroll_rest = 0.0
        self.visual = visual
        self.ui = ui  # runs visual calls on the GUI thread (macOS) or inline
        self.laser_on = False
        self.held: dict[str, float] = {}  # key -> last time the phone confirmed it

    def hold(self, key: str, on: bool) -> None:
        if key not in HOLD_KEYS:
            return
        if on:
            # Pressing again while down is what a physical keyboard's auto-repeat does.
            self.keyboard.press(key)
            self.held[key] = time.monotonic()
        elif self.held.pop(key, None) is not None:
            self.keyboard.release(key)

    def release_stale(self, max_age: float = HOLD_TIMEOUT) -> None:
        """Never leave a key stuck down: lets go of keys the phone stopped confirming."""
        now = time.monotonic()
        for key in [k for k, seen in self.held.items() if now - seen >= max_age]:
            del self.held[key]
            try:
                self.keyboard.release(key)
            except Exception as e:
                print(f"  aviso: no se pudo soltar la tecla {key} ({e})")

    def _visual(self, fn: Callable[..., None], *args) -> None:
        def safe() -> None:
            try:
                fn(*args)
            except Exception as e:  # never let the overlay break input
                print(f"  aviso: punto rojo falló ({e})")

        self.ui(safe)

    def set_laser(self, on: bool) -> None:
        if on == self.laser_on:
            return
        self.laser_on = on
        if on and self.follow_monitor:
            x, y = self.mouse.position
            self.area = monitor_at(x, y, self.primary, self.strict)
        self._visual(self.visual.show if on else self.visual.hide)

    def handle(self, msg: dict) -> None:
        t = msg.get("t")
        if t == "move":
            self.mouse.move(int(msg["dx"]), int(msg["dy"]))
        elif t == "lpos":
            x = min(max(float(msg["x"]), 0.0), 1.0)
            y = min(max(float(msg["y"]), 0.0), 1.0)
            left, top, width, height = self.area
            px, py = left + int(x * (width - 1)), top + int(y * (height - 1))
            self.mouse.position = (px, py)
            if self.laser_on:
                self._visual(self.visual.move, px, py)
        elif t == "laser":
            self.set_laser(bool(msg.get("on")))
        elif t == "click":
            self.mouse.click(Button.right if msg.get("b") == "right" else Button.left)
        elif t == "scroll":
            self.scroll_rest += float(msg["dy"]) / SCROLL_PX_PER_NOTCH
            notches = int(self.scroll_rest)
            if notches:
                self.scroll_rest -= notches
                self.mouse.scroll(0, -notches)  # finger up = content up, like a phone
        elif t == "key":
            key = KEYS.get(msg.get("k"))
            if key is not None:
                self.keyboard.tap(key)
        elif t == "hold":
            self.hold(str(msg.get("k")), bool(msg.get("on")))
        elif t == "text":
            text = str(msg.get("s", ""))[:MAX_TEXT]
            if text:
                self.keyboard.type(text)  # unicode-safe: accents, ñ, emoji


# ---------------------------------------------------------------------------- main


def selftest(injector: Injector) -> None:
    """Exercises the laser visual on a real desktop (used by CI on Windows and macOS)."""
    injector.strict = True  # a monitor lookup that fails must fail the test, not fall back
    injector.handle({"t": "laser", "on": True})
    print(f"selftest monitor: {injector.area}")
    for i in range(10):
        injector.handle({"t": "lpos", "x": 0.3 + i * 0.04, "y": 0.5})
    injector.handle({"t": "laser", "on": False})
    print(f"selftest ok: {injector.visual.name}")


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)  # status lines show up immediately, also when frozen
    ap = argparse.ArgumentParser(description="ClickerFex desktop agent")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument(
        "--origin",
        action="append",
        default=[],
        help="Origen web adicional permitido (regex), p. ej. https://mi-dominio\\.com",
    )
    ap.add_argument("--dev", action="store_true", help="Aceptar también páginas servidas en localhost (desarrollo)")
    ap.add_argument("--screen", help="Forzar el láser a la pantalla principal con este tamaño, p. ej. 2560x1440")
    ap.add_argument("--no-dot", action="store_true", help="Láser con el cursor normal, sin punto rojo")
    ap.add_argument("--selftest", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()

    if args.screen:
        w, h = (int(v) for v in args.screen.lower().split("x"))
    else:
        w, h = screen_size()

    visual = LaserVisual() if args.no_dot else make_visual(strict=args.selftest)
    mac_gui = isinstance(visual, MacOverlayLaser)
    if mac_gui:
        from PyObjCTools import AppHelper

        ui: Callable[..., None] = AppHelper.callAfter
    else:
        ui = lambda fn: fn()  # noqa: E731

    injector = Injector(w, h, visual, ui, follow_monitor=not args.screen)
    stop = threading.Event()

    if args.selftest:
        if mac_gui:
            def run_test() -> None:
                selftest(injector)
                AppHelper.callAfter(stop.set)

            AppHelper.callAfter(run_test)
            run_mac_loop(stop)
        else:
            selftest(injector)
        return

    allowed = [re.compile(f"^{p}$") for p in DEFAULT_ORIGINS + (DEV_ORIGINS if args.dev else []) + args.origin]

    def check_origin(conn: ServerConnection, request: Request) -> Response | None:
        origin = request.headers.get("Origin", "")
        if not any(p.match(origin) for p in allowed):
            print(f"  rechazado: origen no permitido {origin or '(vacío)'}")
            return conn.respond(403, "Origin not allowed\n")
        return None

    async def handler(ws: ServerConnection) -> None:
        print(f"  conectado: {ws.request.headers.get('Origin')}")
        try:
            await ws.send(json.dumps({"t": "hello", "v": AGENT_VERSION}))
            async for raw in ws:
                try:
                    injector.handle(json.loads(raw))
                except (ValueError, KeyError, TypeError, OverflowError):
                    continue
        except ConnectionClosed:
            pass  # tab closed or laptop slept: normal
        finally:
            injector.set_laser(False)  # never leave the red dot stuck on screen
            injector.release_stale(0)
            print("  desconectado")

    async def watchdog() -> None:
        while True:
            await asyncio.sleep(0.25)
            injector.release_stale()

    async def run() -> None:
        guard = asyncio.create_task(watchdog())  # noqa: F841 - keeps the task referenced
        async with serve(handler, "localhost", args.port, process_request=check_origin, max_size=65536, compression=None):
            print(f"ClickerFex agente activo en ws://localhost:{args.port}  (v{AGENT_VERSION}, pantalla {w}x{h}, láser: {visual.name})")
            print("En la web de ClickerFex, en esta computadora, tocá 'Conectar agente'. Ctrl+C para salir.")
            if SYSTEM == "Darwin":
                print("macOS: dale permiso de Accesibilidad a tu Terminal (Ajustes > Privacidad y seguridad).")
            await asyncio.Future()

    def serve_forever() -> None:
        try:
            asyncio.run(run())
        except OSError as e:
            print(f"No se pudo abrir el puerto {args.port}: {e}. ¿Ya hay otro agente abierto?")
            stop.set()
            if getattr(sys, "frozen", False) and not mac_gui:
                input("Enter para cerrar")

    try:
        if mac_gui:
            # AppKit owns the main thread; the server runs beside it.
            threading.Thread(target=serve_forever, daemon=True).start()
            run_mac_loop(stop)
        else:
            serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        visual.hide()
        injector.release_stale(0)


if __name__ == "__main__":
    main()
