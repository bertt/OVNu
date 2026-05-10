# OVNu – Real-time departure times for bus, train & tram

A fully static, client-side website that uses your location (or a search query) to find the nearest public transit stops and show upcoming departures. No server required — runs entirely in the browser.

Built on multiple GTFS feeds, currently covering:
- 🇳🇱 **Netherlands** — [OVapi](https://gtfs.ovapi.nl), all 40 NL operators (NS, GVB, RET, HTM, U-OV, Connexxion, Arriva, Qbuzz, MeerPlus, and more)
- 🇧🇪 **Belgium (De Lijn)** — all Flemish bus and tram services

## 🌐 Live

👉 **[https://bertt.github.io/OVNu/](https://bertt.github.io/OVNu/)**

## Features

- 📍 GPS location → nearest stops & stations on a Leaflet/OpenStreetMap map
- 🔍 Search by stop name, station name, or city (multi-word autocomplete)
- 🗓️ Day selector: Today / Mon–Fri / Saturday / Sunday
- ⏱️ Today view shows only upcoming departures; next departure is highlighted
- 🚉 Platform grouping: large stations (e.g. with platforms A/B/C) are shown as one entry; a **Platform** column appears in the departure table when relevant
- 🗺️ Click the map button on any departure to draw its route on the map
- 📦 No backend — works on GitHub Pages or any static host

## Data

| File | Contents | Size (NL only) |
|---|---|---|
| `data/stops.json` | 78,000+ stops & stations with coordinates | ~6 MB |
| `data/schedules/{feed}/{stop_id}.json` | Per-stop departures (time, line, headsign, shape) | ~62,000 files |
| `data/shapes/{feed}/{shape_id}.json` | Route polylines as `[[lat,lon],…]` | ~9,500 files |

Stop IDs in `stops.json` are namespaced with the feed name (e.g. `nl:12345`, `be-delijn:67890`). The file paths use the same namespace as a subdirectory (`schedules/nl/12345.json`).

The `data/` folder is **not committed to git** — it is generated fresh each week by the GitHub Actions workflow from the latest GTFS feeds.

## Local development

### Requirements

- Node.js 18+

### Install & build

```bash
npm install
npm run build   # downloads all GTFS feeds and generates data/
npm run serve   # starts local server → http://localhost:3000/src/
```

Each feed is cached separately (e.g. `build/gtfs-nl.zip`, `build/gtfs-be-delijn.zip`). Delete a zip to force a fresh download for that feed.

## GitHub Pages deployment

1. Push this repo to GitHub.

2. Go to **Settings → Pages → Source** and select **GitHub Actions**.

3. Trigger the first run manually: **Actions → OVNu – Build & Deploy → Run workflow**.

The workflow runs automatically every **Monday at 04:00 UTC** to pick up updated schedules.

## Configuring feeds

Feeds are defined in `build/feeds.json`. Each entry has a `name` (used as the ID prefix and cache filename), a human-readable `label`, and a `url`:

```json
[
  { "name": "nl",       "label": "🇳🇱 Netherlands (OVapi)", "url": "https://gtfs.ovapi.nl/nl/gtfs-nl.zip" },
  { "name": "be-delijn","label": "🇧🇪 Belgium – De Lijn",   "url": "https://data.gtfs.be/delijn/gtfs/be-delijn-gtfs.zip" }
]
```

To add a new feed, append an entry to `feeds.json` and run `npm run build`. The build script automatically handles both `calendar.txt` and `calendar_dates.txt` service definitions.

Popular GTFS sources:
- 🇳🇱 Netherlands (all operators): `https://gtfs.ovapi.nl/nl/gtfs-nl.zip`
- 🇧🇪 Belgium – De Lijn: `https://data.gtfs.be/delijn/gtfs/be-delijn-gtfs.zip`
- 🌍 Many countries: [transitfeeds.com](https://transitfeeds.com) / [mobilitydatabase.org](https://mobilitydatabase.org)

## Project structure

```
OVNu/
├── .github/
│   └── workflows/
│       └── deploy.yml        ← weekly build + GitHub Pages deploy
├── build/
│   ├── feeds.json            ← list of GTFS feeds to process
│   └── process-gtfs.js       ← GTFS download, streaming pipeline, data generation
├── src/
│   ├── index.html
│   ├── app.js                ← all client-side logic
│   └── style.css
├── data/                     ← generated (not in git)
│   ├── stops.json
│   ├── routes.json
│   ├── schedules/            ← per-stop JSON files (nl/*, be-delijn/*, …)
│   └── shapes/               ← route shape files  (nl/*, be-delijn/*, …)
├── index.html                ← root redirect to src/
└── package.json
```

