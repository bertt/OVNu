#!/usr/bin/env node
/**
 * GTFS data processor for public transit stops.
 * Downloads a single GTFS feed (defined in feed.json) and generates the
 * static data files used by the client-side website.
 *
 * Output files in ../data/:
 *   stops.json         - [{id, name, lat, lon, town}]
 *   routes.json        - [{id, short_name, long_name}]
 *   schedules/{id}.json - [{time, line, headsign, agency, route_id}, ...]  (per stop, today only)
 *   shapes/{id}.json    - [[lat,lon],...]                       (per shape)
 *   route-stops/{id}.json - {direction: [{id,name,lat,lon},...]}
 *
 * Stop IDs and shape IDs are plain GTFS IDs as provided by the feed.
 */

import { createWriteStream, existsSync, readFileSync, writeFileSync, mkdirSync, createReadStream, rmSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import AdmZip from 'adm-zip';
import { parse as csvParse } from 'csv-parse';
import { parse as csvParseSync } from 'csv-parse/sync';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = join(__dirname, '..', 'data');
const FEED_FILE  = join(__dirname, 'feed.json');

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

function extractFiles(zip, extractDir, gtfsFile) {
  mkdirSync(extractDir, { recursive: true });

  // Detect a stale extraction left over from a previous (older/different) zip
  // download — without this, re-downloading the feed would silently keep
  // using outdated extracted .txt files since they already exist on disk.
  const marker = join(extractDir, '.zip-source');
  const zipStat = statSync(gtfsFile);
  const zipFingerprint = `${zipStat.size}:${zipStat.mtimeMs}`;
  const prevFingerprint = existsSync(marker) ? readFileSync(marker, 'utf8') : null;
  if (prevFingerprint !== zipFingerprint) {
    if (prevFingerprint !== null) log('  Detected a different/updated GTFS zip — clearing stale extraction...');
    for (const name of NEEDED) {
      const dest = join(extractDir, name);
      if (existsSync(dest)) rmSync(dest);
    }
    writeFileSync(marker, zipFingerprint);
  }

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
  extractFiles(zip, extractDir, gtfsFile);

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

  // 4. Determine which service_ids are active *today* only (build runs nightly,
  // so we only ever need "today" — no more weekday/saturday/sunday bucketing).
  log(`[${feed.name}] Determining services active today...`);
  const now = new Date();
  const todayStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const DOW = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const todayDowName = DOW[now.getDay()];

  const activeToday = new Set();

  // 4a. calendar.txt — regular weekly pattern, active if today falls within the
  // service's date range and today's weekday flag is set.
  const calRows = parseSmall('calendar.txt', extractDir);
  for (const row of calRows) {
    if (!serviceIds.has(row.service_id)) continue;
    if (row.start_date > todayStr || row.end_date < todayStr) continue;
    if (row[todayDowName] === '1') activeToday.add(row.service_id);
  }
  log(`[${feed.name}] calendar.txt: ${calRows.length} service rows`);

  // 4b. calendar_dates.txt — exceptions for today: type 1 = added, type 2 = removed.
  const calDates = parseSmall('calendar_dates.txt', extractDir);
  log(`[${feed.name}] calendar_dates.txt: ${calDates.length.toLocaleString()} rows`);
  for (const row of calDates) {
    if (!serviceIds.has(row.service_id) || row.date !== todayStr) continue;
    if (row.exception_type === '1') activeToday.add(row.service_id);
    else if (row.exception_type === '2') activeToday.delete(row.service_id);
  }
  log(`[${feed.name}] ${activeToday.size} services active today (${todayStr})`);

  // 4c. Services active *yesterday* — needed for night trains: a trip that
  // departs after midnight (e.g. 00:10) is often still part of yesterday's
  // service_id, encoded with GTFS's "extended" times (24:10, 25:00, ...) so
  // the whole overnight trip stays on one service day. Without this, those
  // early-morning departures would be missing from today's schedule.
  log(`[${feed.name}] Determining services active yesterday (for night trains)...`);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = `${yesterday.getFullYear()}${String(yesterday.getMonth() + 1).padStart(2, '0')}${String(yesterday.getDate()).padStart(2, '0')}`;
  const yesterdayDowName = DOW[yesterday.getDay()];

  const activeYesterday = new Set();
  for (const row of calRows) {
    if (!serviceIds.has(row.service_id)) continue;
    if (row.start_date > yesterdayStr || row.end_date < yesterdayStr) continue;
    if (row[yesterdayDowName] === '1') activeYesterday.add(row.service_id);
  }
  for (const row of calDates) {
    if (!serviceIds.has(row.service_id) || row.date !== yesterdayStr) continue;
    if (row.exception_type === '1') activeYesterday.add(row.service_id);
    else if (row.exception_type === '2') activeYesterday.delete(row.service_id);
  }
  log(`[${feed.name}] ${activeYesterday.size} services active yesterday (${yesterdayStr})`);

  // Shift a GTFS "extended" time (24:10:00 → 00:10:00) back by 24 hours so an
  // overnight trip from yesterday's service lands on today's timeline.
  function shiftTimeBackADay(t) {
    const parts = t.split(':');
    parts[0] = String(parseInt(parts[0], 10) - 24).padStart(2, '0');
    return parts.join(':');
  }

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

  // Representative trips for route-stop lists are selected from ALL trips (any
  // service_id), not just those active today — route/stop-sequence data is
  // static route info and should stay available even on days the route/line
  // has no departures. Departure *times* below are still restricted to today.
  for (const trip of trips) {
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

    let departureTime = st.departure_time;
    if (!activeToday.has(trip.service_id)) {
      // Not active today — only keep it if it's an overnight continuation of
      // yesterday's service (extended time >= 24:00:00), shifted onto today.
      const hour = parseInt(departureTime.split(':')[0], 10);
      if (activeYesterday.has(trip.service_id) && hour >= 24) {
        departureTime = shiftTimeBackADay(departureTime);
      } else {
        return;
      }
    }

    // Skip stops where boarding is not allowed (drop-off only / terminus arrivals).
    // pickup_type=1 means "No pickup available" per the GTFS spec — these are not departures.
    if (st.pickup_type === '1') return;

    const stopId = st.stop_id;
    usedStopIds.add(stopId);
    if (!schedule[stopId]) schedule[stopId] = [];

    const entry = {
      time:     departureTime,
      line:     route.route_short_name,
      headsign: trip.trip_headsign,
      agency:   routeAgency.get(trip.route_id) || '',
      route_id: trip.route_id
    };
    schedule[stopId].push(entry);
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
    const seen = new Set();
    let entries = schedule[sid]
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
    schedule[sid] = entries;
  }

  // 8. Lines list — only routes with at least one trip active today
  const routeIdsActiveToday = new Set();
  for (const trip of trips) {
    if (activeToday.has(trip.service_id)) routeIdsActiveToday.add(trip.route_id);
  }
  log(`[${feed.name}] ${routeIdsActiveToday.size} routes active today`);
  const routesToday = routes.filter(r => routeIdsActiveToday.has(r.route_id));

  const agencyRoutes = new Map();
  for (const r of routesToday) {
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

  // Routes list (backward compat) — only routes active today
  for (const r of routesToday) {
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
  const feed = JSON.parse(readFileSync(FEED_FILE, 'utf8'));
  log(`Processing feed: ${feed.name}`);

  // Accumulators populated while processing the feed
  const shared = {
    schedule:    {},
    usedStopIds: new Set(),
    allStopMap:  new Map(),
    allRoutesList: [],
    allLinesList:  [],
    allAgencies:   new Map()
  };

  await processFeed(feed, shared);

  const { schedule, usedStopIds, allStopMap, allRoutesList, allLinesList, allAgencies } = shared;
  log(`Schedule built for ${Object.keys(schedule).length} stops`);

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

  // feeds-info.json — stats for the UI (kept as an array for backward compat with app.js)
  const feedRoutes = allLinesList.reduce((sum, ag) => sum + ag.routes.length, 0);
  const feedsInfo = [{ name: feed.name, label: feed.label || feed.name, routes: feedRoutes, stops: usedStops.length }];
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
