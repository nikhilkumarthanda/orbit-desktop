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

export const drawEscape = (ctx: CanvasRenderingContext2D, width: number, height: number, game: EscapeState, t: number): { justEnded: boolean } => {
  const horizon = height * 0.29, roadBottom = height * 1.04, centerX = width * 0.5;
  let justEnded = false;
  const bg = ctx.createLinearGradient(0, 0, 0, height); bg.addColorStop(0, "#01030a"); bg.addColorStop(.48, "#07101a"); bg.addColorStop(1, "#020407"); ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < 360; i++) { const x = ((Math.sin(i * 73.37) * 27183.17) % 1 + 1) % 1 * width, y = ((Math.sin(i * 41.71) * 13731.91) % 1 + 1) % 1 * horizon * .95; ctx.fillStyle = `rgba(220,235,255,${.16 + (i % 13 === 0 ? .55 : 0)})`; ctx.fillRect(x, y, i % 13 === 0 ? 1.4 : .55, i % 13 === 0 ? 1.4 : .55) }
  const anomaly = ctx.createRadialGradient(width * .78, height * .14, 2, width * .78, height * .14, width * .22); anomaly.addColorStop(0, "#000"); anomaly.addColorStop(.12, "#020207"); anomaly.addColorStop(.16, "rgba(178,211,255,.78)"); anomaly.addColorStop(.2, "rgba(43,91,155,.2)"); anomaly.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = anomaly; ctx.fillRect(0, 0, width, height * .55);
  ctx.fillStyle = "#080d14"; ctx.beginPath(); ctx.moveTo(0, height); ctx.lineTo(width * .34, horizon); ctx.lineTo(width * .66, horizon); ctx.lineTo(width, height); ctx.closePath(); ctx.fill();
  for (let line = -1; line <= 1; line++) { ctx.strokeStyle = "rgba(111,161,202,.16)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(centerX + line * width * .055, horizon); ctx.lineTo(centerX + line * width * .28, roadBottom); ctx.stroke() }
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
  const project = (lane: number, z: number) => { const depth = 1 - clamp(z, 0, 1), spread = width * (.055 + depth * .225); return { x: centerX + lane * spread, y: horizon + (roadBottom - horizon) * depth, scale: .1 + depth * 1.22 } };
  game.obstacles.slice().sort((a, b) => b.z - a.z).forEach(item => { const p = project(item.lane, item.z), r = 22 * p.scale; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(t * (item.kind === "debris" ? .7 : .18) + item.lane); ctx.shadowColor = item.kind === "rift" ? "#509cff" : "#8db9d1"; ctx.shadowBlur = item.kind === "rift" ? 22 : 7; if (item.kind === "rift") { ctx.strokeStyle = "rgba(102,170,255,.85)"; ctx.lineWidth = 5 * p.scale; ctx.beginPath(); ctx.ellipse(0, 0, r * .6, r * 1.35, 0, 0, Math.PI * 2); ctx.stroke() } else { ctx.fillStyle = item.kind === "ice" ? "#7692a4" : "#343b43"; ctx.strokeStyle = "#b6d4df"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-r, -r * .55); ctx.lineTo(r * .52, -r); ctx.lineTo(r, r * .4); ctx.lineTo(0, r); ctx.lineTo(-r * .75, r * .35); ctx.closePath(); ctx.fill(); ctx.stroke() } ctx.restore() });
  const shipX = centerX + game.lane * width * .28, shipY = height * .81, shipScale = Math.min(width, height) / 780; ctx.save(); ctx.translate(shipX, shipY); ctx.scale(shipScale, shipScale); ctx.shadowColor = game.dash < .22 ? "#d9f6ff" : "#5fcaff"; ctx.shadowBlur = game.dash < .22 ? 38 : 16; ctx.fillStyle = "#c7d2d8"; ctx.beginPath(); ctx.moveTo(0, -31); ctx.lineTo(24, 21); ctx.lineTo(7, 14); ctx.lineTo(0, 28); ctx.lineTo(-7, 14); ctx.lineTo(-24, 21); ctx.closePath(); ctx.fill(); ctx.fillStyle = game.dash < .22 ? "#fff" : "#62cfff"; ctx.beginPath(); ctx.moveTo(-7, 19); ctx.lineTo(0, 48 + (game.dash < .22 ? 35 : 0)); ctx.lineTo(7, 19); ctx.fill(); ctx.restore();
  ctx.fillStyle = "#eef6fb"; ctx.font = "600 12px Inter, sans-serif"; ctx.textAlign = "left"; ctx.fillText(`SCORE  ${Math.floor(game.score).toString().padStart(6, "0")}`, 32, 42); ctx.fillStyle = "#81909d"; ctx.fillText(`BEST  ${game.best.toString().padStart(6, "0")}`, 32, 62); ctx.textAlign = "right"; ctx.fillStyle = "#d7e8f2"; ctx.fillText(`× ${game.multiplier.toFixed(2)}`, width - 32, 42); ctx.fillStyle = "rgba(115,191,231,.25)"; ctx.fillRect(width - 152, 54, 120, 3); ctx.fillStyle = "#8edcff"; ctx.fillRect(width - 152, 54, 120 * game.dash, 3);
  if (!game.running) { ctx.textAlign = "center"; ctx.fillStyle = "#f3f7fa"; ctx.font = "300 34px Inter, sans-serif"; ctx.fillText(game.over ? "SIGNAL LOST" : "ORBIT ESCAPE", centerX, height * .42); ctx.fillStyle = "#94a6b2"; ctx.font = "500 11px Inter, sans-serif"; ctx.fillText(game.over ? "ENTER TO RUN AGAIN" : "A / D TO STEER  ·  SPACE TO PHASE DASH", centerX, height * .42 + 28) }
  return { justEnded };
};
