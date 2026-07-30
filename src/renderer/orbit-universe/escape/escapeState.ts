export type EscapeObstacle = { lane: number; z: number; kind: "ice" | "debris" | "rift"; passed: boolean };
export type EscapeState = { running: boolean; over: boolean; lane: number; targetLane: number; distance: number; score: number; best: number; speed: number; multiplier: number; dash: number; obstacles: EscapeObstacle[]; lastSpawn: number };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;

export const createEscapeState = (): EscapeState => ({
  running: false,
  over: false,
  lane: 0,
  targetLane: 0,
  distance: 0,
  score: 0,
  best: Number(localStorage.getItem("orbit-escape-best") ?? 0),
  speed: 0.006,
  multiplier: 1,
  dash: 1,
  obstacles: [],
  lastSpawn: 0,
});

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

/** Advances game state one tick (spawn, movement, collision, scoring). Pure state — no drawing. */
export const tickEscape = (game: EscapeState): { justEnded: boolean } => {
  let justEnded = false;
  if (game.running) {
    game.speed = Math.min(.018, game.speed + .0000022); game.distance += game.speed; game.score += game.speed * 125 * game.multiplier; game.dash = Math.min(1, game.dash + .0018);
    if (game.distance - game.lastSpawn > .19) { game.lastSpawn = game.distance; const lane = ([-1, 0, 1] as const)[Math.floor(Math.random() * 3)]; game.obstacles.push({ lane, z: 1, kind: (["ice", "debris", "rift"] as const)[Math.floor(Math.random() * 3)], passed: false }) }
    game.lane = mix(game.lane, game.targetLane, .13);
    game.obstacles.forEach(obstacle => { obstacle.z -= game.speed * (game.dash < .22 ? 1.9 : 1) });
    const collision = game.obstacles.find(item => !item.passed && item.z < .115 && item.z > .025 && Math.abs(item.lane - game.lane) < .42);
    if (collision && game.dash > .22) { game.running = false; game.over = true; game.best = Math.max(game.best, Math.floor(game.score)); localStorage.setItem("orbit-escape-best", String(game.best)); justEnded = true }
    game.obstacles.forEach(item => { if (!item.passed && item.z <= .02) { item.passed = true; game.multiplier = Math.min(8, game.multiplier + .25) } });
    game.obstacles = game.obstacles.filter(item => item.z > -.2);
  }
  return { justEnded };
};
