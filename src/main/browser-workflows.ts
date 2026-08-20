import * as agent from "./browser-agent.js";
import * as embedded from "./embedded-browser.js";

// Workflows orchestrate browser primitives. YouTube playback intentionally uses
// the embedded Orbit Browser so a normal "play ... on YouTube" request never
// falls back to the legacy external Chrome automation path.

export interface WorkflowResult { summary: string; url: string }

type YouTubeControl = { kind: string; label: string };

function sleep(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function bestYouTubeResult(query: string, controls: YouTubeControl[]) {
  const stopWords = new Set(["the", "a", "an", "and", "or", "of", "to", "for", "on", "in", "official", "video", "youtube"]);
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2 && !stopWords.has(token));
  const normalizedQuery = query.toLowerCase().trim();
  return controls
    .filter(control => /^(?:a|link)$/i.test(control.kind) && control.label.trim().length >= 4)
    .filter(control => !/^(?:home|shorts|subscriptions|you|history|sign in|youtube|explore|trending)$/i.test(control.label.trim()))
    .map(control => {
      const label = control.label.toLowerCase();
      const score = tokens.reduce((total, token) => total + (label.includes(token) ? 4 : 0), 0)
        + (normalizedQuery && label.includes(normalizedQuery) ? 8 : 0)
        + (/trailer/i.test(query) && /trailer/i.test(label) ? 4 : 0)
        + (/official/i.test(label) ? 1 : 0);
      return { control, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.control || null;
}

export async function youtubePlayFirst(query: string): Promise<WorkflowResult> {
  const clean = query.trim().replace(/^browser\s+agent\s+to\s+/i, "");
  if (!clean) throw new Error("Orbit needs something to search for on YouTube");

  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(clean)}`;
  await embedded.showEmbeddedBrowser();
  await embedded.openUrl(searchUrl);

  let chosen: YouTubeControl | null = null;
  for (let attempt = 0; attempt < 14; attempt++) {
    const current = await embedded.currentUrl();
    if (/youtube\.com\/watch\?v=/i.test(current)) break;
    const snapshot = await embedded.actionSnapshot().catch(() => null);
    if (snapshot) {
      chosen = bestYouTubeResult(clean, snapshot.controls);
      if (chosen) break;
    }
    await sleep(650 + Math.min(attempt, 5) * 120);
  }

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
    throw new Error(`Orbit found “${chosen.label}” on YouTube but the video page did not open.`);
  }

  const title = await embedded.pageTitle();
  return {
    summary: `Playing "${title.replace(/\s*-\s*YouTube$/, "") || chosen.label}" on YouTube inside Orbit Browser, boss.`,
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