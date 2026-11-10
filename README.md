# ClickerFex

Tu teléfono como clicker de presentaciones: touchpad, avanzar/retroceder y láser por giroscopio. Web estática (Vercel), vinculación por QR, sin cuentas.

## Uso

1. En la computadora abrí la web. Aparece un QR y un código de 5 caracteres.
2. Escaneá el QR con la cámara del teléfono (Android: Chrome). Queda vinculado.
3. Elegí modo en la computadora:

| Modo | Instalación | Controla | Cuándo |
|---|---|---|---|
| **PDF en navegador** | Nada | El PDF dentro de la web | PCs ajenas (universidad, eventos) |
| **Sistema (agente)** | Python + agente | Mouse y teclado reales: PowerPoint, Keynote, Google Slides, Canva | Tu propia laptop |

### Controles en el teléfono

- **Touchpad**: deslizar mueve el puntero (con aceleración), tocar = clic, tocar con dos dedos = clic derecho, arrastrar con dos dedos = scroll.
- **‹ / ›**: diapositiva anterior / siguiente.
- **Láser**: mantené apretado y apuntá moviendo la muñeca. Arranca siempre en el centro de la pantalla. En ajustes (`⋯`) se puede cambiar a modo toque (encender/apagar) y ajustar sensibilidades.
- La pantalla del teléfono no se apaga mientras está vinculado. Para usarlo como app: menú de Chrome → *Agregar a pantalla principal*.

### Atajos en la computadora (modo PDF)

`→` `Espacio` `Enter` siguiente · `←` anterior · `F` pantalla completa · `Q` mostrar QR para vincular otro teléfono.

## Modo sistema: agente de escritorio

Un navegador no puede mover el mouse del sistema ni enviar teclas a otras apps. El agente es un script de ~150 líneas que hace eso, escuchando solo en `localhost:8765`.

```bash
cd agent
```

```bash
pip install -r requirements.txt
```

```bash
python clickerfex_agent.py
```

Después, en la web abierta en esa misma computadora: **Conectar agente** (Chrome puede pedir permiso de "acceso a la red local": aceptar). La pestaña de ClickerFex debe quedar abierta (puede estar en segundo plano) mientras presentás en PowerPoint.

- macOS: dar permiso de **Accesibilidad** a la Terminal (Ajustes → Privacidad y seguridad).
- Láser en modo sistema = el cursor real. En PowerPoint, `Ctrl+L` durante la presentación lo convierte en puntero láser.
- Seguridad: el agente solo acepta conexiones desde `https://clickerfex.vercel.app` y `localhost`. Si usás otro dominio: `python clickerfex_agent.py --origin "https://tu-dominio\.com"`.

## Arquitectura

```
Teléfono (/remote) ──WebRTC P2P (misma Wi-Fi)──▶ Computadora (/)
                                                  ├─ modo PDF: pdf.js + láser/puntero dibujados en la página
                                                  └─ modo sistema: ws://localhost:8765 ──▶ agente Python ──▶ mouse/teclado del SO
```

- Señalización: servidor público de PeerJS (solo para el apretón de manos inicial). Los datos van directo entre dispositivos; si la red bloquea tráfico entre clientes, PeerJS usa sus servidores TURN.
- Sin backend propio, sin base de datos. El código de la computadora se recuerda en el navegador: el teléfono reconecta solo si recargás la página.
- Para eliminar la dependencia del broker público: `npx peer --port 9000` en un servidor propio y configurar `VITE_PEER_HOST`, `VITE_PEER_PORT`, `VITE_PEER_PATH`, `VITE_PEER_SECURE` en Vercel.

## Problemas conocidos

- **Wi-Fi universitaria con aislamiento de clientes**: los dispositivos no se ven entre sí; PeerJS cae a TURN (más latencia). Solución infalible: conectá la computadora al hotspot del teléfono.
- El láser usa el giroscopio (`devicemotion`); requiere HTTPS (Vercel lo da).

## Desarrollo

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build
```

Deploy: importar el repo en Vercel (framework Vite, sin configuración extra).
