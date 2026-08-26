import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

test("Career autofill turns missing reusable profile fields into conversational onboarding", async () => {
  const career = await source("src/main/career-agent.ts");

  assert.match(career, /export type CareerProfileSetupField/);
  assert.match(career, /careerProfileSetupOrder[^\n]*\["fullName", "email", "phone", "location", "linkedin", "github"\]/);
  assert.match(career, /export async function missingCareerProfileFields/);
  assert.match(career, /export async function saveCareerProfileSetupAnswer/);
  assert.match(career, /profileFromInstruction\(cleanAnswer\)/);
  assert.match(career, /fallbackProfileFieldValue\(field, cleanAnswer\)/);
  assert.match(career, /requiresProfileSetup: true/);
  assert.match(career, /I will resume this autofill automatically when setup is complete/);
  assert.match(career, /legal\/EEO\/compensation\/visa\/authentication answers are never promoted here/);
  assert.match(career, /safeProfileKeys/);
});

test("Career profile onboarding remains a resumable input task and resumes its parent Career action", async () => {
  const engine = await source("src/main/browser-task-engine.ts");

  assert.match(engine, /let careerProfileSetup:/);
  assert.match(engine, /function applyCareerResult/);
  assert.match(engine, /result\\.requiresProfileSetup && result\\.nextProfileField/);
  assert.match(engine, /active\\.status = "waiting_for_confirmation"/);
  assert.match(engine, /active\.pendingKind = "input"/);
  assert.match(engine, /Career profile: \$\{careerProfileSetupFieldLabel/);
  assert.match(engine, /saveCareerProfileSetupAnswer\(currentField, cleanAnswer\)/);
  assert.match(engine, /const originalGoal = careerProfileSetup\.originalGoal/);
  assert.match(engine, /handleCareerCommand\(originalGoal\)/);
  assert.match(engine, /Career profile setup complete\. Resuming the Career task you originally requested/);
  assert.match(engine, /Orbit is still setting up your reusable Career profile/);
  assert.match(engine, /careerProfileSetup = null/);
});
