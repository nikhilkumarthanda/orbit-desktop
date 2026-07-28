import type { LiveInfoService, ServiceOutcome } from "./types.js";

const WEATHER_DESCRIPTIONS: Record<number, string> = {
  0: "clear skies", 1: "mainly clear skies", 2: "partly cloudy skies", 3: "overcast skies", 45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain", 71: "light snow",
  73: "snow", 75: "heavy snow", 80: "light rain showers", 81: "rain showers", 82: "heavy rain showers", 95: "thunderstorms",
};

async function geocodePlace(place: string) {
  const endpoint = new URL("https://geocoding-api.open-meteo.com/v1/search");
  endpoint.search = new URLSearchParams({ name: place, count: "1", language: "en", format: "json" }).toString();
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(8_000) });
  const result = (await response.json() as { results?: Array<{ latitude: number; longitude: number; name: string; admin1?: string }> }).results?.[0];
  if (!result) throw new Error(`I couldn't find weather for ${place}`);
  return { latitude: result.latitude, longitude: result.longitude, label: [result.name, result.admin1].filter(Boolean).join(", ") };
}

async function resolvePlace(query: string, resolveLocation: () => Promise<{ latitude: number; longitude: number }>) {
  const place = query.match(/\b(?:weather|temperature|forecast)(?:\s+(?:right now|today|now))?\s+(?:in|for|at)\s+(.+?)[?.!]*$/i)?.[1]?.trim();
  if (place) return geocodePlace(place);
  try { return { ...(await resolveLocation()), label: "your location" }; }
  catch {
    const response = await fetch("https://ipapi.co/json/", { headers: { "User-Agent": "Orbit-Desktop" }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Location is unavailable. Ask me "weather in Houston" or another city.`);
    const data = await response.json() as { latitude?: number; longitude?: number; city?: string; region?: string };
    if (data.latitude == null || data.longitude == null) throw new Error(`Location is unavailable. Ask me "weather in Houston" or another city.`);
    return { latitude: data.latitude, longitude: data.longitude, label: [data.city, data.region].filter(Boolean).join(", ") || "your area" };
  }
}

export function createWeatherService(resolveLocation: () => Promise<{ latitude: number; longitude: number }>): LiveInfoService {
  return {
    name: "weather",
    appliesTo: query => /\b(weather|temperature|forecast|rain|raining|umbrella|sunny|snow|humid)\b/i.test(query),
    async fetch(query): Promise<ServiceOutcome> {
      try {
        const { latitude, longitude, label } = await resolvePlace(query, resolveLocation);
        const endpoint = new URL("https://api.open-meteo.com/v1/forecast");
        endpoint.search = new URLSearchParams({
          latitude: String(latitude), longitude: String(longitude),
          current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
          temperature_unit: "fahrenheit", wind_speed_unit: "mph", timezone: "auto",
        }).toString();
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(8_000) });
        if (!response.ok) return { ok: false, error: "The weather service is temporarily unavailable" };
        const data = await response.json() as { current?: { temperature_2m?: number; apparent_temperature?: number; weather_code?: number; wind_speed_10m?: number; time?: string } };
        const current = data.current;
        if (current?.temperature_2m == null) return { ok: false, error: "The weather service returned incomplete conditions" };
        const condition = WEATHER_DESCRIPTIONS[current.weather_code ?? -1] || "current conditions";
        const excerpt = `In ${label} it is ${Math.round(current.temperature_2m)} degrees with ${condition}. It feels like ${Math.round(current.apparent_temperature ?? current.temperature_2m)} degrees, with winds around ${Math.round(current.wind_speed_10m ?? 0)} miles per hour.`;
        return { ok: true, sources: [{ title: "Current weather", url: "", excerpt }], source: "Open-Meteo", updatedAt: current.time || new Date().toISOString() };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Weather service failed" };
      }
    },
  };
}
