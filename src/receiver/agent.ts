import type { AgentMsg } from '../shared/protocol';

export const AGENT_URL = 'ws://localhost:8765';

type Listener = (connected: boolean) => void;

/**
 * Bridge to the optional desktop agent, which injects real OS mouse/keyboard input.
 * Browsers allow https pages to open ws://localhost (loopback is a secure context).
 * Only connects on explicit opt-in: probing localhost triggers a permission prompt in Chrome.
 */
export class AgentBridge {
  connected = false;
  /** Protocol version announced by the agent; 0 = an old build that announces nothing. */
  version = 0;
  private ws: WebSocket | null = null;
  private wanted = false;
  private retry: number | undefined;

  constructor(private readonly onChange: Listener) {}

  enable(): void {
    this.wanted = true;
    this.open();
  }

  disable(): void {
    this.wanted = false;
    clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
    this.set(false);
  }

  get enabled(): boolean {
    return this.wanted;
  }

  send(msg: AgentMsg): void {
    if (this.connected) this.ws!.send(JSON.stringify(msg));
  }

  private open(): void {
    if (!this.wanted || this.ws) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(AGENT_URL);
    } catch {
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.set(true);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as { t?: string; v?: number };
        if (msg.t === 'hello' && typeof msg.v === 'number') {
          this.version = msg.v;
          this.onChange(this.connected);
        }
      } catch {
        /* not ours */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.version = 0;
      this.set(false);
      this.schedule();
    };
    ws.onerror = () => ws.close();
  }

  private schedule(): void {
    clearTimeout(this.retry);
    if (this.wanted) this.retry = window.setTimeout(() => this.open(), 2500);
  }

  private set(v: boolean): void {
    if (v === this.connected) return;
    this.connected = v;
    this.onChange(v);
  }
}
