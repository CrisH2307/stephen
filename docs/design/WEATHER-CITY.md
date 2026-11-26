# Design note: ask the weather city at first run

Status: built (Cris said yes to both questions on 2026-11-26). Open-Meteo's free API is for non-commercial use, under
10,000 calls a day; the city list credits GeoNames (CC BY 4.0). Follow-up to B8 (#387), which removed the other personal defaults but kept
`DEFAULT_WEATHER` (Toronto, ON) as the only built-in place.

## The problem

A friend who never sets a place gets Toronto weather. Today the only way to change it is
`stephen accounts weather set <latitude> <longitude> [label]`, and most people do not know their coordinates.

## What to ask, and where

1. **`stephen setup`, one optional question**, asked only on a terminal (no TTY: skipped, setup stays non-interactive
   in scripts and CI):
   `Which city should Stephen use for the weather? (press Enter to keep Toronto, ON)`
   Then it shows up to 5 matches as plain lines (`1. Springfield, Illinois, United States`) and asks for a number.
   Enter or 0 keeps the current place. Running setup again shows the current place and asks again only if the person
   wants to change it.
2. **`stephen accounts weather set <city name>`**: the same lookup and pick, outside setup. The existing
   `set <latitude> <longitude> [label]` form stays for people who do not want any lookup (no network).
3. **Later, the helper's Settings page**: one "Weather place" field that calls the same lookup through app.sock. Not in
   the first PR.
4. **Doctor**: an info line while the place is still the built-in default: `Weather uses Toronto, ON (the built-in
   place). Set yours: stephen accounts weather set <your city>`.

## Where the coordinates come from

| Option | Network | Privacy | Work |
|---|---|---|---|
| **A. Open-Meteo geocoding** (recommended) | One GET to Open-Meteo's geocoding service with the typed name | The city name and the Mac's IP go to Open-Meteo, the provider that already gets the coordinates on every forecast. No new third party, no key, no account | Small: one pinned origin in `src/accounts/`, like `WEATHER_ORIGIN` |
| B. Apple geocoder (CLGeocoder in the helper) | To Apple | The name goes to Apple, a second party | Medium: Swift, a new helper protocol message, macOS only |
| C. Offline city list bundled | None | Nothing leaves the Mac | Medium: a few MB of GeoNames data in the package, CC-BY attribution, updates by hand |
| D. The Mac's current location (CoreLocation) | To Apple | Precise location, a Location permission prompt | Rejected: far more than weather needs |

Recommendation: **A**, with the coordinate form as the no-network choice. Things to check at build time, not assumed
here: the exact endpoint and parameters, Open-Meteo's terms for the geocoding service, and its rate limit. If its
terms do not fit a free app, fall back to C.

## Privacy

- What leaves the Mac: the city name the person typed, once, when they set it, plus the IP address that any request
  carries. Nothing else: no account, no other text, no history.
- What is kept: only the picked place's latitude and longitude, **rounded to 2 decimals (about 1 km)**, and its label,
  in `config.json` (`accounts.weather`, as today). The typed text and the other matches are not stored.
- Forecast calls then send only those rounded coordinates (today they send whatever `accounts.weather` holds).
- `docs/DATA-STORES.md` "Everything that leaves the Mac" gets one row for the lookup.

## Safety

- The geocoding answer is untrusted, like the forecast: only numbers and a few fixed fields are read.
- Latitude and longitude must be numbers in range (the existing `accounts.weather` schema checks this).
- The label shown and saved is built from the answer's name, region and country, each cleaned like memory text and
  limited to letters (any script), spaces, `,`, `.`, `-` and `'`, at most 60 characters (the schema's limit). Anything
  else is dropped. The person picks it by number, so a strange label is visible before it is saved.
- The lookup is owner-only: it runs from `stephen setup` and `stephen accounts`, never from a model tool. Claude
  cannot change the place.

## First PR (when approved)

- Files: `src/accounts/geocode.ts` (new: the pinned origin, the request, the strict parse), `src/connect/accounts-cli.ts`
  (`weather set <city>`), `src/setup.ts` (the optional question), `src/cli.ts` (the doctor line),
  `docs/DATA-STORES.md`, tests with a fake fetch (no real network in tests).
- Tests: a normal pick; Enter keeps the place; no TTY skips the question; a hostile answer (huge numbers, a label with
  escape codes or a closing tag) is refused or cleaned; coordinates are rounded; the typed name is not stored.
- Size: S to M. Safety: owner-only config write, so `[DEV REVIEW]`.

## Questions for Cris

1. Is it OK that the typed city name goes to Open-Meteo (the forecast provider already in use)?
2. Is rounding to about 1 km OK? Weather does not need more.
