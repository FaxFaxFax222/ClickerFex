/**
 * Where the phone's top edge (selfie-camera end) points, as world-frame angles.
 * Absolute orientation, not integrated angular velocity: pointing at the same spot always
 * gives the same angles, and rolling the phone around its long axis has no effect — like a laser.
 */
export type Aim = { yaw: number; pitch: number }; // radians; yaw grows turning left, pitch grows pointing up

type Source = 'sensor' | 'event';

interface OrientationSensorLike extends EventTarget {
  quaternion?: ArrayLike<number>;
  start(): void;
  stop(): void;
}
type OrientationSensorCtor = new (opts: { frequency: number; referenceFrame?: 'device' | 'screen' }) => OrientationSensorLike;

/** Device +Y axis expressed in world coordinates (X east, Y north, Z up). */
function aimFromVector(px: number, py: number, pz: number): Aim {
  return { yaw: Math.atan2(-px, py), pitch: Math.asin(Math.max(-1, Math.min(1, pz))) };
}

export class AimTracker {
  source: Source | null = null;
  private sensor: OrientationSensorLike | null = null;
  private eventBound = false;
  private gotData = false;

  constructor(private readonly onAim: (aim: Aim) => void) {}

  /** Must be called from a user gesture (iOS permission prompt). Resolves false if no orientation data is available. */
  async start(): Promise<boolean> {
    if (this.source === 'sensor' && this.sensor) {
      this.sensor.start();
      return true;
    }
    if (this.source === 'event') return true;
    if (await this.trySensor()) return true;
    return this.tryEvent();
  }

  /** Releases the sensor while the page is hidden (battery). */
  pause(): void {
    this.sensor?.stop();
  }

  /**
   * Generic Sensor API (Chrome Android): gyro + accelerometer fusion, no magnetometer,
   * so projectors and metal lecterns cannot bend the beam.
   */
  private async trySensor(): Promise<boolean> {
    const Ctor = (window as unknown as { RelativeOrientationSensor?: OrientationSensorCtor }).RelativeOrientationSensor;
    if (!Ctor) return false;
    try {
      const states = await Promise.all(
        (['accelerometer', 'gyroscope'] as const).map((name) =>
          navigator.permissions.query({ name: name as PermissionName }).then((s) => s.state).catch(() => 'prompt'),
        ),
      );
      if (states.includes('denied')) return false;
      const sensor = new Ctor({ frequency: 60, referenceFrame: 'device' });
      const ok = await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => resolve(false), 1200);
        sensor.addEventListener('reading', () => {
          clearTimeout(timer);
          resolve(true);
        }, { once: true });
        sensor.addEventListener('error', () => {
          clearTimeout(timer);
          resolve(false);
        }, { once: true });
        sensor.start();
      });
      if (!ok) {
        sensor.stop();
        return false;
      }
      sensor.addEventListener('reading', () => {
        const q = sensor.quaternion;
        if (!q) return;
        const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
        // Second column of the rotation matrix = device +Y in world frame.
        this.onAim(aimFromVector(2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)));
      });
      this.sensor = sensor;
      this.source = 'sensor';
      return true;
    } catch {
      return false;
    }
  }

  /** Fallback: deviceorientation Euler angles (Z-X'-Y''). Pointing vector = Rz(α)·Rx(β)·(0,1,0); γ (roll) drops out. */
  private async tryEvent(): Promise<boolean> {
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === 'function') {
      try {
        if ((await DOE.requestPermission()) === 'denied') return false;
      } catch {
        /* no user activation: events may still arrive */
      }
    }
    if (!this.eventBound) {
      window.addEventListener('deviceorientation', (e) => {
        if (e.alpha === null || e.beta === null) return;
        this.gotData = true;
        const a = (e.alpha * Math.PI) / 180;
        const b = (e.beta * Math.PI) / 180;
        this.onAim(aimFromVector(-Math.sin(a) * Math.cos(b), Math.cos(a) * Math.cos(b), Math.sin(b)));
      });
      this.eventBound = true;
    }
    this.source = 'event';
    return true;
  }

  get hasData(): boolean {
    return this.source === 'sensor' || this.gotData;
  }
}

/** One Euro filter: heavy smoothing when the hand is still (kills tremor), little lag when it moves. */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;

  constructor(private readonly minCutoff = 1.2, private readonly beta = 3, private readonly dCutoff = 1) {}

  reset(): void {
    this.x = null;
  }

  filter(value: number, tMs: number): number {
    if (this.x === null) {
      this.x = value;
      this.t = tMs;
      return value;
    }
    const dt = Math.max((tMs - this.t) / 1000, 1e-3);
    this.t = tMs;
    const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff) * (value - this.x);
    return this.x;
  }
}
