import test from "node:test";
import assert from "node:assert/strict";
import { LocalScoreService } from "../src/renderer/orbit-universe/escape/localScoreService.ts";

function memoryStore() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, v) } };
}

test("startRun issues a runId, a stable daily seed, and the current rules version", async () => {
  const svc = new LocalScoreService(memoryStore());
  const a = await svc.startRun();
  assert.ok(a.runId);
  assert.equal(typeof a.seed, "number");
  assert.equal(a.rulesVersion, 1);
});

test("submitCheckpoint rejects a runId that doesn't match the active run", async () => {
  const svc = new LocalScoreService(memoryStore());
  const { runId } = await svc.startRun();
  const result = await svc.submitCheckpoint("not-the-real-run-id", 100, 1);
  assert.equal(result.accepted, false);
  const good = await svc.submitCheckpoint(runId, 100, 1);
  assert.equal(good.accepted, true);
});

test("submitCheckpoint rejects a decreasing score or distance (monotonic check)", async () => {
  const svc = new LocalScoreService(memoryStore());
  const { runId } = await svc.startRun();
  assert.equal((await svc.submitCheckpoint(runId, 100, 5)).accepted, true);
  assert.equal((await svc.submitCheckpoint(runId, 50, 5)).accepted, false, "score decreased");
  assert.equal((await svc.submitCheckpoint(runId, 100, 2)).accepted, false, "distance decreased");
  assert.equal((await svc.submitCheckpoint(runId, 150, 6)).accepted, true);
});

test("finishRun persists the run and it appears on both leaderboards", async () => {
  const svc = new LocalScoreService(memoryStore());
  await svc.setDisplayName("Nikhil");
  const { runId } = await svc.startRun();
  await svc.submitCheckpoint(runId, 500, 10);
  const result = await svc.finishRun(runId, 500, 12000);
  assert.equal(result.accepted, true);
  assert.equal(result.rank, 1);

  const daily = await svc.getDailyLeaderboard();
  assert.equal(daily.length, 1);
  assert.equal(daily[0].score, 500);
  assert.equal(daily[0].name, "Nikhil");
  assert.equal(daily[0].isSelf, true);

  const global = await svc.getGlobalLeaderboard();
  assert.equal(global.length, 1);
  assert.equal(global[0].score, 500);
});

test("finishRun keeps only the best score across multiple runs on the leaderboards", async () => {
  const svc = new LocalScoreService(memoryStore());
  const run1 = await svc.startRun();
  await svc.finishRun(run1.runId, 300, 8000);
  const run2 = await svc.startRun();
  await svc.finishRun(run2.runId, 150, 4000);

  const global = await svc.getGlobalLeaderboard();
  assert.equal(global.length, 1, "one player should occupy exactly one leaderboard slot");
  assert.equal(global[0].score, 300, "best score should win, not the most recent run");
});

test("abandonRun discards the active run without persisting a score", async () => {
  const svc = new LocalScoreService(memoryStore());
  const { runId } = await svc.startRun();
  await svc.submitCheckpoint(runId, 900, 20);
  await svc.abandonRun(runId);
  const global = await svc.getGlobalLeaderboard();
  assert.equal(global.length, 0, "abandoned runs must not appear on any leaderboard");
});

test("subscribeLive receives updates on checkpoint and stops after unsubscribe", async () => {
  const svc = new LocalScoreService(memoryStore());
  const seen = [];
  const unsubscribe = svc.subscribeLive((entries) => seen.push(entries));
  const { runId } = await svc.startRun();
  await svc.submitCheckpoint(runId, 42, 3);
  unsubscribe();
  await svc.submitCheckpoint(runId, 84, 6);
  const scoresSeen = seen.flatMap((batch) => batch.map((e) => e.score));
  assert.ok(scoresSeen.includes(42));
  assert.ok(!scoresSeen.includes(84), "should not receive updates after unsubscribing");
});

test("setDisplayName validates length and getDisplayName reflects it", async () => {
  const svc = new LocalScoreService(memoryStore());
  assert.equal(svc.getDisplayName(), null);
  assert.equal((await svc.setDisplayName("a")).ok, false);
  assert.equal((await svc.setDisplayName("x".repeat(21))).ok, false);
  const ok = await svc.setDisplayName("  Nik  ");
  assert.equal(ok.ok, true);
  assert.equal(svc.getDisplayName(), "Nik");
});

test("LocalScoreService is always in local mode and every entry is isSelf", async () => {
  const svc = new LocalScoreService(memoryStore());
  assert.equal(svc.mode, "local");
  const { runId } = await svc.startRun();
  await svc.finishRun(runId, 10, 1000);
  const daily = await svc.getDailyLeaderboard();
  assert.ok(daily.every((e) => e.isSelf));
});
