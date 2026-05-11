/**
 * app.js – client-side logic for OVNu.
 *
 * Flow:
 *  1. Load stops.json from ../data/ (lazy-load per-stop schedule on demand)
 *  2. User triggers GPS or searches by name
 *  3. Find nearest stops/stations (haversine)
 *  4. Show on map + list
 *  5. User selects stop → show departures for chosen day
 */

// ── Data loading ──────────────────────────────────────────────────────────────

let stops = [];        // [{id, name, lat, lon, town}]
let agencyById = {};       // "feed:rawId" → agency_name
let agencyByRawId = {};    // "rawId" → {name}
let dataLoaded = false;
const scheduleCache = {}; // stop_id → {weekday:[], saturday:[], sunday:[]}

async function loadData() {
  const [stopsRes, agenciesRes, feedsRes] = await Promise.all([
    fetch('../data/stops.json'),
    fetch('../data/agencies.json'),
    fetch('../data/feeds-info.json')
  ]);
  if (!stopsRes.ok) throw new Error('Kon stops.json niet laden');
  stops = await stopsRes.json();
  if (agenciesRes.ok) {
    const list = await agenciesRes.json();
    agencyById = Object.fromEntries(list.map(a => [a.id, a.name]));
    for (const a of list) {
      const raw = a.id.replace(/^[^:]+:/, '');
      if (!agencyByRawId[raw]) agencyByRawId[raw] = { name: a.name };
    }
  }
  if (feedsRes.ok) {
    const feedsInfo = await feedsRes.json();
    renderFeedsInfo(feedsInfo);
  }

  // Detect platform letters in two naming conventions:
  //   "Name A"       (single trailing letter)
  //   "Name [ A ]"   (letter in brackets, used by e.g. NS/Arriva train stations)
  // Grouping priority: GTFS parent_station (parentName field) > regex heuristic.
  function parsePlatform(name) {
    let m = name.match(/^(.+?)\s+\[\s*([A-Z0-9]+)\s*\]$/);
    if (m) return { baseName: m[1], platform: m[2] };
    m = name.match(/^(.+)\s+([A-Z])$/);
    if (m) return { baseName: m[1], platform: m[2] };
    return null;
  }
  // Regex fallback: count only for stops without a GTFS parent station
  const baseCount = new Map();
  for (const s of stops) {
    if (s.parentName) continue;
    const p = parsePlatform(s.name);
    if (p) baseCount.set(p.baseName, (baseCount.get(p.baseName) || 0) + 1);
  }
  for (const s of stops) {
    if (s.parentName) {
      // Use the GTFS parent station name for grouping
      s.baseName = s.parentName;
      // Prefer explicit platform_code; fall back to extracting from stop name
      if (s.platformCode) {
        s.platform = s.platformCode;
      } else {
        const p = parsePlatform(s.name);
        s.platform = p ? p.platform : null;
      }
    } else {
      const p = parsePlatform(s.name);
      if (p && (baseCount.get(p.baseName) || 0) >= 2) {
        s.baseName = p.baseName;
        s.platform = p.platform;
      } else {
        s.baseName = s.name;
        s.platform = null;
      }
    }
  }

  dataLoaded = true;
}

function renderFeedsInfo(feedsInfo) {
  const el = document.getElementById('feedsInfo');
  if (!el) return;
  el.innerHTML = feedsInfo.map(f =>
    `<span class="feed-badge">${f.label} · ${f.routes.toLocaleString('nl-NL')} lines · ${f.stops.toLocaleString('nl-NL')} stops</span>`
  ).join('');
}

async function loadStopSchedule(stopId) {
  if (scheduleCache[stopId]) return scheduleCache[stopId];
  // stopId is "feed:localId" (e.g. "nl:3517780") → path "feed/localId"
  const res = await fetch(`../data/schedules/${stopId}.json`);
  if (!res.ok) return { weekday: [], saturday: [], sunday: [] };
  scheduleCache[stopId] = await res.json();
  return scheduleCache[stopId];
}

