import type { NormalizedLandmark } from "@mediapipe/hands";

export type GestureName = "Point" | "Pinch" | "Drag" | "Scroll" | "Open palm" | "Fist";

const distance = (a: NormalizedLandmark, b: NormalizedLandmark) => Math.hypot(a.x - b.x, a.y - b.y);
const raised = (lm: NormalizedLandmark[], tip: number, pip: number) => lm[tip].y < lm[pip].y;

/** Wrist-to-middle-MCP span, used to scale-normalize the pinch threshold so the same
 *  physical pinch reads the same regardless of how far the hand is from the camera. */
export const handScale = (lm: NormalizedLandmark[]) => Math.max(0.02, distance(lm[0], lm[9]));

export const pinchRatio = (lm: NormalizedLandmark[]) => distance(lm[4], lm[8]) / handScale(lm);

const PINCH_ENGAGE_RATIO = 0.42;
const PINCH_RELEASE_RATIO = 0.58;

export function classify(lm: NormalizedLandmark[], pinching: boolean, ratio: number): GestureName {
  const threshold = pinching ? PINCH_RELEASE_RATIO : PINCH_ENGAGE_RATIO;
  if (ratio < threshold) return pinching ? "Drag" : "Pinch";
  const fingers = [raised(lm, 8, 6), raised(lm, 12, 10), raised(lm, 16, 14), raised(lm, 20, 18)];
  const count = fingers.filter(Boolean).length;
  if (count === 0) return "Fist";
  if (fingers[0] && fingers[1] && !fingers[2] && !fingers[3]) return "Scroll";
  if (fingers[0] && count === 1) return "Point";
  if (count === 4) return "Open palm";
  return "Point";
}
