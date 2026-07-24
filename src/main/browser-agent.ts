import { app } from "electron";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";

// BrowserAgent is a reusable automation primitive layer. It knows nothing about
// any particular website - workflows (browser-workflows.ts) orchestrate these
// primitives. It drives a dedicated Chrome profile (separate from the user's
// everyday Chrome window, which Orbit still controls via AppleScript for plain
// navigation) so Playwright can hold a persistent, real, logged-in session
// without disrupting or locking the user's regular browsing.

let context: BrowserContext | null = null;
let page: Page | null = null;

function profileDir() {
  return path.join(app.getPath("userData"), "browser-agent-profile");
}

async function ensurePage(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  if (!context) {
    context = await chromium.launchPersistentContext(profileDir(), {
      channel: "chrome",
      headless: false,
      viewport: null,
    });
    context.on("close", () => { context = null; page = null; });
  }
  const existing = context.pages();
  page = existing[0] || await context.newPage();
  page.on("close", () => { if (page?.isClosed()) page = null; });
  return page;
}

export async function closeAgent() {
  if (context) await context.close().catch(() => {});
  context = null;
  page = null;
}

// ---- Core primitives ----

export async function openUrl(url: string) {
  const p = await ensurePage();
  await p.goto(url, { waitUntil: "domcontentloaded" });
}

export async function waitForLoad(timeoutMs = 15_000) {
  const p = await ensurePage();
  await p.waitForLoadState("load", { timeout: timeoutMs });
}

export async function pageTitle() {
  return (await ensurePage()).title();
}

export async function visibleText(selector = "body") {
  const p = await ensurePage();
  return (await p.locator(selector).first().innerText()).trim();
}

export async function findElement(selector: string) {
  const p = await ensurePage();
  return (await p.locator(selector).first().count()) > 0;
}

export async function click(selector: string) {
  await (await ensurePage()).locator(selector).first().click();
}

export async function doubleClick(selector: string) {
  await (await ensurePage()).locator(selector).first().dblclick();
}

export async function rightClick(selector: string) {
  await (await ensurePage()).locator(selector).first().click({ button: "right" });
}

export async function hover(selector: string) {
  await (await ensurePage()).locator(selector).first().hover();
}

export async function scroll(direction: "up" | "down" = "down", amount = 800) {
  const p = await ensurePage();
  await p.mouse.wheel(0, direction === "down" ? amount : -amount);
}

export async function typeText(selector: string, text: string) {
  await (await ensurePage()).locator(selector).first().fill(text);
}

export async function clearText(selector: string) {
  await (await ensurePage()).locator(selector).first().fill("");
}

export async function pressKey(key: string) {
  await (await ensurePage()).keyboard.press(key);
}

export async function uploadFile(selector: string, filePath: string | string[]) {
  await (await ensurePage()).locator(selector).first().setInputFiles(filePath);
}

export async function downloadFile(triggerSelector: string, saveAs?: string) {
  const p = await ensurePage();
  const [download] = await Promise.all([
    p.waitForEvent("download"),
    p.locator(triggerSelector).first().click(),
  ]);
  const target = saveAs || path.join(app.getPath("downloads"), download.suggestedFilename());
  await download.saveAs(target);
  return target;
}

export async function selectOption(selector: string, value: string) {
  await (await ensurePage()).locator(selector).first().selectOption(value);
}

export async function pageMetadata() {
  const p = await ensurePage();
  return p.evaluate(() => ({
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
    url: location.href,
  }));
}

// General escape hatch for read-only page inspection (page-intelligence.ts's
// classifier and extractors are built on this). Never used for actions - those
// stay on the named primitives above so call sites read as intent, not raw JS.
export function evaluate<R, Arg>(fn: (arg: Arg) => R, arg: Arg): Promise<R>;
export function evaluate<R>(fn: () => R): Promise<R>;
export async function evaluate(fn: any, arg?: any): Promise<any> {
  const p = await ensurePage();
  return p.evaluate(fn, arg);
}

export async function screenshot(): Promise<string> {
  const p = await ensurePage();
  const buffer = await p.screenshot({ type: "png" });
  return buffer.toString("base64");
}

// ---- Interaction primitives ----

export async function waitUntilExists(selector: string, timeoutMs = 10_000) {
  await (await ensurePage()).locator(selector).first().waitFor({ state: "attached", timeout: timeoutMs });
}

export async function waitUntilClickable(selector: string, timeoutMs = 10_000) {
  const p = await ensurePage();
  const locator = p.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: timeoutMs });
  await locator.scrollIntoViewIfNeeded();
}

export async function retry<T>(action: () => Promise<T>, attempts = 3, delayMs = 500): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await action(); }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, delayMs)); }
  }
  throw lastError instanceof Error ? lastError : new Error("Action failed after retrying");
}

export async function waitForNavigation(timeoutMs = 15_000) {
  await (await ensurePage()).waitForLoadState("load", { timeout: timeoutMs });
}

export async function waitWhileLoading(indicatorSelector: string, timeoutMs = 10_000) {
  const p = await ensurePage();
  const indicator = p.locator(indicatorSelector).first();
  if (await indicator.count()) await indicator.waitFor({ state: "hidden", timeout: timeoutMs }).catch(() => {});
}

export async function scrollUntilStable(maxRounds = 10, pauseMs = 600) {
  const p = await ensurePage();
  let lastHeight = 0;
  for (let round = 0; round < maxRounds; round++) {
    const height = await p.evaluate(() => document.body.scrollHeight);
    if (height === lastHeight) break;
    lastHeight = height;
    await p.mouse.wheel(0, 1600);
    await p.waitForTimeout(pauseMs);
  }
}

// ---- Safety gate ----
// Any workflow step that purchases, sends a message, submits a form, deletes
// data, or posts socially must go through guardedAction(). It refuses to run
// the action unless the caller has already obtained explicit confirmation
// (confirmed=true) - Orbit's IPC layer is responsible for surfacing the
// description to the user and only re-invoking with confirmed=true after
// they say yes.

export type GuardedActionKind = "purchase" | "message" | "form-submit" | "delete" | "social-post";

export class ConfirmationRequiredError extends Error {
  kind: GuardedActionKind;
  constructor(kind: GuardedActionKind, description: string) {
    super(description);
    this.kind = kind;
    this.name = "ConfirmationRequiredError";
  }
}

export async function guardedAction<T>(kind: GuardedActionKind, description: string, confirmed: boolean, action: () => Promise<T>): Promise<T> {
  if (!confirmed) throw new ConfirmationRequiredError(kind, description);
  return action();
}
