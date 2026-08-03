import test from "node:test";
import assert from "node:assert/strict";
import { mulberry32, seedFromLocalDate } from "../src/renderer/orbit-universe/escape/seededRandom.ts";
import { generateSection } from "../src/renderer/orbit-universe/escape/obstacleGenerator.ts";
import { nextHandLane } from "../src/renderer/orbit-universe/escape/laneHysteresis.ts";

const HAZARD_KINDS = new Set(["slab", "wreckage", "fragment", "rift", "collapsing", "sweep"]);
const LANES = [-1, 0, 1];

test("mulberry32 is deterministic for a given seed", () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((v) => v >= 0 && v < 1));
});

test("mulberry32 produces different sequences for different seeds", () => {
  const a = mulberry32(1);
  const b = mulberry32(2);
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  assert.notDeepEqual(seqA, seqB);
});

test("seedFromLocalDate is stable for the same calendar date and differs across dates", () => {
  const day1a = seedFromLocalDate(new Date(2026, 0, 15));
  const day1b = seedFromLocalDate(new Date(2026, 0, 15));
  const day2 = seedFromLocalDate(new Date(2026, 0, 16));
  assert.equal(day1a, day1b);
  assert.notEqual(day1a, day2);
});

test("generateSection never leaves all three lanes hazarded unless flagged dashRequired", () => {
  for (let seed = 0; seed < 200; seed++) {
    const rng = mulberry32(seed);
    let previousWasDashRequired = false;
    for (let step = 0; step < 100; step++) {
      const section = generateSection(rng, previousWasDashRequired);
      if (!section.dashRequired) {
        const hazardLanes = new Set(
          section.obstacles.filter((o) => HAZARD_KINDS.has(o.kind)).map((o) => o.lane),
        );
        const clearLaneExists = LANES.some((lane) => !hazardLanes.has(lane));
        assert.ok(clearLaneExists, `seed ${seed} step ${step}: no clear lane in a non-dash section (hazard lanes: ${[...hazardLanes]})`);
      }
      previousWasDashRequired = section.dashRequired;
    }
  }
});

test("generateSection never produces two dashRequired sections back-to-back", () => {
  for (let seed = 0; seed < 200; seed++) {
    const rng = mulberry32(seed);
    let previousWasDashRequired = false;
    for (let step = 0; step < 200; step++) {
      const section = generateSection(rng, previousWasDashRequired);
      if (previousWasDashRequired) {
        assert.equal(section.dashRequired, false, `seed ${seed} step ${step}: dashRequired section followed another dashRequired section`);
      }
      previousWasDashRequired = section.dashRequired;
    }
  }
});

test("dashRequired sections hazard all three lanes", () => {
  let sawDashRequired = false;
  for (let seed = 0; seed < 50; seed++) {
    const rng = mulberry32(seed);
    let previousWasDashRequired = false;
    for (let step = 0; step < 200; step++) {
      const section = generateSection(rng, previousWasDashRequired);
      if (section.dashRequired) {
        sawDashRequired = true;
        const lanes = new Set(section.obstacles.map((o) => o.lane));
        assert.deepEqual([...lanes].sort(), [-1, 0, 1]);
        assert.ok(section.obstacles.every((o) => HAZARD_KINDS.has(o.kind)));
      }
      previousWasDashRequired = section.dashRequired;
    }
  }
  assert.ok(sawDashRequired, "expected at least one dashRequired section across 50 seeds x 200 steps");
});

test("ring sections carry a ringValue between 2 and 5 and are never treated as hazards", () => {
  let sawRing = false;
  for (let seed = 0; seed < 50; seed++) {
    const rng = mulberry32(seed);
    let previousWasDashRequired = false;
    for (let step = 0; step < 200; step++) {
      const section = generateSection(rng, previousWasDashRequired);
      for (const obstacle of section.obstacles) {
        if (obstacle.kind === "ring") {
          sawRing = true;
          assert.ok(!HAZARD_KINDS.has("ring"));
          assert.ok(obstacle.ringValue >= 2 && obstacle.ringValue <= 5, `unexpected ringValue ${obstacle.ringValue}`);
        }
      }
      previousWasDashRequired = section.dashRequired;
    }
  }
  assert.ok(sawRing, "expected at least one ring section across 50 seeds x 200 steps");
});

test("nextHandLane does not flicker for a hand resting near a lane boundary", () => {
  // A hand sitting exactly at the old hard-cutoff (0.38) jittering by +-0.01 around it must not
  // bounce the committed lane back and forth once it has committed to the left lane.
  let lane = 0;
  lane = nextHandLane(lane, 0.36); // crosses into left lane
  assert.equal(lane, -1);
  for (const jitter of [0.37, 0.39, 0.36, 0.4, 0.38, 0.41]) {
    lane = nextHandLane(lane, jitter);
    assert.equal(lane, -1, `expected to stay in left lane at palmX=${jitter}`);
  }
});

test("nextHandLane requires crossing the looser exit threshold to leave a side lane", () => {
  let lane = nextHandLane(0, 0.3); // commits to left lane (< 0.38)
  assert.equal(lane, -1);
  lane = nextHandLane(lane, 0.4); // past entry threshold but not yet past exit threshold (0.44)
  assert.equal(lane, -1);
  lane = nextHandLane(lane, 0.45); // past exit threshold now
  assert.equal(lane, 0);
});

test("nextHandLane can jump directly from one side lane to the other", () => {
  let lane = nextHandLane(0, 0.3);
  assert.equal(lane, -1);
  lane = nextHandLane(lane, 0.7);
  assert.equal(lane, 1);
});

test("nextHandLane stays centered for a hand near the middle", () => {
  assert.equal(nextHandLane(0, 0.5), 0);
  assert.equal(nextHandLane(0, 0.45), 0);
  assert.equal(nextHandLane(0, 0.55), 0);
});
