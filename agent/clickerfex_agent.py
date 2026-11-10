#!/usr/bin/env python3
"""ClickerFex desktop agent.

Turns commands from the ClickerFex web page (open in this computer's browser) into real
mouse and keyboard input, so the phone controls PowerPoint, Keynote, Google Slides or any app.

    pip install -r requirements.txt
    python clickerfex_agent.py

Listens only on localhost:8765 and only accepts the ClickerFex web origins, so other
websites you visit cannot drive your mouse.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import platform
import re
import sys

try:
    from pynput.keyboard import Controller as Keyboard, Key
    from pynput.mouse import Button, Controller as Mouse
    from websockets.asyncio.server import ServerConnection, serve
    from websockets.http11 import Request, Response
except ImportError as e:
    sys.exit(f"Faltan dependencias ({e}). Ejecutá:  pip install -r requirements.txt")

# Exact production domain only: any "clickerfex-*.vercel.app" could be registered by someone else.
DEFAULT_ORIGINS = [
    r"https://clickerfex\.vercel\.app",
    r"http://(localhost|127\.0\.0\.1)(:\d+)?",
]

KEYS = {"next": Key.right, "prev": Key.left}
SCROLL_PX_PER_NOTCH = 40


def screen_size() -> tuple[int, int]:
    if platform.system() == "Windows":
        import ctypes

        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)  # match pynput's physical pixels
        except Exception:
            pass
        u = ctypes.windll.user32
        return u.GetSystemMetrics(0), u.GetSystemMetrics(1)
    if platform.system() == "Darwin":
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


class Injector:
    def __init__(self, width: int, height: int) -> None:
        self.mouse = Mouse()
        self.keyboard = Keyboard()
        self.w, self.h = width, height
        self.scroll_rest = 0.0

    def handle(self, msg: dict) -> None:
        t = msg.get("t")
        if t == "move":
            self.mouse.move(int(msg["dx"]), int(msg["dy"]))
        elif t == "lpos":
            x = min(max(float(msg["x"]), 0.0), 1.0)
            y = min(max(float(msg["y"]), 0.0), 1.0)
            self.mouse.position = (int(x * (self.w - 1)), int(y * (self.h - 1)))
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
        # "laser" on/off needs no OS action: the cursor itself is the pointer.


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
    ap.add_argument("--screen", help="Forzar tamaño de pantalla, p. ej. 2560x1440")
    args = ap.parse_args()

    if args.screen:
        w, h = (int(v) for v in args.screen.lower().split("x"))
    else:
        w, h = screen_size()

    allowed = [re.compile(f"^{p}$") for p in DEFAULT_ORIGINS + args.origin]
    injector = Injector(w, h)

    def check_origin(conn: ServerConnection, request: Request) -> Response | None:
        origin = request.headers.get("Origin", "")
        if not any(p.match(origin) for p in allowed):
            print(f"  rechazado: origen no permitido {origin or '(vacío)'}")
            return conn.respond(403, "Origin not allowed\n")
        return None

    async def handler(ws: ServerConnection) -> None:
        print(f"  conectado: {ws.request.headers.get('Origin')}")
        try:
            async for raw in ws:
                try:
                    injector.handle(json.loads(raw))
                except (ValueError, KeyError, TypeError):
                    continue
        finally:
            print("  desconectado")

    async def run() -> None:
        async with serve(handler, "localhost", args.port, process_request=check_origin, max_size=4096):
            print(f"ClickerFex agente activo en ws://localhost:{args.port}  (pantalla {w}x{h})")
            print("En la web de ClickerFex, en esta computadora, tocá 'Conectar agente'. Ctrl+C para salir.")
            if platform.system() == "Darwin":
                print("macOS: dale permiso de Accesibilidad a tu Terminal (Ajustes > Privacidad y seguridad).")
            await asyncio.Future()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    except OSError as e:
        print(f"No se pudo abrir el puerto {args.port}: {e}. ¿Ya hay otro agente abierto?")
        if getattr(sys, "frozen", False):
            input("Enter para cerrar")


if __name__ == "__main__":
    main()
