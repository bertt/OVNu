# OVNu – Vertrektijden bus, trein & tram

Een 100% statische website die je locatie gebruikt om de dichtstbijzijnde OV-haltes en vertrektijden te tonen. Data van alle 40 NL OV-operators (bus, trein, tram, metro, snelbus).

## 🌐 Live

👉 **[https://bertt.github.io/OVNu/](https://bertt.github.io/OVNu/)**

## Deployment via GitHub Pages

### Eenmalige setup

1. Maak een GitHub-repository aan en push deze code:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/<jouw-naam>/<repo>.git
   git push -u origin main
   ```

2. Ga in de repository naar **Settings → Pages → Source** en kies:  
   **GitHub Actions** (niet "Deploy from a branch")

3. Ga naar **Actions** en run de workflow handmatig ("Run workflow") voor de eerste deployment.

De workflow draait vervolgens automatisch elke **maandag om 04:00 UTC** met verse GTFS-data.

---

## Lokale ontwikkeling

### Vereisten

- Node.js 18+

### Installeer en bouw

```bash
npm install
npm run build   # download GTFS (~238 MB) en genereer data/
npm run serve   # start server → http://localhost:3000/src/
```

De GTFS-download wordt gecacht in `build/gtfs-nl.zip`. Verwijder dit bestand om opnieuw te downloaden.

---

## Projectstructuur

```
bushalte-app/
├── .github/
│   └── workflows/
│       └── deploy.yml      ← weekly build + GitHub Pages deploy
├── build/
│   └── process-gtfs.js     ← GTFS build script
├── src/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── data/                   ← gegenereerd (niet in git)
│   ├── stops.json
│   ├── routes.json
│   ├── schedules/          ← ~52.000 per-halte bestanden
│   └── shapes/             ← ~9.500 routeshapes
├── index.html              ← root-redirect naar src/
└── package.json
```

## Features

- 📍 GPS-locatie → dichtstbijzijnde haltes op Leaflet/OSM kaart
- 🔍 Zoekbalk met multi-word autocomplete (unieke namen)
- 🗓️ Dag-selector: Vandaag / Ma–Vr / Zaterdag / Zondag
- ⏱️ Alleen toekomstige vertrektijden bij "Vandaag"
- 🗺️ Klik op 🗺 naast een rit → route tekenen op kaart
- Alle 40 NL OV-operators, 52.000+ haltes


Een 100% statische, client-side website die je huidige locatie gebruikt om de dichtstbijzijnde RRReis/Connexxion bushaltes en vertrektijden te tonen.

## Features

- 📍 GPS-locatie → dichtstbijzijnde haltes tonen op kaart (Leaflet/OpenStreetMap)
- 🔍 Zoeken op haltename of plaatsnaam
- 🗓️ Vertrektijden per dag: Maandag–Vrijdag, Zaterdag, Zondag
- ⏱️ Verlopen vertrektijden grijs weergeven, eerstvolgende bus gemarkeerd
- 📦 Geen server nodig — werkt op GitHub Pages, Netlify, of elk ander statisch host

## Data

Data komt uit de [nationale GTFS feed](https://gtfs.ovapi.nl/nl/gtfs-nl.zip) van OVapi, gefilterd op RRReis (Connexxion, RRReis Arriva, RRReis Keolis). De feed wordt dagelijks bijgewerkt.

## Aan de slag

### Vereisten

- Node.js 18+

### 1. Installeer dependencies

```bash
npm install
```

### 2. Genereer de data (eenmalig, daarna bij elke dienstregeling-update)

```bash
npm run build
```

Dit downloadt de GTFS-feed (~238 MB), extraheert de RRReis-data en schrijft:
- `data/stops.json` — alle haltes met coördinaten (~335 KB)
- `data/routes.json` — alle lijnen
- `data/schedules/{stop_id}.json` — vertrektijden per halte (~12.000 bestanden)

De download wordt gecached in `build/gtfs-nl.zip`. Verwijder dit bestand om opnieuw te downloaden.

### 3. Start de lokale webserver

```bash
npm run serve
```

Open dan http://localhost:3000 in je browser.

### Deployen

Commit de gegenereerde `data/` map mee en deploy de `src/` + `data/` mappen op:
- **GitHub Pages**: zet `src/` als root of gebruik een `docs/` folder
- **Netlify / Vercel**: drag-and-drop de `src/` + `data/` mappen

## Projectstructuur

```
bushalte-app/
├── build/
│   ├── process-gtfs.js     ← GTFS build script
│   ├── gtfs-nl.zip         ← gecachede download (niet in git)
│   └── gtfs-extracted/     ← uitgepakte bestanden (niet in git)
├── data/
│   ├── stops.json
│   ├── routes.json
│   └── schedules/          ← per-halte vertrektijden
├── src/
│   ├── index.html
│   ├── style.css
│   └── app.js
└── package.json
```
