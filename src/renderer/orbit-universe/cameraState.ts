import * as THREE from "three";
import { ALL_BODIES, ORBIT_INDEX } from "./planets";

export type Tier = "galaxy" | "system" | "planet";

export interface CameraState {
  tier: Tier;
  targetTier: Tier;
  focusIndex: number; // -1 = system center (the Sun), 0..7 = Mercury..Neptune, ORBIT_INDEX = Orbit
  targetFocusIndex: number;
  azimuth: number;
  targetAzimuth: number;
  radius: number;
  targetRadius: number;
}

export const createCameraState = (): CameraState => ({
  tier: "system",
  targetTier: "system",
  focusIndex: -1,
  targetFocusIndex: -1,
  azimuth: 0,
  targetAzimuth: 0,
  radius: 46,
  targetRadius: 46,
});

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Sensible orbit-camera radius for a given tier/focus, used to clamp gesture-driven zoom. */
export const radiusRangeFor = (tier: Tier, focusIndex: number): [number, number] => {
  if (tier === "galaxy") return [90, 220];
  if (tier === "planet") {
    const body = focusIndex === ORBIT_INDEX ? ALL_BODIES[ORBIT_INDEX] : ALL_BODIES[focusIndex];
    const r = body?.radius ?? 0.45;
    return [r * 2.4, r * 9];
  }
  return [14, 70];
};

export const clampRadius = (radius: number, tier: Tier, focusIndex: number) => {
  const [min, max] = radiusRangeFor(tier, focusIndex);
  return clamp(radius, min, max);
};

export interface NavStep {
  tier: Tier;
  focusIndex: number;
  radius: number;
}

// The gesture "advance" ladder: galaxy -> whole system -> each real planet in order -> Orbit -> back to galaxy.
export const NAV_STEPS: NavStep[] = [
  { tier: "galaxy", focusIndex: -1, radius: 150 },
  { tier: "system", focusIndex: -1, radius: 46 },
  ...ALL_BODIES.map((body, index) => ({ tier: "planet" as const, focusIndex: index, radius: Math.max(body.radius * 4.2, 1.8) })),
];

export const currentNavStepIndex = (tier: Tier, focusIndex: number) => {
  const found = NAV_STEPS.findIndex((step) => step.tier === tier && step.focusIndex === focusIndex);
  return found === -1 ? 1 : found;
};

export const nextNavStep = (tier: Tier, focusIndex: number): NavStep => NAV_STEPS[(currentNavStepIndex(tier, focusIndex) + 1) % NAV_STEPS.length];

/** World-space position of a body's live orbit at elapsed time t (seconds). */
export const bodyPosition = (index: number, t: number): THREE.Vector3 => {
  const body = ALL_BODIES[index];
  if (!body) return new THREE.Vector3(0, 0, 0);
  const angle = t * body.orbitSpeed + index * 1.37;
  const x = Math.cos(angle) * body.orbitDistance;
  const z = Math.sin(angle) * body.orbitDistance;
  return new THREE.Vector3(x, 0, z);
};
