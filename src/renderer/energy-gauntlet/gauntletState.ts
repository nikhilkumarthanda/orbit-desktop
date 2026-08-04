import type { HandState } from "../orbit-universe/gestures/gestureStateMachine";

export type GauntletPhase = "ball" | "suiting-up" | "suited" | "powering-down";
export type Point = { x: number; y: number };
export type Projectile = { x: number; y: number; vx: number; vy: number; age: number; life: number };
export type Fireball = { active: boolean; x: number; y: number; charge: number };
export type Spark = { angle: number; radius: number; speed: number; size: number; alpha: number; hue: number; burstX: number; burstY: number };
export type BallState = { center: Point; scale: number; rotation: number; rotationVelocity: number; tension: number; burst: number; burstAt: number; lastSeparation: number; lastSeen: number };

export type GauntletState = {
  phase: GauntletPhase;
  phaseStartedAt: number;
  fistSince: number;
  fistStartScale: number;
  powerDownFistSince: number;
  lastProjectileAt: [number, number];
  lastGestures: [string, string];
  projectiles: Projectile[];
  fireball: Fireball;
  ball: BallState;
  sparks: Spark[];
};

export const createGauntletState = (): GauntletState => ({
  phase: "ball",
  phaseStartedAt: 0,
  fistSince: 0,
  fistStartScale: 0,
  powerDownFistSince: 0,
  lastProjectileAt: [0, 0],
  lastGestures: ["", ""],
  projectiles: [],
  fireball: { active: false, x: 0.5, y: 0.5, charge: 0 },
  ball: { center: { x: .5, y: .53 }, scale: 1, rotation: 0, rotationVelocity: 0, tension: 0, burst: 0, burstAt: 0, lastSeparation: .34, lastSeen: 0 },
  sparks: [],
});

export const SUIT_UP_MS = 1500;
export const POWER_DOWN_HOLD_MS = 3000;
export const POWER_DOWN_MS = 900;

const PROJECTILE_COOLDOWN_MS = 260;
const PROJECTILE_SPEED = 0.85;
const PROJECTILE_LIFE = 1.1;
const FIREBALL_DISTANCE = 0.22;
const FIREBALL_CHARGE_PER_MS = 1 / 900;
const FIREBALL_DECAY_PER_MS = 1 / 500;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
const mixPoint = (from: Point, to: Point, amount: number) => ({ x: mix(from.x, to.x, amount), y: mix(from.y, to.y, amount) });

export type GauntletEvent = "suiting-up" | "suited" | "powering-down" | "ball" | "burst" | "projectile" | null;

export const powerDownProgress = (state: GauntletState, now: number) =>
  state.phase === "suited" && state.powerDownFistSince
    ? clamp((now - state.powerDownFistSince) / POWER_DOWN_HOLD_MS, 0, 1)
    : 0;

const tickBall = (state: GauntletState, hands: HandState[], now: number): GauntletEvent => {
  const ball = state.ball;
  if (hands.length < 2) { ball.tension *= .94; ball.lastSeen = now; return null }
  const ordered = [...hands].sort((a, b) => a.palm.x - b.palm.x);
  const midpoint = { x: (ordered[0].palm.x + ordered[1].palm.x) / 2, y: (ordered[0].palm.y + ordered[1].palm.y) / 2 };
  const separation = Math.hypot(ordered[1].palm.x - ordered[0].palm.x, ordered[1].palm.y - ordered[0].palm.y);
  const angle = Math.atan2(ordered[1].palm.y - ordered[0].palm.y, ordered[1].palm.x - ordered[0].palm.x);
  let delta = angle - ball.rotation; while (delta > Math.PI) delta -= Math.PI * 2; while (delta < -Math.PI) delta += Math.PI * 2;
  ball.rotationVelocity = mix(ball.rotationVelocity, delta, .16); ball.rotation += ball.rotationVelocity * .7;
  ball.center = mixPoint(ball.center, { x: clamp(midpoint.x, .2, .8), y: clamp(midpoint.y, .24, .82) }, .13);
  ball.scale = mix(ball.scale, clamp(separation * 2.45, .68, 1.62), .12);
  const bothGrab = ordered.every(hand => hand.pinching);
  if (bothGrab && separation > .3) ball.tension = clamp(ball.tension + (separation - ball.lastSeparation) * 4.2 + .012, 0, 1);
  else ball.tension *= .955;
  const closingSpeed = ball.lastSeparation - separation;
  const clap = ball.tension > .42 && separation < .135 && closingSpeed > .025 && now - ball.burstAt > 2200;
  let event: GauntletEvent = null;
  if (clap) {
    ball.burst = 1; ball.burstAt = now; ball.tension = 0; ball.rotationVelocity *= 1.8;
    state.sparks.forEach(spark => { const force = .8 + Math.random() * 1.25; spark.burstX = Math.cos(spark.angle) * force; spark.burstY = Math.sin(spark.angle) * force });
    event = "burst";
  }
  ball.lastSeparation = separation; ball.lastSeen = now;
  return event;
};

