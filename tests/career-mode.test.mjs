import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("career mode stays in Orbit Browser and has local profile/application primitives", async () => {
  const [career, engine, preload] = await Promise.all([
    source("src/main/career-agent.ts"),
    source("src/main/browser-task-engine.ts"),
    source("preload.cjs"),
  ]);

  assert.match(career, /Orbit Career profile/);
  assert.match(career, /autofillCurrentApplication/);
  assert.match(career, /draftRecruiterOutreach/);
  assert.match(career, /trackCurrentApplication/);
  assert.match(career, /legal, demographic, compensation, identity, authentication, visa, sponsorship, or EEO/i);
  assert.match(career, /Orbit did not submit anything/);

  assert.match(engine, /\.\/career-agent\.js/);
  assert.match(engine, /Opening an Apply or Easy Apply flow is allowed without confirmation/);
  assert.match(engine, /Final submission, sending a message, connecting, publishing/);
  assert.doesNotMatch(engine.match(/const riskyLabels = .*;/)?.[0] || "", /\|apply\|/i);

  assert.match(preload, /looksLikeCareerBrowserRequest/);
  assert.match(preload, /jobright/);
  assert.match(preload, /APPROVE NEXT/);
  assert.match(preload, /orbit:browser:task:resume/);
});

test("career profile storage is intentionally limited to reusable non-sensitive identity/contact fields", async () => {
  const career = await source("src/main/career-agent.ts");
  const safeKeys = career.match(/const safeProfileKeys[\s\S]*?\]\);/)?.[0] || "";
  assert.match(safeKeys, /fullName/);
  assert.match(safeKeys, /email/);
  assert.match(safeKeys, /linkedin/);
  assert.doesNotMatch(safeKeys, /sponsorship|citizenship|race|gender|disability|veteran|salary|ssn/i);
});
