export type FeedItem = { title: string; link: string; pubDate?: string };

function decodeXml(value: string) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<[^>]+>/g, "").trim();
}

export async function fetchRssItems(url: string, limit: number): Promise<FeedItem[]> {
  const response = await fetch(url, { headers: { "User-Agent": "Orbit-Desktop/0.7" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`The live source returned status ${response.status}`);
  const xml = await response.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .map(match => {
      const block = match[1];
      const title = decodeXml(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "");
      const link = decodeXml(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "");
      const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim();
      return { title, link, pubDate };
    })
    .filter(item => item.title)
    .slice(0, limit);
}

export function isFreshItem(item: FeedItem, maxAgeHours: number) {
  if (!item.pubDate) return false;
  const published = Date.parse(item.pubDate);
  return !Number.isNaN(published) && Date.now() - published <= maxAgeHours * 60 * 60 * 1000;
}

export function dedupeHeadlines(items: FeedItem[]) {
  const seen = new Set<string>();
  const deduped: FeedItem[] = [];
  for (const item of items) {
    const key = item.title.replace(/\s+-\s+[^-]+$/, "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

export function cleanTitle(title: string) {
  return title.replace(/\s+-\s+[^-]+$/, "");
}
