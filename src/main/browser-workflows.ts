import * as agent from "./browser-agent.js";
import * as embedded from "./embedded-browser.js";

// Workflows orchestrate browser primitives. YouTube playback intentionally uses
// the embedded Orbit Browser so a normal "play ... on YouTube" request never
// falls back to the legacy external Chrome automation path.

export interface WorkflowResult { summary: string; url: string }

type YouTubeControl = { kind: string; label: string };

let lastYouTubeSearch = "";

function sleep(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function ordinalFromQuery(query: string) {
  const match = query.trim().match(/^(?:go\s+back(?:\s+(?:and\s+)?)?)?(?:(?:open|play)\s+)?(?:the\s+)?(first|second|third|fourth|fifth|\d+(?:st|nd|rd|th)?)\s*(?:one|video|result)?[.!?]*$/i);
  if (!match) return null;
  const named: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4 };
  const token = match[1].toLowerCase();
  if (token in named) return named[token];
  const numeric = Number.parseInt(token, 10);
  return Number.isFinite(numeric) ? Math.max(0, numeric - 1) : null;
}

function youtubeResultControls(query: string, controls: YouTubeControl[]) {
  const stopWords = new Set(["the", "a", "an", "and", "or", "of", "to", "for", "on", "in", "official", "video", "youtube", "open", "play"]);
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 1 && !stopWords.has(token));
  const seen = new Set<string>();

  return controls
    .filter(control => /^(?:a|link)$/i.test(control.kind) && control.label.trim().length >= 5)
    .filter(control => !/^(?:home|shorts|subscriptions|you|history|sign in|youtube|explore|trending|library|watch later|liked videos)$/i.test(control.label.trim()))
    .filter(control => {
      const label = control.label.toLowerCase();
      if (tokens.length && !tokens.some(token => label.includes(token))) return false;
      const key = label.replace(/\s+/g, " ").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function waitForYouTubeResults(query: string) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const snapshot = await embedded.actionSnapshot().catch(() => null);
    if (snapshot) {
      const results = youtubeResultControls(query, snapshot.controls);
      if (results.length) return results;
    }
    await sleep(500 + Math.min(attempt, 6) * 120);
  }
  return [] as YouTubeControl[];
}

async function openCurrentYouTubeResult(index: number) {
  await embedded.showEmbeddedBrowser();
  let current = await embedded.currentUrl();

  // "Open the first one" means the current result list. If the user is on a
  // watch page, return to that list instead of searching YouTube for the words
  // "first one".
  if (/youtube\.com\/watch\?v=/i.test(current)) {
    await embedded.goBack();
    for (let attempt = 0; attempt < 16; attempt++) {
      await sleep(350);
      current = await embedded.currentUrl();
      if (/youtube\.com\/results(?:\?|$)/i.test(current)) break;
    }
  }

  if (!/youtube\.com\/results(?:\?|$)/i.test(current)) {
    throw new Error("Orbit does not have a YouTube result list to choose from yet. Search for a video first.");
  }

  const results = await waitForYouTubeResults(lastYouTubeSearch);
  const chosen = results[index];
  if (!chosen) throw new Error(`YouTube result ${index + 1} is not available on the current results page yet.`);

  await embedded.clickByLabel(chosen.label);
  let watchUrl = "";
  for (let attempt = 0; attempt < 12; attempt++) {
    watchUrl = await embedded.currentUrl();
    if (/youtube\.com\/watch\?v=/i.test(watchUrl)) break;
    await sleep(400);
  }
  if (!/youtube\.com\/watch\?v=/i.test(watchUrl)) throw new Error(`Orbit selected YouTube result ${index + 1}, but its video page did not open.`);

  const title = await embedded.pageTitle();
  return {
    summary: `Playing result ${index + 1}, "${title.replace(/\s*-\s*YouTube$/, "") || chosen.label}", on YouTube inside Orbit Browser, boss.`,
    url: watchUrl,
  };
}

export async function youtubePlayFirst(query: string): Promise<WorkflowResult> {
  const clean = query.trim().replace(/^browser\s+agent\s+to\s+/i, "");
  if (!clean) throw new Error("Orbit needs something to search for on YouTube");

  const ordinal = ordinalFromQuery(clean);
  if (ordinal !== null) return openCurrentYouTubeResult(ordinal);

  lastYouTubeSearch = clean;
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(clean)}`;
  await embedded.showEmbeddedBrowser();
  await embedded.openUrl(searchUrl);

  // For a normal "open/play X video" request, respect YouTube's own ordering.
  // Orbit opens the first organic-looking result that matches the search terms;
  // it no longer globally re-ranks the page and jumps to result 3 or 4.
  const results = await waitForYouTubeResults(clean);
  const chosen = results[0];
  if (!chosen) {
    throw new Error(`YouTube search opened inside Orbit Browser, but no playable result for “${clean}” became available yet.`);
  }

  await embedded.clickByLabel(chosen.label);

  let watchUrl = "";
  for (let attempt = 0; attempt < 12; attempt++) {
    watchUrl = await embedded.currentUrl();
    if (/youtube\.com\/watch\?v=/i.test(watchUrl)) break;
    await sleep(450);
  }

  if (!/youtube\.com\/watch\?v=/i.test(watchUrl)) {
    throw new Error(`Orbit found the first YouTube result, “${chosen.label}”, but the video page did not open.`);
  }

  const title = await embedded.pageTitle();
  return {
    summary: `Playing the first YouTube result, "${title.replace(/\s*-\s*YouTube$/, "") || chosen.label}", inside Orbit Browser, boss.`,
    url: watchUrl,
  };
}

export async function amazonSearchWithPriceFilter(query: string, maxPrice?: number, minPrice?: number): Promise<WorkflowResult> {
  const clean = query.trim();
  if (!clean) throw new Error("Orbit needs something to search for on Amazon");
  // Amazon encodes its price-range filter directly in the URL as
  // rh=p_36:<min_cents>-<max_cents> (an empty bound means unbounded on that
  // side). This is the same parameter the sidebar's price filter links use,
  // and it survives layout/DOM changes far better than clicking a rendered
  // filter link would.
  const params = new URLSearchParams({ k: clean });
  if (maxPrice != null || minPrice != null) {
    const low = minPrice != null ? String(Math.round(minPrice * 100)) : "";
    const high = maxPrice != null ? String(Math.round(maxPrice * 100)) : "";
    params.set("rh", `p_36:${low}-${high}`);
  }
  await agent.openUrl(`https://www.amazon.com/s?${params.toString()}`);
  await agent.waitUntilExists('[data-component-type="s-search-result"]', 15_000);

  const hasResults = await agent.findElement('[data-component-type="s-search-result"]');
  const priceLabel = maxPrice != null && minPrice != null ? ` between $${minPrice} and $${maxPrice}`
    : maxPrice != null ? ` under $${maxPrice}`
    : minPrice != null ? ` over $${minPrice}`
    : "";
  return {
    summary: hasResults
      ? `Searched Amazon for ${clean}${priceLabel}, boss.`
      : `Searched Amazon for ${clean}${priceLabel}, but I couldn't confirm any matching results, boss.`,
    url: "",
  };
}