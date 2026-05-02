# OVNu – Real-time departure times for bus, train & tram

A fully static, client-side website that uses your location (or a search query) to find the nearest public transit stops and show upcoming departures. No server required — runs entirely in the browser.

Built on the national Dutch GTFS feed from [OVapi](https://gtfs.ovapi.nl), covering **all 40 NL transit operators** (bus, train, tram, metro, and express bus): NS, GVB, RET, HTM, U-OV, Connexxion, Arriva, Qbuzz, MeerPlus, and more.

## 🌐 Live

👉 **[https://bertt.github.io/OVNu/](https://bertt.github.io/OVNu/)**

## Features

- 📍 GPS location → nearest stops & stations on a Leaflet/OpenStreetMap map
- 🔍 Search by stop name, station name, or city (multi-word autocomplete)
- 🗓️ Day selector: Today / Mon–Fri / Saturday / Sunday
- ⏱️ Today view shows only upcoming departures; next departure is highlighted
- 🗺️ Click the map button on any departure to draw its route on the map
- 📦 No backend — works on GitHub Pages or any static host

## Data

| File | Contents | Size |
|---|---|---|
| `data/stops.json` | 52,000+ stops & stations with coordinates | ~4 MB |
| `data/schedules/{stop_id}.json` | Per-stop departures (time, line, headsign, shape) | ~62,000 files |
| `data/shapes/{shape_id}.json` | Route polylines as `[[lat,lon],…]` | ~9,500 files |

The `data/` folder is **not committed to git** — it is generated fresh each week by the GitHub Actions workflow from the latest GTFS feed.

## Local development

### Requirements

- Node.js 18+

### Install & build

```bash
npm install
npm run build   # downloads GTFS feed (~238 MB) and generates data/
npm run serve   # starts local server → http://localhost:3000/src/
```

The GTFS zip is cached at `build/gtfs-nl.zip`. Delete it to force a fresh download.

## GitHub Pages deployment

1. Push this repo to GitHub.

2. Go to **Settings → Pages → Source** and select **GitHub Actions**.

3. Trigger the first run manually: **Actions → OVNu – Build & Deploy → Run workflow**.

The workflow runs automatically every **Monday at 04:00 UTC** to pick up updated schedules.

## Using a different GTFS feed

The build script (`build/process-gtfs.js`) works with any standard GTFS feed. To point it at a different source:

1. Open `build/process-gtfs.js` and update the `GTFS_URL` constant at the top:
   ```js
   const GTFS_URL = 'https://your-gtfs-provider.example/gtfs.zip';
   ```

2. If the feed uses `calendar.txt` instead of (or in addition to) `calendar_dates.txt`, the
   service-day classification at the top of `build/process-gtfs.js` may need adjustment —
   look for the comment `// classify service days`.

3. Run `npm run build`. All output files are regenerated automatically.

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
│   └── process-gtfs.js       ← GTFS download, streaming pipeline, data generation
├── src/
│   ├── index.html
│   ├── app.js                ← all client-side logic
│   └── style.css
├── data/                     ← generated (not in git)
│   ├── stops.json
│   ├── routes.json
│   ├── schedules/            ← ~52,000 per-stop JSON files
│   └── shapes/               ← ~9,500 route shape files
├── index.html                ← root redirect to src/
└── package.json
```

