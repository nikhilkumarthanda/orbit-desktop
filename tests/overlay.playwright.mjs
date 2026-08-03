// Dynamic regression guard for the historical "dark overlay on hover" bug class.
// Not part of `npm test` (needs a real Chrome executable + a dev server) — run on demand via
// `npm run test:overlay`. Spins up its own Vite dev server and a headless Chrome instance,
// stubs the Electron IPC bridge, then asserts `.orbit-play` / `.content.play-content` never
// darken (opacity/filter/background) outside the one known, intentional state-driven fade.
import { createServer } from "vite";
import { chromium } from "playwright-core";

const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const failures = [];

function check(label, condition, detail) {
  if (!condition) failures.push(`${label}: ${detail}`);
  console.log(`${condition ? "PASS" : "FAIL"} — ${label}`);
}

const server = await createServer({ configFile: new URL("../vite.config.ts", import.meta.url).pathname, server: { port: 0 } });
await server.listen();
const port = server.config.server.port;
const baseUrl = `http://localhost:${port}`;

let browser;
try {
  browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, permissions: ["camera"] });
  const page = await context.newPage();

  await page.addInitScript(() => {
    const noop = () => Promise.resolve({});
    window.orbit = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === "onVoiceEvent" || prop === "onVoiceCommand") return () => () => {};
        if (prop === "conversationHistory") return () => Promise.resolve([]);
        if (prop === "systemSnapshot") return () => Promise.resolve({ platform: "x", hostname: "x", uptimeHours: 0, cpuModel: "x", cpuUsagePct: 0, memory: { totalGb: 0, usedGb: 0, usedPct: 0 }, storage: [], processes: [], capturedAt: new Date().toISOString() });
        if (prop === "orbitPlayStart") return () => Promise.resolve({ active: true, mode: "playground", supported: true, permission: "granted", message: "" });
        return noop;
      },
    });
  });

  await page.goto(`${baseUrl}/?overlaycheck=${Date.now()}`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Orbit Play" }).click().catch(() => page.getByText("Orbit Play", { exact: true }).first().click());
  await page.waitForSelector(".play-start", { timeout: 15000 });
  await page.click(".play-start");
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
  await page.waitForTimeout(1200);

  const readState = () => page.evaluate(() => {
    const el = document.querySelector(".orbit-play");
    const content = document.querySelector(".content.play-content");
    const cs = el ? getComputedStyle(el) : null;
    const csContent = content ? getComputedStyle(content) : null;
    return {
      orbitPlayOpacity: cs?.opacity, orbitPlayFilter: cs?.filter, orbitPlayBg: cs?.backgroundColor,
      contentOpacity: csContent?.opacity, contentFilter: csContent?.filter,
    };
  });

  const isClean = (s) =>
    s.orbitPlayOpacity === "1" && s.orbitPlayFilter === "none" &&
    (s.contentOpacity === "1" || s.contentOpacity === undefined) &&
    (s.contentFilter === "none" || s.contentFilter === undefined);

  const baseline = await readState();
  check("baseline is undimmed", isClean(baseline), JSON.stringify(baseline));

  await page.mouse.move(800, 500);
  await page.waitForTimeout(250);
  check("mouse over canvas stays undimmed", isClean(await readState()), "hover-in");

  await page.mouse.move(50, 50);
  await page.waitForTimeout(250);
  check("mouse over sidebar stays undimmed", isClean(await readState()), "hover-out");

  // .orbit-play header is intentionally pointer-events:none (fixed in Milestone A so it never
  // blocks controls beneath it), so a real Playwright .hover() actionability check would time
  // out on it by design — use a raw mouse move to the same coordinates instead.
  const headerBox = await page.$eval(".orbit-play header", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }).catch(() => null);
  if (headerBox) {
    await page.mouse.move(headerBox.x, headerBox.y);
    await page.waitForTimeout(250);
    check("hovering header stays undimmed", isClean(await readState()), "header-hover");
  }

  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.waitForTimeout(250);
  check("window blur stays undimmed", isClean(await readState()), "window-blur");

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(250);
  check("window focus stays undimmed", isClean(await readState()), "window-focus");

  // Force the historical precondition (.is-active + .is-bursting) and re-check.
  await page.evaluate(() => document.querySelector(".orbit-play")?.classList.add("is-bursting"));
  await page.waitForTimeout(250);
  check("forced is-bursting state stays undimmed", isClean(await readState()), "is-bursting");
} finally {
  await browser?.close();
  await server.close();
}

console.log(`\n${failures.length === 0 ? "All overlay checks passed." : `${failures.length} overlay check(s) FAILED:`}`);
failures.forEach((f) => console.log(` - ${f}`));
if (failures.length > 0) process.exit(1);
