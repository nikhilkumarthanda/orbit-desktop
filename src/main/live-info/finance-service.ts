import type { LiveInfoService, ServiceOutcome } from "./types.js";

const TICKER_ALIASES: Record<string, string> = {
  tesla: "TSLA", apple: "AAPL", google: "GOOGL", alphabet: "GOOGL", amazon: "AMZN",
  microsoft: "MSFT", nvidia: "NVDA", meta: "META", facebook: "META", netflix: "NFLX",
};

function extractTicker(query: string): string | null {
  const lower = query.toLowerCase();
  for (const [name, ticker] of Object.entries(TICKER_ALIASES)) if (lower.includes(name)) return ticker;
  const explicit = query.match(/\b([A-Z]{1,5})\b/);
  return explicit ? explicit[1] : null;
}

export function createFinanceService(): LiveInfoService {
  return {
    name: "finance",
    appliesTo: query => /\b(stock|shares?|ticker|market cap|share price|trading at)\b/i.test(query) && Boolean(extractTicker(query)),
    async fetch(query): Promise<ServiceOutcome> {
      try {
        const ticker = extractTicker(query);
        if (!ticker) return { ok: false, error: "Orbit couldn't identify a stock symbol in that request" };
        const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`, {
          headers: { "User-Agent": "Mozilla/5.0 Orbit-Desktop" }, signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) return { ok: false, error: "The finance service is temporarily unavailable" };
        const data = await response.json() as { chart?: { result?: Array<{ meta?: { symbol?: string; longName?: string; shortName?: string; regularMarketPrice?: number; chartPreviousClose?: number; regularMarketTime?: number; currency?: string } }> } };
        const meta = data.chart?.result?.[0]?.meta;
        if (!meta?.regularMarketPrice) return { ok: false, error: `Orbit couldn't find a quote for ${ticker}` };
        const name = meta.longName || meta.shortName || meta.symbol || ticker;
        const price = meta.regularMarketPrice;
        const previous = meta.chartPreviousClose;
        const change = previous ? price - previous : undefined;
        const changePct = previous ? (change! / previous) * 100 : undefined;
        const direction = change == null ? "" : change >= 0 ? "up" : "down";
        const changeText = change == null ? "" : ` ${direction} ${Math.abs(changePct!).toFixed(1)} percent from the previous close`;
        const excerpt = `${name} (${meta.symbol || ticker}) is trading at ${price.toFixed(2)} ${meta.currency || "USD"}${changeText}.`;
        return { ok: true, sources: [{ title: `${name} quote`, url: "", excerpt }], source: "Yahoo Finance", updatedAt: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString() };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Finance service failed" };
      }
    },
  };
}