// ── Haversine distance (km) ───────────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function stopTown(stop) {
  return stop.name.includes(',') ? stop.name.split(',')[0].trim() : stop.name;
}

function nearestStops(lat, lon, n = 8) {
  const seen = new Set();
  return stops
    .map(s => ({ ...s, dist: haversine(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.dist - b.dist)
    .filter(s => {
      if (seen.has(s.baseName)) return false;
      seen.add(s.baseName);
      return true;
    })
    .slice(0, n);
}

// ── Day helpers ───────────────────────────────────────────────────────────────

function todayDayType() {
  const dow = new Date().getDay(); // 0=sun, 6=sat
  if (dow === 0) return 'sunday';
  if (dow === 6) return 'saturday';
  return 'weekday';
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function timeToMinutes(t) {
  // GTFS times can exceed 24:00 for trips past midnight
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// ── Map ───────────────────────────────────────────────────────────────────────

const VIEWPORT_ZOOM_THRESHOLD = 13;

let map = null;
let userMarker = null;
let viewportStopMarkers = [];
let viewportMarkerById  = {}; // stop.id → Leaflet marker

const busIcon = L.divIcon({
  html: '<span style="font-size:18px;line-height:24px;display:block;text-align:center;font-family:\'Segoe UI Emoji\',\'Apple Color Emoji\',sans-serif;">🚏</span>',
  className: '',
  iconSize: [24, 24],
  iconAnchor: [12, 12]
});

function initMap(lat, lon, zoom = 15) {
  if (!map) {
    map = L.map('map').setView([lat, lon], zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }).addTo(map);
    map.on('moveend', updateViewportMarkers);
  } else {
    map.setView([lat, lon], zoom);
  }
}

function updateViewportMarkers() {
  // Remove old viewport markers
  viewportStopMarkers.forEach(m => m.remove());
  viewportStopMarkers = [];
  viewportMarkerById  = {};

  if (!map || !dataLoaded || map.getZoom() < VIEWPORT_ZOOM_THRESHOLD) return;

  const bounds = map.getBounds();
  const south = bounds.getSouth(), north = bounds.getNorth();
  const west  = bounds.getWest(),  east  = bounds.getEast();

  // Collect stops in bounds, deduplicated by baseName
  const seen = new Set();
  const inBounds = [];
  for (const s of stops) {
    if (s.lat < south || s.lat > north || s.lon < west || s.lon > east) continue;
    if (seen.has(s.baseName)) continue;
    seen.add(s.baseName);
    inBounds.push(s);
    if (inBounds.length >= 400) break;
  }

  for (const stop of inBounds) {
    const m = L.marker([stop.lat, stop.lon], { icon: busIcon })
      .addTo(map)
      .bindPopup(`<strong>${stop.baseName}</strong>`, { autoPan: false });
    m.on('click', () => selectStop(stop));
    viewportStopMarkers.push(m);
    viewportMarkerById[stop.id] = m;
  }
}

function updateUserMarker(lat, lon) {
  if (userMarker) userMarker.remove();
  userMarker = L.circleMarker([lat, lon], {
    radius: 9, fillColor: '#1a56db', color: '#fff', weight: 2, fillOpacity: 1
  }).addTo(map).bindPopup('Jouw locatie');
}

function formatDist(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

// ── Stops list UI ─────────────────────────────────────────────────────────────

let selectedStopId = null;
let selectedStopName = null;

function renderStopsList(nearStops) {
  const list = document.getElementById('stopsList');
  list.innerHTML = '';
  nearStops.forEach(stop => {
    const li = document.createElement('li');
    li.className = 'stop-item' + (stop.id === selectedStopId ? ' active' : '');
    li.dataset.id = stop.id;
    li.innerHTML = `
      <span class="stop-name">${stop.baseName}</span>
      <span class="stop-dist">${formatDist(stop.dist)}</span>
    `;
    li.addEventListener('click', () => selectStop(stop));
    list.appendChild(li);
  });
}

function selectStop(stop) {
  selectedStopId = stop.id;
  selectedStopName = stop.baseName;
  // Update URL — use stop_id so the exact stop is preserved when sharing/navigating back
  const url = new URL(location.href);
  url.searchParams.set('stop_id', stop.id);
  url.searchParams.delete('stop');
  history.replaceState(null, '', url.toString());
  // Refresh nearby stops list centred on this stop (active state set inside renderStopsList)
  renderStopsList(nearestStops(stop.lat, stop.lon, 8));
  // Open popup on map marker if visible
  viewportMarkerById[stop.id]?.openPopup();
  // Show departures — merge all stops sharing this baseName (all platforms)
  document.getElementById('departuresTitle').textContent = stop.baseName;
  document.getElementById('departuresPanel').hidden = false;
  renderDepartures(stop.baseName, currentDay());
}

function currentDay() {
  const active = document.querySelector('.day-btn.active');
  const day = active?.dataset.day;
  return day === 'today' ? todayDayType() : (day || todayDayType());
}

document.querySelectorAll('.day-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.day-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (selectedStopName) renderDepartures(selectedStopName, currentDay());
  });
});

// ── Departures rendering ──────────────────────────────────────────────────────

async function renderDepartures(stationName, dayType) {
  const container = document.getElementById('departuresContent');
  container.innerHTML = '<p class="empty-msg"><span class="spinner"></span> Laden…</p>';

  const stationStops = stops.filter(s => s.baseName === stationName);
  const scheds = await Promise.all(stationStops.map(s => loadStopSchedule(s.id)));

  // Merge and deduplicate, tagging each departure with its platform
  const seen = new Set();
  let deps = [];
  for (let i = 0; i < stationStops.length; i++) {
    const platform = stationStops[i].platform;
    for (const dep of (scheds[i][dayType] ?? [])) {
      const key = `${dep.time}|${dep.line}|${dep.headsign}|${platform ?? ''}`;
      if (!seen.has(key)) { seen.add(key); deps.push({ ...dep, platform }); }
    }
  }
  deps.sort((a, b) => a.time.localeCompare(b.time));

  // Collapse same-trip entries: same line+headsign within 2 min = same bus
  // passing through adjacent stops with the same name (keep the earliest)
  const lastSeen = new Map(); // `line|headsign` → last departure in minutes
  deps = deps.filter(dep => {
    const key = `${dep.line}|${dep.headsign}`;
    const timeMin = timeToMinutes(dep.time);
    const last = lastSeen.get(key);
    if (last !== undefined && timeMin - last <= 2) return false;
    lastSeen.set(key, timeMin);
    return true;
  });

  // For "today" view: filter to upcoming departures only
  const isToday = document.querySelector('.day-btn.active')?.dataset.day === 'today';
  if (isToday) {
    const nowMin = nowMinutes();
    deps = deps.filter(d => timeToMinutes(d.time) >= nowMin);
  }

  const dayLabel = dayType === 'weekday' ? 'maandag–vrijdag'
                 : dayType === 'saturday' ? 'zaterdag' : 'zondag';

  if (deps.length === 0) {
    container.innerHTML = `<p class="empty-msg">Geen ${isToday ? 'komende' : ''} vertrektijden gevonden voor ${dayLabel}.</p>`;
    return;
  }

  const hasPlatforms = deps.some(d => d.platform);

  let html = `<table class="dep-table">
    <thead><tr><th>Tijd</th><th>Lijn</th>${hasPlatforms ? '<th>Perron</th>' : ''}<th>Richting</th><th>Maatschappij</th></tr></thead>
    <tbody>`;
  deps.forEach((dep, i) => {
    const [h, m] = dep.time.split(':').map(Number);
    const overnight = h >= 24;
    const displayTime = `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}${overnight ? '<span class="overnight" title="Volgende dag">+1</span>' : ''}`;
    const cls = i === 0 && isToday ? 'next-up' : '';
    const agInfo = dep.agency ? agencyByRawId[dep.agency] : null;
    const agencyName = agInfo ? agInfo.name : (dep.agency || '');
    const stopIdSuffix = selectedStopId ? `&stop_id=${encodeURIComponent(selectedStopId)}` : '';
    const lineLink = dep.route_id
      ? `<a href="route?id=${encodeURIComponent(dep.route_id)}&line=${encodeURIComponent(dep.line)}&agency=${encodeURIComponent(agencyName)}&type=3${stopIdSuffix}" class="dep-link">${escHtml(dep.line)}</a>`
      : escHtml(dep.line);
    const agencyLink = agencyName
      ? `<a href="lines?agency=${encodeURIComponent(agencyName)}" class="dep-link">${escHtml(agencyName)}</a>`
      : '';
    html += `<tr class="${cls}">
      <td class="dep-time">${displayTime}</td>
      <td class="dep-line-col">${lineLink}</td>
      ${hasPlatforms ? `<td class="dep-platform">${dep.platform ? escHtml(dep.platform) : ''}</td>` : ''}
      <td class="dep-dest">${escHtml(dep.headsign)}</td>
      <td class="dep-agency">${agencyLink}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Search / autocomplete ─────────────────────────────────────────────────────

let autocompleteEl = null;
let currentNearStops = [];

function setupSearch() {
  const input = document.getElementById('searchInput');
  const wrapper = input.parentElement;
  wrapper.style.position = 'relative';

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { hideAutocomplete(); return; }
    if (!dataLoaded) return;

    // Split query into words; try strict AND first, relax short words if few results
    const words = q.split(/\s+/).filter(Boolean);
    const longWords = words.filter(w => w.length > 2);
    const seen = new Set();

    const matchFn = (wordList) => stops.filter(s => {
      const name = s.baseName.toLowerCase();
      if (!wordList.every(w => name.includes(w))) return false;
      if (seen.has(s.baseName)) return false;
      seen.add(s.baseName);
      return true;
    });

    let matches = matchFn(words);
    // Relax: if few results and query has short words (de/in/op), retry with long words only
    if (matches.length < 3 && longWords.length > 0 && longWords.length < words.length) {
      matches = [...matches, ...matchFn(longWords)];
    }
    matches = matches.slice(0, 12);

    if (matches.length === 0) { hideAutocomplete(); return; }
    showAutocomplete(matches, input);
  });

  input.addEventListener('keydown', e => {
    if (!autocompleteEl) return;
    const items = autocompleteEl.querySelectorAll('.autocomplete-item');
    const selected = autocompleteEl.querySelector('.selected');
    let idx = selected ? [...items].indexOf(selected) : -1;
    if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(idx+1, items.length-1)]?.classList.add('selected'); selected?.classList.remove('selected'); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); items[Math.max(idx-1, 0)]?.classList.add('selected'); selected?.classList.remove('selected'); }
    if (e.key === 'Enter' && selected) selected.click();
    if (e.key === 'Escape') hideAutocomplete();
  });

  document.addEventListener('click', e => {
    if (!autocompleteEl?.contains(e.target) && e.target !== input) hideAutocomplete();
  });
}

function showAutocomplete(matches, input) {
  hideAutocomplete();
  autocompleteEl = document.createElement('ul');
  autocompleteEl.className = 'autocomplete-list';

  const rect = input.getBoundingClientRect();
  autocompleteEl.style.cssText = `position:fixed;top:${rect.bottom+4}px;left:${rect.left}px;width:${rect.width}px`;

  matches.forEach(stop => {
    const li = document.createElement('li');
    li.className = 'autocomplete-item';
    li.textContent = stop.baseName;
    li.addEventListener('click', () => {
      document.getElementById('searchInput').value = stop.baseName;
      hideAutocomplete();
      centreOnStop(stop);
    });
    autocompleteEl.appendChild(li);
  });
  document.body.appendChild(autocompleteEl);
}

function hideAutocomplete() {
  autocompleteEl?.remove();
  autocompleteEl = null;
}

function centreOnStop(stop) {
  // Find all stops sharing this baseName (different platforms) plus their neighbours
  const sameNameStops = stops.filter(s => s.baseName === stop.baseName);
  const centerLat = sameNameStops.reduce((s, x) => s + x.lat, 0) / sameNameStops.length;
  const centerLon = sameNameStops.reduce((s, x) => s + x.lon, 0) / sameNameStops.length;
  const near = nearestStops(centerLat, centerLon, 8);
  currentNearStops = near;
  showContent(centerLat, centerLon, near);
  // Auto-select first stop with this baseName
  const first = near.find(s => s.baseName === stop.baseName) || near[0];
  if (first) selectStop(first);
}

// ── GPS ───────────────────────────────────────────────────────────────────────

function setupGps() {
  document.getElementById('gpsBtn').addEventListener('click', async () => {
    if (!dataLoaded) {
      showStatus('Data wordt geladen, even geduld…', 'info');
      return;
    }
    if (!navigator.geolocation) {
      showStatus('Geolocatie wordt niet ondersteund door deze browser.', 'error');
      return;
    }
    const btn = document.getElementById('gpsBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Locatie bepalen…';
    showStatus('<span class="spinner"></span> Locatie wordt bepaald…', 'info');

    navigator.geolocation.getCurrentPosition(
      pos => {
        btn.disabled = false;
        btn.textContent = '📍 Gebruik locatie';
        hideStatus();
        const { latitude: lat, longitude: lon } = pos.coords;
        const near = nearestStops(lat, lon, 8);
        currentNearStops = near;
        showContent(lat, lon, near);
        if (near.length) selectStop(near[0]);
      },
      err => {
        btn.disabled = false;
        btn.textContent = '📍 Gebruik locatie';
        const msgs = {
          1: 'Locatietoegang geweigerd. Sta locatietoestemming toe in je browser.',
          2: 'Locatie kon niet worden bepaald.',
          3: 'Timeout bij ophalen locatie.'
        };
        showStatus(msgs[err.code] || 'Onbekende fout bij locatie.', 'error');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

function showContent(lat, lon, nearStops) {
  document.getElementById('contentGrid').hidden = false;
  initMap(lat, lon);
  updateUserMarker(lat, lon);
  renderStopsList(nearStops);
  // Trigger map resize then update viewport markers (zoom is 15 so stops will show)
  setTimeout(() => { map?.invalidateSize(); updateViewportMarkers(); }, 100);
}

function showStatus(html, type = '') {
  const el = document.getElementById('statusMsg');
  el.innerHTML = html;
  el.className = 'status-msg' + (type ? ` ${type}` : '');
  el.hidden = false;
}
function hideStatus() {
  document.getElementById('statusMsg').hidden = true;
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Show map immediately centred on the Netherlands
  document.getElementById('contentGrid').hidden = false;
  initMap(52.1, 5.3, 7);
  setTimeout(() => map?.invalidateSize(), 100);

  showStatus('<span class="spinner"></span> Haltegegevens laden…', 'info');
  try {
    await loadData();
    hideStatus();
    showStatus(`✅ ${stops.length.toLocaleString('nl-NL')} haltes geladen. Druk op 📍 of zoek op naam.`, 'info');
    setTimeout(hideStatus, 4000);

    // Auto-navigate if ?stop=name or ?stop_id=id is in URL (e.g. when arriving from route.html)
    const urlParams = new URLSearchParams(location.search);
    const stopParam = urlParams.get('stop');
    const stopIdParam = urlParams.get('stop_id');
    const match = stopIdParam
      ? stops.find(s => s.id === stopIdParam)
      : stopParam ? stops.find(s => s.baseName === stopParam || s.name === stopParam) : null;
    if (match) {
      hideStatus();
      document.getElementById('searchInput').value = match.baseName;
      centreOnStop(match);
    }
  } catch (err) {
    showStatus(`❌ Fout bij laden data: ${err.message}. Controleer of je de build-stap hebt uitgevoerd (npm run build).`, 'error');
  }
  setupSearch();
  setupGps();
}

init();
