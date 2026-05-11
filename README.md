# OVNu – Real-time departure times for bus, train & tram

A fully static, client-side website that uses your location (or a search query) to find the nearest public transit stops and show upcoming departures. No server required — runs entirely in the browser.

Built on the Dutch GTFS feed, currently covering:
- 🇳🇱 **Netherlands** — [OVapi](https://gtfs.ovapi.nl), all 40 NL operators (NS, GVB, RET, HTM, U-OV, Connexxion, Arriva, Qbuzz, MeerPlus, and more)

Blog see https://bertt.wordpress.com/2026/05/11/gtfs-public-transport-data-as-a-standard/

## 🌐 Live

👉 **[https://bertt.github.io/OVNu/](https://bertt.github.io/OVNu/)**

## Features

- 📍 GPS location → nearest stops & stations on a Leaflet/OpenStreetMap map
- 🔍 Search by stop name, station name, or city (multi-word autocomplete)
- 🗓️ Day selector: Today / Mon–Fri / Saturday / Sunday
- ⏱️ Today view shows only upcoming departures; next departure is highlighted
- 🚉 Platform grouping: large stations (e.g. with platforms A/B/C) are shown as one entry; a **Platform** column appears in the departure table when relevant
- 🗺️ Click any line in the departure table to view the full route on a map; if arriving from a stop the selected stop is highlighted and shown above the map with a link back
- 📦 No backend — works on GitHub Pages or any static host

## Data

| File | Contents | Size |
|---|---|---|
| `data/stops.json` | 78,000+ stops & stations with coordinates | ~6 MB |
| `data/schedules/{stop_id}.json` | Per-stop departures (time, line, headsign) | ~62,000 files |
| `data/route-stops/{route_id}.json` | Ordered stop list per route direction | ~8,000 files |

Stop IDs and route IDs in all data files are plain GTFS IDs (e.g. `3517780`, `106131`) — no feed prefix. The `data/` folder is **not committed to git** — it is generated fresh each week by the GitHub Actions workflow from the latest GTFS feed.

## Local development

### Requirements

- Node.js 18+

### Install & build

```bash
npm install
npm run build   # downloads the GTFS feed and generates data/
npm run serve   # starts local server → http://localhost:3000/src/
```

The feed zip is cached at `build/gtfs-nl.zip`. Delete it to force a fresh download.

## GitHub Pages deployment

1. Push this repo to GitHub.

2. Go to **Settings → Pages → Source** and select **GitHub Actions**.

3. Trigger the first run manually: **Actions → OVNu – Build & Deploy → Run workflow**.

The workflow runs automatically every **Monday at 04:00 UTC** to pick up updated schedules.

## Configuring feeds

The feed is defined in `build/feeds.json`:

```json
[
  { "name": "nl", "label": "🇳🇱 Netherlands (OVapi)", "url": "https://gtfs.ovapi.nl/nl/gtfs-nl.zip" }
]
```

To add a feed, append an entry to `feeds.json` and run `npm run build`. The build script handles both `calendar.txt` and `calendar_dates.txt` service definitions.

Popular GTFS sources:
- 🇳🇱 Netherlands (all operators): `https://gtfs.ovapi.nl/nl/gtfs-nl.zip`
- 🌍 Many countries: [transitfeeds.com](https://transitfeeds.com) / [mobilitydatabase.org](https://mobilitydatabase.org)

## Project structure

```
OVNu/
├── .github/
│   └── workflows/
│       └── deploy.yml        ← weekly build + GitHub Pages deploy
├── build/
│   ├── feeds.json            ← GTFS feed definition
│   └── process-gtfs.js       ← GTFS download, streaming pipeline, data generation
├── src/
│   ├── index.html            ← main page (stop search + departures)
│   ├── app.js                ← all client-side logic
│   ├── route.html            ← route map page (stop list + map)
│   ├── lines.html            ← all lines overview
│   └── style.css
├── data/                     ← generated (not in git)
│   ├── stops.json
│   ├── schedules/            ← per-stop JSON files ({stop_id}.json)
│   └── route-stops/          ← per-route JSON files ({route_id}.json)
├── index.html                ← root redirect to src/
└── package.json
```

