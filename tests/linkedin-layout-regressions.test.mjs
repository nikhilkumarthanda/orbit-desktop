import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

test("LinkedIn Jobs opens the jobs destination instead of the LinkedIn feed", async () => {
  const engine = await source("src/main/browser-task-engine.ts");
  const jobsIndex = engine.indexOf('return "https://www.linkedin.com/jobs/"');
  const genericIndex = engine.indexOf('[/\\blinkedin\\b/i, "https://www.linkedin.com"]');
  const fallbackIndex = engine.indexOf("return NAMED_SITES.find");
  assert.ok(jobsIndex >= 0, "LinkedIn Jobs must have a deterministic jobs URL");
  assert.ok(genericIndex >= 0, "generic LinkedIn route must remain available");
  assert.ok(fallbackIndex >= 0, "named-site fallback must remain available");
  assert.ok(jobsIndex < fallbackIndex, "LinkedIn Jobs must be checked before the generic named-site fallback");
});

test("Orbit interaction controls fully reflow inside the compact assistant pane", async () => {
  const css = await source("src/renderer/browser-agent.css");
  assert.match(css, /html\.orbit-browser-open \.assistant-shell\{display:flex!important/);
  assert.match(css, /justify-items:stretch!important/);
  assert.match(css, /html\.orbit-browser-open \.assistant-shell \.space-interaction/);
  assert.match(css, /inset:auto!important/);
  assert.match(css, /width:100%!important/);
  assert.match(css, /html\.orbit-browser-open \.activity-strip/);
  assert.match(css, /html\.orbit-browser-open \.browser-runtime-bar/);
  assert.match(css, /\.space-interaction \.command input\{min-width:0!important;width:0!important\}/);
});
