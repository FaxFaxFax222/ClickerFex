# ClickerFex

Tu teléfono como clicker de presentaciones: touchpad, avanzar/retroceder y láser por giroscopio. Web estática (Vercel), vinculación por QR, sin cuentas.

## Uso

1. En la computadora abrí la web. Aparece un QR y un código de 5 caracteres.
2. Escaneá el QR con la cámara del teléfono (Android: Chrome). Queda vinculado.
3. Elegí modo en la computadora:

| Modo | Instalación | Controla | Cuándo |
|---|---|---|---|
| **PDF en navegador** | Nada | El PDF dentro de la web | PCs ajenas (universidad, eventos) |
| **Sistema (agente)** | Agente: ejecutable o script Python | Mouse y teclado reales: PowerPoint, Keynote, Google Slides, Canva | Tu propia laptop |

### Controles en el teléfono

- **Touchpad**: deslizar mueve el puntero (con aceleración), tocar = clic, tocar con dos dedos = clic derecho, arrastrar con dos dedos = scroll.
- **‹ / ›**: diapositiva anterior / siguiente.
- **Láser**: apuntá con la parte de arriba del teléfono (donde está la cámara selfie) hacia el centro de la pantalla y mantené apretado el botón. El punto aparece en el centro y sigue hacia dónde apuntás, como un láser real. Usa orientación absoluta: girar el teléfono sobre su eje largo no lo mueve, y la misma dirección siempre cae en el mismo lugar.
  - Ajuste clave (`⋯` → *Ancho de la pantalla vista desde vos*): cuántos grados ocupa la pantalla desde donde estás parado. Default 30° (≈3 m de pantalla a 5–6 m). Lejos o pantalla chica: bajalo. Cerca o pantalla gigante: subilo.
  - También se puede cambiar a modo toque (encender/apagar).
- La pantalla del teléfono no se apaga mientras está vinculado. Para usarlo como app: menú de Chrome → *Agregar a pantalla principal*.

### Atajos en la computadora (modo PDF)

`→` `Espacio` `Enter` siguiente · `←` anterior · `F` pantalla completa · `Q` mostrar QR para vincular otro teléfono.

## Modo sistema: agente de escritorio

Un navegador no puede mover el mouse del sistema ni enviar teclas a otras apps. El agente es un programa chico que hace eso, escuchando solo en `localhost:8765`. Con el agente, el touchpad del teléfono maneja toda la computadora.

