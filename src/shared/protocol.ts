/** Phone -> laptop. Keep messages tiny: they flow at up to 60 Hz. */
export type RemoteMsg =
  | { t: 'hello'; v: 4; name?: string; commit: string } // commit: SHA-256 of the key this phone would enrol with
  | { t: 'prove'; kid: string; mac: string } // answer to a challenge from a computer that approved this phone before
  | { t: 'enrol'; key: string } // first contact with this computer: a fresh key, kept only if someone approves
  | { t: 'ping'; id: number }
  | { t: 'move'; dx: number; dy: number } // touchpad, phone px already scaled
  | { t: 'click'; b: 'left' | 'right' }
  | { t: 'scroll'; dy: number }
  | { t: 'key'; k: Key }
  | { t: 'hold'; k: HoldKey; on: boolean } // tour mode: key kept down; re-sent while held
  | { t: 'text'; s: string } // typed on the computer (system mode)
  | { t: 'switcher'; a: SwitchAction } // 3-finger swipe: app switcher (Alt+Tab / Cmd+Tab)
  | { t: 'laser'; on: boolean }
  | { t: 'lpos'; x: number; y: number }; // laser, absolute 0..1 (phone maps pointing angle to screen)

export type Key = 'next' | 'prev' | 'enter' | 'backspace' | 'tab';

/** Matterport-style walkthrough keys: WASD walks, IJKL turns the camera. */
export type HoldKey = 'w' | 'a' | 's' | 'd' | 'i' | 'j' | 'k' | 'l';

/** App switcher: open holds Alt (Cmd on macOS) and taps Tab; arrows move the highlight; close lets go and picks it.
 *  keep is re-sent while open: the agent lets go on its own after 1 s of silence. */
export type SwitchAction = 'open' | 'left' | 'right' | 'up' | 'down' | 'keep' | 'close';

export type Mode = 'idle' | 'pdf' | 'agent';

/** Laptop -> phone. */
export type HostMsg =
  | { t: 'pong'; id: number }
  | { t: 'challenge'; host: string; nonce: string } // host: the computer's public id; nonce: one per connection
  | { t: 'auth'; state: 'pending' | 'denied' | 'unknown' } // nothing but ping is obeyed until the computer approves the phone
  | { t: 'code'; code: string } // the computer changed its pairing code: follow it
  | { t: 'state'; mode: Mode; page: number; total: number; aspect: number; tour?: boolean; gestures?: boolean }; // tour: agent can hold keys; gestures: agent knows the app switcher

/** Laptop browser -> desktop agent (ws://localhost). */
export type AgentMsg =
  | { t: 'move'; dx: number; dy: number }
  | { t: 'click'; b: 'left' | 'right' }
  | { t: 'scroll'; dy: number }
  | { t: 'key'; k: Key }
  | { t: 'hold'; k: HoldKey; on: boolean }
  | { t: 'text'; s: string }
  | { t: 'switcher'; a: SwitchAction }
  | { t: 'laser'; on: boolean }
  | { t: 'lpos'; x: number; y: number }; // absolute, 0..1
