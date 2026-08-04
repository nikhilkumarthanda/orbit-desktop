import test from "node:test";
import assert from "node:assert/strict";
import {
  POWER_DOWN_HOLD_MS,
  SUIT_UP_MS,
  createGauntletState,
  powerDownProgress,
  updateGauntlet,
} from "../src/renderer/energy-gauntlet/gauntletState.ts";

const hand = (gesture, overrides = {}) => ({
  gesture,
  pinching: false,
  scale: 0.2,
  palm: { x: 0.5, y: 0.5 },
  point: { x: 0.5, y: 0.25 },
  landmarks: [],
  ...overrides,
});

test("a deliberate fist starts the gauntlet assembly", () => {
  const state = createGauntletState();
  assert.equal(updateGauntlet(state, [hand("Fist")], 1000, 16), null);
  assert.equal(updateGauntlet(state, [hand("Fist")], 1220, 16), "suiting-up");
  assert.equal(state.phase, "suiting-up");
  assert.equal(updateGauntlet(state, [hand("Fist")], 1220 + SUIT_UP_MS + 1, 16), "suited");
  assert.equal(state.phase, "suited");
});

test("opening a suited palm emits one blast instead of an automatic stream", () => {
  const state = createGauntletState();
  state.phase = "suited";
  assert.equal(updateGauntlet(state, [hand("Open palm")], 1000, 16), "projectile");
  assert.equal(updateGauntlet(state, [hand("Open palm")], 1400, 16), null);
  assert.equal(state.projectiles.length, 1);
  updateGauntlet(state, [hand("Fist")], 1500, 16);
  assert.equal(updateGauntlet(state, [hand("Open palm")], 1800, 16), "projectile");
  assert.equal(state.projectiles.length, 2);
});

test("gauntlet retracts only after a continuous three-second fist hold", () => {
  const state = createGauntletState();
  state.phase = "suited";
  updateGauntlet(state, [hand("Fist")], 1000, 16);
  assert.equal(powerDownProgress(state, 2500), 0.5);
  assert.equal(updateGauntlet(state, [hand("Fist")], 1000 + POWER_DOWN_HOLD_MS - 1, 16), null);
  assert.equal(state.phase, "suited");
  assert.equal(updateGauntlet(state, [hand("Fist")], 1000 + POWER_DOWN_HOLD_MS + 1, 16), "powering-down");
  assert.equal(state.phase, "powering-down");
});

test("opening the hand cancels the retraction hold", () => {
  const state = createGauntletState();
  state.phase = "suited";
  updateGauntlet(state, [hand("Fist")], 1000, 16);
  updateGauntlet(state, [hand("Open palm")], 2600, 16);
  assert.equal(state.powerDownFistSince, 0);
  assert.equal(powerDownProgress(state, 3000), 0);
});
