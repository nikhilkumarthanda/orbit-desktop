import { generateSection, type ObstacleKind } from "./obstacleGenerator";
import { mulberry32, randomSeed, type Rng } from "./seededRandom";

export type EscapeObstacle = { lane: number; z: number; kind: ObstacleKind; ringValue?: number; passed: boolean; nearMissChecked: boolean };
export type EscapeToast = { text: string; ttl: number } | null;
export type EscapeState = {
  running: boolean; over: boolean; lane: number; targetLane: number; distance: number; score: number; best: number;
  speed: number; multiplier: number; combo: number; dash: number; obstacles: EscapeObstacle[]; lastSpawn: number;
  lastSectionDashRequired: boolean; seed: number; rng: Rng; toast: EscapeToast;
  runId: string | null; startedAt: number;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;

const COLLISION_LANE_DIST = 0.42;
const NEAR_MISS_LANE_DIST = 0.9;
const NEAR_MISS_BASE = 40;
const MAX_COMBO = 12;
const MAX_MULTIPLIER = 8;
const TOAST_TTL = 90;

export const createEscapeState = (seed: number = randomSeed()): EscapeState => {
  return {
    running: false,
    over: false,
    lane: 0,
    targetLane: 0,
    distance: 0,
    score: 0,
    best: Number(localStorage.getItem("orbit-escape-best") ?? 0),
    speed: 0.006,
    multiplier: 1,
    combo: 0,
    dash: 1,
    obstacles: [],
    lastSpawn: 0,
    lastSectionDashRequired: false,
    seed,
    rng: mulberry32(seed),
    toast: null,
    runId: null,
    startedAt: 0,
  };
};

export const steerEscape = (game: EscapeState, direction: -1 | 1) => {
  if (game.running) game.targetLane = clamp(game.targetLane + direction, -1, 1);
};

export const dashEscape = (game: EscapeState): boolean => {
  if (game.running && game.dash >= 1) {
    game.dash = 0;
    return true;
  }
  return false;
};

const setToast = (game: EscapeState, text: string) => { game.toast = { text, ttl: TOAST_TTL } };

/** Advances game state one tick (spawn, movement, collision, scoring). Pure state — no drawing. */
export const tickEscape = (game: EscapeState): { justEnded: boolean } => {
  let justEnded = false;
  if (game.toast) { game.toast.ttl -= 1; if (game.toast.ttl <= 0) game.toast = null }
  if (game.running) {
    game.speed = Math.min(0.018, game.speed + 0.0000022); game.distance += game.speed; game.score += game.speed * 125 * game.multiplier; game.dash = Math.min(1, game.dash + 0.0018);

    if (game.distance - game.lastSpawn > 0.19) {
      game.lastSpawn = game.distance;
      const section = generateSection(game.rng, game.lastSectionDashRequired);
      game.lastSectionDashRequired = section.dashRequired;
      for (const spec of section.obstacles) {
        game.obstacles.push({ lane: spec.lane, z: 1, kind: spec.kind, ringValue: spec.ringValue, passed: false, nearMissChecked: false });
      }
    }

    game.lane = mix(game.lane, game.targetLane, 0.13);
    game.obstacles.forEach(obstacle => { obstacle.z -= game.speed * (game.dash < 0.22 ? 1.9 : 1) });

    const inPassWindow = (item: EscapeObstacle) => item.z < 0.115 && item.z > 0.025;

    const collision = game.obstacles.find(item =>
      item.kind !== "ring" && !item.passed && inPassWindow(item) && Math.abs(item.lane - game.lane) < COLLISION_LANE_DIST,
    );
    if (collision && game.dash > 0.22) { game.running = false; game.over = true; game.best = Math.max(game.best, Math.floor(game.score)); localStorage.setItem("orbit-escape-best", String(game.best)); justEnded = true }

    game.obstacles.forEach(item => {
      if (item.nearMissChecked || item.passed || item.kind === "ring" || !inPassWindow(item)) return;
      const laneDist = Math.abs(item.lane - game.lane);
      if (laneDist >= COLLISION_LANE_DIST && laneDist < NEAR_MISS_LANE_DIST) {
        item.nearMissChecked = true;
        game.combo = Math.min(MAX_COMBO, game.combo + 1);
        const bonus = Math.round(NEAR_MISS_BASE * (1 + game.combo * 0.2));
        game.score += bonus;
        setToast(game, `NEAR MISS +${bonus}`);
      }
    });

    game.obstacles.forEach(item => {
      if (item.passed || item.z > 0.02) return;
      item.passed = true;
      if (item.kind === "ring") {
        game.combo = Math.min(MAX_COMBO, game.combo + 1);
        game.multiplier = Math.min(MAX_MULTIPLIER, Math.max(game.multiplier, item.ringValue ?? game.multiplier));
        setToast(game, `RING ×${item.ringValue ?? game.multiplier}`);
      }
    });

    game.obstacles = game.obstacles.filter(item => item.z > -0.2);
  }
  return { justEnded };
};
