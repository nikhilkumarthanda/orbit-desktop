import { BrowserWindow, WebContentsView, ipcMain, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { planVisualBrowserTarget } from "./gemini.js";

const PARTITION = "persist:orbit-agent";
const SIDEBAR_WIDTH = 276;
const PANE_GAP = 12;
const BROWSER_TOP = 114;
const MINIMUM_BROWSER_WIDTH = 220;
const MINIMUM_BROWSER_HEIGHT = 180;
const MAXIMUM_AGENT_WIDTH = 720;
const VISUAL_CONFIDENCE = 0.72;
const BLOCKED_SECRET_INPUT = /\b(?:password|passcode|otp|mfa|2fa|verification code|auth(?:entication)? code|captcha|social security|ssn|government id|passport|driver'?s license|credit card|card number|cvv|cvc)\b/i;
const CONSEQUENTIAL_LABEL = /\b(?:submit|send|post|publish|purchase|buy|pay|delete|remove|connect|accept|agree|confirm order|place order)\b/i;
const HOST_LAYOUT_CSS = `
html.orbit-browser-open main {
  grid-template-columns: ${SIDEBAR_WIDTH}px var(--orbit-agent-pane-width, 410px) minmax(0, 1fr) !important;
}
html.orbit-browser-open .content {
  grid-column: 2 !important;
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
  margin: 0 !important;
  padding: 18px 14px !important;
  overflow: hidden !important;
}
html.orbit-browser-open .content.space-content {
  padding: 0 !important;
  overflow: hidden !important;
}
html.orbit-browser-open .assistant-shell {
  box-sizing: border-box !important;
  width: 100% !important;
  max-width: 100% !important;
  min-width: 0 !important;
  padding: 18px 14px 56px !important;
  overflow: hidden !important;
}
html.orbit-browser-open .assistant-heading,
html.orbit-browser-open .assistant-core,
html.orbit-browser-open .quick-prompts,
html.orbit-browser-open .space-stats {
  display: none !important;
}
html.orbit-browser-open .assistant-shell .space-interaction,
html.orbit-browser-open .activity-strip,
html.orbit-browser-open .conversation-history {
  box-sizing: border-box !important;
  width: 100% !important;
  max-width: 100% !important;
  min-width: 0 !important;
}
html.orbit-browser-open .conversation-history {
  max-height: 280px !important;
  overflow: auto !important;
}
html.orbit-browser-open .command,
html.orbit-browser-open .command input,
html.orbit-browser-open .orbit-command-preview {
  max-width: 100% !important;
  min-width: 0 !important;
}
`;

const CURSOR_FACTORY_JS = `(() => {
  let node = document.getElementById('__orbit_agent_cursor');
  if (node) return node;
  node = document.createElement('div');
  node.id = '__orbit_agent_cursor';
  node.setAttribute('aria-hidden', 'true');
  node.style.cssText = 'position:fixed;left:0;top:0;width:20px;height:20px;border:2px solid #9b7cff;border-radius:50%;background:rgba(155,124,255,.12);box-shadow:0 0 0 5px rgba(155,124,255,.10),0 0 22px rgba(155,124,255,.72);pointer-events:none;z-index:2147483647;opacity:.88;transform:translate3d(22px,22px,0);transition:transform 420ms cubic-bezier(.2,.8,.2,1),opacity 120ms ease;mix-blend-mode:difference;';
  const dot = document.createElement('i');
  dot.style.cssText = 'position:absolute;left:50%;top:50%;width:5px;height:5px;border-radius:50%;background:white;transform:translate(-50%,-50%);box-shadow:0 0 8px white;';
  const badge = document.createElement('span');
  badge.textContent = 'ORBIT';
  badge.style.cssText = 'position:absolute;left:16px;top:16px;padding:3px 6px;border-radius:999px;background:#171126;color:#dcd4ff;font:700 8px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.12em;box-shadow:0 4px 14px rgba(0,0,0,.35);white-space:nowrap;';
  node.append(dot, badge);
  document.documentElement.appendChild(node);
  return node;
})()`;

type BrowserTab = { id: string; view: WebContentsView };
export type BrowserAgentActivity = "idle" | "reading_dom" | "visual_inspection" | "target_found" | "acting" | "verifying";

let tabs: BrowserTab[] = [];
let activeTabId = "";
let host: BrowserWindow | null = null;
let resizeListener: (() => void) | null = null;
let layoutCssKey: string | null = null;
let layoutGeneration = 0;
let preferredAgentWidth: number | null = null;
let visible = false;
let agentActivity: BrowserAgentActivity = "idle";

function publicUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Orbit Browser only opens HTTP or HTTPS pages");
  if (/^(?:localhost|127\.|0\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname)) throw new Error("Orbit Browser cannot open private network addresses");
  return url.toString();
}

function findHostWindow() {
  const candidates = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
  if (!candidates.length) throw new Error("Orbit's main window is not available");
  return candidates.sort((a, b) => {
    const aa = a.getContentBounds();
    const bb = b.getContentBounds();
    return bb.width * bb.height - aa.width * aa.height;
  })[0];
}

function activeTab() {
  return tabs.find(tab => tab.id === activeTabId) || tabs[0] || null;
}

function paneGeometry(width: number) {
  const available = Math.max(0, width - SIDEBAR_WIDTH);
  const minimumAgentWidth = 300;
  const automaticAgentWidth = Math.min(430, Math.max(minimumAgentWidth, Math.round(available * 0.34)));
  const preferredBrowserWidth = width >= 1450 ? 820 : width >= 1300 ? 720 : 620;
  let agentWidth = preferredAgentWidth == null
    ? automaticAgentWidth
    : Math.max(minimumAgentWidth, Math.min(MAXIMUM_AGENT_WIDTH, Math.round(preferredAgentWidth)));

  if (preferredAgentWidth == null && available - agentWidth - PANE_GAP * 2 < preferredBrowserWidth) {
    agentWidth = Math.max(minimumAgentWidth, available - preferredBrowserWidth - PANE_GAP * 2);
  }

  const roomyEnough = available >= minimumAgentWidth + MINIMUM_BROWSER_WIDTH + PANE_GAP * 2;
  if (roomyEnough) {
    const maximumAgentWidth = Math.max(minimumAgentWidth, available - MINIMUM_BROWSER_WIDTH - PANE_GAP * 2);
    agentWidth = Math.min(agentWidth, maximumAgentWidth);
  } else {
    // When the window is narrow, protect Orbit first. Never enforce a browser
    // minimum by extending the native WebContentsView beyond the host viewport.
    agentWidth = Math.min(minimumAgentWidth, Math.max(0, available - PANE_GAP * 2));
  }

  const browserX = Math.min(width, SIDEBAR_WIDTH + agentWidth + PANE_GAP);
  const browserWidth = Math.max(0, width - browserX - PANE_GAP);
  return { agentWidth, browserX, browserWidth };
}

async function syncHostLayout(open = visible) {
  if (!host || host.isDestroyed()) return;
  const { agentWidth } = paneGeometry(host.getContentBounds().width);
  const script = open
    ? `document.documentElement.classList.add('orbit-browser-open'); document.documentElement.style.setProperty('--orbit-agent-pane-width', '${agentWidth}px'); document.documentElement.getBoundingClientRect(); true;`
    : `document.documentElement.classList.remove('orbit-browser-open'); document.documentElement.style.removeProperty('--orbit-agent-pane-width'); document.documentElement.getBoundingClientRect(); true;`;
  await host.webContents.executeJavaScript(script).catch(() => false);
}

async function layout() {
  const generation = ++layoutGeneration;
  if (!host || host.isDestroyed()) return;

  const bounds = host.getContentBounds();
  const geometry = paneGeometry(bounds.width);
  const browserHeight = Math.max(0, bounds.height - BROWSER_TOP - PANE_GAP);

  // WebContentsView is a native surface and always sits above the renderer.
  // Hide it while Orbit's DOM switches layouts so there is no frame where the
  // browser can cover the assistant/sidebar with stale bounds.
  for (const tab of tabs) {
    tab.view.setVisible(false);
    tab.view.setBounds({
      x: geometry.browserX,
      y: BROWSER_TOP,
      width: Math.max(1, geometry.browserWidth),
      height: Math.max(1, browserHeight),
    });
  }

  await syncHostLayout();
  if (generation !== layoutGeneration || !host || host.isDestroyed()) return;

  const browserFits = geometry.browserWidth >= MINIMUM_BROWSER_WIDTH && browserHeight >= MINIMUM_BROWSER_HEIGHT;
  for (const tab of tabs) {
    tab.view.setVisible(visible && browserFits && tab.id === activeTabId);
  }
}

function tabSnapshot(tab: BrowserTab) {
  const contents = tab.view.webContents;
  return {
    id: tab.id,
    url: contents.isDestroyed() ? "" : contents.getURL(),
    title: contents.isDestroyed() ? "" : (contents.getTitle() || (contents.getURL() ? "Loading…" : "New tab")),
    loading: !contents.isDestroyed() && contents.isLoading(),
  };
}

export function embeddedBrowserState() {
  const current = activeTab();
  const contents = current && !current.view.webContents.isDestroyed() ? current.view.webContents : null;
  return {
    visible,
    url: contents?.getURL() || "",
    title: contents?.getTitle() || (contents ? "New tab" : ""),
    loading: Boolean(contents?.isLoading()),
    canGoBack: Boolean(contents?.navigationHistory.canGoBack()),
    canGoForward: Boolean(contents?.navigationHistory.canGoForward()),
    activeTabId: current?.id || "",
    agentActivity,
    tabs: tabs.filter(tab => !tab.view.webContents.isDestroyed()).map(tabSnapshot),
  };
}

function emitState() {
  if (!host || host.isDestroyed()) return;
  host.webContents.send("orbit:embedded-browser:state", embeddedBrowserState());
}

function setAgentActivity(activity: BrowserAgentActivity) {
  agentActivity = activity;
  emitState();
}

async function installAgentCursor(target: WebContents) {
  if (target.isDestroyed() || !target.getURL().startsWith("http")) return;
  await target.executeJavaScript(`(() => {
    if (!document.documentElement) return false;
    const cursor = ${CURSOR_FACTORY_JS};
    cursor.style.opacity = '.88';
    return true;
  })()`, true).catch(() => false);
}

function closeAllTabs() {
  ++layoutGeneration;
  if (host && !host.isDestroyed()) {
    for (const tab of tabs) {
      try { host.contentView.removeChildView(tab.view); } catch {}
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
  } else {
    for (const tab of tabs) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }
  tabs = [];
  activeTabId = "";
  agentActivity = "idle";
}

async function ensureHost() {
  const nextHost = findHostWindow();
  if (host === nextHost && !host.isDestroyed()) return host;

  if (resizeListener && host && !host.isDestroyed()) host.removeListener("resize", resizeListener);
  if (layoutCssKey && host && !host.isDestroyed()) void host.webContents.removeInsertedCSS(layoutCssKey).catch(() => {});
  closeAllTabs();

  host = nextHost;
  layoutCssKey = await host.webContents.insertCSS(HOST_LAYOUT_CSS).catch(() => null);
  resizeListener = () => { void layout(); };
  host.on("resize", resizeListener);

  const attachedHost = host;
  attachedHost.once("closed", () => {
    if (host !== attachedHost) return;
    closeAllTabs();
    host = null;
    resizeListener = null;
    layoutCssKey = null;
    visible = false;
  });
  return host;
}

async function createTab(url?: string) {
  const currentHost = await ensureHost();
  const id = randomUUID();
  const tabView = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      javascript: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  tabView.setBackgroundColor("#0b0c10");
  tabView.setBorderRadius(16);
  tabView.setVisible(false);
  currentHost.contentView.addChildView(tabView);

  const tab: BrowserTab = { id, view: tabView };
  tabs.push(tab);
  activeTabId = id;

  const contents = tabView.webContents;
  contents.setWindowOpenHandler(({ url: popupUrl }) => {
    try { void newTab(publicUrl(popupUrl)); } catch {}
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, nextUrl) => {
    try { publicUrl(nextUrl); }
    catch { event.preventDefault(); }
  });
  for (const event of ["did-start-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"] as const) {
    contents.on(event as any, () => emitState());
  }
  contents.on("did-stop-loading", () => {
    if (tab.id === activeTabId) void installAgentCursor(contents);
    emitState();
  });
  contents.on("render-process-gone", () => emitState());

  await layout();
  if (url) await contents.loadURL(publicUrl(url));
  await layout();
  if (visible) void installAgentCursor(contents);
  emitState();
  return tab;
}

async function ensureTab() {
  await ensureHost();
  return activeTab() || createTab();
}

export async function showEmbeddedBrowser() {
  await ensureTab();
  visible = true;
  await layout();
  const current = activeTab();
  if (current) void installAgentCursor(current.view.webContents);
  emitState();
  return embeddedBrowserState();
}

export function hideEmbeddedBrowser() {
  visible = false;
  agentActivity = "idle";
  ++layoutGeneration;
  for (const tab of tabs) tab.view.setVisible(false);
  void syncHostLayout(false);
  emitState();
  return embeddedBrowserState();
}

export async function setAgentPaneWidth(width: number) {
  const requested = Number(width);
  if (!Number.isFinite(requested)) return embeddedBrowserState();
  preferredAgentWidth = Math.max(300, Math.min(MAXIMUM_AGENT_WIDTH, Math.round(requested)));
  await ensureHost();
  await layout();
  emitState();
  return embeddedBrowserState();
}

export async function focusOrbitPane() {
  await ensureHost();
  if (!host || host.isDestroyed()) return embeddedBrowserState();
  host.show();
  host.focus();
  host.webContents.focus();
  emitState();
  return embeddedBrowserState();
}

export async function focusBrowserPane() {
  await ensureTab();
  visible = true;
  await layout();
  const current = activeTab();
  if (host && !host.isDestroyed()) host.focus();
  if (current && !current.view.webContents.isDestroyed()) current.view.webContents.focus();
  emitState();
  return embeddedBrowserState();
}

export async function newTab(url?: string) {
  await ensureHost();
  visible = true;
  await createTab(url);
  await layout();
  emitState();
  return embeddedBrowserState();
}

export async function switchTab(id: string) {
  await ensureHost();
  const target = tabs.find(tab => tab.id === id);
  if (!target) return embeddedBrowserState();
  activeTabId = target.id;
  visible = true;
  await layout();
  void installAgentCursor(target.view.webContents);
  emitState();
  return embeddedBrowserState();
}

export async function closeTab(id: string) {
  await ensureHost();
  const index = tabs.findIndex(tab => tab.id === id);
  if (index < 0) return embeddedBrowserState();
  const [removed] = tabs.splice(index, 1);
  try { host?.contentView.removeChildView(removed.view); } catch {}
  if (!removed.view.webContents.isDestroyed()) removed.view.webContents.close();

  if (activeTabId === id) {
    const replacement = tabs[Math.min(index, tabs.length - 1)] || tabs.at(-1) || null;
    activeTabId = replacement?.id || "";
  }
  if (!tabs.length) visible = false;
  await layout();
  emitState();
  return embeddedBrowserState();
}

async function contents() {
  const tab = await ensureTab();
  return tab.view.webContents;
}

export async function openUrl(url: string) {
  await showEmbeddedBrowser();
  const target = await contents();
  await target.loadURL(publicUrl(url));
  void installAgentCursor(target);
  emitState();
}

export async function pageTitle() { return (await contents()).getTitle(); }
export async function currentUrl() { return (await contents()).getURL(); }

export async function goBack() {
  const target = await contents();
  if (target.navigationHistory.canGoBack()) target.navigationHistory.goBack();
  emitState();
  return embeddedBrowserState();
}

export async function goForward() {
  const target = await contents();
  if (target.navigationHistory.canGoForward()) target.navigationHistory.goForward();
  emitState();
  return embeddedBrowserState();
}

export async function reload() {
  const target = await contents();
  target.reload();
  emitState();
  return embeddedBrowserState();
}

export interface ActionControl {
  kind: string;
  label: string;
  value?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}
export interface ActionSnapshot { title: string; url: string; text: string; controls: ActionControl[] }

export async function actionSnapshot(): Promise<ActionSnapshot> {
  await showEmbeddedBrowser();
  const target = await contents();
  void installAgentCursor(target);
  const snapshot = await target.executeJavaScript(`(() => {
    const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const controls = Array.from(document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[role="link"],[role="combobox"],[role="option"]'))
      .filter(visible)
      .slice(0, 100)
      .map(element => {
        const label = clean(element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.textContent || element.getAttribute('name') || element.getAttribute('value'));
        const tag = element.tagName.toLowerCase();
        const kind = tag === 'input' ? (element.getAttribute('type') || 'input') : (element.getAttribute('role') || tag);
        const rect = element.getBoundingClientRect();
        const value = 'value' in element ? clean(element.value) : clean(element.getAttribute('aria-valuetext') || element.getAttribute('aria-selected') || '');
        return { kind, label: label.slice(0, 120), value: value.slice(0, 180), x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
      })
      .filter(item => item.label);
    return { title: document.title, url: location.href, text: clean(document.body?.innerText).slice(0, 10000), controls };
  })()`, true) as ActionSnapshot;
  emitState();
  return snapshot;
}

export interface VisualBrowserSnapshot extends ActionSnapshot {
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  imageBase64: string;
}

export async function visualSnapshot(): Promise<VisualBrowserSnapshot> {
  await showEmbeddedBrowser();
  const target = await contents();
  const page = await actionSnapshot();
  const viewport = await target.executeJavaScript(`(() => ({ width: Math.max(1, innerWidth), height: Math.max(1, innerHeight), scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) }))()`, true) as VisualBrowserSnapshot["viewport"];
  const previousOpacity = await target.executeJavaScript(`(() => { const cursor = document.getElementById('__orbit_agent_cursor'); if (!cursor) return ''; const previous = cursor.style.opacity; cursor.style.opacity = '0'; return previous; })()`, true).catch(() => "");
  await new Promise(resolve => setTimeout(resolve, 40));
  const image = await target.capturePage();
  await target.executeJavaScript(`(() => { const cursor = document.getElementById('__orbit_agent_cursor'); if (cursor) cursor.style.opacity = ${JSON.stringify(String(previousOpacity || ".88"))}; return true; })()`, true).catch(() => false);
  return { ...page, viewport, imageBase64: image.toPNG().toString("base64") };
}

async function animateCursorTo(x: number, y: number) {
  const target = await contents();
  const px = Math.round(x);
  const py = Math.round(y);
  await target.executeJavaScript(`(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const cursor = ${CURSOR_FACTORY_JS};
    const x = Math.max(4, Math.min(innerWidth - 24, ${px} - 10));
    const y = Math.max(4, Math.min(innerHeight - 24, ${py} - 10));
    cursor.style.opacity = '1';
    cursor.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    await sleep(440);
    cursor.animate([
      { transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(1)' },
      { transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(.72)', boxShadow: '0 0 0 12px rgba(155,124,255,.25),0 0 28px rgba(155,124,255,.95)' },
      { transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(1)' }
    ], { duration: 300, easing: 'ease-out' });
    return true;
  })()`, true);
}

export async function clickAtPoint(x: number, y: number) {
  const target = await contents();
  const viewport = await target.executeJavaScript(`(() => ({ width: Math.max(1, innerWidth), height: Math.max(1, innerHeight) }))()`, true) as { width: number; height: number };
  const px = Math.max(1, Math.min(viewport.width - 2, Math.round(Number(x))));
  const py = Math.max(1, Math.min(viewport.height - 2, Math.round(Number(y))));
  await animateCursorTo(px, py);
  target.sendInputEvent({ type: "mouseMove", x: px, y: py });
  target.sendInputEvent({ type: "mouseDown", x: px, y: py, button: "left", clickCount: 1 });
  target.sendInputEvent({ type: "mouseUp", x: px, y: py, button: "left", clickCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 180));
}

function pageChanged(before: VisualBrowserSnapshot, after: VisualBrowserSnapshot) {
  const beforeControls = JSON.stringify(before.controls.map(control => [control.kind, control.label, control.value]));
  const afterControls = JSON.stringify(after.controls.map(control => [control.kind, control.label, control.value]));
  return before.url !== after.url
    || before.title !== after.title
    || before.text !== after.text
    || beforeControls !== afterControls
    || before.imageBase64 !== after.imageBase64;
}

async function valueAtPoint(x: number, y: number) {
  const target = await contents();
  const px = Math.round(x);
  const py = Math.round(y);
  return target.executeJavaScript(`(() => {
    let element = document.elementFromPoint(${px}, ${py});
    if (!element) return '';
    const editable = element.closest('input,textarea,select,[contenteditable="true"],[role="combobox"]') || element;
    if ('value' in editable) return String(editable.value || '');
    return String(editable.getAttribute?.('aria-valuetext') || editable.textContent || '').replace(/\\s+/g, ' ').trim();
  })()`, true) as Promise<string>;
}

async function fieldValueByLabel(label: string) {
  const target = await contents();
  const encoded = JSON.stringify(label.trim().toLowerCase());
  return target.executeJavaScript(`(() => {
    const wanted = ${encoded};
    const clean = text => String(text || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const fields = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="password"]),textarea,select'));
    const field = fields.find(element => {
      const id = element.id;
      const explicit = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]')?.textContent : '';
      const wrapped = element.closest('label')?.textContent || '';
      const labels = [element.getAttribute('aria-label'), element.getAttribute('placeholder'), element.getAttribute('name'), explicit, wrapped].map(clean);
      return labels.some(item => item && (item === wanted || item.includes(wanted) || wanted.includes(item)));
    });
    return field && 'value' in field ? String(field.value || '') : '';
  })()`, true) as Promise<string>;
}

async function nativeReplaceFocusedText(value: string) {
  const target = await contents();
  const modifier = process.platform === "darwin" ? "meta" : "control";
  target.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: [modifier] });
  target.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: [modifier] });
  target.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
  target.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
  await target.insertText(value);
  await new Promise(resolve => setTimeout(resolve, 180));
}

