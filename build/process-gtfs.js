#!/usr/bin/env node
/**
 * GTFS data processor for RRReis/Connexxion bus stops in the Netherlands.
 * Downloads the national GTFS feed and extracts relevant schedule data
 * for use in the static client-side bushalte website.
 *
 * Output files in ../data/:
 *   stops.json         - [{id, name, lat, lon, town}]
 *   routes.json        - [{id, short_name, long_name}]
 *   stop_schedule.json - {stop_id: {weekday:[],saturday:[],sunday:[]}}
 */

import { createWriteStream, existsSync, readFileSync, writeFileSync, mkdirSync, createReadStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import AdmZip from 'adm-zip';
import { parse as csvParse } from 'csv-parse';
import { parse as csvParseSync } from 'csv-parse/sync';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = join(__dirname, '..', 'data');
const GTFS_URL   = 'https://gtfs.ovapi.nl/nl/gtfs-nl.zip';
const GTFS_FILE  = join(__dirname, 'gtfs-nl.zip');
const EXTRACT_DIR = join(__dirname, 'gtfs-extracted');

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);
}

// ── Download ──────────────────────────────────────────────────────────────────

async function download() {
  if (existsSync(GTFS_FILE)) {
    log('Using cached gtfs-nl.zip (delete build/gtfs-nl.zip to re-download)');
    return;
  }
  log(`Downloading ${GTFS_URL} ...`);
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const total = parseInt(res.headers.get('content-length') || '0');
  let received = 0;
  const dest = createWriteStream(GTFS_FILE);
  const reader = res.body.getReader();
  const stream = new ReadableStream({
    async start(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); break; }
        received += value.length;
        if (total) process.stdout.write(`\r  ${(received/1e6).toFixed(1)} / ${(total/1e6).toFixed(1)} MB`);
        controller.enqueue(value);
      }
    }
  });
  await pipeline(stream, dest);
  process.stdout.write('\n');
  log('Download complete');
}

// ── Extract needed files to disk (avoids string-length limits) ───────────────

const NEEDED = ['agency.txt','routes.txt','trips.txt','stops.txt','stop_times.txt','calendar_dates.txt','shapes.txt'];

function extractFiles(zip) {
  mkdirSync(EXTRACT_DIR, { recursive: true });
  for (const name of NEEDED) {
    const dest = join(EXTRACT_DIR, name);
    if (existsSync(dest)) { log(`  ${name} already extracted`); continue; }
    log(`  Extracting ${name}...`);
    const entry = zip.getEntry(name);
    if (!entry) { log(`  WARNING: ${name} not in zip`); continue; }
    zip.extractEntryTo(entry, EXTRACT_DIR, false, true);
  }
}

// ── Parse small file from disk ────────────────────────────────────────────────

function parseSmall(name) {
  return csvParseSync(readFileSync(join(EXTRACT_DIR, name), 'utf8'),
    { columns: true, skip_empty_lines: true, trim: true });
}

// ── Stream a large CSV file row-by-row ───────────────────────────────────────

