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
        const topicWords = topic.toLowerCase().split(/\W+/).filter(word => word.length > 2);
        const items = dedupeHeadlines(await fetchRssItems(feed, topic ? 16 : 10))
          .map((item, index) => {
            const title = cleanTitle(item.title);
            const normalized = title.toLowerCase();
            const relevance = topicWords.reduce((score, word) => score + (normalized.includes(word) ? 1 : 0), 0);
            const publishedAt = Date.parse(item.pubDate || "") || 0;
            const ageHours = publishedAt ? Math.max(0, (Date.now() - publishedAt) / 3_600_000) : 168;
            return { item, title, relevance, score: relevance * 100 - Math.min(ageHours, 168) - index * 0.01 };
          })
          .filter(story => !topicWords.length || topicWords.every(word => story.title.toLowerCase().includes(word)))
          .sort((a, b) => b.score - a.score)
          .slice(0, 2);
        if (!items.length) return { ok: false, error: topic ? `No current, relevant news about ${topic} was available` : "No current headlines were available" };
        const sources: ResearchSource[] = items.map(({ item, title }) => ({ title, url: item.link, excerpt: title }));
        return { ok: true, sources, source: "Google News RSS", updatedAt: new Date().toISOString() };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "News service failed" };
      }
    },
  };
}