async function visualTarget(label: string, goal: string, targetKind: "click" | "field" | "option") {
  setAgentActivity("visual_inspection");
  const page = await visualSnapshot();
  const visual = await planVisualBrowserTarget({
    goal,
    requestedLabel: label,
    targetKind,
    imageBase64: page.imageBase64,
    page: {
      title: page.title,
      url: page.url,
      text: page.text,
      controls: page.controls,
      viewport: page.viewport,
    },
  });
  if (visual.confidence < VISUAL_CONFIDENCE) throw new Error(`Orbit could not safely identify “${label}” visually (confidence ${visual.confidence.toFixed(2)})`);
  setAgentActivity("target_found");
  return { page, visual };
}

async function visualFill(label: string, value: string) {
  if (BLOCKED_SECRET_INPUT.test(label)) throw new Error(`Orbit will not visually type secret or verification information into “${label}”`);
  let lastDescription = label;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { visual } = await visualTarget(label, `Focus the visible editable field named “${label}” so Orbit can enter the user's supplied value locally.`, "field");
    lastDescription = visual.description || label;
    setAgentActivity("acting");
    await clickAtPoint(visual.x, visual.y);
    await nativeReplaceFocusedText(value);
    setAgentActivity("verifying");
    const actual = await valueAtPoint(visual.x, visual.y);
    if (actual === value) { setAgentActivity("idle"); return; }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 320));
  }
  setAgentActivity("idle");
  throw new Error(`Orbit visually filled “${lastDescription}”, but the field did not retain the requested value after one corrected retry`);
}

