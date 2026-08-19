import { BrowserWindow, WebContentsView } from "electron";

const PARTITION = "persist:orbit-agent";
const SIDEBAR_WIDTH = 276;
const PANE_GAP = 12;
const BROWSER_TOP = 42;
const HOST_LAYOUT_CSS = `
html.orbit-browser-open main {
  grid-template-columns: ${SIDEBAR_WIDTH}px var(--orbit-agent-pane-width, 460px) minmax(0, 1fr) !important;
}
html.orbit-browser-open .content {
  grid-column: 2 !important;
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
  margin: 0 !important;
  padding: 32px 22px !important;
  overflow-x: hidden !important;
}
html.orbit-browser-open .content.space-content {
  padding: 0 !important;
  overflow: hidden !important;
}
html.orbit-browser-open .assistant-shell {
  width: calc(100% - 30px) !important;
  padding: 42px 0 84px !important;
}
html.orbit-browser-open .assistant-heading {
  max-width: 430px !important;
}
html.orbit-browser-open .assistant-heading h1 {
  font-size: clamp(30px, 3.2vw, 43px) !important;
}
html.orbit-browser-open .assistant-heading p {
  font-size: 11px !important;
}
html.orbit-browser-open .assistant-core {
  width: 168px !important;
  margin: 12px 0 9px !important;
}
html.orbit-browser-open .assistant-shell .space-interaction,
html.orbit-browser-open .activity-strip {
  width: 100% !important;
}
html.orbit-browser-open .quick-prompts,
html.orbit-browser-open .space-stats {
  display: none !important;
}
html.orbit-browser-open .conversation-history {
  max-height: 190px !important;
}
`;

let view: WebContentsView | null = null;
let host: BrowserWindow | null = null;
let resizeListener: (() => void) | null = null;
let layoutCssKey: string | null = null;
let visible = false;

function publicUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Orbit's embedded browser only opens HTTP or HTTPS pages");
  if (/^(?:localhost|127\.|0\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname)) throw new Error("Orbit's embedded browser cannot open private network addresses");
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

function paneGeometry(width: number) {
  const available = Math.max(0, width - SIDEBAR_WIDTH);
  let agentWidth = Math.min(560, Math.max(390, Math.round(available * 0.4)));
  const minimumBrowserWidth = 420;
  if (available - agentWidth - PANE_GAP * 2 < minimumBrowserWidth) {
    agentWidth = Math.max(340, available - minimumBrowserWidth - PANE_GAP * 2);
  }
  const browserX = SIDEBAR_WIDTH + agentWidth + PANE_GAP;
  return {
    agentWidth,
    browserX,
    browserWidth: Math.max(320, width - browserX - PANE_GAP),
  };
}

function syncHostLayout(open = visible) {
  if (!host || host.isDestroyed()) return;
  const { agentWidth } = paneGeometry(host.getContentBounds().width);
  const script = open
    ? `document.documentElement.classList.add('orbit-browser-open'); document.documentElement.style.setProperty('--orbit-agent-pane-width', '${agentWidth}px');`
    : `document.documentElement.classList.remove('orbit-browser-open'); document.documentElement.style.removeProperty('--orbit-agent-pane-width');`;
  void host.webContents.executeJavaScript(script).catch(() => {});
}

function layout() {
  if (!host || host.isDestroyed() || !view) return;
  const bounds = host.getContentBounds();
  const geometry = paneGeometry(bounds.width);
  syncHostLayout();
  view.setBounds({
    x: geometry.browserX,
    y: BROWSER_TOP,
    width: geometry.browserWidth,
    height: Math.max(320, bounds.height - BROWSER_TOP - PANE_GAP),
  });
}

function emitState() {
  if (!host || host.isDestroyed() || !view || view.webContents.isDestroyed()) return;
  const contents = view.webContents;
  host.webContents.send("orbit:embedded-browser:state", {
    visible,
    url: contents.getURL(),
    title: contents.getTitle(),
    loading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  });
}

async function ensureView() {
  const nextHost = findHostWindow();
  if (view && host === nextHost && !view.webContents.isDestroyed()) return view;

  if (view && host && !host.isDestroyed()) host.contentView.removeChildView(view);
  if (resizeListener && host && !host.isDestroyed()) host.removeListener("resize", resizeListener);

  host = nextHost;
  layoutCssKey = await host.webContents.insertCSS(HOST_LAYOUT_CSS).catch(() => null);
  view = new WebContentsView({
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
  view.setBackgroundColor("#0b0c10");
  view.setBorderRadius(16);
  view.setVisible(false);
  host.contentView.addChildView(view);

  resizeListener = () => layout();
  host.on("resize", resizeListener);

  const attachedHost = host;
  const attachedView = view;
  attachedHost.once("closed", () => {
    attachedView.webContents.close();
    if (view === attachedView) view = null;
    if (host === attachedHost) host = null;
    resizeListener = null;
    layoutCssKey = null;
    visible = false;
  });

  const contents = view.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    try { void contents.loadURL(publicUrl(url)); } catch {}
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    try { publicUrl(url); }
    catch { event.preventDefault(); }
  });
  for (const event of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"] as const) {
    contents.on(event as any, () => emitState());
  }
  contents.on("render-process-gone", () => {
    visible = false;
    syncHostLayout(false);
    emitState();
  });

  layout();
  return view;
}

