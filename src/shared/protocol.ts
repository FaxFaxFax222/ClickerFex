/** Phone -> laptop. Keep messages tiny: they flow at up to 60 Hz. */
export type RemoteMsg =
  | { t: 'hello'; v: 1 }
  | { t: 'ping'; id: number }
  | { t: 'move'; dx: number; dy: number } // touchpad, phone px already scaled
  | { t: 'click'; b: 'left' | 'right' }
  | { t: 'scroll'; dy: number }
  | { t: 'key'; k: Key }
  | { t: 'text'; s: string } // typed on the computer (system mode)
  | { t: 'laser'; on: boolean }
  | { t: 'lpos'; x: number; y: number }; // laser, absolute 0..1 (phone maps pointing angle to screen)

export type Key = 'next' | 'prev' | 'enter' | 'backspace' | 'tab';

export type Mode = 'idle' | 'pdf' | 'agent';

/** Laptop -> phone. */
export type HostMsg =
  | { t: 'pong'; id: number }
  | { t: 'state'; mode: Mode; page: number; total: number; aspect: number };

/** Laptop browser -> desktop agent (ws://localhost). */
export type AgentMsg =
  | { t: 'move'; dx: number; dy: number }
  | { t: 'click'; b: 'left' | 'right' }
  | { t: 'scroll'; dy: number }
  | { t: 'key'; k: Key }
  | { t: 'text'; s: string }
  | { t: 'laser'; on: boolean }
  | { t: 'lpos'; x: number; y: number }; // absolute, 0..1
