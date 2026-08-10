import type { ResearchProgress, ResearchSource } from "../shared/contracts.js";

const SEARCH_TIMEOUT_MS = 12_000;
const PAGE_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 1_500_000;
const MAX_SOURCES = 5;

function decodeHtml(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, "\"")
    .replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function publicHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0" || host === "::1") return null;
    if (/^(?:10|127|169\.254|192\.168)\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return null;
    return url;
  } catch { return null; }
}

function readableText(html: string) {
  const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ").replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ").replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return { title, text: decodeHtml(cleaned).slice(0, 9_000) };
}

async function fetchReadablePage(source: ResearchSource, fetcher: typeof fetch): Promise<ResearchSource> {
  const safe = publicHttpUrl(source.url);
  if (!safe) return source;
  try {
    const response = await fetcher(safe, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Orbit-Desktop/0.12" },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    const finalUrl = publicHttpUrl(response.url || safe.toString());
    const contentType = response.headers.get("content-type") || "";
    const length = Number(response.headers.get("content-length") || 0);
    if (!response.ok || !finalUrl || !contentType.includes("text/html") || length > MAX_PAGE_BYTES) return source;
    const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
    const page = readableText(html);
    if (page.text.length < 300) return source;
    return { title: page.title || source.title, url: finalUrl.toString(), excerpt: page.text };
  } catch { return source; }
}

export async function researchPublicWeb(query: string, fetcher: typeof fetch = fetch, progress?: (event: ResearchProgress) => void): Promise<ResearchSource[]> {
  progress?.({ stage: "searching", message: `Searching the web for “${query.slice(0, 90)}”` });
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetcher(endpoint, {
    headers: { "User-Agent": "Mozilla/5.0 Orbit-Desktop/0.12" },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("Web search is temporarily unavailable");
  const html = await response.text();
  const blocks = [...html.matchAll(/<div[^>]+class="[^"]*result[^"]*"[\s\S]*?<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)/gi)];
  const candidates: ResearchSource[] = [];
  for (const match of blocks) {
    const raw = decodeHtml(match[1]);
    const redirect = new URL(raw, "https://duckduckgo.com");
    const safe = publicHttpUrl(redirect.searchParams.get("uddg") || redirect.toString());
    if (!safe || safe.hostname.endsWith("duckduckgo.com")) continue;
    const source = { title: decodeHtml(match[2]), url: safe.toString(), excerpt: decodeHtml(match[3] || match[4] || "") };
    if (source.title && source.excerpt && !candidates.some(item => item.url === source.url)) candidates.push(source);
    if (candidates.length === MAX_SOURCES) break;
  }
  if (!candidates.length) throw new Error("I couldn't retrieve reliable web results for that question");
  const sources: ResearchSource[] = [];
  for (const [index, candidate] of candidates.entries()) {
    progress?.({ stage: "reading", message: `Reading ${candidate.title}`, current: index + 1, total: candidates.length, source: candidate.url });
    sources.push(await fetchReadablePage(candidate, fetcher));
  }
  progress?.({ stage: "comparing", message: `Comparing evidence across ${sources.length} sources`, current: sources.length, total: sources.length });
  return sources;
}

export function shouldReadTheWeb(query: string) {
  return /\b(search|browse|check|read|research|look\s*up|find\s*out|according\s+to|websites?|sites?|online|internet|sources?|today|tonight|now|current|currently|latest|recent|news|price|stock|score|weather|forecast|election|president|ceo|release|version|202[5-9]|who won|winner|champion|world cup|fifa|ipl|nba|nfl|mlb|nhl)\b/i.test(query);
}
