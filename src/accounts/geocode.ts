/**
 * City name → coordinates, from Open-Meteo's geocoding service (https://open-meteo.com/en/docs/geocoding-api, no key,
 * free for non-commercial use, location data based on GeoNames, CC BY 4.0). Owner-only: called from
 * `stephen accounts weather set <city>` and `stephen setup`, never from a model tool, so Claude cannot change the place.
 *
 * The answer is untrusted. Only numbers in range and a strict label are read: letters (any script), spaces, `.`, `-`
 * and `'` per part, parts joined by ", ", at most 60 characters. Coordinates are rounded to 2 decimals (about 1 km).
 */
import { AccountHttpError, type ApiClient } from './http.js';
import type { WeatherPlace } from './weather.js';

export const GEOCODE_ORIGIN = 'https://geocoding-api.open-meteo.com';
export const GEOCODE_CREDIT = 'Places from Open-Meteo.com (location data based on GeoNames).';
export const MAX_MATCHES = 5;
const MAX_LABEL = 60;

/** Round to 2 decimals (about 1 km): weather needs no more. */
export const roundCoord = (n: number): number => Math.round(n * 100) / 100;

/** One part of a label: only letters, marks, spaces, `.`, `-`, `'`. Everything else is dropped. */
const part = (v: unknown): string =>
  typeof v === 'string'
    ? v
        .slice(0, 200)
        .normalize('NFKC')
        .replace(/[^\p{L}\p{M} .'-]/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
    : '';

/** Pure: name, region and country → "Springfield, Illinois, United States", cut to 60 characters. '' when nothing is left. */
export function placeLabel(r: { name?: unknown; admin1?: unknown; country?: unknown }): string {
  const parts = [part(r.name), part(r.admin1), part(r.country)].filter((p, i, a) => p && a.indexOf(p) === i);
  const label = parts.join(', ');
  return label.length > MAX_LABEL ? label.slice(0, MAX_LABEL).trim() : label;
}

const coord = (v: unknown, max: number): number | null => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max ? roundCoord(v) : null);

/** Pure: the parsed JSON → at most 5 places. A result with a bad number or no usable name is skipped. */
export function parseGeocode(data: unknown): WeatherPlace[] {
  const results = (data as { results?: unknown } | null)?.results;
  if (results === undefined) return [];
  if (!Array.isArray(results)) throw new AccountHttpError('the place lookup sent an answer Stephen could not read');
  const out: WeatherPlace[] = [];
  for (const r of results.slice(0, 20)) {
    if (!r || typeof r !== 'object') continue;
    const latitude = coord((r as Record<string, unknown>).latitude, 90);
    const longitude = coord((r as Record<string, unknown>).longitude, 180);
    const label = placeLabel(r as Record<string, unknown>);
    if (latitude === null || longitude === null || !label) continue;
    out.push({ latitude, longitude, label });
    if (out.length === MAX_MATCHES) break;
  }
  return out;
}

/** The typed name, cleaned the same way; null when it is too short to look up (the service needs 2 characters). */
export function cityQuery(raw: string): string | null {
  // "Paris, France" keeps its comma: the service uses the part after it to narrow the matches.
  const q = raw.slice(0, 200).split(',').map(part).filter(Boolean).join(', ').slice(0, 100);
  return q.length >= 2 ? q : null;
}

/** One GET with the typed city name. Nothing else is sent. */
export async function lookupPlaces(api: ApiClient, query: string): Promise<WeatherPlace[]> {
  const q = new URLSearchParams({ name: query, count: String(MAX_MATCHES), language: 'en', format: 'json' });
  return parseGeocode(await api.getJson(`/v1/search?${q}`));
}