async function visualSelect(label: string, value: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const fieldTarget = await visualTarget(label, `Open the visible dropdown or selector named “${label}”.`, "click");
    setAgentActivity("acting");
    await clickAtPoint(fieldTarget.visual.x, fieldTarget.visual.y);
    await new Promise(resolve => setTimeout(resolve, 260));

    const optionTarget = await visualTarget(value, `Choose the visible option “${value}” from the open selector “${label}”.`, "option");
    setAgentActivity("acting");
    await clickAtPoint(optionTarget.visual.x, optionTarget.visual.y);
    await new Promise(resolve => setTimeout(resolve, 260));
    setAgentActivity("verifying");
    const selected = (await valueAtPoint(fieldTarget.visual.x, fieldTarget.visual.y)).toLowerCase();
    if (selected.includes(value.trim().toLowerCase())) { setAgentActivity("idle"); return; }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 320));
  }
  setAgentActivity("idle");
  throw new Error(`Orbit visually selected “${value}” from “${label}”, but it could not verify that the selection stuck after one corrected retry`);
}

export interface YouTubeVideoResult { title: string; url: string }

export async function youtubeVideoResults(limit = 12): Promise<YouTubeVideoResult[]> {
  await showEmbeddedBrowser();
  const target = await contents();
  const safeLimit = Math.max(1, Math.min(30, Math.floor(limit) || 12));
  const results = await target.executeJavaScript(`(() => {
    const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const anchors = Array.from(document.querySelectorAll(
      'ytd-search ytd-video-renderer a#video-title[href*="/watch?v="], ytd-search ytd-video-renderer a#video-title-link[href*="/watch?v="], ytd-search a#video-title[href*="/watch?v="]'
    ));
    const seen = new Set();
    const results = [];
    for (const anchor of anchors) {
      const raw = anchor.getAttribute('href') || '';
      let url;
      try { url = new URL(raw, location.origin); } catch { continue; }
      const videoId = url.searchParams.get('v');
      if (!videoId || seen.has(videoId)) continue;
      const title = clean(anchor.getAttribute('title') || anchor.textContent || anchor.getAttribute('aria-label'));
      if (!title) continue;
      seen.add(videoId);
      results.push({ title: title.slice(0, 180), url: 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId) });
      if (results.length >= ${safeLimit}) break;
    }
    return results;
  })()`, true) as YouTubeVideoResult[];
  emitState();
  return Array.isArray(results) ? results : [];
}

