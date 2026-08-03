import type { Rng } from "./seededRandom";

export type HazardKind = "slab" | "wreckage" | "fragment" | "rift" | "collapsing" | "sweep";
export type ObstacleKind = HazardKind | "ring";
export type Lane = -1 | 0 | 1;

export type ObstacleSpec = { lane: Lane; kind: ObstacleKind; ringValue?: number };
export type SectionResult = { obstacles: ObstacleSpec[]; dashRequired: boolean };

const LANES: readonly Lane[] = [-1, 0, 1];
const HAZARD_KINDS: readonly HazardKind[] = ["slab", "wreckage", "fragment", "rift", "collapsing", "sweep"];
const DASH_SECTION_CHANCE = 0.08;
const RING_ONLY_CHANCE = 0.16;

const shuffleLanes = (rng: Rng): Lane[] => {
  const lanes = [...LANES];
  for (let i = lanes.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
  }
  return lanes;
};

/**
 * Generates one section (a bundle of 0-2 simultaneous obstacles across the 3 lanes).
 * Invariant: every section leaves at least one lane clear, UNLESS it's flagged dashRequired
 * (all 3 lanes hazarded) — and dashRequired sections never occur back-to-back, since the
 * caller must pass the previous section's flag in and this function refuses to roll another
 * one immediately after.
 */
export function generateSection(rng: Rng, previousWasDashRequired: boolean): SectionResult {
  if (!previousWasDashRequired && rng() < DASH_SECTION_CHANCE) {
    const kind: HazardKind = rng() < 0.5 ? "collapsing" : "sweep";
    return { obstacles: LANES.map((lane) => ({ lane, kind })), dashRequired: true };
  }

  if (rng() < RING_ONLY_CHANCE) {
    const lane = LANES[Math.floor(rng() * LANES.length)];
    const ringValue = 2 + Math.floor(rng() * 4);
    return { obstacles: [{ lane, kind: "ring", ringValue }], dashRequired: false };
  }

  const hazardCount = rng() < 0.55 ? 1 : 2;
  const hazardLanes = shuffleLanes(rng).slice(0, hazardCount);
  const obstacles = hazardLanes.map((lane) => ({
    lane,
    kind: HAZARD_KINDS[Math.floor(rng() * HAZARD_KINDS.length)],
  }));
  return { obstacles, dashRequired: false };
}
