import type { NormalizedLandmark } from "@mediapipe/hands";
import { OneEuroFilter } from "./oneEuroFilter";
import { classify, handScale, pinchRatio, type GestureName } from "./classify";

export type Point = { x: number; y: number };
export type HandState = { landmarks: NormalizedLandmark[]; point: Point; palm: Point; gesture: GestureName; pinching: boolean; scale: number };

export const HAND_CONNECTIONS: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

const palmPoint = (lm: NormalizedLandmark[]): Point => ({
  x: (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5,
  y: (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5,
});

const DEBOUNCE_FRAMES = 3;

/**
 * Per-hand jitter filtering + gesture debounce. Pinch-engage stays low-latency (commits
 * immediately, for a responsive "click" feel); every other label change — including
 * pinch-release — needs a few consecutive consistent frames before it's committed, so
 * boundary noise doesn't flicker the reported gesture.
 */
export class GestureStabilizer {
  private palmXFilter = new OneEuroFilter(1.0, 0.5);
  private palmYFilter = new OneEuroFilter(1.0, 0.5);
  private pointXFilter = new OneEuroFilter(0.8, 0.7);
  private pointYFilter = new OneEuroFilter(0.8, 0.7);
  private pinchRatioFilter = new OneEuroFilter(1.5, 0.4);
  private scaleFilter = new OneEuroFilter(1.2, 0.5);
  private pinching = false;
  private committed: GestureName = "Point";
  private pendingLabel: GestureName | null = null;
  private pendingFrames = 0;
  lastPalm: Point = { x: 0.5, y: 0.5 };

  update(landmarks: NormalizedLandmark[], timestampMs: number): HandState {
    const rawPalm = palmPoint(landmarks);
    const palm = { x: this.palmXFilter.filter(rawPalm.x, timestampMs), y: this.palmYFilter.filter(rawPalm.y, timestampMs) };
    const point = { x: this.pointXFilter.filter(landmarks[8].x, timestampMs), y: this.pointYFilter.filter(landmarks[8].y, timestampMs) };
    const ratio = this.pinchRatioFilter.filter(pinchRatio(landmarks), timestampMs);
    const scale = this.scaleFilter.filter(handScale(landmarks), timestampMs);

    const wasPinching = this.pinching;
    const raw = classify(landmarks, wasPinching, ratio);
    this.pinching = raw === "Pinch" || raw === "Drag";

    const engaging = raw === "Pinch" && this.committed !== "Pinch" && this.committed !== "Drag";
    if (engaging || raw === this.committed) {
      this.committed = raw;
      this.pendingLabel = null;
      this.pendingFrames = 0;
    } else if (raw === this.pendingLabel) {
      this.pendingFrames++;
      if (this.pendingFrames >= DEBOUNCE_FRAMES) {
        this.committed = raw;
        this.pendingLabel = null;
        this.pendingFrames = 0;
      }
    } else {
      this.pendingLabel = raw;
      this.pendingFrames = 1;
    }

    this.lastPalm = palm;
    return { landmarks, point, palm, gesture: this.committed, pinching: this.committed === "Pinch" || this.committed === "Drag", scale };
  }
}
