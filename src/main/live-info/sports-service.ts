import type { LiveInfoService, ServiceOutcome } from "./types.js";
import { cleanTitle, fetchRssItems, isFreshItem } from "./rss-feed.js";
import type { ResearchSource } from "../../shared/contracts.js";

const CRICKET_RE = /\b(cricket|ipl|test match)\b.*\b(score|scores|result|match|update|live)\b|\b(score|scores)\b.*\b(cricket|ipl)\b/i;
const SOCCER_RE = /\b(fifa|world cup|premier league|champions league|soccer)\b.*\b(score|scores|result|match|final|winner|won|update|live)\b|\b(score|scores|result|winner)\b.*\b(fifa|world cup|soccer)\b/i;

async function fetchScore(searchTerms: string, sportLabel: string): Promise<ServiceOutcome> {
  const items = await fetchRssItems(`https://news.google.com/rss/search?q=${encodeURIComponent(searchTerms)}&hl=en-US&gl=US&ceid=US:en`, 8);
  const scoreLike = items.filter(item => /\b(?:\d+\/\d+|\d+-\d+|won by|final score|full[- ]time|live score|beats?|defeat(?:ed|s)?|runs?|wickets?)\b/i.test(item.title));
  const fresh = (scoreLike.length ? scoreLike : items).filter(item => isFreshItem(item, 20));
  if (!fresh.length) return { ok: false, error: `No current ${sportLabel} result was found within the last day` };
  const sources: ResearchSource[] = fresh.slice(0, 3).map(item => ({ title: cleanTitle(item.title), url: item.link, excerpt: cleanTitle(item.title) }));
  return { ok: true, sources, source: "Google News RSS", updatedAt: fresh[0].pubDate || new Date().toISOString() };
}

function soccerSearchTerms(query: string) {
  const team = query.match(/\b(?:fifa|world cup|soccer|premier league|champions league)\b[\s\S]*?\b(?:for|about)\s+(.+?)[?.!]*$/i)?.[1]?.trim();
  return team ? `${team} score result` : "FIFA World Cup result score";
}

export function createSportsService(): LiveInfoService {
  return {
    name: "sports",
    appliesTo: query => CRICKET_RE.test(query) || SOCCER_RE.test(query),
    async fetch(query): Promise<ServiceOutcome> {
      try {
        if (CRICKET_RE.test(query)) return await fetchScore("live cricket score", "cricket");
        return await fetchScore(soccerSearchTerms(query), "FIFA/soccer");
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Sports service failed" };
      }
    },
  };
}
