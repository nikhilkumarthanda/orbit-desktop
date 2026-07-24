import * as agent from "./browser-agent.js";
import { summarizeWithAI } from "./ai-summarize.js";
import type { ResearchSource } from "../shared/contracts.js";

// Generic page understanding, built only on browser-agent's evaluate()
// primitive. No site-specific selectors here - this is what lets any future
// website module ask "what kind of page is this" instead of guessing.

export type PageKind = "product-listing" | "article" | "form" | "table" | "general";
export interface ProductSummary { title: string; price: string; url: string }
export interface FormSummary { fieldCount: number; labels: string[]; submitLabel: string }
export interface TableSummary { rows: number; columns: number; headers: string[] }
export interface InteractiveSummary { buttons: string[]; forms: FormSummary[]; tables: TableSummary[] }
export interface PageInspection {
  kind: PageKind;
  title: string;
  url: string;
  products: ProductSummary[];
  productCount: number;
  filters: string[];
  articleText: string;
  articleParagraphCount: number;
  interactive: InteractiveSummary;
}

export async function inspectPage(): Promise<PageInspection> {
  return agent.evaluate(() => {
    const clean = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
    const isVisible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };

    // ---- product cards ----
    const priceRe = /\$\s?\d[\d,]*(?:\.\d{2})?/;
    const knownProductSelectors = [
      '[data-component-type="s-search-result"]',
      '[data-testid*="product" i]',
      '[class*="product-card" i]',
      '[class*="productCard" i]',
      '[itemtype*="Product" i]',
    ];
    let productEls: Element[] = [];
    for (const selector of knownProductSelectors) {
      const found = Array.from(document.querySelectorAll(selector));
      if (found.length >= 3) { productEls = found; break; }
    }
    if (!productEls.length) {
      const groups = new Map<string, Element[]>();
      for (const el of document.querySelectorAll("body *")) {
        if (!el.children.length) continue;
        const text = el.textContent || "";
        if (text.length > 500 || text.length < 10) continue;
        if (!priceRe.test(text)) continue;
        if (!el.querySelector("a")) continue;
        const classKey = Array.from(el.classList).slice(0, 2).join(".");
        if (!classKey) continue;
        const key = `${el.tagName}.${classKey}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(el);
      }
      let best: Element[] = [];
      for (const group of groups.values()) if (group.length > best.length) best = group;
      if (best.length >= 3) productEls = best;
    }
    const products = productEls.slice(0, 12).map(el => {
      const priceMatch = (el.textContent || "").match(priceRe);
      const link = el.querySelector("a[href]") as HTMLAnchorElement | null;
      // A card can have several heading-like elements (e.g. a short brand
      // label plus the full title) - the longest one is almost always the
      // actual descriptive title, not the first one in document order.
      const headingCandidates = Array.from(el.querySelectorAll("h1,h2,h3,h4,[role=heading]"));
      const heading = headingCandidates.sort((a, b) => (b.textContent || "").length - (a.textContent || "").length)[0] || link;
      return { title: clean(heading?.textContent).slice(0, 140), price: priceMatch ? priceMatch[0] : "", url: link?.href || "" };
    }).filter(product => product.title);

    // ---- article body ----
    // Prefer a single <article> tag, or a clearly dominant one if a page has
    // several (a real single-story page has one; a hub/listing page often
    // wraps many small teaser cards in their own <article> tags).
    const articleTags = Array.from(document.querySelectorAll("article"));
    let articleRoot: Element | null = null;
    if (articleTags.length === 1) {
      articleRoot = articleTags[0];
    } else if (articleTags.length > 1) {
      const sorted = articleTags.slice().sort((a, b) => b.querySelectorAll("p").length - a.querySelectorAll("p").length);
      const topParagraphs = sorted[0].querySelectorAll("p").length;
      const secondParagraphs = sorted[1]?.querySelectorAll("p").length ?? 0;
      if (topParagraphs >= 6 && topParagraphs >= secondParagraphs * 3) articleRoot = sorted[0];
    }
    if (!articleRoot) {
      let bestScore = 0;
      for (const el of document.querySelectorAll("main, [role=main], #content, .content, .article, .post")) {
        const paragraphCount = el.querySelectorAll("p").length;
        if (paragraphCount > bestScore) { bestScore = paragraphCount; articleRoot = el; }
      }
    }
    if (!articleRoot) {
      const byParent = new Map<Element, number>();
      for (const p of document.querySelectorAll("p")) {
        const parent = p.parentElement;
        if (!parent) continue;
        byParent.set(parent, (byParent.get(parent) || 0) + (p.textContent || "").length);
      }
      let bestLength = 0;
      for (const [el, length] of byParent) if (length > bestLength) { bestLength = length; articleRoot = el; }
    }
    let articleText = "";
    let articleParagraphCount = 0;
    if (articleRoot) {
      const paragraphs = articleRoot.querySelectorAll("p").length;
      const links = articleRoot.querySelectorAll("a").length;
      // Real article prose has few links relative to its paragraph count; a
      // teaser feed or listing packed into one container is link-dense.
      const linkDensity = links / Math.max(1, paragraphs);
      if (linkDensity <= 1.5) {
        articleParagraphCount = paragraphs;
        const clone = articleRoot.cloneNode(true) as Element;
        clone.querySelectorAll("script,style,nav,aside,footer,header,form,button,noscript").forEach(node => node.remove());
        articleText = clean(clone.textContent).slice(0, 12_000);
      }
    }

    // ---- interactive elements ----
    const buttons = Array.from(document.querySelectorAll("button, [role=button], input[type=submit], input[type=button], a.button, a[role=button]")).filter(isVisible);
    const buttonLabels: string[] = [];
    const seen = new Set<string>();
    for (const el of buttons) {
      const label = clean(el.getAttribute("aria-label") || el.textContent || (el as HTMLInputElement).value);
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      buttonLabels.push(label.slice(0, 60));
      if (buttonLabels.length >= 25) break;
    }

    const forms = Array.from(document.querySelectorAll("form")).slice(0, 8).map(form => {
      const fields = Array.from(form.querySelectorAll("input, select, textarea")).filter(field => (field as HTMLInputElement).type !== "hidden");
      const labels = fields.map(field => clean(field.getAttribute("aria-label") || field.getAttribute("placeholder") || (field as HTMLInputElement).name)).filter(Boolean).slice(0, 10);
      const submit = form.querySelector("button[type=submit], input[type=submit], button:not([type])");
      return { fieldCount: fields.length, labels, submitLabel: clean(submit?.textContent || (submit as HTMLInputElement)?.value) };
    });

    const tables = Array.from(document.querySelectorAll("table")).slice(0, 8).map(table => {
      const rows = table.querySelectorAll("tr").length;
      const headerCells = Array.from(table.querySelectorAll("thead th, tr:first-child th"));
      const headers = headerCells.map(cell => clean(cell.textContent)).filter(Boolean).slice(0, 12);
      const columns = headers.length || (table.querySelector("tr")?.children.length || 0);
      return { rows, columns, headers };
    });

    const filters = Array.from(new Set(
      Array.from(document.querySelectorAll("#s-refinements [role=heading], [aria-label*='filter' i] [role=heading], .filters [role=heading], .facet-title"))
        .map(el => clean(el.textContent)).filter(Boolean)
    )).slice(0, 10);

    let kind: PageKind = "general";
    if (products.length >= 3) kind = "product-listing";
    else if (articleParagraphCount >= 6 && articleText.length > 800) kind = "article";
    else if (forms.length >= 1 && document.querySelectorAll("form input, form select, form textarea").length >= 3) kind = "form";
    else if (tables.length >= 1) kind = "table";

    return { kind, title: document.title, url: location.href, products, productCount: productEls.length, filters, articleText, articleParagraphCount, interactive: { buttons: buttonLabels, forms, tables } };
  });
}

function hostnameOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return "this site"; }
}

export async function describeCurrentPage(): Promise<string> {
  const page = await inspectPage();
  const site = hostnameOf(page.url);
  if (page.kind === "product-listing") {
    const filterText = page.filters.length ? ` Filters available: ${page.filters.join(", ")}.` : "";
    return `This is a product listing on ${site} - ${page.productCount} products.${filterText}`;
  }
  if (page.kind === "article") {
    return `This is an article on ${site} titled "${page.title}", about ${page.articleParagraphCount} paragraphs long.`;
  }
  if (page.kind === "form") {
    const form = page.interactive.forms[0];
    return `This page on ${site} has a form with ${form?.fieldCount ?? 0} fields${form?.submitLabel ? `, submitted with "${form.submitLabel}"` : ""}.`;
  }
  if (page.kind === "table") {
    const table = page.interactive.tables[0];
    return `This page on ${site} has a table with ${table?.rows ?? 0} rows and ${table?.columns ?? 0} columns.`;
  }
  return `This is "${page.title}" on ${site}.`;
}

export async function summarizeCurrentPage(): Promise<string> {
  const page = await inspectPage();
  if (!page.articleText || page.articleParagraphCount < 2) throw new Error("Orbit couldn't find article text on this page to summarize");
  const sources: ResearchSource[] = [{ title: page.title, url: page.url, excerpt: page.articleText.slice(0, 6_000) }];
  const instruction = "Summarize the article in the evidence below in 3 to 4 concise, natural spoken sentences. Do not use citation numbers or brackets.";
  return summarizeWithAI(instruction, sources, () => page.articleText.split(/(?<=[.!?])\s+/).slice(0, 3).join(" "));
}

export async function findOnPage(query: string): Promise<string> {
  const page = await inspectPage();
  const needle = query.toLowerCase().trim();
  if (!needle) throw new Error("Orbit needs something to look for on this page");
  const exact = page.interactive.buttons.find(label => label.toLowerCase().includes(needle));
  if (exact) return `The "${exact}" button should do that, boss.`;
  const words = needle.split(/\s+/).filter(word => word.length > 3);
  const fuzzy = page.interactive.buttons.find(label => words.some(word => label.toLowerCase().includes(word)));
  if (fuzzy) return `The "${fuzzy}" button looks like the closest match, boss.`;
  throw new Error(`Orbit couldn't find a button or link matching "${query}" on this page`);
}
