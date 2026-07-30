class LowPass {
  private y = 0;
  private initialized = false;

  filter(x: number, alpha: number): number {
    if (!this.initialized) {
      this.y = x;
      this.initialized = true;
      return x;
    }
    this.y = alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
}

/**
 * 1€ Filter (Casiez et al.) — adapts smoothing strength to signal speed, so a hand
 * held nearly still gets heavy smoothing (kills jitter) while a fast motion gets
 * light smoothing (kills lag). A single fixed blend factor can't do both at once.
 */
export class OneEuroFilter {
  private xFilter = new LowPass();
  private dxFilter = new LowPass();
  private lastTimestamp: number | null = null;
  private lastValue: number | null = null;

  constructor(private minCutoff = 1.0, private beta = 0.0, private dCutoff = 1.0) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value: number, timestampMs: number): number {
    if (this.lastTimestamp === null) {
      this.lastTimestamp = timestampMs;
      this.lastValue = value;
      this.xFilter.filter(value, 1);
      this.dxFilter.filter(0, 1);
      return value;
    }
    const dt = Math.max(1e-3, (timestampMs - this.lastTimestamp) / 1000);
    this.lastTimestamp = timestampMs;
    const derivative = (value - (this.lastValue ?? value)) / dt;
    this.lastValue = value;
    const smoothedDerivative = this.dxFilter.filter(derivative, this.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(smoothedDerivative);
    return this.xFilter.filter(value, this.alpha(cutoff, dt));
  }
}
