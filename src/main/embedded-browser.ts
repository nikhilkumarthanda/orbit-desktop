import { BrowserWindow, WebContentsView } from "electron";

const PARTITION = "persist:orbit-agent";
let view: WebContentsView | null = null;
let host: BrowserWindow | null = null;
let resizeListener: (() => void) | null = null;
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

function layout() {
  if (!host || host.isDestroyed() || !view) return;
  const bounds = host.getContentBounds();
  // Keep Orbit's conversation/command surface on the left and the live web on the right.
  const left = Math.max(460, Math.round(bounds.width * 0.5));
  const top = 88;
  const margin = 12;
  view.setBounds({
    x: left,
    y: top,
    width: Math.max(320, bounds.width - left - margin),
    height: Math.max(320, bounds.height - top - margin),
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
    emitState();
  });

  layout();
  return view;
}

export async function showEmbeddedBrowser() {
  const browserView = await ensureView();
  visible = true;
  browserView.setVisible(true);
  layout();
  emitState();
  return embeddedBrowserState();
}

export function hideEmbeddedBrowser() {
  visible = false;
  view?.setVisible(false);
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