/** Pure tick — advances phase/ball/projectile/fireball state from the current hand set. No drawing, no audio. */
export const updateGauntlet = (state: GauntletState, hands: HandState[], now: number, deltaMs: number): GauntletEvent => {
  const primary = hands[0];

  if (state.phase === "ball") {
    if (primary && primary.gesture === "Fist") {
      if (!state.fistSince) { state.fistSince = now; state.fistStartScale = primary.scale }
      else if (now - state.fistSince >= 220) {
        state.phase = "suiting-up"; state.phaseStartedAt = now; state.fistSince = 0;
        return "suiting-up";
      }
    } else state.fistSince = 0;
    return tickBall(state, hands, now);
  }

  if (state.phase === "suiting-up") {
    if (now - state.phaseStartedAt > SUIT_UP_MS) { state.phase = "suited"; state.phaseStartedAt = now; return "suited" }
    return null;
  }

  if (state.phase === "suited") {
    let spawned = false;
    hands.forEach((hand, index) => {
      const opened = hand.gesture === "Open palm" && state.lastGestures[index] !== "Open palm";
      if (opened && now - state.lastProjectileAt[index] > PROJECTILE_COOLDOWN_MS) {
        state.lastProjectileAt[index] = now; spawned = true;
        const dx = hand.point.x - hand.palm.x, dy = hand.point.y - hand.palm.y, len = Math.max(0.001, Math.hypot(dx, dy));
        state.projectiles.push({ x: hand.palm.x, y: hand.palm.y, vx: (dx / len) * PROJECTILE_SPEED, vy: (dy / len) * PROJECTILE_SPEED, age: 0, life: PROJECTILE_LIFE });
      }
      state.lastGestures[index] = hand.gesture;
    });
    for (let index = hands.length; index < 2; index++) state.lastGestures[index] = "";
    state.projectiles.forEach(p => { p.x += p.vx * (deltaMs / 1000); p.y += p.vy * (deltaMs / 1000); p.age += deltaMs / 1000 });
    state.projectiles = state.projectiles.filter(p => p.age < p.life);

    if (hands.length === 2 && !hands.some(h => h.gesture === "Fist") && Math.hypot(hands[0].palm.x - hands[1].palm.x, hands[0].palm.y - hands[1].palm.y) < FIREBALL_DISTANCE) {
      state.fireball.active = true;
      state.fireball.x = (hands[0].palm.x + hands[1].palm.x) / 2;
      state.fireball.y = (hands[0].palm.y + hands[1].palm.y) / 2;
      state.fireball.charge = clamp(state.fireball.charge + FIREBALL_CHARGE_PER_MS * deltaMs, 0, 1);
    } else {
      state.fireball.charge = clamp(state.fireball.charge - FIREBALL_DECAY_PER_MS * deltaMs, 0, 1);
      if (state.fireball.charge <= 0) state.fireball.active = false;
    }

    if (primary && primary.gesture === "Fist") {
      if (!state.powerDownFistSince) state.powerDownFistSince = now;
      else if (now - state.powerDownFistSince > POWER_DOWN_HOLD_MS) {
        state.phase = "powering-down"; state.phaseStartedAt = now; state.powerDownFistSince = 0;
        return "powering-down";
      }
    } else state.powerDownFistSince = 0;
    return spawned ? "projectile" : null;
  }

  // powering-down
  if (now - state.phaseStartedAt > POWER_DOWN_MS) {
    state.phase = "ball"; state.phaseStartedAt = now;
    state.projectiles = []; state.lastGestures = ["", ""]; state.fireball = { active: false, x: 0.5, y: 0.5, charge: 0 };
    return "ball";
  }
  return null;
};
