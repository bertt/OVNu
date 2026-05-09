#!/usr/bin/env node
/**
 * GTFS data processor for public transit stops.
 * Downloads one or more GTFS feeds (defined in feeds.json) and merges them into
 * a single set of static data files used by the client-side website.
 *
 * Output files in ../data/:
 *   stops.json         - [{id, name, lat, lon, town}]
 *   lines.json         - [{agency_name, routes:[{id, short_name, long_name, route_type}]}]
  *   schedules/{id}.json - {deps:[], services:{svcId:[YYYYMMDD,...]}}  (per stop)
  *   shapes/{id}.json    - [[lat,lon],...]                       (per shape)
 *   route-stops/{id}.json - {direction: [{id,name,lat,lon},...]}
 *
 * Stop IDs and shape IDs are prefixed with the feed name (e.g. "nl:12345")
 * to avoid collisions between feeds.
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
const FEEDS_FILE = join(__dirname, 'feeds.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${msg}\n`);
}

// ── Download ──────────────────────────────────────────────────────────────────

async function download(feed) {
  const gtfsFile = join(__dirname, `gtfs-${feed.name}.zip`);
  if (existsSync(gtfsFile)) {
    log(`[${feed.name}] Using cached gtfs-${feed.name}.zip (delete to re-download)`);
    return gtfsFile;
  }
  log(`[${feed.name}] Downloading ${feed.url} ...`);
  const res = await fetch(feed.url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const total = parseInt(res.headers.get('content-length') || '0');
  let received = 0;
  const dest = createWriteStream(gtfsFile);
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
  log(`[${feed.name}] Download complete`);
  return gtfsFile;
}

// ── Extract needed files to disk (avoids string-length limits) ───────────────

const NEEDED = ['agency.txt','routes.txt','trips.txt','stops.txt','stop_times.txt','calendar.txt','calendar_dates.txt','shapes.txt'];

function extractFiles(zip, extractDir) {
  mkdirSync(extractDir, { recursive: true });
  for (const name of NEEDED) {
    const dest = join(extractDir, name);
    if (existsSync(dest)) { log(`  ${name} already extracted`); continue; }
    const entry = zip.getEntry(name);
    if (!entry) { log(`  (${name} not in zip, skipping)`); continue; }
    log(`  Extracting ${name}...`);
    zip.extractEntryTo(entry, extractDir, false, true);
  }
}

// ── Parse small file from disk ────────────────────────────────────────────────

function parseSmall(name, extractDir) {
  const p = join(extractDir, name);
  if (!existsSync(p)) return [];
  return csvParseSync(readFileSync(p, 'utf8'),
    { columns: true, skip_empty_lines: true, trim: true });
}

// ── Stream a large CSV file row-by-row ───────────────────────────────────────

function streamCsv(name, extractDir, onRow) {
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
    createReadStream(join(extractDir, name)).pipe(parser);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

function gtfsDateStr(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

async function processFeed(feed, shared) {
  const { schedule, usedStopIds, allStopMap, allLinesList, allAgencies, serviceDatesPerFeed } = shared;

  const gtfsFile  = await download(feed);
  const extractDir = join(__dirname, `gtfs-extracted-${feed.name}`);

  log(`[${feed.name}] Opening zip...`);
  const zip = new AdmZip(gtfsFile);

  log(`[${feed.name}] Extracting files...`);
  extractFiles(zip, extractDir);

  // 1. Agencies
  log(`[${feed.name}] Parsing agency.txt...`);
  const agencies = parseSmall('agency.txt', extractDir);
  log(`[${feed.name}] ${agencies.length} agencies`);
  const agencyIds  = new Set(agencies.map(a => a.agency_id));
  const agencyMap  = new Map(agencies.map(a => [a.agency_id, a.agency_name]));
  for (const a of agencies) {
    allAgencies.set(`${feed.name}:${a.agency_id}`, a.agency_name);
  }

  // 2. Routes
  log(`[${feed.name}] Parsing routes.txt...`);
  const allRoutes = parseSmall('routes.txt', extractDir);
  const routes = allRoutes.filter(r => agencyIds.has(r.agency_id));
  const routeMap   = new Map(routes.map(r => [r.route_id, r]));
  const routeAgency = new Map(routes.map(r => [r.route_id, r.agency_id]));
  log(`[${feed.name}] ${routes.length} routes`);

  // 3. Trips
  log(`[${feed.name}] Parsing trips.txt...`);
  const allTrips = parseSmall('trips.txt', extractDir);
  const trips = allTrips.filter(t => routeMap.has(t.route_id));
  const tripMap    = new Map(trips.map(t => [t.trip_id, t]));
  const serviceIds = new Set(trips.map(t => t.service_id));
  log(`[${feed.name}] ${trips.length} trips, ${serviceIds.size} service_ids`);

  // 4. Collect concrete running dates for each service_id
  log(`[${feed.name}] Collecting service dates...`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sixMonthsOn = new Date(today);
  sixMonthsOn.setMonth(sixMonthsOn.getMonth() + 6);
  const todayStr      = gtfsDateStr(today);
  const sixMonthsOnStr = gtfsDateStr(sixMonthsOn);

  const serviceDates = new Map(); // service_id → Set<YYYYMMDD>

  // 4a. calendar.txt (standard weekly schedule)
  const calRows = parseSmall('calendar.txt', extractDir);
  const DOW_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  for (const row of calRows) {
    if (!serviceIds.has(row.service_id)) continue;
    const start = new Date(`${row.start_date.slice(0,4)}-${row.start_date.slice(4,6)}-${row.start_date.slice(6,8)}`);
    const end   = new Date(`${row.end_date.slice(0,4)}-${row.end_date.slice(4,6)}-${row.end_date.slice(6,8)}`);
    const lo = start < today ? today : start;
    const hi = end   > sixMonthsOn ? sixMonthsOn : end;
    for (let d = new Date(lo); d <= hi; d.setDate(d.getDate() + 1)) {
      if (row[DOW_NAMES[d.getDay()]] !== '1') continue;
      const ds = gtfsDateStr(d);
      if (!serviceDates.has(row.service_id)) serviceDates.set(row.service_id, new Set());
      serviceDates.get(row.service_id).add(ds);
    }
  }
  log(`[${feed.name}] calendar.txt: ${calRows.length} service rows`);

  // 4b. calendar_dates.txt — exception_type=1 adds a date, exception_type=2 removes it
  const calDates = parseSmall('calendar_dates.txt', extractDir);
  log(`[${feed.name}] calendar_dates.txt: ${calDates.length.toLocaleString()} rows`);
  for (const row of calDates) {
    if (!serviceIds.has(row.service_id)) continue;
    const ds = row.date; // already YYYYMMDD
    if (ds < todayStr || ds > sixMonthsOnStr) continue;
    if (row.exception_type === '1') {
      if (!serviceDates.has(row.service_id)) serviceDates.set(row.service_id, new Set());
      serviceDates.get(row.service_id).add(ds);
    } else if (row.exception_type === '2') {
      serviceDates.get(row.service_id)?.delete(ds);
    }
  }

  serviceDatesPerFeed.set(feed.name, serviceDates);
  log(`[${feed.name}] ${serviceDates.size} services with concrete dates`);

  // 5. Stops — build prefixed stop map
  log(`[${feed.name}] Parsing stops.txt...`);
  const allStops = parseSmall('stops.txt', extractDir);
  for (const s of allStops) {
    allStopMap.set(`${feed.name}:${s.stop_id}`, s);
  }

  // 6. Stream stop_times — build schedules and track first departure per trip
  log(`[${feed.name}] Streaming stop_times.txt...`);
  const tripFirstDep = new Map(); // trip_id → {seq, time}
  const rowCount = await streamCsv('stop_times.txt', extractDir, (st) => {
    const trip = tripMap.get(st.trip_id);
    if (!trip) return;
    const route = routeMap.get(trip.route_id);
    if (!route) return;

    // Track first departure (lowest stop_sequence) per trip
    const seq = parseInt(st.stop_sequence);
    const cur = tripFirstDep.get(st.trip_id);
    if (!cur || seq < cur.seq) tripFirstDep.set(st.trip_id, { seq, time: st.departure_time });

    const svcDates = serviceDates.get(trip.service_id);
    if (!svcDates?.size) return;

    // Skip stops where boarding is not allowed (drop-off only / terminus arrivals).
    // pickup_type=1 means "No pickup available" per the GTFS spec — these are not departures.
    if (st.pickup_type === '1') return;

    const stopId = `${feed.name}:${st.stop_id}`;
    usedStopIds.add(stopId);
    if (!schedule[stopId]) schedule[stopId] = [];

    schedule[stopId].push({
      time:     st.departure_time,
      line:     route.route_short_name,
      headsign: trip.trip_headsign,
      agency:   routeAgency.get(trip.route_id) || '',
      route_id: trip.route_id,
      sid:      trip.service_id
    });
  });
  log(`[${feed.name}] ${rowCount.toLocaleString()} stop_times rows processed`);

  // 6b. Build route-trips: one entry per trip with first departure time
  const routeTripsMap = {}; // route_id → [trips]
  for (const trip of trips) {
    const firstDep = tripFirstDep.get(trip.trip_id);
    if (!firstDep) continue;
    const svcDates = serviceDates.get(trip.service_id);
    if (!svcDates?.size) continue;
    const rid = trip.route_id;
    if (!routeTripsMap[rid]) routeTripsMap[rid] = [];
    routeTripsMap[rid].push({
      trip_id:      trip.trip_id,
      headsign:     trip.trip_headsign || '',
      departure:    firstDep.time,
      direction_id: trip.direction_id || '0',
      sid:          trip.service_id
    });
  }
  for (const trips of Object.values(routeTripsMap)) {
    trips.sort((a, b) => a.departure.localeCompare(b.departure));
  }
  const routeTripsDir = join(DATA_DIR, 'route-trips');
  mkdirSync(routeTripsDir, { recursive: true });
  let routeTripsWritten = 0;
  for (const [routeId, trips] of Object.entries(routeTripsMap)) {
    const sids = new Set(trips.map(t => t.sid));
    const services = {};
    for (const sid of sids) {
      const dates = serviceDates.get(sid);
      if (dates?.size) services[sid] = [...dates].sort();
    }
    writeFileSync(join(routeTripsDir, `${routeId}.json`), JSON.stringify({ trips, services }));
    routeTripsWritten++;
  }
  log(`[${feed.name}] Wrote ${routeTripsWritten} route-trips files`);

  // 7. Sort + deduplicate per stop
  for (const stopId of Object.keys(schedule)) {
    if (!stopId.startsWith(`${feed.name}:`)) continue;
    const seen = new Set();
    let entries = schedule[stopId]
      .sort((a, b) => a.time.localeCompare(b.time))
      .filter(d => {
        const key = `${d.time}|${d.line}|${d.headsign}|${d.sid}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const lastMin = new Map();
    entries = entries.filter(d => {
      const key = `${d.line}|${d.headsign}|${d.sid}`;
      const [h, m] = d.time.split(':').map(Number);
      const mins = h * 60 + m;
      const last = lastMin.get(key);
      if (last !== undefined && mins - last <= 2) return false;
      lastMin.set(key, mins);
      return true;
    });
    schedule[stopId] = entries;
  }

  // 8. Lines list
  const agencyRoutes = new Map();
  for (const r of routes) {
    if (!agencyRoutes.has(r.agency_id)) agencyRoutes.set(r.agency_id, []);
    agencyRoutes.get(r.agency_id).push({
      id:         r.route_id,
      short_name: r.route_short_name || '',
      long_name:  r.route_long_name  || '',
      route_type: parseInt(r.route_type) || 3
    });
  }
  const collator = new Intl.Collator('nl', { numeric: true });
  for (const [agency_id, rts] of agencyRoutes) {
    allLinesList.push({
      agency_name: agencyMap.get(agency_id) || agency_id,
      routes: rts
        .filter((r, i, arr) => arr.findIndex(x => x.short_name === r.short_name) === i)
        .sort((a, b) => collator.compare(a.short_name, b.short_name))
    });
  }

  // 9. Route info files (one per route: metadata only)
  log(`[${feed.name}] Writing route info files...`);
  const routeStopsDir = join(DATA_DIR, 'route-stops');
  mkdirSync(routeStopsDir, { recursive: true });
  let routeStopsWritten = 0;
  for (const r of routes) {
    const agencyName = agencyMap.get(r.agency_id) || r.agency_id || '';
    const info = {
      short_name:  r.route_short_name || '',
      long_name:   r.route_long_name  || '',
      agency_name: agencyName,
      route_type:  parseInt(r.route_type) || 3
    };
    writeFileSync(join(routeStopsDir, `${r.route_id}.json`), JSON.stringify(info));
    routeStopsWritten++;
  }
  log(`[${feed.name}] Wrote ${routeStopsWritten} route info files`);
}

async function main() {
  const feeds = JSON.parse(readFileSync(FEEDS_FILE, 'utf8'));
  log(`Processing ${feeds.length} feed(s): ${feeds.map(f => f.name).join(', ')}`);

  // Shared accumulators across all feeds
  const shared = {
    schedule:            {},
    usedStopIds:         new Set(),
    allStopMap:          new Map(),
    allLinesList:        [],
    allAgencies:         new Map(),
    serviceDatesPerFeed: new Map()
  };

  for (const feed of feeds) {
    await processFeed(feed, shared);
  }

  const { schedule, usedStopIds, allStopMap, allLinesList, allAgencies } = shared;
  log(`Schedule built for ${Object.keys(schedule).length} stops across all feeds`);

  // Write output
  log('Writing output files...');
  mkdirSync(DATA_DIR, { recursive: true });

  // stops.json
  const usedStops = [...usedStopIds]
    .map(id => {
      const s = allStopMap.get(id);
      if (!s) return null;
      const locType = s.location_type ?? '';
      if (locType !== '0' && locType !== '') return null;
      const lat = Math.round(parseFloat(s.stop_lat) * 100000) / 100000;
      const lon = Math.round(parseFloat(s.stop_lon) * 100000) / 100000;
      if (isNaN(lat) || isNaN(lon)) return null;
      return {
        id,
        name: s.stop_name,
        lat,
        lon,
        town: s.stop_name.includes(',') ? s.stop_name.split(',')[0].trim() : s.stop_name
      };
    })
    .filter(Boolean);
  log(`${usedStops.length} stops with coordinates`);

  writeFileSync(join(DATA_DIR, 'stops.json'),    JSON.stringify(usedStops));
  writeFileSync(join(DATA_DIR, 'lines.json'),    JSON.stringify(allLinesList));
  writeFileSync(join(DATA_DIR, 'agencies.json'), JSON.stringify(
    [...allAgencies.entries()].map(([id, name]) => ({ id, name }))
  ));
  log(`lines.json: ${allLinesList.length} agency groups`);

  // feeds-info.json — per-feed stats for the UI
  const feedsInfo = feeds.map(feed => {
    const feedStops  = usedStops.filter(s => s.id.startsWith(`${feed.name}:`)).length;
    const feedRoutes = allLinesList.reduce((sum, ag) => sum + ag.routes.length, 0);
    return { name: feed.name, label: feed.label || feed.name, routes: feedRoutes, stops: feedStops };
  });
  writeFileSync(join(DATA_DIR, 'feeds-info.json'), JSON.stringify(feedsInfo));

  // Per-stop schedule files — split into feed subdirectory to avoid ':' in filenames
  // (e.g. stop ID "nl:3517780" → data/schedules/nl/3517780.json)
  const schedDir = join(DATA_DIR, 'schedules');
  mkdirSync(schedDir, { recursive: true });
  let written = 0;
  for (const [stopId, deps] of Object.entries(schedule)) {
    const colonIdx = stopId.indexOf(':');
    const feedName = stopId.slice(0, colonIdx);
    const localId  = stopId.slice(colonIdx + 1);
    const feedServiceDates = shared.serviceDatesPerFeed.get(feedName);
    const sids = new Set(deps.map(d => d.sid));
    const services = {};
    for (const sid of sids) {
      const dates = feedServiceDates?.get(sid);
      if (dates?.size) services[sid] = [...dates].sort();
    }
    mkdirSync(join(schedDir, feedName), { recursive: true });
    writeFileSync(join(schedDir, feedName, `${localId}.json`), JSON.stringify({ deps, services }));
    written++;
  }
  log(`Wrote ${written} per-stop schedule files to data/schedules/`);

  const kb = f => (readFileSync(f).length / 1024).toFixed(0) + ' KB';
  log(`stops.json: ${kb(join(DATA_DIR,'stops.json'))}`);
  log(`lines.json: ${kb(join(DATA_DIR,'lines.json'))}`);
  log('✅ Done!');
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
