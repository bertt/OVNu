#!/usr/bin/env node
/**
 * GTFS data processor for public transit stops.
 * Downloads one or more GTFS feeds (defined in feeds.json) and merges them into
 * a single set of static data files used by the client-side website.
 *
 * Output files in ../data/:
 *   stops.json         - [{id, name, lat, lon, town}]
 *   routes.json        - [{id, short_name, long_name}]
 *   schedules/{id}.json - {weekday:[], saturday:[], sunday:[]}  (per stop)
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

async function processFeed(feed, shared) {
  const { schedule, usedStopIds, allStopMap, allRoutesList, allLinesList, allAgencies } = shared;

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
    allAgencies.set(a.agency_id, a.agency_name);
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

  // 4. Classify service_ids → day types
  log(`[${feed.name}] Classifying service days...`);
  const today = new Date();
  const sixMonthsOn = new Date(today);
  sixMonthsOn.setMonth(sixMonthsOn.getMonth() + 6);

  const serviceDayCounts = new Map(); // service_id → {weekday, saturday, sunday}

  // 4a. calendar.txt (standard weekly schedule, if present)
  const calRows = parseSmall('calendar.txt', extractDir);
  if (calRows.length > 0) {
    const DOW = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    for (const row of calRows) {
      if (!serviceIds.has(row.service_id)) continue;
      const start = new Date(`${row.start_date.slice(0,4)}-${row.start_date.slice(4,6)}-${row.start_date.slice(6,8)}`);
      const end   = new Date(`${row.end_date.slice(0,4)}-${row.end_date.slice(4,6)}-${row.end_date.slice(6,8)}`);
      const lo = start < today ? today : start;
      const hi = end   > sixMonthsOn ? sixMonthsOn : end;
      for (let d = new Date(lo); d <= hi; d.setDate(d.getDate() + 1)) {
        const dow = d.getDay();
        if (row[DOW[dow]] !== '1') continue;
        const dayType = dow === 0 ? 'sunday' : dow === 6 ? 'saturday' : 'weekday';
        if (!serviceDayCounts.has(row.service_id)) serviceDayCounts.set(row.service_id, { weekday: 0, saturday: 0, sunday: 0 });
        serviceDayCounts.get(row.service_id)[dayType]++;
      }
    }
    log(`[${feed.name}] calendar.txt: ${calRows.length} service rows`);
  }

  // 4b. calendar_dates.txt (exceptions / sole source)
  const calDates = parseSmall('calendar_dates.txt', extractDir);
  log(`[${feed.name}] calendar_dates.txt: ${calDates.length.toLocaleString()} rows`);
  for (const row of calDates) {
    if (!serviceIds.has(row.service_id) || row.exception_type !== '1') continue;
    const d  = row.date;
    const dt = new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`);
    if (dt < today || dt > sixMonthsOn) continue;
    const dow = dt.getDay();
    const dayType = dow === 0 ? 'sunday' : dow === 6 ? 'saturday' : 'weekday';
    if (!serviceDayCounts.has(row.service_id)) serviceDayCounts.set(row.service_id, { weekday: 0, saturday: 0, sunday: 0 });
    serviceDayCounts.get(row.service_id)[dayType]++;
  }

  // Classify: only mark as 'weekday' if weekday count strictly exceeds sunday count.
  // Prevents holiday-only runs (e.g. Hemelvaartsdag, Pinkstermaandag) from leaking
  // into the normal weekday schedule.
  const serviceDay = new Map();
  for (const [serviceId, counts] of serviceDayCounts) {
    const days = [];
    if (counts.weekday > 0 && counts.weekday > counts.sunday) days.push('weekday');
    if (counts.saturday > 0) days.push('saturday');
    if (counts.sunday > 0) days.push('sunday');
    if (days.length > 0) serviceDay.set(serviceId, days);
  }
  log(`[${feed.name}] ${serviceDay.size} services classified`);

  // 5. Stops — build prefixed stop map
  log(`[${feed.name}] Parsing stops.txt...`);
  const allStops = parseSmall('stops.txt', extractDir);
  for (const s of allStops) {
    allStopMap.set(s.stop_id, s);
  }

  // Representative trips for route-stop lists.
  // Strategy: collect ALL valid trips as candidates per (route, direction).
  // Pass 1 counts the max stop_sequence per candidate trip (cheap: one integer per trip).
  // After pass 1 we select the trip with the most stops per direction as the representative.
  // Pass 2 (lightweight) then collects the full stop sequence only for those selected trips.
  const repTripCandidates = new Map(); // "route_id|dir" → Set<trip_id>
  const candidateTripIds  = new Set(); // all valid trip_ids for candidates

  for (const trip of trips) {
    if (!serviceDay.has(trip.service_id)) continue;
    const key = `${trip.route_id}|${trip.direction_id ?? '0'}`;
    if (!repTripCandidates.has(key)) repTripCandidates.set(key, new Set());
    repTripCandidates.get(key).add(trip.trip_id);
    candidateTripIds.add(trip.trip_id);
  }
  log(`[${feed.name}] ${candidateTripIds.size} candidate trips for route-stop selection`);

  // 6. Stream stop_times — single pass: build schedules + collect route stop sequences
  const candidateMaxSeq = new Map(); // trip_id → highest stop_sequence seen
  const candidateStops  = new Map(); // trip_id → [[seq, stopId], ...]
  log(`[${feed.name}] Streaming stop_times.txt...`);
  const rowCount = await streamCsv('stop_times.txt', extractDir, (st) => {
    const trip = tripMap.get(st.trip_id);
    if (!trip) return;
    const route = routeMap.get(trip.route_id);
    if (!route) return;

    // Collect stop sequences for candidate trips (used for route-stop lists).
    if (candidateTripIds.has(st.trip_id)) {
      const seq = parseInt(st.stop_sequence);
      const cur = candidateMaxSeq.get(st.trip_id) || 0;
      if (seq > cur) candidateMaxSeq.set(st.trip_id, seq);
      if (!candidateStops.has(st.trip_id)) candidateStops.set(st.trip_id, []);
      candidateStops.get(st.trip_id).push([seq, st.stop_id]);
    }

    const dayTypes = serviceDay.get(trip.service_id);
    if (!dayTypes?.length) return;

    // Skip stops where boarding is not allowed (drop-off only / terminus arrivals).
    // pickup_type=1 means "No pickup available" per the GTFS spec — these are not departures.
    if (st.pickup_type === '1') return;

    const stopId = st.stop_id;
    usedStopIds.add(stopId);
    if (!schedule[stopId]) schedule[stopId] = { weekday: [], saturday: [], sunday: [] };

    const entry = {
      time:     st.departure_time,
      line:     route.route_short_name,
      headsign: trip.trip_headsign,
      agency:   routeAgency.get(trip.route_id) || '',
      route_id: trip.route_id
    };
    for (const day of dayTypes) schedule[stopId][day].push(entry);
  });
  log(`[${feed.name}] ${rowCount.toLocaleString()} stop_times rows processed`);

  // Select the representative per direction: the trip with the most stops.
  const repTripKey  = new Map(); // "route_id|dir" → best trip_id
  const repTripStops = new Map(); // trip_id → [[seq, stopId], ...]
  for (const [key, candidates] of repTripCandidates) {
    let bestTrip = null, bestCount = -1;
    for (const tid of candidates) {
      const count = candidateMaxSeq.get(tid) || 0;
      if (count > bestCount) { bestCount = count; bestTrip = tid; }
    }
    if (bestTrip) {
      repTripKey.set(key, bestTrip);
      repTripStops.set(bestTrip, candidateStops.get(bestTrip) || []);
    }
  }
  log(`[${feed.name}] ${repTripKey.size} representative trips selected (most stops per direction)`);

  // 7. Sort + deduplicate per stop
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
      agency_id:   agency_id,
      agency_name: agencyMap.get(agency_id) || agency_id,
      routes: rts
        .filter((r, i, arr) => arr.findIndex(x => x.short_name === r.short_name) === i)
        .sort((a, b) => collator.compare(a.short_name, b.short_name))
    });
  }

  // Routes list (backward compat)
  for (const r of routes) {
    allRoutesList.push({
      id:         r.route_id,
      short_name: r.route_short_name,
      long_name:  r.route_long_name || ''
    });
  }

  // 9. Route-stop files
  log(`[${feed.name}] Writing route-stop files...`);
  const routeStopsDir = join(DATA_DIR, 'route-stops');
  mkdirSync(routeStopsDir, { recursive: true });
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
        const s = allStopMap.get(stopId);
        if (!s) return null;
        return {
          id: stopId,
          name: s.stop_name,
          lat: Math.round(parseFloat(s.stop_lat) * 100000) / 100000,
          lon: Math.round(parseFloat(s.stop_lon) * 100000) / 100000
        };
      }).filter(Boolean);
    }
    // routeId is now just the raw GTFS route_id → write to route-stops/{routeId}.json
    writeFileSync(join(routeStopsDir, `${routeId}.json`), JSON.stringify(result));
    routeStopsWritten++;
  }
  log(`[${feed.name}] Wrote ${routeStopsWritten} route-stop files`);
}

async function main() {
  const feeds = JSON.parse(readFileSync(FEEDS_FILE, 'utf8'));
  log(`Processing ${feeds.length} feed(s): ${feeds.map(f => f.name).join(', ')}`);

  // Shared accumulators across all feeds
  const shared = {
    schedule:    {},
    usedStopIds: new Set(),
    allStopMap:  new Map(),
    allRoutesList: [],
    allLinesList:  [],
    allAgencies:   new Map()
  };

  for (const feed of feeds) {
    await processFeed(feed, shared);
  }

  const { schedule, usedStopIds, allStopMap, allRoutesList, allLinesList, allAgencies } = shared;
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
      const parentId = s.parent_station || null;
      const parentStop = parentId ? allStopMap.get(parentId) : null;
      return {
        id,
        name: s.stop_name,
        lat,
        lon,
        town: s.stop_name.includes(',') ? s.stop_name.split(',')[0].trim() : s.stop_name,
        parentName: parentStop?.stop_name ?? null,
        platformCode: s.platform_code || null
      };
    })
    .filter(Boolean);
  log(`${usedStops.length} stops with coordinates`);

  writeFileSync(join(DATA_DIR, 'stops.json'),    JSON.stringify(usedStops));
  writeFileSync(join(DATA_DIR, 'routes.json'),   JSON.stringify(allRoutesList));
  writeFileSync(join(DATA_DIR, 'lines.json'),    JSON.stringify(allLinesList));
  writeFileSync(join(DATA_DIR, 'agencies.json'), JSON.stringify(
    [...allAgencies.entries()].map(([id, name]) => ({ id, name }))
  ));
  log(`lines.json: ${allLinesList.length} agency groups`);

  // feeds-info.json — per-feed stats for the UI
  const feedsInfo = feeds.map(feed => {
    const feedStops  = usedStops.length;
    const feedRoutes = allLinesList.reduce((sum, ag) => sum + ag.routes.length, 0);
    return { name: feed.name, label: feed.label || feed.name, routes: feedRoutes, stops: feedStops };
  });
  writeFileSync(join(DATA_DIR, 'feeds-info.json'), JSON.stringify(feedsInfo));

  // Per-stop schedule files — stop IDs are now plain numeric GTFS IDs (no feed prefix)
  const schedDir = join(DATA_DIR, 'schedules');
  mkdirSync(schedDir, { recursive: true });
  let written = 0;
  for (const [stopId, daySched] of Object.entries(schedule)) {
    writeFileSync(join(schedDir, `${stopId}.json`), JSON.stringify(daySched));
    written++;
  }
  log(`Wrote ${written} per-stop schedule files to data/schedules/`);

  const kb = f => (readFileSync(f).length / 1024).toFixed(0) + ' KB';
  log(`stops.json: ${kb(join(DATA_DIR,'stops.json'))}`);
  log(`routes.json: ${kb(join(DATA_DIR,'routes.json'))}`);
  log('✅ Done!');
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