**Ejecutable (sin Python)** — links en la web, o en el release [`agent-latest`](https://github.com/FaxFaxFax222/ClickerFex/releases/tag/agent-latest). GitHub Actions lo recompila en cada cambio de `agent/`.

- Windows: abrir `ClickerFex-Agent-Windows.exe`. Si aparece SmartScreen: *Más información → Ejecutar de todas formas* (no está firmado).
- macOS (Apple Silicon): descomprimir, clic derecho → *Abrir* la primera vez (no está firmado). Dar permiso de **Accesibilidad** a Terminal en Ajustes → Privacidad y seguridad.

**Con Python**:

```bash
cd agent
```

```bash
pip install -r requirements.txt
```

```bash
python clickerfex_agent.py
```

Después, en la web abierta en esa misma computadora: **Conectar agente** (Chrome puede pedir permiso de "acceso a la red local": aceptar). La pestaña de ClickerFex debe quedar abierta (puede estar en segundo plano, o mejor en su propia ventana) mientras presentás.

- Láser en modo sistema: mientras mantenés el botón, el puntero se convierte en un punto rojo visible sobre cualquier app (también PowerPoint/Keynote en pantalla completa); al soltar vuelve el cursor normal. Windows reemplaza el cursor del sistema; macOS dibuja el punto en una capa transparente y oculta el cursor. `--no-dot` lo desactiva.
- **Escribir y dictar** (botón de micrófono, solo en modo sistema): hacé clic en un campo de texto con el touchpad y dictá con el micrófono del teléfono; cada frase se escribe en la computadora. También hay un campo para escribir con el teclado del teléfono, y teclas Borrar / Tab / Enter. El dictado usa el reconocimiento de voz de Chrome (requiere internet).
- Seguridad: el agente solo acepta conexiones desde `https://clickerfex.vercel.app`. Si usás otro dominio: `python clickerfex_agent.py --origin "https://tu-dominio\.com"`. Para desarrollo local (`npm run dev`): `python clickerfex_agent.py --dev`, que además acepta páginas servidas en `localhost`.
- Segundo plano: con el agente conectado, la pestaña mantiene abierto un flujo de audio inaudible para que Chrome no le baje la prioridad cuando queda detrás de otra pestaña o de PowerPoint. El teléfono muestra la demora de ida y vuelta (`Conectado · 12 ms`); si aparece `vía servidor externo`, la red no deja que teléfono y computadora se hablen directo.

## Modo Recorrido (Matterport y otros recorridos 3D)

En el teléfono, el selector **Clicker / Recorrido** cambia el control a un joystick. Requiere el modo sistema (agente v2 o posterior).

| Control | Acción | Tecla que mantiene el agente |
|---|---|---|
| Cruz de flechas | Caminar adelante / atrás / costados | `W` `S` `A` `D` |
| Joystick | Girar la cámara | `I` `K` `J` `L` |
| Palanca | Zoom (vuelve sola al centro) | rueda del mouse |

El modo Recorrido se usa con el teléfono de costado: cámara a la izquierda, movimiento a la derecha, zoom arriba. Si la rotación automática está bloqueada, la pantalla se gira sola.

La cámara de Matterport solo entiende tecla apretada o suelta, así que la velocidad se regula pulsando la tecla: *Ajustes → Velocidad de la cámara* (50 % por defecto) fija la del borde del joystick; cerca del centro gira más lento.

- Antes de empezar, hacé un clic dentro del recorrido con el touchpad: las teclas van a la ventana con foco y el zoom actúa donde está el cursor.
- Las diagonales mantienen dos teclas a la vez.
- Seguridad: el teléfono reconfirma las teclas mantenidas ~8 veces por segundo; si deja de hacerlo (pantalla apagada, sin señal), el agente las suelta en 1 s.

## Varios monitores

El láser apunta dentro del monitor donde está el cursor en el momento de encenderlo. Para cambiar de pantalla: llevá el cursor a esa pantalla con el touchpad y volvé a encender el láser.

## Seguridad de la vinculación

- **Aprobación**: la primera vez que un teléfono se conecta, la computadora muestra un aviso (*Permitir / Rechazar*). Hasta que se acepta, no se obedece ningún comando suyo. Los teléfonos aceptados se recuerdan en ese navegador y no vuelven a preguntar.
- **Número de verificación**: el aviso muestra 4 dígitos y el teléfono que espera muestra los suyos. Aceptá solo si coinciden: así no se aprueba por error el teléfono de otra persona que se conectó al mismo tiempo.
- **Reconocimiento sin enviar secretos**: al aprobarse, el teléfono entrega una clave creada solo para esa computadora. Después no la vuelve a enviar: firma un desafío de un solo uso junto con el código al que se conectó. Una página que se haga pasar por la computadora no obtiene nada reutilizable ni puede retransmitir la firma.
- **Código por sesión**: el código dura mientras la pestaña esté abierta (recargar lo conserva). Al cerrar la pestaña o el navegador se genera uno nuevo.
- **Cambiar código**: lo reemplaza al instante; los teléfonos aceptados que estén conectados pasan solos al nuevo.
- **Olvidar teléfonos autorizados**: borra la lista y cambia el código; todos vuelven a pedir permiso.

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

Deploy: importar el repo en Vercel (framework Vite, sin configuración extra). `vercel.json` fija una Content-Security-Policy: si cambiás el broker (`VITE_PEER_HOST`) o el puerto del agente, agregá ese origen a `connect-src`.
