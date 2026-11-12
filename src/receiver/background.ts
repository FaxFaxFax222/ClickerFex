/**
 * In system mode this tab works from behind PowerPoint or another tab. Chrome gives a tab it cannot see
 * a low CPU priority, so when the foreground is busy (a video playing) the phone's movements wait their
 * turn and the cursor stutters. A tab with an open audio stream keeps normal priority.
 *
 * The stream carries a 20 Hz tone at -86 dBFS: far below what any speaker reproduces and below the level
 * at which Chrome shows the speaker icon, but not digital silence, which Chrome detects and stops.
 */
export class KeepAwakeInBackground {
  private ctx: AudioContext | null = null;
  private readonly resume = () => void this.ctx?.resume().catch(() => {});

  start(): void {
    if (this.ctx || typeof AudioContext === 'undefined') return;
    try {
      const ctx = new AudioContext({ latencyHint: 'playback' });
      const tone = ctx.createOscillator();
      const level = ctx.createGain();
      tone.frequency.value = 20;
      level.gain.value = 0.00005;
      tone.connect(level).connect(ctx.destination);
      tone.start();
      this.ctx = ctx;
    } catch {
      return;
    }
    // Without a click on the page the browser keeps audio suspended (restored session): start at the first one.
    window.addEventListener('pointerdown', this.resume);
    window.addEventListener('keydown', this.resume);
    this.resume();
  }

  stop(): void {
    window.removeEventListener('pointerdown', this.resume);
    window.removeEventListener('keydown', this.resume);
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