export async function showEmbeddedBrowser() {
  const browserView = await ensureView();
  visible = true;
  syncHostLayout(true);
  browserView.setVisible(true);
  layout();
  emitState();
  return embeddedBrowserState();
}

export function hideEmbeddedBrowser() {
  visible = false;
  view?.setVisible(false);
  syncHostLayout(false);
  emitState();
  return embeddedBrowserState();
}

export function embeddedBrowserState() {
  const contents = view && !view.webContents.isDestroyed() ? view.webContents : null;
  return {
    visible,
    url: contents?.getURL() || "",
    title: contents?.getTitle() || "",
    loading: Boolean(contents?.isLoading()),
    canGoBack: Boolean(contents?.navigationHistory.canGoBack()),
    canGoForward: Boolean(contents?.navigationHistory.canGoForward()),
  };
}

async function contents() {
  const browserView = await ensureView();
  return browserView.webContents;
}

export async function openUrl(url: string) {
  await showEmbeddedBrowser();
  const target = await contents();
  await target.loadURL(publicUrl(url));
  emitState();
}

export async function pageTitle() {
  return (await contents()).getTitle();
}

export async function currentUrl() {
  return (await contents()).getURL();
}

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

export interface ActionSnapshot { title: string; url: string; text: string; controls: Array<{ kind: string; label: string }> }

export async function actionSnapshot(): Promise<ActionSnapshot> {
  await showEmbeddedBrowser();
  const target = await contents();
  const snapshot = await target.executeJavaScript(`(() => {
    const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const controls = Array.from(document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[role="link"]'))
      .filter(visible)
      .slice(0, 80)
      .map(element => {
        const label = clean(element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.textContent || element.getAttribute('name') || element.getAttribute('value'));
        const tag = element.tagName.toLowerCase();
        const kind = tag === 'input' ? (element.getAttribute('type') || 'input') : tag;
        return { kind, label: label.slice(0, 120) };
      })
      .filter(item => item.label);
    return {
      title: document.title,
      url: location.href,
      text: clean(document.body?.innerText).slice(0, 10000),
      controls,
    };
  })()`, true) as ActionSnapshot;
  emitState();
  return snapshot;
}

export async function clickByLabel(label: string) {
  const target = await contents();
  const encoded = JSON.stringify(label.trim().toLowerCase());
  const result = await target.executeJavaScript(`(() => {
    const wanted = ${encoded};
    const clean = value => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const elements = Array.from(document.querySelectorAll('button,a[href],[role="button"],[role="link"],input[type="button"],input[type="submit"]'));
    const ranked = elements.map(element => {
      const text = clean(element.getAttribute('aria-label') || element.textContent || element.getAttribute('value'));
      return { element, text, score: text === wanted ? 3 : text.startsWith(wanted) ? 2 : text.includes(wanted) ? 1 : 0 };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    const match = ranked[0]?.element;
    if (!match) return false;
    match.scrollIntoView({ block: 'center', inline: 'center' });
    match.click();
    return true;
  })()`, true);
  if (!result) throw new Error(`Orbit could not find the control “${label}”`);
}

export async function fillByLabel(label: string, value: string) {
  const target = await contents();
  const encodedLabel = JSON.stringify(label.trim().toLowerCase());
  const encodedValue = JSON.stringify(value);
  const result = await target.executeJavaScript(`(() => {
    const wanted = ${encodedLabel};
    const value = ${encodedValue};
    const clean = text => String(text || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const fields = Array.from(document.querySelectorAll('input:not([type="hidden"]),textarea'));
    const field = fields.find(element => {
      const id = element.id;
      const explicit = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]')?.textContent : '';
      const wrapped = element.closest('label')?.textContent || '';
      const labels = [element.getAttribute('aria-label'), element.getAttribute('placeholder'), element.getAttribute('name'), explicit, wrapped].map(clean);
      return labels.some(item => item === wanted || item.includes(wanted) || wanted.includes(item));
    });
    if (!field) return false;
    field.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    if (setter) setter.call(field, value); else field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`, true);
  if (!result) throw new Error(`Orbit could not find the field “${label}”`);
}

export async function selectByLabel(label: string, value: string) {
  const target = await contents();
  const encodedLabel = JSON.stringify(label.trim().toLowerCase());
  const encodedValue = JSON.stringify(value.trim().toLowerCase());
  const result = await target.executeJavaScript(`(() => {
    const wanted = ${encodedLabel};
    const optionWanted = ${encodedValue};
    const clean = text => String(text || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const menus = Array.from(document.querySelectorAll('select'));
    const menu = menus.find(element => {
      const id = element.id;
      const explicit = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]')?.textContent : '';
      const labels = [element.getAttribute('aria-label'), element.getAttribute('name'), explicit].map(clean);
      return labels.some(item => item === wanted || item.includes(wanted) || wanted.includes(item));
    });
    if (!menu) return false;
    const option = Array.from(menu.options).find(item => clean(item.label) === optionWanted || clean(item.textContent).includes(optionWanted) || clean(item.value) === optionWanted);
    if (!option) return false;
    menu.value = option.value;
    menu.dispatchEvent(new Event('input', { bubbles: true }));
    menu.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`, true);
  if (!result) throw new Error(`Orbit could not select “${value}” from “${label}”`);
}

export async function scroll(direction: "up" | "down" = "down", amount = 800) {
  const target = await contents();
  await target.executeJavaScript(`window.scrollBy({ top: ${direction === "down" ? amount : -amount}, behavior: 'smooth' })`, true);
}
