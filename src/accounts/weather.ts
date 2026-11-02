/**
 * Weather from Open-Meteo (https://open-meteo.com, no key). One GET on a pinned origin; the location comes from
 * config (`accounts.weather`), never from Claude. The response is untrusted: only numbers are read, no string from it
 * is ever echoed. Weather is not private data, so the tool does not arm the cross-site taint.
 */
import { AccountHttpError, type ApiClient } from './http.js';
import { field } from './result.js';

export const WEATHER_ORIGIN = 'https://api.open-meteo.com';
export const DEFAULT_WEATHER = { latitude: 43.6532, longitude: -79.3832, label: 'Toronto, ON' } as const;

export type WeatherDay = 'today' | 'tomorrow';

export interface WeatherPlace {
  latitude: number;
  longitude: number;
  label: string;
}

export interface Weather {
  /** Right now (today only). */
  now: { temp: number; feelsLike: number; code: number; wind: number } | null;
  high: number;
  low: number;
  /** Percent, null when the model gave none. */
  rain: number | null;
  code: number;
}

/** WMO weather interpretation code → a short word. */
export function weatherWord(code: number): string {
  if (code === 0) return 'clear';
  if (code === 1) return 'mostly clear';
  if (code === 2) return 'partly cloudy';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if (code >= 61 && code <= 65) return 'rain';
  if (code === 66 || code === 67) return 'freezing rain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'rain showers';
  if (code === 85 || code === 86) return 'snow showers';
  if (code >= 95 && code <= 99) return 'thunderstorm';
  return 'unsettled';
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const at = (o: unknown, key: string, i: number): number | null => {
  const a = (o as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(a) ? num(a[i]) : null;
};
const unreadable = () => new AccountHttpError('the weather service sent an answer Stephen could not read');

/** Pure: the parsed JSON → numbers. Throws AccountHttpError when the needed numbers are missing. */
export function parseWeather(data: unknown, day: WeatherDay): Weather {
  const d = data as { current?: unknown; daily?: unknown } | null;
  const i = day === 'tomorrow' ? 1 : 0;
  const high = at(d?.daily, 'temperature_2m_max', i);
  const low = at(d?.daily, 'temperature_2m_min', i);
  const code = at(d?.daily, 'weather_code', i);
  const rain = at(d?.daily, 'precipitation_probability_max', i);
  if (high === null || low === null || code === null) throw unreadable();
  let now: Weather['now'] = null;
  if (day === 'today') {
    const c = d?.current as Record<string, unknown> | null | undefined;
    const temp = num(c?.temperature_2m);
    const cc = num(c?.weather_code);
    if (temp === null || cc === null) throw unreadable();
    now = { temp, feelsLike: num(c?.apparent_temperature) ?? temp, code: cc, wind: num(c?.wind_speed_10m) ?? 0 };
  }
  return { now, high, low, rain, code };
}

const deg = (n: number) => `${Math.round(n)}°C`;

/** The header and lines of the data block (the label is the owner's own config text, cleaned anyway). No coordinates. */
export function formatWeather(w: Weather, place: Pick<WeatherPlace, 'label'>, day: WeatherDay): { header: string; lines: string[] } {
  const label = field(place.label, 60) || 'your location';
  const rain = w.rain === null ? '' : `, ${Math.round(w.rain)}% chance of rain`;
  const range = `high ${deg(w.high)}, low ${deg(w.low)}${rain}`;
  if (day === 'tomorrow' || !w.now) return { header: `Weather in ${label}, tomorrow:`, lines: [`- ${weatherWord(w.code)}, ${range}`] };
  const n = w.now;
  return {
    header: `Weather in ${label}, now and today:`,
    lines: [`- now: ${weatherWord(n.code)}, ${deg(n.temp)} (feels like ${deg(n.feelsLike)}), wind ${Math.round(n.wind)} km/h`, `- today: ${range}`],
  };
}

/** One call to Open-Meteo for the configured place. */
export async function fetchWeather(api: ApiClient, place: WeatherPlace, day: WeatherDay, timeZone: string | undefined): Promise<Weather> {
  const q = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
    timezone: timeZone ?? 'auto',
    forecast_days: '2',
  });
  return parseWeather(await api.getJson(`/v1/forecast?${q}`), day);
}
