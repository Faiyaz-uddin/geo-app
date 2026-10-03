(() => {
  'use strict';

  /* ------------------------------------------------------------ helpers */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const pad = n => String(n).padStart(2, '0');
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const state = {
    units: store.get('units', 'metric'),
    place: null,
    wx: null,
    tab: 'weather',
    maps: {},
    trail: [],
    issTimer: null,
    lastIss: null,
    spaceLoaded: false,
    req: 0,
  };

  async function api(path, params = {}) {
    const res = await fetch(`/api/${path}?${new URLSearchParams(params)}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Something went wrong. Try again.');
    return body;
  }

  /* --------------------------------------------------------- formatting */
  const shifted = (sec, tz) => new Date((sec + tz) * 1000);
  const hourOf = (sec, tz) => { const d = shifted(sec, tz); return d.getUTCHours() + d.getUTCMinutes() / 60; };

  function clock(sec, tz, withSeconds = false) {
    const d = shifted(sec, tz);
    let h = d.getUTCHours();
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${pad(d.getUTCMinutes())}${withSeconds ? ':' + pad(d.getUTCSeconds()) : ''} ${ap}`;
  }
  const fullDate = (sec, tz) => { const d = shifted(sec, tz); return `${WD[d.getUTCDay()]}, ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const hourLabel = (sec, tz) => { const h = shifted(sec, tz).getUTCHours(); return `${h % 12 || 12} ${h >= 12 ? 'PM' : 'AM'}`; };
  const utcLabel = tz => {
    const a = Math.abs(tz), m = Math.round((a % 3600) / 60);
    return `UTC${tz < 0 ? '−' : '+'}${Math.floor(a / 3600)}${m ? ':' + pad(m) : ''}`;
  };
  const dur = s => `${Math.floor(s / 3600)}h ${pad(Math.round((s % 3600) / 60))}m`;
  const deg = (t) => `${Math.round(t)}°`;
  const unitLetter = () => (state.units === 'metric' ? 'C' : 'F');
  const compass = d => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(d / 22.5) % 16];
  const windText = ms => (state.units === 'metric' ? `${Math.round(ms * 3.6)} km/h` : `${Math.round(ms)} mph`);
  const distText = m => (state.units === 'metric' ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${(m / 1609.34).toFixed(m >= 16093 ? 0 : 1)} mi`);
  const kmText = km => (state.units === 'metric' ? `${Math.round(km).toLocaleString()} km` : `${Math.round(km * 0.621371).toLocaleString()} mi`);
  const fmtNum = (n, d = 0) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
  const countryName = cc => (cc && regionNames ? (() => { try { return regionNames.of(cc); } catch { return cc; } })() : cc || '');
  const flag = cc => (cc && cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : '');

  function dms(v, pos, neg) {
    const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 60);
    return `${d}° ${pad(m)}′ ${pad(s)}″ ${v >= 0 ? pos : neg}`;
  }
  const haversine = (a, b) => {
    const R = 6371, r = x => x * Math.PI / 180;
    const dLat = r(b[0] - a[0]), dLon = r(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  const facts = rows => rows.filter(Boolean).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

  /* -------------------------------------------------------- weather art */
  function wxIcon(id, night) {
    const sun = `<g fill="#ffc145" stroke="#ffc145" stroke-width="2.5" stroke-linecap="round"><circle cx="24" cy="24" r="8" stroke="none"/>${
      [0, 45, 90, 135, 180, 225, 270, 315].map(a => `<line x1="24" y1="9" x2="24" y2="12.5" transform="rotate(${a} 24 24)"/>`).join('')}</g>`;
    const moon = `<path d="M31 8a16 16 0 1 0 11 27A13 13 0 0 1 31 8z" fill="#e4e9ff"/>`;
    const body = night ? moon : sun;
    const smallBody = `<g transform="translate(-4 -6) scale(.7)">${body}</g>`;
    const cloud = (fill = 'var(--cloud)', t = '') => `<path transform="${t}" d="M14 36a8 8 0 0 1 1-16 11 11 0 0 1 21 3 6.5 6.5 0 0 1-1 13z" fill="${fill}" stroke="rgba(20,40,80,.18)" stroke-width="1"/>`;
    const drops = n => Array.from({ length: n }, (_, i) => `<line x1="${16 + i * 8}" y1="40" x2="${14 + i * 8}" y2="46" stroke="#5aa9ff" stroke-width="2.5" stroke-linecap="round"/>`).join('');
    let inner;
    if (id >= 200 && id < 300) inner = `${cloud('#9aa7bd')}<path d="M26 34l-5 8h5l-2 6 8-9h-5l3-5z" fill="#ffc145"/>`;
    else if (id >= 300 && id < 400) inner = `${cloud()}${drops(3)}`;
    else if (id >= 500 && id < 600) inner = `${cloud('#b9c3d6')}${drops(4)}`;
    else if (id >= 600 && id < 700) inner = `${cloud()}${[16, 24, 32].map(x => `<circle cx="${x}" cy="43" r="2" fill="#fff"/>`).join('')}`;
    else if (id >= 700 && id < 800) inner = [18, 26, 34].map((y, i) => `<line x1="${9 + i * 2}" y1="${y}" x2="${39 - i * 2}" y2="${y}" stroke="var(--cloud)" stroke-width="3" stroke-linecap="round"/>`).join('');
    else if (id === 800) inner = body;
    else if (id === 801 || id === 802) inner = `${smallBody}${cloud('var(--cloud)', 'translate(2 2)')}`;
    else if (id === 803) inner = `${cloud('#c8d0df', 'translate(-2 -2)')}${cloud('var(--cloud)', 'translate(3 3)')}`;
    else inner = `${cloud('#aab4c8', 'translate(-2 -2)')}${cloud('#c8d0df', 'translate(3 3)')}`;
    return `<svg viewBox="0 0 48 48" role="img" aria-label="weather icon">${inner}</svg>`;
  }

  function moonMarkup(phase, r = 20) {
    const a = Math.cos(2 * Math.PI * phase), rx = (r * Math.abs(a)).toFixed(2);
    let d;
    if (phase < 0.5) d = `M0 ${-r}A${r} ${r} 0 0 1 0 ${r}A${rx} ${r} 0 0 ${phase < 0.25 ? 0 : 1} 0 ${-r}Z`;
    else d = `M0 ${-r}A${r} ${r} 0 0 0 0 ${r}A${rx} ${r} 0 0 ${phase < 0.75 ? 0 : 1} 0 ${-r}Z`;
    return `<circle r="${r}" fill="#2b3560"/><path d="${d}" fill="#f4f1e1"/>`;
  }

  /* -------------------------------------------------------------- sky */
  function skyPhase(now, rise, set) {
    if (!rise || !set) return 'day';
    const near = 40 * 60;
    if (Math.abs(now - rise) <= near || Math.abs(now - set) <= near) return 'golden';
    return now > rise && now < set ? 'day' : 'night';
  }

  function applySky(phase) {
    if (document.body.dataset.sky === phase) return;
    document.body.dataset.sky = phase;
    const meta = $('meta[name="theme-color"]') || Object.assign(document.head.appendChild(document.createElement('meta')), { name: 'theme-color' });
    meta.content = { day: '#7fc3ec', golden: '#2a2d69', night: '#050920' }[phase];
    updateTiles();
  }

  const ARC = { cx: 200, cy: 170, rx: 160, ry: 135 };
  const arcPoint = f => {
    const t = Math.min(1, Math.max(0, f));
    return [ARC.cx - ARC.rx * Math.cos(Math.PI * t), ARC.cy - ARC.ry * Math.sin(Math.PI * t)];
  };

  function skyFraction(now, rise, set) {
    if (now >= rise && now <= set) return { f: (now - rise) / (set - rise), night: false };
    const DAY = 86400;
    if (now > set) return { f: (now - set) / (rise + DAY - set), night: true };
    return { f: (now - (set - DAY)) / (rise - (set - DAY)), night: true };
  }

  function buildSky() {
    const { wx } = state;
    const c = wx.current, tz = wx.location.timezone;
    const box = $('#sky');
    if (!c.sunrise || !c.sunset) {
      box.innerHTML = '';
      $('#daylight').textContent = 'The sun does not rise or set here today.';
      return;
    }
    box.innerHTML = `<svg viewBox="0 0 400 200" aria-hidden="true">
      <path id="track" class="track" d="M40 170A160 135 0 0 1 360 170"/>
      <line class="horizon" x1="10" y1="170" x2="390" y2="170"/>
      <g id="body"></g>
      <text x="40" y="192" text-anchor="middle">${clock(c.sunrise, tz)}</text>
      <text x="360" y="192" text-anchor="middle">${clock(c.sunset, tz)}</text>
      <text x="40" y="160" text-anchor="middle" font-size="11">rise</text>
      <text x="360" y="160" text-anchor="middle" font-size="11">set</text>
    </svg>`;
    $('#daylight').textContent = `${dur(c.sunset - c.sunrise)} of daylight`;
    state.skyBuilt = null;
    updateSky(true);
  }

  function updateSky(animate = false) {
    const { wx } = state;
    if (!wx) return;
    const c = wx.current, now = Math.floor(Date.now() / 1000);
    const phase = skyPhase(now, c.sunrise, c.sunset);
    applySky(phase);
    const body = $('#body');
    if (!body || !c.sunrise || !c.sunset) return;
    const { f, night } = skyFraction(now, c.sunrise, c.sunset);
    $('#track').classList.toggle('night', night);
    if (state.skyBuilt !== night) {
      body.innerHTML = night
        ? `<g transform="scale(.95)">${moonMarkup(wx.moon.phase, 14)}</g>`
        : `<circle r="20" fill="#ffc145" opacity=".28"/><circle r="11" fill="#ffc145"/>`;
      state.skyBuilt = night;
    }
    const place = t => {
      const [x, y] = arcPoint(t);
      body.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    };
    if (animate && !reduceMotion) {
      const t0 = performance.now(), D = 1200;
      const step = ts => {
        const k = Math.min(1, (ts - t0) / D);
        place(f * (1 - Math.pow(1 - k, 3)));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    } else place(f);
  }

  /* ------------------------------------------------------------- hero */
  function dailyFrom(fc, tz) {
    const map = new Map();
    for (const it of fc) {
      const d = shifted(it.dt, tz);
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      if (!map.has(key)) map.set(key, { dt: it.dt, items: [] });
      map.get(key).items.push(it);
    }
    return [...map.values()].map(g => {
      const temps = g.items.map(i => i.temp);
      const mid = g.items.reduce((a, b) => (Math.abs(hourOf(b.dt, tz) - 13) < Math.abs(hourOf(a.dt, tz) - 13) ? b : a));
      return { dt: g.dt, min: Math.min(...temps), max: Math.max(...temps), pop: Math.max(...g.items.map(i => i.pop || 0)), id: mid.id, desc: mid.desc };
    });
  }

  function placeTitle() {
    const p = state.place || {}, loc = state.wx.location;
    return {
      name: p.name || loc.name || `${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`,
      sub: [p.state, countryName(p.country || loc.country)].filter(Boolean).join(', '),
      cc: p.country || loc.country,
    };
  }

  function renderHero() {
    const { wx } = state, c = wx.current, tz = wx.location.timezone;
    const t = placeTitle();
    const now = Math.floor(Date.now() / 1000);
    const night = skyPhase(now, c.sunrise, c.sunset) === 'night';
    const days = dailyFrom(wx.forecast, tz);
    const today = days[0];
    const hi = today ? Math.max(today.max, c.temp) : c.temp, lo = today ? Math.min(today.min, c.temp) : c.temp;

    $('#place-name').textContent = `${flag(t.cc)} ${t.name}`.trim();
    $('#place-sub').textContent = t.sub || '\u00a0';
    $('#temp').textContent = deg(c.temp) ;
    $('#wx-icon').innerHTML = wxIcon(c.id, night);
    $('#cond').textContent = c.description || c.main || '';
    $('#feels').textContent = `Feels like ${deg(c.feels_like)}`;
    $('#hilo').textContent = `High ${deg(hi)}, low ${deg(lo)}`;
    document.title = `${deg(c.temp)}${unitLetter()} in ${t.name} · Overhead`;
    tickClock();
  }

  function tickClock() {
    if (!state.wx) return;
    const tz = state.wx.location.timezone, now = Math.floor(Date.now() / 1000);
    $('#local-time').textContent = clock(now, tz);
    $('#local-date').textContent = fullDate(now, tz);
  }

  /* ---------------------------------------------------------- weather */
  function renderHourly() {
    const { wx } = state, tz = wx.location.timezone;
    const pts = wx.forecast.slice(0, 9);
    if (pts.length < 2) { $('#hourly').innerHTML = '<p class="empty">No forecast available.</p>'; return; }
    const W = 720, H = 200, pl = 28, pr = 28, pt = 40, pb = 62;
    const temps = pts.map(p => p.temp), lo = Math.min(...temps), hi = Math.max(...temps), span = Math.max(hi - lo, 4);
    const x = i => pl + i * (W - pl - pr) / (pts.length - 1);
    const y = v => pt + (hi - v) / span * (H - pt - pb);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.temp).toFixed(1)}`).join('');
    const area = `${line}L${x(pts.length - 1)} ${H - pb + 8}L${x(0)} ${H - pb + 8}Z`;
    $('#hourly').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Temperature over the next 24 hours">
      <defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color:var(--accent);stop-opacity:.45"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#fill)"/>
      <path class="line" d="${line}"/>
      ${pts.map((p, i) => `
        <circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(p.temp).toFixed(1)}" r="4.5"/>
        <text class="t" x="${x(i).toFixed(1)}" y="${(y(p.temp) - 14).toFixed(1)}" text-anchor="middle">${deg(p.temp)}</text>
        <text x="${x(i).toFixed(1)}" y="${H - 30}" text-anchor="middle">${hourLabel(p.dt, tz)}</text>
        ${p.pop >= 0.2 ? `<text class="pop" x="${x(i).toFixed(1)}" y="${H - 12}" text-anchor="middle">${Math.round(p.pop * 100)}%</text>` : ''}`).join('')}
    </svg>`;
  }

  function renderDaily() {
    const { wx } = state, tz = wx.location.timezone;
    const days = dailyFrom(wx.forecast, tz).slice(0, 5);
    const lo = Math.min(...days.map(d => d.min)), hi = Math.max(...days.map(d => d.max)), span = Math.max(hi - lo, 1);
    $('#daily').innerHTML = days.map((d, i) => {
      const left = (d.min - lo) / span * 100, width = Math.max((d.max - d.min) / span * 100, 6);
      return `<li>
        <span class="day">${i === 0 ? 'Today' : WD[shifted(d.dt, tz).getUTCDay()]}</span>
        <span class="ico" title="${esc(d.desc)}">${wxIcon(d.id, false)}</span>
        <span class="rain">${d.pop >= 0.2 ? Math.round(d.pop * 100) + '%' : ''}</span>
        <span class="lo">${deg(d.min)}</span>
        <span class="range"><i style="left:${left}%;width:${width}%"></i></span>
        <span class="hi">${deg(d.max)}</span>
      </li>`;
    }).join('');
  }

  function renderReadings() {
    const c = state.wx.current;
    const precip = c.rain_1h ?? c.snow_1h;
    const rows = [
      ['Wind', `<span class="arrow" style="transform:rotate(${(c.wind_deg ?? 0) + 180}deg)">↑</span> ${windText(c.wind_speed ?? 0)}<small>${c.wind_deg != null ? compass(c.wind_deg) : ''}</small>`],
      c.wind_gust ? ['Gusts', windText(c.wind_gust)] : null,
      ['Humidity', `${c.humidity}%`],
      ['Pressure', `${fmtNum(c.pressure)} hPa`],
      ['Visibility', c.visibility != null ? distText(c.visibility) : 'n/a'],
      ['Cloud cover', c.clouds != null ? `${c.clouds}%` : 'n/a'],
      precip != null ? [c.rain_1h != null ? 'Rain, last hour' : 'Snow, last hour', `${precip} mm`] : null,
    ];
    $('#readings').innerHTML = facts(rows);
  }

  const AQI = [
    ['Good', 'Air is clean. Enjoy the outdoors.'],
    ['Fair', 'Fine for most people. Very sensitive people may notice it.'],
    ['Moderate', 'Sensitive groups should ease off long outdoor exercise.'],
    ['Poor', 'Consider shorter outdoor time, especially for children and older adults.'],
    ['Very poor', 'Limit time outside and avoid strenuous activity.'],
  ];
  function renderAir() {
    const a = state.wx.air, box = $('#air');
    if (!a) { box.innerHTML = '<p class="empty">Air quality data isn\'t available for this spot.</p>'; return; }
    const [label, note] = AQI[Math.min(Math.max(a.aqi, 1), 5) - 1];
    const comp = a.components || {};
    const rows = [['PM2.5', comp.pm2_5], ['PM10', comp.pm10], ['Ozone (O₃)', comp.o3], ['Nitrogen dioxide', comp.no2], ['Sulphur dioxide', comp.so2], ['Carbon monoxide', comp.co]]
      .filter(r => r[1] != null).map(([k, v]) => [k, `${fmtNum(v, 1)}<small>µg/m³</small>`]);
    box.innerHTML = `<div>
        <p class="air-head">${label}</p>
        <div class="aqi-scale" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><b style="left:${(a.aqi - 0.5) * 20}%"></b></div>
        <div class="aqi-labels" aria-hidden="true"><span>Good</span><span>Very poor</span></div>
        <p class="air-note">${note}</p>
      </div>
      <dl class="facts">${facts(rows)}</dl>`;
  }

  /* ------------------------------------------------------------ place */
  function renderPlace() {
    const { wx } = state, loc = wx.location, c = wx.current, tz = loc.timezone;
    const t = placeTitle();
    const rows = [
      ['Place', esc([t.name, t.sub].filter(Boolean).join(', '))],
      ['Latitude', `${dms(loc.lat, 'N', 'S')}<small>${loc.lat.toFixed(4)}</small>`],
      ['Longitude', `${dms(loc.lon, 'E', 'W')}<small>${loc.lon.toFixed(4)}</small>`],
      loc.elevation != null ? ['Elevation', `${state.units === 'metric' ? fmtNum(loc.elevation) + ' m' : fmtNum(loc.elevation * 3.28084) + ' ft'}<small>above sea level</small>`] : null,
      ['Time zone', utcLabel(tz)],
      c.sunrise ? ['Sunrise', clock(c.sunrise, tz)] : null,
      c.sunset ? ['Sunset', clock(c.sunset, tz)] : null,
      c.sunrise ? ['Solar noon', clock((c.sunrise + c.sunset) / 2, tz)] : null,
    ];
    $('#place-facts').innerHTML = facts(rows);
    syncPlaceMap();
  }

  /* ------------------------------------------------------------- maps */
const tileUrl = () => 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const tileOpts = { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 };

  function makeMap(id, opts) {
    const map = L.map(id, { zoomControl: true, attributionControl: true, ...opts });
    const tiles = L.tileLayer(tileUrl(), tileOpts).addTo(map);
    state.maps[id] = { map, tiles };
    return map;
  }
  function updateTiles() {
    Object.values(state.maps).forEach(m => m.tiles.setUrl(tileUrl()));
  }

  function syncPlaceMap() {
    if (state.tab !== 'place' || !state.wx) return;
    const { lat, lon } = state.wx.location;
    let m = state.maps['place-map'];
    if (!m) {
      const map = makeMap('place-map', { center: [lat, lon], zoom: 9 });
      map.on('click', e => {
        const { lat, lng } = e.latlng;
        pickCoords(lat, ((lng + 540) % 360) - 180);
      });
      state.placeMarker = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<span class="you-dot"></span>', iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(map);
      m = state.maps['place-map'];
    } else {
      state.placeMarker.setLatLng([lat, lon]);
      m.map.setView([lat, lon], m.map.getZoom());
    }
    setTimeout(() => m.map.invalidateSize(), 50);
  }

  /* ------------------------------------------------------------ space */
  function splitPath(points) {
    const segs = [];
    let cur = [];
    points.forEach((p, i) => {
      if (i && Math.abs(p[1] - points[i - 1][1]) > 180) { segs.push(cur); cur = []; }
      cur.push(p);
    });
    if (cur.length) segs.push(cur);
    return segs;
  }

  function ensureIssMap(first) {
    let m = state.maps['iss-map'];
    if (!m) {
      const map = makeMap('iss-map', { center: [first.lat, first.lon], zoom: 2, minZoom: 1, worldCopyJump: true });
      state.issLayers = L.layerGroup().addTo(map);
      state.issMarker = L.marker([first.lat, first.lon], { icon: L.divIcon({ className: '', html: '<span class="iss-dot"></span>', iconSize: [18, 18], iconAnchor: [9, 9] }), keyboard: false }).addTo(map);
      state.youMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<span class="you-dot"></span>', iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false, opacity: 0 }).addTo(map);
      m = state.maps['iss-map'];
      state.issCentered = false;
    }
    setTimeout(() => m.map.invalidateSize(), 50);
    return m.map;
  }

  function renderIss(iss) {
    state.lastIss = iss;
    const map = ensureIssMap(iss);
    state.issLayers.clearLayers();
    const style = (dash) => ({ color: '#ffc145', weight: 2.5, opacity: .9, dashArray: dash });
    splitPath(iss.path.past).forEach(s => L.polyline(s, style(null)).addTo(state.issLayers));
    splitPath(iss.path.future).forEach(s => L.polyline(s, style('4 8')).addTo(state.issLayers));
    state.issMarker.setLatLng([iss.lat, iss.lon]);
    if (state.wx) {
      const { lat, lon } = state.wx.location;
      state.youMarker.setLatLng([lat, lon]).setOpacity(1);
    }
    if (!state.issCentered) { map.setView([iss.lat, iss.lon], 2); state.issCentered = true; }

    const you = state.wx ? [state.wx.location.lat, state.wx.location.lon] : null;
    const dist = you ? haversine(you, [iss.lat, iss.lon]) : null;
    const vis = { daylight: 'In sunlight', eclipsed: 'In Earth\'s shadow', visible: 'In sunlight' }[iss.visibility] || '';
    $('#iss-facts').innerHTML = facts([
      ['Over', `${Math.abs(iss.lat).toFixed(2)}° ${iss.lat >= 0 ? 'N' : 'S'}, ${Math.abs(iss.lon).toFixed(2)}° ${iss.lon >= 0 ? 'E' : 'W'}`],
      ['Altitude', kmText(iss.altitude_km)],
      ['Speed', `${kmText(iss.velocity_kmh)}/h`],
      vis ? ['Lighting', vis] : null,
      dist != null ? ['Distance from you', `${kmText(dist)}<small>${dist < 2200 ? 'above your horizon' : 'below your horizon'}</small>`] : null,
      ['Orbit time', '≈ 92 min'],
    ]);
  }

  async function pollIss() {
    try { renderIss(await api('iss')); } catch { /* keep last known position */ }
  }
  function startIss() {
    stopIss();
    pollIss();
    state.issTimer = setInterval(pollIss, 6000);
  }
  function stopIss() { clearInterval(state.issTimer); state.issTimer = null; }

  function renderMoon(moon) {
    const tz = state.wx ? state.wx.location.timezone : 0;
    const dateOf = iso => { const s = Date.parse(iso) / 1000; return `${fullDate(s, tz)}`; };
    $('#moon').innerHTML = `<svg viewBox="-24 -24 48 48" role="img" aria-label="${esc(moon.name)}">${moonMarkup(moon.phase, 22)}</svg>
      <dl class="facts">${facts([
        ['Phase', moon.name],
        ['Lit', `${Math.round(moon.illumination * 100)}%`],
        ['Age', `${moon.age_days} days`],
        ['Next full moon', dateOf(moon.next_full)],
        ['Next new moon', dateOf(moon.next_new)],
      ])}</dl>`;
  }

  function renderCrew(crew) {
    const box = $('#crew');
    if (!crew) { box.innerHTML = '<p class="empty">Crew list isn\'t available right now.</p>'; return; }
    const by = {};
    crew.people.forEach(p => (by[p.craft] = by[p.craft] || []).push(p.name));
    box.innerHTML = `<p class="count">${crew.number}<small>people beyond Earth right now</small></p>` +
      Object.entries(by).map(([craft, names]) => `<h3>${esc(craft)}</h3><ul>${names.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`).join('');
  }

  function renderApod(a) {
    const box = $('#apod');
    if (!a || !a.title) { box.innerHTML = '<p class="empty">Today\'s picture isn\'t available right now. NASA\'s demo key is rate limited, so try again later or add your own NASA_API_KEY.</p>'; return; }
    const media = a.media_type === 'image'
      ? `<a href="${esc(a.hdurl || a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" alt="${esc(a.title)}" loading="lazy"></a>`
      : `<a href="${esc(a.url)}" target="_blank" rel="noopener">Watch today's video</a>`;
    const text = a.explanation && a.explanation.length > 520 ? a.explanation.slice(0, 520).replace(/\s+\S*$/, '') + '…' : a.explanation;
    box.innerHTML = `${media}<figcaption><h3>${esc(a.title)}</h3><p>${esc(text)}</p>${a.copyright ? `<p class="hint">Credit: ${esc(a.copyright.trim())}</p>` : ''}</figcaption>`;
  }

  async function loadSpaceInfo() {
    if (state.spaceLoaded) return;
    try {
      const s = await api('space');
      renderMoon(s.moon); renderCrew(s.crew); renderApod(s.apod);
      state.spaceLoaded = true;
    } catch (e) { $('#apod').innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
  }

  /* ------------------------------------------------------------- flow */
  function renderAll() {
    buildSky();
    renderHero();
    renderHourly();
    renderDaily();
    renderReadings();
    renderAir();
    renderPlace();
    if (state.tab === 'space') { if (state.lastIss) renderIss(state.lastIss); renderMoon(state.wx.moon); }
  }

  function showBanner(msg) { const b = $('#banner'); b.textContent = msg; b.hidden = false; }
  const hideBanner = () => { $('#banner').hidden = true; };

  async function loadPlace(p) {
    const id = ++state.req;
    state.place = p;
    $('#hero').setAttribute('aria-busy', 'true');
    hideBanner();
    try {
      const wx = await api('weather', { lat: p.lat, lon: p.lon, units: state.units });
      if (id !== state.req) return;
      state.wx = wx;
      store.set('last', p);
      renderAll();
      pushRecent(p, wx);
    } catch (e) {
      if (id === state.req) showBanner(e.message);
    } finally {
      if (id === state.req) $('#hero').setAttribute('aria-busy', 'false');
    }
  }

  async function pickCoords(lat, lon) {
    let p = { name: null, state: null, country: null, lat, lon };
    try { p = await api('reverse', { lat, lon }); } catch { /* fall back to coordinates */ }
    loadPlace(p);
  }

  /* ----------------------------------------------------------- search */
  const recentKey = 'recent';
  function pushRecent(p, wx) {
    const item = { name: p.name || wx.location.name, state: p.state, country: p.country || wx.location.country, lat: p.lat, lon: p.lon };
    if (!item.name) return;
    const list = store.get(recentKey, []).filter(r => Math.abs(r.lat - item.lat) > .05 || Math.abs(r.lon - item.lon) > .05);
    store.set(recentKey, [item, ...list].slice(0, 5));
  }

  const q = $('#q'), list = $('#suggest');
  let items = [], active = -1, debounce;

  function openList(html, data) {
    items = data; active = -1;
    list.innerHTML = html;
    list.hidden = !html;
    q.setAttribute('aria-expanded', String(!!html));
  }
  const closeList = () => openList('', []);
  const label = p => [p.state, countryName(p.country)].filter(Boolean).join(', ');

  function renderSuggestions(rows, heading) {
    if (!rows.length) { openList(heading === 'search' ? '<li class="group">No places match that. Try a nearby city.</li>' : '', []); return; }
    openList((heading && heading !== 'search' ? `<li class="group" role="presentation">${heading}</li>` : '') +
      rows.map((p, i) => `<li role="option" id="s${i}" data-i="${i}" aria-selected="false"><span>${esc(p.name)}</span><small>${esc(label(p))}</small></li>`).join(''), rows);
  }
  function highlight(i) {
    active = (i + items.length) % items.length;
    $$('#suggest [role=option]').forEach((li, n) => li.setAttribute('aria-selected', String(n === active)));
    q.setAttribute('aria-activedescendant', `s${active}`);
  }
  function choose(i) {
    const p = items[i];
    if (!p) return;
    q.value = ''; closeList(); q.blur();
    loadPlace(p);
  }

  q.addEventListener('input', () => {
    clearTimeout(debounce);
    const v = q.value.trim();
    if (v.length < 2) { showRecent(); return; }
    debounce = setTimeout(async () => {
      try { renderSuggestions(await api('search', { q: v }), 'search'); }
      catch (e) { showBanner(e.message); closeList(); }
    }, 250);
  });
  function showRecent() {
    const r = store.get(recentKey, []);
    if (r.length && !q.value.trim()) renderSuggestions(r, 'Recent'); else closeList();
  }
  q.addEventListener('focus', showRecent);
  q.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); highlight(active + 1); }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); highlight(active - 1); }
    else if (e.key === 'Escape') closeList();
  });
  $('#search-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (active >= 0) return choose(active);
    if (items.length) return choose(0);
    const v = q.value.trim();
    if (v.length < 2) return;
    try {
      const rows = await api('search', { q: v });
      if (rows.length) { items = rows; choose(0); } else renderSuggestions([], 'search');
    } catch (err) { showBanner(err.message); }
  });
  list.addEventListener('mousedown', e => { const li = e.target.closest('[data-i]'); if (li) { e.preventDefault(); choose(+li.dataset.i); } });
  document.addEventListener('click', e => { if (!e.target.closest('.search')) closeList(); });

  /* ---------------------------------------------------- locate + units */
  function locate() {
    if (!navigator.geolocation) { showBanner('Your browser can\'t share a location. Search for a place instead.'); return; }
    const btn = $('#locate');
    btn.classList.add('busy');
    navigator.geolocation.getCurrentPosition(
      pos => { btn.classList.remove('busy'); pickCoords(pos.coords.latitude, pos.coords.longitude); },
      err => {
        btn.classList.remove('busy');
        showBanner(err.code === 1 ? 'Location access is blocked. Allow it in your browser settings, or search for a place.' : 'Couldn\'t find your location. Search for a place instead.');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }
  $('#locate').addEventListener('click', locate);

  function setUnits(u) {
    state.units = u; store.set('units', u);
    $$('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.u === u)));
    if (state.place) loadPlace(state.place);
  }
  $$('.seg button').forEach(b => b.addEventListener('click', () => { if (b.dataset.u !== state.units) setUnits(b.dataset.u); }));

  /* -------------------------------------------------------------- tabs */
  function showTab(name, focus = false) {
    state.tab = name;
    $$('.tabs [role=tab]').forEach(t => {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    $$('.panel').forEach(p => { p.hidden = p.id !== `tab-${name}`; });
    history.replaceState(null, '', `#${name}`);
    if (name === 'place') syncPlaceMap();
    if (name === 'space') { loadSpaceInfo(); startIss(); if (state.wx) renderMoon(state.wx.moon); } else stopIss();
  }
  const tabs = $$('.tabs [role=tab]');
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => showTab(t.dataset.tab));
    t.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') showTab(tabs[(i + 1) % tabs.length].dataset.tab, true);
      if (e.key === 'ArrowLeft') showTab(tabs[(i + tabs.length - 1) % tabs.length].dataset.tab, true);
    });
  });
  document.addEventListener('visibilitychange', () => {
    if (state.tab !== 'space') return;
    document.hidden ? stopIss() : startIss();
  });

  /* -------------------------------------------------------------- boot */
  setInterval(() => { tickClock(); }, 15000);
  setInterval(() => updateSky(false), 60000);

  async function boot() {
    $$('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.u === state.units)));
    const hash = location.hash.slice(1);
    if (['weather', 'place', 'space'].includes(hash)) showTab(hash);

    const last = store.get('last', null);
    if (last) return loadPlace(last);

    // First visit: use the device location only if permission was already granted.
    try {
      const perm = await navigator.permissions.query({ name: 'geolocation' });
      if (perm.state === 'granted') return locate();
    } catch { /* Permissions API unavailable */ }
    loadPlace({ name: 'London', state: 'England', country: 'GB', lat: 51.5073, lon: -0.1276 });
  }
  boot();
})();
