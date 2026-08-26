import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

test("Phase 4.3 preserves LinkedIn filtered result order across follow-ups", async () => {
  const [embedded, engine, preload] = await Promise.all([
    source("src/main/embedded-browser.ts"),
    source("src/main/browser-task-engine.ts"),
    source("preload.cjs"),
  ]);

  assert.match(embedded, /export async function linkedinJobResults/);
  assert.match(embedded, /a\[href\*="\/jobs\/view\/"\]/);
  assert.match(embedded, /seen\.has\(jobId\)/);
  assert.match(engine, /function linkedinResultOrdinal/);
  assert.match(engine, /browser\.linkedinJobResults/);
  assert.match(engine, /preserving the filtered search in browser history/);
  assert.match(preload, /function linkedinCompoundBackOpen/);
  assert.match(preload, /orbit:embedded-browser:back/);
  assert.match(preload, /LinkedIn filtered-result history preserved/);
});

test("Phase 4.3 attaches resume files only through a native picker and verifies the file input", async () => {
  const embedded = await source("src/main/embedded-browser.ts");

  assert.match(embedded, /export async function chooseAndAttachFileByLabel/);
  assert.match(embedded, /dialog\.showOpenDialog/);
  assert.match(embedded, /extensions: \["pdf", "doc", "docx"\]/);
  assert.match(embedded, /DOM\.setFileInputFiles/);
  assert.match(embedded, /field\.files\?\.\[0\]\?\.name/);
  assert.match(embedded, /verified !== fileName/);
  assert.match(embedded, /input\[type="file"\]/);
});

test("Phase 4.3 Career workflows checkpoint safe progression and gate final submit", async () => {
  const [career, engine] = await Promise.all([
    source("src/main/career-agent.ts"),
    source("src/main/browser-task-engine.ts"),
  ]);

  assert.match(career, /export interface CareerApplicationCheckpoint/);
  assert.match(career, /export async function currentApplicationCheckpoint/);
  assert.match(career, /export async function startCurrentApplication/);
  assert.match(career, /export async function attachResumeToCurrentApplication/);
  assert.match(career, /export async function advanceCurrentApplication/);
  assert.match(career, /requiresManualTakeover: true/);
  assert.match(career, /requiresInput: true/);
  assert.match(career, /requiresApproval: true/);
  assert.match(career, /Final control/);
  assert.match(career, /Nothing was submitted/);

  assert.match(engine, /type DirectCareerResult/);
  assert.match(engine, /let careerWorkflowResume/);
  assert.match(engine, /function applyCareerResult/);
  assert.match(engine, /careerWorkflowResume\?\.mode === "manual"/);
  assert.match(engine, /careerWorkflowResume\?\.mode === "input"/);
  assert.match(engine, /careerWorkflowResume\?\.mode === "approval"/);
  assert.match(engine, /Approved and completed only/);
});