export async function clickByLabel(label: string) {
  setAgentActivity("reading_dom");
  const target = await contents();
  const encoded = JSON.stringify(label.trim().toLowerCase());
  const result = await target.executeJavaScript(`(async () => {
    const wanted = ${encoded};
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const clean = value => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const cursor = ${CURSOR_FACTORY_JS};
    const elements = Array.from(document.querySelectorAll('button,a[href],[role="button"],[role="link"],input[type="button"],input[type="submit"]'));
    const ranked = elements.map(element => {
      const text = clean(element.getAttribute('aria-label') || element.textContent || element.getAttribute('value'));
      return { element, text, score: text === wanted ? 3 : text.startsWith(wanted) ? 2 : text.includes(wanted) ? 1 : 0 };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    const match = ranked[0]?.element;
    if (!match) return false;
    match.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    await sleep(280);
    const rect = match.getBoundingClientRect();
    const x = Math.max(4, Math.min(innerWidth - 24, rect.left + rect.width / 2 - 10));
    const y = Math.max(4, Math.min(innerHeight - 24, rect.top + rect.height / 2 - 10));
    cursor.style.opacity = '1';
    cursor.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    await sleep(440);
    cursor.animate([
      { transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(1)' },
      { transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(.72)', boxShadow: '0 0 0 12px rgba(155,124,255,.25),0 0 28px rgba(155,124,255,.95)' },
      { transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(1)' }
    ], { duration: 300, easing: 'ease-out' });
    await sleep(120);
    match.click();
    await sleep(180);
    return true;
  })()`, true);
  if (result) { setAgentActivity("idle"); return; }

  const allowRetry = !CONSEQUENTIAL_LABEL.test(label);
  let previous: VisualBrowserSnapshot | null = null;
  let lastDescription = label;
  for (let attempt = 0; attempt < (allowRetry ? 2 : 1); attempt++) {
    let targeted;
    try {
      targeted = await visualTarget(label, `Click the visible browser control requested by the user: ${label}`, "click");
    } catch (error) {
      setAgentActivity("idle");
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Orbit could not find the control “${label}” in the DOM, and visual targeting was unavailable: ${detail}`);
    }
    previous = targeted.page;
    lastDescription = targeted.visual.description || label;
    setAgentActivity("acting");
    await clickAtPoint(targeted.visual.x, targeted.visual.y);
    await new Promise(resolve => setTimeout(resolve, 720));
    setAgentActivity("verifying");
    const after = await visualSnapshot();
    if (pageChanged(previous, after)) { setAgentActivity("idle"); return; }
    if (attempt === 0 && allowRetry) await new Promise(resolve => setTimeout(resolve, 320));
  }
  setAgentActivity("idle");
  throw new Error(`Orbit visually clicked “${lastDescription}”, but the browser did not show a verifiable change, so it stopped instead of retrying blindly`);
}

export async function fillByLabel(label: string, value: string) {
  if (BLOCKED_SECRET_INPUT.test(label)) throw new Error(`Orbit will not type secret or verification information into “${label}”`);
  setAgentActivity("reading_dom");
  const target = await contents();
  const encodedLabel = JSON.stringify(label.trim().toLowerCase());
  const encodedValue = JSON.stringify(value);
  const result = await target.executeJavaScript(`(async () => {
    const wanted = ${encodedLabel};
    const value = ${encodedValue};
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const clean = text => String(text || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const cursor = ${CURSOR_FACTORY_JS};
    const fields = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="password"]),textarea'));
    const field = fields.find(element => {
      const id = element.id;
      const explicit = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]')?.textContent : '';
      const wrapped = element.closest('label')?.textContent || '';
      const labels = [element.getAttribute('aria-label'), element.getAttribute('placeholder'), element.getAttribute('name'), explicit, wrapped].map(clean);
      return labels.some(item => item && (item === wanted || item.includes(wanted) || wanted.includes(item)));
    });
    if (!field) return false;
    field.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    await sleep(260);
    const rect = field.getBoundingClientRect();
    const x = Math.max(4, Math.min(innerWidth - 24, rect.left + Math.min(rect.width * .35, 140) - 10));
    const y = Math.max(4, Math.min(innerHeight - 24, rect.top + rect.height / 2 - 10));
    cursor.style.opacity = '1';
    cursor.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    await sleep(430);
    cursor.animate([
      { transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(1)' },
      { transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(.78)' },
      { transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(1)' }
    ], { duration: 240, easing: 'ease-out' });
    field.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    const setValue = next => { if (setter) setter.call(field, next); else field.value = next; };
    setValue('');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    const delay = value.length > 160 ? 4 : value.length > 80 ? 8 : 18;
    let current = '';
    for (const character of value) {
      current += character;
      setValue(current);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(delay);
    }
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(120);
    return true;
  })()`, true);
  if (result) {
    setAgentActivity("verifying");
    const actual = await fieldValueByLabel(label);
    if (actual === value) { setAgentActivity("idle"); return; }
  }
  await visualFill(label, value);
}

export async function selectByLabel(label: string, value: string) {
  setAgentActivity("reading_dom");
  const target = await contents();
  const encodedLabel = JSON.stringify(label.trim().toLowerCase());
  const encodedValue = JSON.stringify(value.trim().toLowerCase());
  const result = await target.executeJavaScript(`(async () => {
    const wanted = ${encodedLabel};
    const optionWanted = ${encodedValue};
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const clean = text => String(text || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const cursor = ${CURSOR_FACTORY_JS};
    const menus = Array.from(document.querySelectorAll('select'));
    const menu = menus.find(element => {
      const id = element.id;
      const explicit = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]')?.textContent : '';
      const labels = [element.getAttribute('aria-label'), element.getAttribute('name'), explicit].map(clean);
      return labels.some(item => item && (item === wanted || item.includes(wanted) || wanted.includes(item)));
    });
    if (!menu) return false;
    const option = Array.from(menu.options).find(item => clean(item.label) === optionWanted || clean(item.textContent).includes(optionWanted) || clean(item.value) === optionWanted);
    if (!option) return false;
    menu.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    await sleep(240);
    const rect = menu.getBoundingClientRect();
    const x = Math.max(4, Math.min(innerWidth - 24, rect.right - 26));
    const y = Math.max(4, Math.min(innerHeight - 24, rect.top + rect.height / 2 - 10));
    cursor.style.opacity = '1';
    cursor.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    await sleep(420);
    cursor.animate([{ transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(1)' }, { transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(.74)' }, { transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(1)' }], { duration: 260 });
    menu.value = option.value;
    menu.dispatchEvent(new Event('input', { bubbles: true }));
    menu.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(140);
    return true;
  })()`, true);
  if (result) {
    setAgentActivity("verifying");
    const actual = (await fieldValueByLabel(label)).toLowerCase();
    if (actual && (actual === value.trim().toLowerCase() || actual.includes(value.trim().toLowerCase()))) { setAgentActivity("idle"); return; }
  }
  await visualSelect(label, value);
}

export async function scroll(direction: "up" | "down" = "down", amount = 800) {
  const target = await contents();
  await target.executeJavaScript(`(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const cursor = ${CURSOR_FACTORY_JS};
    const x = Math.max(12, innerWidth - 46);
    const y = Math.max(24, Math.round(innerHeight * .62));
    cursor.style.opacity = '1';
    cursor.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    await sleep(260);
    cursor.animate([
      { transform: 'translate3d(' + x + 'px,' + y + 'px,0)' },
      { transform: 'translate3d(' + x + 'px,' + (y + ${direction === "down" ? 24 : -24}) + 'px,0)' },
      { transform: 'translate3d(' + x + 'px,' + y + 'px,0)' }
    ], { duration: 520, easing: 'ease-in-out' });
    window.scrollBy({ top: ${direction === "down" ? amount : -amount}, behavior: 'smooth' });
    await sleep(620);
    return true;
  })()`, true);
}

function registerBrowserChromeIpc() {
  const registrations: Array<[string, (...args: any[]) => any]> = [
    ["orbit:embedded-browser:tab:new", (_event, url?: string) => newTab(url)],
    ["orbit:embedded-browser:tab:switch", (_event, id: string) => switchTab(String(id || ""))],
    ["orbit:embedded-browser:tab:close", (_event, id: string) => closeTab(String(id || ""))],
    ["orbit:embedded-browser:back", () => goBack()],
    ["orbit:embedded-browser:forward", () => goForward()],
    ["orbit:embedded-browser:reload", () => reload()],
    ["orbit:embedded-browser:pane:set", (_event, width: number) => setAgentPaneWidth(Number(width))],
    ["orbit:embedded-browser:focus:orbit", () => focusOrbitPane()],
    ["orbit:embedded-browser:focus:browser", () => focusBrowserPane()],
  ];
  for (const [channel, handler] of registrations) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler);
  }
}

registerBrowserChromeIpc();
