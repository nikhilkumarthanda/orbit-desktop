import * as agent from "./browser-agent.js";

// Workflows only orchestrate BrowserAgent primitives - no raw Playwright calls
// live here. Adding a new site is adding a new small file like this one.

export interface WorkflowResult { summary: string; url: string }

export async function youtubePlayFirst(query: string): Promise<WorkflowResult> {
  const clean = query.trim();
  if (!clean) throw new Error("Orbit needs something to search for on YouTube");
  await agent.openUrl(`https://www.youtube.com/results?search_query=${encodeURIComponent(clean)}`);
  const resultLink = "ytd-video-renderer #video-title, a#video-title";
  await agent.waitUntilClickable(resultLink, 15_000);
  await agent.retry(() => agent.click(resultLink), 2, 400);
  await agent.waitForNavigation();
  const title = await agent.pageTitle();
  return { summary: `Playing "${title.replace(/\s*-\s*YouTube$/, "")}" on YouTube, boss.`, url: "" };
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
