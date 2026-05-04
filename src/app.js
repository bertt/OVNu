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
let agencyById = {};   // agency_id → agency_name
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
  }
  if (feedsRes.ok) {
    const feedsInfo = await feedsRes.json();
    renderFeedsInfo(feedsInfo);
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
  const res = await fetch(`../data/schedules/${stopId.replace(':', '/')}.json`);
  if (!res.ok) return { weekday: [], saturday: [], sunday: [] };
  scheduleCache[stopId] = await res.json();
  return scheduleCache[stopId];
}

const shapeCache = {};
async function loadShape(shapeId) {
  if (shapeCache[shapeId]) return shapeCache[shapeId];
  // shapeId is "feed:localId" → path "feed/localId"
  const res = await fetch(`../data/shapes/${shapeId.replace(':', '/')}.json`);
  if (!res.ok) return null;
  shapeCache[shapeId] = await res.json();
  return shapeCache[shapeId];
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
      if (seen.has(s.name)) return false;
      seen.add(s.name);
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

let map = null;
let userMarker = null;
let stopMarkers = [];
let routePolyline = null;

function clearRoute() {
  if (routePolyline) { routePolyline.remove(); routePolyline = null; }
}

function initMap(lat, lon, zoom = 15) {
  if (!map) {
    map = L.map('map').setView([lat, lon], zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }).addTo(map);
  } else {
    map.setView([lat, lon], zoom);
  }
}

function updateMapMarkers(userLat, userLon, nearStops) {
  // User marker
  if (userMarker) userMarker.remove();
  userMarker = L.circleMarker([userLat, userLon], {
    radius: 9, fillColor: '#1a56db', color: '#fff', weight: 2, fillOpacity: 1
  }).addTo(map).bindPopup('Jouw locatie');

  // Remove old stop markers
  stopMarkers.forEach(m => m.remove());
  stopMarkers = [];

  const busIcon = L.divIcon({
    html: '<span style="font-size:18px;line-height:24px;display:block;text-align:center;font-family:\'Segoe UI Emoji\',\'Apple Color Emoji\',sans-serif;">🚏</span>',
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  nearStops.forEach(stop => {
    const m = L.marker([stop.lat, stop.lon], { icon: busIcon })
      .addTo(map)
      .bindPopup(`<strong>${stop.name}</strong><br>${formatDist(stop.dist)} weg`);
    m.stopId = stop.id;
    stopMarkers.push(m);
  });
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
      <span class="stop-name">${stop.name}</span>
      <span class="stop-dist">${formatDist(stop.dist)}</span>
    `;
    li.addEventListener('click', () => selectStop(stop));
    list.appendChild(li);
  });
}

function selectStop(stop) {
  selectedStopId = stop.id;
  selectedStopName = stop.name;
  // Highlight in list
  document.querySelectorAll('.stop-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === stop.id);
  });
  // Open popup on map
  const marker = stopMarkers.find(m => m.stopId === stop.id);
  if (marker) marker.openPopup();
  // Show departures — merge all stops sharing this name (both directions)
  document.getElementById('departuresTitle').textContent = stop.name;
  document.getElementById('departuresPanel').hidden = false;
  renderDepartures(stop.name, currentDay());
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

async function renderDepartures(stopName, dayType) {
  const container = document.getElementById('departuresContent');
  container.innerHTML = '<p class="empty-msg"><span class="spinner"></span> Laden…</p>';
  clearRoute();

  const stopIds = stops.filter(s => s.name === stopName).map(s => s.id);
  const scheds = await Promise.all(stopIds.map(id => loadStopSchedule(id)));

  // Merge and deduplicate
  const seen = new Set();
  let deps = [];
  for (const sched of scheds) {
    for (const dep of (sched[dayType] ?? [])) {
      const key = `${dep.time}|${dep.line}|${dep.headsign}`;
      if (!seen.has(key)) { seen.add(key); deps.push(dep); }
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

  // Mark first departure as next
  const hasShape = deps.some(d => d.shape_id);

  let html = `<table class="dep-table">
    <thead><tr><th>Tijd</th><th>Lijn</th><th>Maatschappij</th><th>Richting</th>${hasShape ? '<th></th>' : ''}</tr></thead>
    <tbody>`;
  deps.forEach((dep, i) => {
    const [h, m] = dep.time.split(':').map(Number);
    const overnight = h >= 24;
    const displayTime = `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}${overnight ? '<span class="overnight" title="Volgende dag">+1</span>' : ''}`;
    const cls = i === 0 && isToday ? 'next-up' : '';
    const shapeBtn = dep.shape_id
      ? `<td><button class="route-btn" data-shape="${escHtml(dep.shape_id)}" title="Toon route op kaart">🗺</button></td>`
      : (hasShape ? '<td></td>' : '');
    const agencyName = dep.agency ? escHtml(agencyById[dep.agency] || dep.agency) : '';
    html += `<tr class="${cls}">
      <td class="dep-time">${displayTime}</td>
      <td class="dep-line-col">${escHtml(dep.line)}</td>
      <td class="dep-agency">${agencyName}</td>
      <td class="dep-dest"><button class="dest-btn" data-headsign="${escHtml(dep.headsign)}">${escHtml(dep.headsign)}</button></td>
      ${shapeBtn}
    </tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;

  // Attach route-button click handlers
  container.querySelectorAll('.route-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const shapeId = btn.dataset.shape;
      container.querySelectorAll('.route-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      clearRoute();
      const coords = await loadShape(shapeId);
      if (coords && map) {
        routePolyline = L.polyline(coords, {
          color: '#1a56db', weight: 4, opacity: .85
        }).addTo(map);
        map.fitBounds(routePolyline.getBounds(), { padding: [30, 30] });
      }
    });
  });

  // Attach destination click handlers — navigate to the terminus stop
  container.querySelectorAll('.dest-btn').forEach(btn => {
    btn.addEventListener('click', () => navigateToHeadsign(btn.dataset.headsign));
  });

}

