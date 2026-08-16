export type ScreenWakeLockSentinel = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
  removeEventListener: (type: "release", listener: () => void) => void;
};

export type ScreenWakeLockRequest = () => Promise<ScreenWakeLockSentinel>;

/**
 * Small lifecycle controller for the optional Screen Wake Lock API. The rest
 * timer remains deadline-based and correct when every request fails.
 */
export class ScreenWakeLockController {
  private active = false;
  private disposed = false;
  private requestGeneration = 0;
  private requestInFlight: Promise<void> | null = null;
  private sentinel: ScreenWakeLockSentinel | null = null;

  constructor(
    private readonly request: ScreenWakeLockRequest | null,
    private readonly isVisible: () => boolean,
  ) {}

  setActive(active: boolean) {
    this.active = active;
    if (active) void this.acquireIfNeeded();
    else void this.release();
  }

  reconcile() {
    if (this.active && this.isVisible()) void this.acquireIfNeeded();
    else void this.release();
  }

  async dispose() {
    this.disposed = true;
    this.active = false;
    await this.release();
  }

  private readonly onRelease = () => {
    this.sentinel?.removeEventListener("release", this.onRelease);
    this.sentinel = null;
    this.requestInFlight = null;
    if (this.active && !this.disposed && this.isVisible()) {
      void this.acquireIfNeeded();
    }
  };

  private acquireIfNeeded() {
    if (
      this.request == null ||
      this.disposed ||
      !this.active ||
      !this.isVisible() ||
      (this.sentinel != null && !this.sentinel.released)
    ) {
      return Promise.resolve();
    }
    if (this.requestInFlight) return this.requestInFlight;

    const generation = ++this.requestGeneration;
    this.requestInFlight = this.request()
      .then(async (sentinel) => {
        if (
          generation !== this.requestGeneration ||
          this.disposed ||
          !this.active ||
          !this.isVisible()
        ) {
          await sentinel.release().catch(() => undefined);
          return;
        }
        this.sentinel = sentinel;
        sentinel.addEventListener("release", this.onRelease);
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation === this.requestGeneration) this.requestInFlight = null;
      });
    return this.requestInFlight;
  }

  private async release() {
    this.requestGeneration += 1;
    this.requestInFlight = null;
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (!sentinel) return;
    sentinel.removeEventListener("release", this.onRelease);
    await sentinel.release().catch(() => undefined);
  }
}
