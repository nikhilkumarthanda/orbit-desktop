import type { LiveInfoService, ServiceOutcome } from "./types.js";
import { cleanTitle, dedupeHeadlines, fetchRssItems } from "./rss-feed.js";
import type { ResearchSource } from "../../shared/contracts.js";

function newsTopic(query = "") {
  return query.match(/\b(?:news|headlines?|updates?|stories)\s+(?:about|on|for)\s+(.+?)[?.!]*$/i)?.[1]?.trim() || "";
}

export function createNewsService(): LiveInfoService {
  return {
    name: "news",
    appliesTo: query => /\b(news|headlines|top stories|world update)\b/i.test(query),
    async fetch(query): Promise<ServiceOutcome> {
      try {
        const topic = newsTopic(query);
        const feed = topic
          ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`
          : "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en";
        const items = dedupeHeadlines(await fetchRssItems(feed, topic ? 6 : 10));
        if (!items.length) return { ok: false, error: "No current headlines were available" };
        const sources: ResearchSource[] = items.map(item => ({ title: cleanTitle(item.title), url: item.link, excerpt: cleanTitle(item.title) }));
        return { ok: true, sources, source: "Google News RSS", updatedAt: new Date().toISOString() };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "News service failed" };
      }
    },
  };
}