function streamCsv(name, onRow) {
  return new Promise((resolve, reject) => {
    const parser = csvParse({ columns: true, skip_empty_lines: true, trim: true });
    let count = 0;
    parser.on('readable', () => {
      let row;
      while ((row = parser.read()) !== null) {
        onRow(row);
        if (++count % 1_000_000 === 0) log(`  ...${(count/1e6).toFixed(0)}M rows`);
      }
    });
    parser.on('error', reject);
    parser.on('end', () => resolve(count));
    createReadStream(join(EXTRACT_DIR, name)).pipe(parser);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await download();

  log('Opening zip...');
  const zip = new AdmZip(GTFS_FILE);

  log('Extracting files to disk...');
  extractFiles(zip);

  // 1. Load all agencies (full NL coverage)
  log('Parsing agency.txt...');
  const agencies = parseSmall('agency.txt');
  log(`${agencies.length} agencies (all NL OV included)`);
  const agencyIds = new Set(agencies.map(a => a.agency_id));
  const agencyMap = new Map(agencies.map(a => [a.agency_id, a.agency_name]));

  // 2. Routes for all agencies
  log('Parsing routes.txt...');
  const allRoutes = parseSmall('routes.txt');
  const routes = allRoutes.filter(r => agencyIds.has(r.agency_id));
  const routeMap = new Map(routes.map(r => [r.route_id, r]));
  const routeAgency = new Map(routes.map(r => [r.route_id, r.agency_id])); // route_id → agency_id
  log(`${routes.length} routes`);

  // 3. Trips for those routes
  log('Parsing trips.txt...');
  const allTrips = parseSmall('trips.txt');
  const trips = allTrips.filter(t => routeMap.has(t.route_id));
  const tripMap = new Map(trips.map(t => [t.trip_id, t]));
  const serviceIds = new Set(trips.map(t => t.service_id));
  log(`${trips.length} trips, ${serviceIds.size} service_ids`);

  // 4. Classify each service_id by day-of-week from calendar_dates.txt
  log('Parsing calendar_dates.txt...');
  const calDates = parseSmall('calendar_dates.txt');
  log(`  ${calDates.length.toLocaleString()} rows`);

  const today = new Date();
  const sixMonthsOn = new Date(today);
  sixMonthsOn.setMonth(sixMonthsOn.getMonth() + 6);

  const serviceDay = new Map(); // service_id → Set<'weekday'|'saturday'|'sunday'>
  for (const row of calDates) {
    if (!serviceIds.has(row.service_id) || row.exception_type !== '1') continue;
    const d = row.date;
    const dt = new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`);
    if (dt < today || dt > sixMonthsOn) continue;
    const dow = dt.getDay();
    const dayType = dow === 0 ? 'sunday' : dow === 6 ? 'saturday' : 'weekday';
    if (!serviceDay.has(row.service_id)) serviceDay.set(row.service_id, new Set());
    serviceDay.get(row.service_id).add(dayType);
  }
  for (const [k, v] of serviceDay) serviceDay.set(k, [...v]);
  log(`  ${serviceDay.size} services classified`);

  // 5. Stops lookup
  log('Parsing stops.txt...');
  const allStops = parseSmall('stops.txt');
  const stopMap = new Map(allStops.map(s => [s.stop_id, s]));

  // Pick one representative trip per (route_id, direction_id) for route-stop lists
  const repTripKey = new Map(); // `route_id|direction_id` → trip_id (first seen with calendar)
  for (const trip of trips) {
    if (!serviceDay.has(trip.service_id)) continue;
    const key = `${trip.route_id}|${trip.direction_id ?? '0'}`;
    if (!repTripKey.has(key)) repTripKey.set(key, trip.trip_id);
  }
  const repTripIds = new Set(repTripKey.values());
  log(`${repTripIds.size} representative trips for route-stop lists`);

  // 6. Stream stop_times (too large to load as string)
  log('Streaming stop_times.txt...');
  const usedStopIds = new Set();
  const schedule = {};
  const repTripStops = new Map(); // trip_id → [[seq, stop_id], ...]

  const rowCount = await streamCsv('stop_times.txt', (st) => {
    const trip = tripMap.get(st.trip_id);
    if (!trip) return;
    const route = routeMap.get(trip.route_id);
    if (!route) return;

    // Collect stops for representative trips (all rows, regardless of calendar)
    if (repTripIds.has(st.trip_id)) {
      if (!repTripStops.has(st.trip_id)) repTripStops.set(st.trip_id, []);
      repTripStops.get(st.trip_id).push([parseInt(st.stop_sequence), st.stop_id]);
    }

    const dayTypes = serviceDay.get(trip.service_id);
    if (!dayTypes?.length) return;

    const stopId = st.stop_id;
    usedStopIds.add(stopId);
    if (!schedule[stopId]) schedule[stopId] = { weekday: [], saturday: [], sunday: [] };

    const entry = {
      time: st.departure_time,
      line: route.route_short_name,
      headsign: trip.trip_headsign,
      agency: routeAgency.get(trip.route_id) || '',
      shape_id: trip.shape_id || undefined
    };
    for (const day of dayTypes) schedule[stopId][day].push(entry);
  });
  log(`  ${rowCount.toLocaleString()} rows processed`);

  // Sort departures by time and deduplicate
  // Pass 1: exact key dedup (same trip via multiple service_ids)
  // Pass 2: 2-minute window dedup (same trip represented with slightly different scheduled times)
  for (const sid of Object.keys(schedule)) {
    for (const day of ['weekday','saturday','sunday']) {
      const seen = new Set();
      let entries = schedule[sid][day]
        .sort((a, b) => a.time.localeCompare(b.time))
        .filter(d => {
          const key = `${d.time}|${d.line}|${d.headsign}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

      // Pass 2: collapse same line+headsign within 2 minutes (same physical trip)
      const lastMin = new Map();
      entries = entries.filter(d => {
        const key = `${d.line}|${d.headsign}`;
        const [h, m] = d.time.split(':').map(Number);
        const mins = h * 60 + m;
        const last = lastMin.get(key);
        if (last !== undefined && mins - last <= 2) return false;
        lastMin.set(key, mins);
        return true;
      });

      schedule[sid][day] = entries;
    }
  }
  log(`Schedule built for ${Object.keys(schedule).length} stops`);

  // 7. Used stops list — keep actual boarding stops (location_type 0 or empty)
  const usedStops = [...usedStopIds]
    .map(id => stopMap.get(id))
    .filter(s => s && (s.location_type === '0' || s.location_type === ''))
    .map(s => ({
      id: s.stop_id,
      name: s.stop_name,
      lat: Math.round(parseFloat(s.stop_lat) * 100000) / 100000,
      lon: Math.round(parseFloat(s.stop_lon) * 100000) / 100000,
      town: s.stop_name.includes(',') ? s.stop_name.split(',')[0].trim() : s.stop_name
    }))
    .filter(s => !isNaN(s.lat) && !isNaN(s.lon));
  log(`${usedStops.length} stops with coordinates`);

  // 8. Lines per agency — grouped, sorted, with route_type for icons
  const agencyRoutes = new Map(); // agency_id → [{short_name, long_name, route_type}]

  for (const r of routes) {
    if (!agencyRoutes.has(r.agency_id)) agencyRoutes.set(r.agency_id, []);
    agencyRoutes.get(r.agency_id).push({
      id:         r.route_id,
      short_name: r.route_short_name || '',
      long_name:  r.route_long_name  || '',
      route_type: parseInt(r.route_type) || 3
    });
  }

  // Sort routes within each agency by short_name (natural numeric sort)
  const collator = new Intl.Collator('nl', { numeric: true });
  const linesList = [...agencyRoutes.entries()]
    .map(([agency_id, rts]) => ({
      agency_id,
      agency_name: agencyMap.get(agency_id) || agency_id,
      routes: rts
        .filter((r, i, arr) =>            // deduplicate by short_name within agency
          arr.findIndex(x => x.short_name === r.short_name) === i)
        .sort((a, b) => collator.compare(a.short_name, b.short_name))
    }))
    .sort((a, b) => a.agency_name.localeCompare(b.agency_name, 'nl'));

  // Routes list (kept for backward compat)
  const routesList = routes.map(r => ({
    id: r.route_id,
    short_name: r.route_short_name,
    long_name: r.route_long_name || ''
  }));

  // 9. Write output — split schedule into per-stop files for lazy loading
  log('Writing output files...');
  mkdirSync(DATA_DIR, { recursive: true });
  const schedDir = join(DATA_DIR, 'schedules');
  mkdirSync(schedDir, { recursive: true });

  writeFileSync(join(DATA_DIR, 'stops.json'),    JSON.stringify(usedStops));
  writeFileSync(join(DATA_DIR, 'routes.json'),   JSON.stringify(routesList));
  writeFileSync(join(DATA_DIR, 'lines.json'),    JSON.stringify(linesList));
  writeFileSync(join(DATA_DIR, 'agencies.json'), JSON.stringify(
    agencies.map(a => ({ id: a.agency_id, name: a.agency_name }))
  ));
  log(`lines.json: ${linesList.length} agencies`);

  // Write one small JSON per stop
  let written = 0;
  for (const [stopId, daySched] of Object.entries(schedule)) {
    writeFileSync(join(schedDir, `${stopId}.json`), JSON.stringify(daySched));
    written++;
  }
  log(`Wrote ${written} per-stop schedule files to data/schedules/`);

  // 10. Collect all unique shape_ids referenced in schedules
  log('Collecting used shape_ids...');
  const usedShapeIds = new Set();
  for (const daySched of Object.values(schedule)) {
    for (const deps of Object.values(daySched)) {
      for (const dep of deps) {
        if (dep.shape_id) usedShapeIds.add(dep.shape_id);
      }
    }
  }
  log(`${usedShapeIds.size} unique shape_ids`);

  // 11. Stream shapes.txt → write per-shape [[lat,lon],...] files
  log('Streaming shapes.txt...');
  const shapesDir = join(DATA_DIR, 'shapes');
  mkdirSync(shapesDir, { recursive: true });
  const shapePoints = new Map(); // shape_id → [{seq, lat, lon}]

  await streamCsv('shapes.txt', (row) => {
    if (!usedShapeIds.has(row.shape_id)) return;
    if (!shapePoints.has(row.shape_id)) shapePoints.set(row.shape_id, []);
    shapePoints.get(row.shape_id).push([
      parseInt(row.shape_pt_sequence),
      Math.round(parseFloat(row.shape_pt_lat) * 100000) / 100000,
      Math.round(parseFloat(row.shape_pt_lon) * 100000) / 100000
    ]);
  });

  log(`Writing ${shapePoints.size} shape files...`);
  for (const [shapeId, pts] of shapePoints) {
    pts.sort((a, b) => a[0] - b[0]);
    const coords = pts.map(p => [p[1], p[2]]);
    writeFileSync(join(shapesDir, `${shapeId}.json`), JSON.stringify(coords));
  }
  log(`Wrote ${shapePoints.size} shape files to data/shapes/`);

  // 12. Write per-route stop lists (one file per route_id, keyed by direction)
  log('Writing route-stop files...');
  const routeStopsDir = join(DATA_DIR, 'route-stops');
  mkdirSync(routeStopsDir, { recursive: true });

  // Build: route_id → { direction_id → trip_id }
  const routeDirTrips = new Map();
  for (const [key, tripId] of repTripKey) {
    const bar = key.lastIndexOf('|');
    const routeId = key.slice(0, bar);
    const dirId   = key.slice(bar + 1);
    if (!routeDirTrips.has(routeId)) routeDirTrips.set(routeId, {});
    routeDirTrips.get(routeId)[dirId] = tripId;
  }

  let routeStopsWritten = 0;
  for (const [routeId, dirs] of routeDirTrips) {
    const result = {};
    for (const [dirId, tripId] of Object.entries(dirs)) {
      const raw = repTripStops.get(tripId) || [];
      raw.sort((a, b) => a[0] - b[0]);
      result[dirId] = raw.map(([, stopId]) => {
        const s = stopMap.get(stopId);
        if (!s) return null;
        return {
          id: stopId,
          name: s.stop_name,
          lat: Math.round(parseFloat(s.stop_lat) * 100000) / 100000,
          lon: Math.round(parseFloat(s.stop_lon) * 100000) / 100000
        };
      }).filter(Boolean);
    }
    writeFileSync(join(routeStopsDir, `${routeId}.json`), JSON.stringify(result));
    routeStopsWritten++;
  }
  log(`Wrote ${routeStopsWritten} route-stop files to data/route-stops/`);

  const kb = f => (readFileSync(f).length / 1024).toFixed(0) + ' KB';
  log(`stops.json: ${kb(join(DATA_DIR,'stops.json'))}`);
  log(`routes.json: ${kb(join(DATA_DIR,'routes.json'))}`);
  log('✅ Done!');
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