function navigateToHeadsign(headsign) {
  if (!dataLoaded) return;
  const words = headsign.toLowerCase().split(/\s+/).filter(Boolean);
  const longWords = words.filter(w => w.length > 2);
  const searchWords = longWords.length > 0 ? longWords : words;

  const seen = new Set();
  const matches = stops.filter(s => {
    const name = s.name.toLowerCase();
    if (!searchWords.every(w => name.includes(w))) return false;
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });

  if (matches.length === 0) {
    showStatus(`Geen halte gevonden voor "${headsign}".`, '');
    setTimeout(hideStatus, 3000);
    return;
  }
  document.getElementById('searchInput').value = matches[0].name;
  centreOnStop(matches[0]);
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
      const name = s.name.toLowerCase();
      if (!wordList.every(w => name.includes(w))) return false;
      if (seen.has(s.name)) return false;
      seen.add(s.name);
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
    li.textContent = stop.name;
    li.addEventListener('click', () => {
      document.getElementById('searchInput').value = stop.name;
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
  // Find all stops sharing this name (different directions/platforms) plus their neighbours
  const sameNameStops = stops.filter(s => s.name === stop.name);
  const centerLat = sameNameStops.reduce((s, x) => s + x.lat, 0) / sameNameStops.length;
  const centerLon = sameNameStops.reduce((s, x) => s + x.lon, 0) / sameNameStops.length;
  const near = nearestStops(centerLat, centerLon, 8);
  currentNearStops = near;
  showContent(centerLat, centerLon, near);
  // Auto-select first stop with this name
  const first = near.find(s => s.name === stop.name) || near[0];
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
  updateMapMarkers(lat, lon, nearStops);
  renderStopsList(nearStops);
  // Trigger map resize in case the container was hidden
  setTimeout(() => map?.invalidateSize(), 100);
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

    // Auto-navigate if ?stop=name is in URL (e.g. when arriving from route.html)
    const stopParam = new URLSearchParams(location.search).get('stop');
    if (stopParam) {
      const match = stops.find(s => s.name === stopParam);
      if (match) {
        hideStatus();
        document.getElementById('searchInput').value = match.name;
        centreOnStop(match);
      }
    }
  } catch (err) {
    showStatus(`❌ Fout bij laden data: ${err.message}. Controleer of je de build-stap hebt uitgevoerd (npm run build).`, 'error');
  }
  setupSearch();
  setupGps();
}

init();
