# McMap

Every McDonald's on Earth, on one map. Red pins are ones you haven't been to,
green pins are ones you have. No server, no account, no tracking — your visits
and ratings live in your browser's `localStorage` and never leave your device.

**→ [rquw.github.io/McMap](https://rquw.github.io/McMap)**

## What it does

- **36,411 restaurants**, every one that OpenStreetMap knows about, shipped with
  the app. Nothing is queried while you browse.
- **Tap a pin** to rate it out of five, mark it visited, or open it in Google or
  Apple Maps.
- **A progress bar that follows your zoom** — from the street you're standing on
  out to the whole planet.
- **The area being counted is outlined** on the map, so you can see exactly what
  the number refers to.
- **Search** any city, region or country instantly; anything else falls through
  to a place search.
- English and German, light and dark.

## Running it locally

Static files, no build step, no dependencies:

```bash
python3 -m http.server 5178
```

Then open <http://localhost:5178>. (Opening `index.html` off disk mostly works,
but some browsers block `fetch` from `file://`.)

## How it works

Everything the map needs is precomputed. The two data files are built once, then
the app is pure arithmetic in the browser:

| File | Size | Holds |
| --- | --- | --- |
| `data/mcdonalds.json` | 1.8 MB (0.66 gzipped) | id, position, country, region, city, district |
| `data/mcdonalds-details.json` | 1.2 MB (0.31 gzipped) | address, opening hours, drive-thru, Wi-Fi |

The core file is loaded before the first paint; details arrive afterwards, since
they only matter once you open a pin. Both are columnar — parallel arrays plus
string tables for the repeated values — which roughly halves the byte count
against one object per restaurant and parses far faster. Latitudes are
delta-encoded, which is worth about a third of the file on its own.

Counting is a lookup. Every scope the progress bar can name (country, region,
city, district, continent) is grouped once at load with its restaurant count and
bounding box, so moving the map is a hash lookup rather than a network request.

| Zoom | Scope | Example |
| --- | --- | --- |
| 17+ | what's on screen | *You've been to the one McDonald's here.* |
| 15–16 | district | *2/6 in **Innere Stadt*** |
| 12–14 | city | *2/53 in **Wien*** |
| 9–11 | state / region | *9/19 in **Oberösterreich*** |
| 6–8 | country | *15/212 in **Österreich*** |
| 4–5 | continent | *15/9,118 in **Europa*** |
| ≤ 3 | Earth | *15/36,411 on **Earth*** |

Past ~500 restaurants in view, DOM pins would bring the browser down, so every
location is drawn as a translucent dot on a single canvas instead. Nothing ever
disappears because you zoomed out — at world zoom you can read the continents
off the dots alone. Positions are stored as precomputed Web Mercator, so a
full-planet redraw is a multiply and a subtract per restaurant.

The only network calls while you use the app are the basemap tiles and, when a
scope changes, one cached Nominatim lookup for the boundary outline. That
outline is decorative and always asynchronous: if it fails, the counts are
unaffected.

| Piece | Source |
| --- | --- |
| Restaurant data | [OpenStreetMap](https://www.openstreetmap.org) via [QLever](https://qlever.dev) |
| Basemap | [OpenFreeMap](https://openfreemap.org) vector tiles (Positron / dark), no API key |
| Boundary outlines & place search | [Nominatim](https://nominatim.openstreetmap.org) |

## Rebuilding the data

```bash
./tools/fetch_raw.sh          # ~35 MB of CSV into build/, about a minute
python3 tools/build_dataset.py # merges, dedupes, writes data/*.json
python3 tools/stamp.py         # cache-bust index.html asset URLs
```

`fetch_raw.sh` pulls from QLever's OSM-planet SPARQL endpoint rather than
Overpass — one indexed query returns the whole planet in seconds, where Overpass
needs hundreds of bbox requests and rate-limits hard.

`build_dataset.py` does the parts that need judgement:

- **Deduping.** A restaurant mapped as both a node and its building outline
  appears twice; the node wins, so ids stay stable across rebuilds and your
  saved visits keep matching.
- **Picking the right boundary.** Administrative relations overlap, so for each
  restaurant and each level it takes the smallest enclosing one. Without that,
  coastal restaurants get attributed to territorial-water relations, which carry
  no country code at all.
- **Knowing what a "city" is.** Level 8 in most countries, 6–7 in some, and for
  city-states like Vienna, Berlin, Singapore and Hong Kong there is no unit
  below level 4 — so level 4 is the fallback. Austrian cadastral parcels
  (*Katastralgemeinde …*) are filtered out of districts; they're a land-registry
  unit, not a neighbourhood.
- **Qualifying district names.** 207 district names repeat across cities in the
  same country — *Innere Stadt*, *Centro*, *Belmont* — so district keys carry
  their city or Linz ends up counting Klagenfurt's restaurants.

## Known limits

- Coverage is OpenStreetMap's. It's excellent in Europe, North America and East
  Asia, and thinner where there are few mappers — 36,411 of the roughly 43,000
  McDonald's that exist. Every figure the app shows is a count of the restaurants
  it actually holds, so the numbers are exact and consistent at every zoom, but
  they are not the company's own totals.
- Boundary outlines are simplified, more so the further you zoom out, so a pin
  within a few hundred metres of a border can sit on the visually wrong side of
  its own outline. The counts use precomputed OSM attribution, not the drawn
  polygon, so they stay correct either way.
- The dataset is a snapshot. Re-run the pipeline to refresh it.

## Licence

Restaurant and boundary data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright).
