// Loupedeck CT ADS-B radar
// Turns a Loupedeck CT into a live aircraft radar fed by a tar1090 / dump1090 receiver.
//   Wheel screen  : radar scope over a satellite map (compass rose, trails, spotlight banner, runway centrelines)
//   Centre screen : 12 tiles aligned with the physical key grid (aircraft list, detail card, airport picker)
//   Side strips   : current value of each side knob
import { discover } from 'loupedeck'
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const DEMO = process.argv.includes('--screenshots') // render README screenshots with demo data, no device needed
const CONFIG = new URL(DEMO ? './config.example.json' : './config.json', import.meta.url)
if (!existsSync(CONFIG)) {
  console.error('config.json not found: copy config.example.json to config.json and set your receiver URL and location.')
  process.exit(1)
}
const cfg = JSON.parse(readFileSync(CONFIG))
if (DEMO) cfg.language = process.argv.includes('--fr') ? 'fr' : 'en'

// ---------- UI language (en | fr)
const STRINGS = {
  en: { filters: ['ALL', 'MILITARY', 'HELICOPTERS', 'LOW ALT.', 'AIRPORT', 'HEAVIES', 'OVERHEAD'], follow: 'FOLLOW', ground: 'GND', mil: 'MIL',
    from: 'FROM', to: 'TO', airline: 'AIRLINE', alt: 'ALT', spd: 'SPD', vs: 'V/S', type: 'TYPE', hdg: 'HDG', dist: 'DIST', squawk: 'SQUAWK',
    back: 'Back', close: 'Close', next: 'Next', unknown: 'unknown', seen: 'observed', noAircraft: r => `No aircraft within ${r} km`, noTraffic: 'No traffic for this airport yet',
    brgAt: b => `bearing ${b}°`, altMin: 'MIN ALT', none: 'none', filter: 'FILTER', bright: 'SCREEN', labels: 'LABELS', trails: 'TRAILS', map: 'MAP',
    overflight: t => `Overhead ${t} min`, at: d => `${d} km`, locale: 'en-GB', eta: 'TOUCHDOWN', slope: 'glide', rwy: 'RWY',
    traffic: n => `${n} aircraft`, airports: 'Airports' },
  fr: { filters: ['TOUS', 'MILITAIRES', 'HELICOS', 'BASSE ALT.', 'AEROPORT', 'GROS PORTEURS', 'AU-DESSUS'], follow: 'SUIVI', ground: 'SOL', mil: 'MIL',
    from: 'DEPART', to: 'ARRIVEE', airline: 'COMPAGNIE', alt: 'ALT', spd: 'VIT', vs: 'V/S', type: 'TYPE', hdg: 'CAP', dist: 'DIST', squawk: 'SQUAWK',
    back: 'Retour', close: 'Fermer', next: 'Suite', unknown: 'inconnu', seen: 'observé', noAircraft: r => `Aucun avion dans ${r} km`, noTraffic: 'Aucun trafic pour cet aéroport',
    brgAt: b => `au ${b}°`, altMin: 'ALT MIN', none: 'aucun', filter: 'FILTRE', bright: 'ECRAN', labels: 'ETIQUETTES', trails: 'TRAINEES', map: 'CARTE',
    overflight: t => `Survol ${t} min`, at: d => `à ${d} km`, locale: 'fr-FR', eta: 'TOUCHER', slope: 'pente', rwy: 'PISTE',
    traffic: n => `${n} avion${n > 1 ? 's' : ''}`, airports: 'Aéroports' },
}
const T = STRINGS[cfg.language] || STRINGS.en
const RANGES = cfg.ranges_km

// ---------- Font: register a Windows UI font explicitly (otherwise the canvas falls back to a serif font)
const FONT_SETS = {
  segoe: ['C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/seguisb.ttf', 'C:/Windows/Fonts/segoeuib.ttf'],
  bahnschrift: ['C:/Windows/Fonts/bahnschrift.ttf'],
  arial: ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/arialbd.ttf'],
  // non-Windows fallbacks
  inter: ['/usr/share/fonts/opentype/inter/Inter-Regular.otf', '/usr/share/fonts/opentype/inter/Inter-SemiBold.otf', '/usr/share/fonts/opentype/inter/Inter-Bold.otf'],
  dejavu: ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  helvetica: ['/System/Library/Fonts/Helvetica.ttc'],
}
let FONT = 'sans-serif'
for (const name of [cfg.font || 'segoe', 'segoe', 'arial', 'inter', 'dejavu', 'helvetica']) {
  const files = (FONT_SETS[name] || []).filter(f => existsSync(f))
  if (files.length) { files.forEach(f => GlobalFonts.registerFromPath(f, 'RadarUI')); FONT = 'RadarUI'; console.log('Font:', name); break }
}
let rangeIdx = Math.max(0, RANGES.indexOf(cfg.default_range_km))
let minAltFt = 0
let brightness = 1
let aircraft = []
let selectedHex = null
let sweep = 0
let lastAlert = 0
let device = null
let busy = false
let filterIdx = 0
let labelsMax = cfg.labels_max ?? 6
let trailMin = cfg.trail_minutes ?? 3
let mapBright = (cfg.map?.brightness ?? 0.75)
let view = { lat: cfg.lat, lon: cfg.lon }   // view centre (can be panned with the arrow keys)
const trails = new Map()                     // hex -> [{lat, lon, t}]
const alerted = new Map()                    // hex -> last alert time
let alertLevel = null                        // null | 'info' | 'warn' | 'emerg'
let night = false, dayBrightness = 1
let spotIdx = 0, spotAt = 0                  // spotlight banner on the wheel screen
let picker = false, pickerPage = 0           // airport picker on the 12 tiles
let follow = true                            // the view follows the selected aircraft
let lastSelected = null
let lostSince = 0
function goHome() { const ap = airportMode && airportByIcao(selAirport); view = ap ? { lat: ap.lat, lon: ap.lon } : { lat: cfg.lat, lon: cfg.lon } }
function updateFollow() {
  if (selectedHex !== lastSelected) { // selection changed
    if (!selectedHex && lastSelected) goHome() // end of follow: back to home
    if (selectedHex) follow = true
    lastSelected = selectedHex; lostSince = 0
  }
  if (!selectedHex) return
  const a = aircraft.find(p => p.hex === selectedHex)
  if (!a) { // aircraft lost (out of coverage): give up after 15 s
    lostSince ||= Date.now()
    if (Date.now() - lostSince > 15000) { console.log('Aircraft lost, back to home'); selectedHex = null; lastSelected = null; lostSince = 0; goHome(); refreshCenterNow() }
    return
  }
  lostSince = 0
  if (follow) view = { lat: a.lat, lon: a.lon }
}
const safe = fn => { try { Promise.resolve(fn()).catch(() => {}) } catch {} }

// ---------- Geo ----------
const R_EARTH = 6371
const toRad = d => d * Math.PI / 180
function distBearing(lat, lon) {
  const p1 = toRad(cfg.lat), p2 = toRad(lat), dl = toRad(lon - cfg.lon)
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  const d = 2 * R_EARTH * Math.asin(Math.sqrt(a))
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return { d, brg: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 }
}

// ---------- Data ----------
async function poll() {
  try {
    const r = await fetch(cfg.tar1090_url.replace(/\/$/, '') + '/data/aircraft.json', { signal: AbortSignal.timeout(4000) })
    const j = await r.json()
    aircraft = j.aircraft
      .filter(a => a.lat != null && a.lon != null && (a.seen_pos ?? a.seen ?? 99) < 60)
      .map(a => {
        const alt = a.alt_baro ?? a.altitude ?? a.alt_geom
        const { d, brg } = distBearing(a.lat, a.lon)
        return {
          hex: a.hex,
          flight: (a.flight || '').trim(),
          alt: alt === 'ground' ? 0 : (typeof alt === 'number' ? alt : null),
          ground: alt === 'ground',
          track: a.track ?? a.true_heading ?? null,
          speed: a.gs ?? a.speed ?? null,
          vrate: a.baro_rate ?? a.vert_rate ?? null,
          squawk: a.squawk || '',
          type: a.t || a.category || '',
          category: a.category || '',
          seenPos: a.seen_pos ?? a.seen ?? 0,
          lat: a.lat, lon: a.lon, d, brg,
        }
      })
      .sort((a, b) => a.d - b.d)
    const now = Date.now()
    for (const a of aircraft) {
      if (a.seenPos > 15) continue
      const tr = trails.get(a.hex) || []
      const last = tr[tr.length - 1]
      if (!last || last.lat !== a.lat || last.lon !== a.lon) tr.push({ lat: a.lat, lon: a.lon, t: now })
      trails.set(a.hex, tr)
    }
    for (const [hex, tr] of trails) {
      while (tr.length && now - tr[0].t > 15 * 60000) tr.shift()
      if (!tr.length) trails.delete(hex)
    }
    const sel = aircraft.find(a => a.hex === selectedHex)
    if (sel) wantInfo(sel, true)
    visible().slice(0, 12).forEach(a => wantInfo(a))
    const ap = airportMode && airportByIcao(selAirport) // airport mode needs the routes of everything around the airport
    if (ap) aircraft.filter(a => kmBetween(a, ap) < 120).sort((p, q) => kmBetween(p, ap) - kmBetween(q, ap)).slice(0, 20).forEach(a => wantInfo(a))
    aircraft.filter(a => !getInfo(a) && airportLink(a)).slice(0, 8).forEach(a => wantInfo(a)) // confirm likely arrivals / departures with their route
    checkAlert()
  } catch (e) {
    console.error('tar1090 unreachable:', e.message)
  }
}

function visible() {
  const f = FILTERS[filterIdx].test
  const r = RANGES[rangeIdx] * 1.45 // everything that fits in the square screen
  return aircraft.filter(a => kmBetween(a, view) <= r && (a.alt == null || a.alt >= minAltFt) && f(a))
}

// Altitude colour scale (inspired by tar1090)
function altColor(alt) {
  if (alt == null) return '#9e9e9e'
  const stops = [[0, [255, 120, 0]], [5000, [255, 210, 0]], [10000, [120, 230, 40]], [20000, [0, 220, 200]], [30000, [60, 130, 255]], [40000, [200, 80, 255]]]
  if (alt <= 0) return 'rgb(255,120,0)'
  for (let i = 1; i < stops.length; i++) {
    if (alt <= stops[i][0]) {
      const [a0, c0] = stops[i - 1], [a1, c1] = stops[i]
      const t = (alt - a0) / (a1 - a0)
      const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * t))
      return `rgb(${c.join(',')})`
    }
  }
  return 'rgb(200,80,255)'
}
const isEmergency = sq => ['7500', '7600', '7700'].includes(sq)

// Military: known ICAO address blocks (heuristic, after tar1090) + callsign prefixes
const MIL_RANGES = [['adf7c8','afffff'],['33ff00','33ffff'],['350000','37ffff'],['3aa000','3affff'],['3b7000','3bffff'],['3ea000','3ebfff'],['3f4000','3fbfff'],['400000','40003f'],['43c000','43cfff'],['444000','446fff'],['44f000','44ffff'],['457000','457fff'],['45f400','45f4ff'],['468000','4683ff'],['473c00','473c0f'],['478100','4781ff'],['480000','480fff'],['48d800','48d87f'],['497c00','497cff'],['498420','49842f'],['4b7000','4b7fff'],['4b8200','4b82ff'],['70c070','70c07f'],['710258','71028f'],['738a00','738aff'],['7cf800','7cfaff'],['c20000','c3ffff'],['e40000','e41fff']].map(([a, b]) => [parseInt(a, 16), parseInt(b, 16)])
const MIL_CALLSIGNS = /^(GAF|GAM|FAF|CTM|FMY|FNY|RCH|RRR|NATO|NAF|BAF|IAM|CFC|SUI|SHF|HKY|DUKE|REACH|ASY|HRZ|PLF|SPAR|LAGR|BOE|AME|NOW|MMF|SVF|DAF|HUAF|CEF|POL|ACID)/
function isMilitary(a) {
  const h = parseInt(a.hex, 16)
  return MIL_RANGES.some(([lo, hi]) => h >= lo && h <= hi) || MIL_CALLSIGNS.test(a.flight)
}
const AIRPORT = cfg.airport && cfg.airport.lat != null ? Object.assign({ name: 'AIRPORT', radius_km: 25, below_ft: 8000 }, cfg.airport) : null
const kmBetween = (a, b) => { const p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lon - a.lon); return 2 * R_EARTH * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2)) }

// Overflight prediction: closest point of approach to home (local plane, straight-line motion)
const OV = Object.assign({ radius_km: 3, horizon_min: 10, alert_min: 2 }, cfg.overflight || {})
function overflight(a) {
  if (a.track == null || !a.speed || a.ground || a.seenPos > 20) return null
  const px = (a.lon - cfg.lon) * 111.32 * Math.cos(toRad(cfg.lat)), py = (a.lat - cfg.lat) * 111.32 // km east / north
  const v = a.speed * 1.852 / 60                                                                     // km/min
  const vx = v * Math.sin(toRad(a.track)), vy = v * Math.cos(toRad(a.track))
  const t = -(px * vx + py * vy) / (v * v)
  if (t <= 0 || t > OV.horizon_min) return null
  const dx = px + vx * t, dy = py + vy * t, d = Math.hypot(dx, dy)
  if (d > OV.radius_km) return null
  return { t, d, lat: cfg.lat + dy / 111.32, lon: cfg.lon + dx / (111.32 * Math.cos(toRad(cfg.lat))) }
}
const nextOverflight = () => aircraft.map(a => ({ a, o: overflight(a) })).filter(x => x.o).sort((p, q) => p.o.t - q.o.t)[0] || null

// ---------- Airports, runways and ILS-like approach detection (data: OurAirports, public domain) ----------
const AP = Object.assign({ enabled: true, radius_km: 350, types: ['large_airport', 'medium_airport'], min_runway_ft: 3000, approach_km: 18, default: '' }, cfg.airports || {})
const AP_CACHE = new URL(DEMO ? './airports-cache-demo.json' : './airports-cache.json', import.meta.url)
const OA = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/'
let airports = []         // [{ icao, iata, name, city, type, lat, lon, elev, runways: [{ a: {...}, b: {...} }], ends: [approach ends] }]
let selAirport = null     // selected airport (icao)
let defaultAirport = null // airport selected at start, restored when going back home
let airportMode = false   // view and list centred on the selected airport
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++ } else q = false } else f += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(f); f = '' }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = '' }
    else if (c !== '\r') f += c
  }
  if (f || row.length) { row.push(f); rows.push(row) }
  const head = rows.shift()
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])))
}
const bearing = (a, b) => { const p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lon - a.lon); return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360 }
const offsetPt = (p, brgDeg, km) => ({ lat: p.lat + km * Math.cos(toRad(brgDeg)) / 111.32, lon: p.lon + km * Math.sin(toRad(brgDeg)) / (111.32 * Math.cos(toRad(p.lat))) })
async function loadAirports() {
  if (!AP.enabled) return
  try {
    const c = JSON.parse(readFileSync(AP_CACHE))
    if (c.v === 2 && Math.abs(c.lat - cfg.lat) < 0.5 && Math.abs(c.lon - cfg.lon) < 0.5 && c.radius >= AP.radius_km && JSON.stringify(c.types) === JSON.stringify(AP.types)) airports = c.airports
  } catch {}
  if (!airports.length) {
    console.log('Downloading airport and runway data (OurAirports, once)...')
    const get = async f => { const r = await fetch(OA + f, { signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.text() }
    const [aCsv, rCsv] = await Promise.all([get('airports.csv'), get('runways.csv')])
    const home = { lat: cfg.lat, lon: cfg.lon }
    const byId = new Map()
    for (const a of parseCSV(aCsv)) {
      if (!AP.types.includes(a.type)) continue
      const p = { lat: +a.latitude_deg, lon: +a.longitude_deg }
      if (kmBetween(home, p) > AP.radius_km) continue
      byId.set(a.id, { icao: a.icao_code || a.gps_code || a.ident, iata: a.iata_code || '', name: a.name, city: a.municipality, type: a.type, sched: a.scheduled_service === 'yes', ...p, elev: +a.elevation_ft || 0, runways: [] })
    }
    const paved = /ASP|CON|PEM|BIT|TAR|ASF|PAV|HARD/i
    for (const w of parseCSV(rCsv)) {
      const ap = byId.get(w.airport_ref)
      if (!ap || w.closed === '1' || +w.length_ft < AP.min_runway_ft || !paved.test(w.surface || '') || !w.le_latitude_deg || !w.he_latitude_deg) continue
      const end = (id, la, lo, el, hd, disp) => ({ id, lat: +la, lon: +lo, elev: el ? +el : ap.elev, hdg: hd ? +hd : null, disp: disp ? +disp * 0.0003048 : 0 })
      ap.runways.push({ a: end(w.le_ident, w.le_latitude_deg, w.le_longitude_deg, w.le_elevation_ft, w.le_heading_degT, w.le_displaced_threshold_ft),
                        b: end(w.he_ident, w.he_latitude_deg, w.he_longitude_deg, w.he_elevation_ft, w.he_heading_degT, w.he_displaced_threshold_ft) })
    }
    airports = [...byId.values()].filter(a => a.runways.length)
    try { writeFileSync(AP_CACHE, JSON.stringify({ v: 2, lat: cfg.lat, lon: cfg.lon, radius: AP.radius_km, types: AP.types, airports })) } catch {}
  }
  // Approach ends: landing on end X means flying X's heading towards X's (displaced) threshold
  for (const ap of airports) {
    ap.ends = []
    for (const w of ap.runways) for (const [x, y] of [[w.a, w.b], [w.b, w.a]]) {
      const course = x.hdg ?? bearing(x, y)
      const thr = x.disp ? offsetPt(x, course, x.disp) : { lat: x.lat, lon: x.lon }
      ap.ends.push({ id: x.id, course, ...thr, elev: x.elev })
    }
  }
  const def = String(AP.default || cfg.airport?.icao || '').toUpperCase()
  selAirport = ((def && airports.find(a => a.icao === def || a.iata === def)) || (cfg.airport?.lat != null ? airports.slice().sort((p, q) => kmBetween(p, cfg.airport) - kmBetween(q, cfg.airport))[0] : null))?.icao || null
  defaultAirport = selAirport
  const home = { lat: cfg.lat, lon: cfg.lon }
  for (const ap of airports) { ap.homeKm = kmBetween(home, ap); ap.homeBrg = bearing(home, ap) }
  airports.sort((p, q) => (q.sched - p.sched) || p.homeKm - q.homeKm) // picker order: airports with scheduled flights first, nearest first
  console.log(`Airports loaded: ${airports.length}${selAirport ? `, selected ${selAirport}` : ''}`)
}
const airportByIcao = icao => airports.find(a => a.icao === icao)

// Is the aircraft flying an ILS-like final approach? (geometry from ADS-B position, not the real ILS signal)
const ilsCache = new Map()
function approachOf(a) {
  const k = `${a.hex}|${a.lat}|${a.lon}|${a.alt}`
  if (ilsCache.has(k)) return ilsCache.get(k)
  let best = null
  if (a.alt != null && !a.ground && a.track != null && a.alt < 12000 && (a.vrate ?? 0) < 500) {
    for (const ap of airports) {
      if (Math.abs(ap.lat - a.lat) > 0.4 || Math.abs(ap.lon - a.lon) > 0.6) continue
      for (const e of ap.ends) {
        const dKm = kmBetween(e, a)
        if (dKm < 0.3 || dKm > AP.approach_km * 1.6) continue
        const brgFromThr = bearing(e, a)                       // bearing threshold -> aircraft
        const off = ((brgFromThr - (e.course + 180)) + 540) % 360 - 180 // angle off the extended centreline
        if (Math.abs(off) > 3) continue
        const hdgDiff = Math.abs(((a.track - e.course) + 540) % 360 - 180)
        if (hdgDiff > 30) continue
        const along = dKm * Math.cos(toRad(off)), hAgl = (a.alt - e.elev) * 0.3048
        if (hAgl < 0) continue
        const glide = Math.atan(hAgl / (along * 1000)) * 180 / Math.PI
        if (glide < 1.5 || glide > 5) continue
        const locDev = -off                                     // + = aircraft right of centreline (seen from the aircraft)
        const cand = { ap, end: e, along, locDev, glide, gsDev: glide - 3, eta: along / Math.max(1, (a.speed || 140) * 1.852 / 60) }
        if (!best || Math.abs(off) < Math.abs(-best.locDev)) best = cand
      }
    }
  }
  if (ilsCache.size > 500) ilsCache.clear()
  ilsCache.set(k, best)
  return best
}

// Which airport is this aircraft using? On final ('app'), arriving ('arr') or departing ('dep').
// Final approach comes from the geometry; arrivals and departures from the route when it is known,
// otherwise from a climb / descent below FL200 within 60 km of the nearest airport with scheduled flights.
const linkCache = new Map()
function airportLink(a) {
  const info = getInfo(a), k = `${a.hex}|${a.lat}|${a.lon}|${a.alt}|${info?.at}`
  if (linkCache.has(k)) return linkCache.get(k)
  let res = null
  const app = approachOf(a), vr = a.vrate ?? 0
  if (app) res = { ap: app.ap, kind: 'app' }
  else if (a.alt != null && !a.ground) {
    const r = routeOf(a)
    if (r) {
      const to = localAirport(r.to.iata), from = localAirport(r.from.iata)
      if (to && kmBetween(a, to) < 150 && (a.alt < 25000 || vr < -500)) res = { ap: to, kind: 'arr' }
      else if (from && kmBetween(a, from) < 150 && (a.alt < 25000 || vr > 500)) res = { ap: from, kind: 'dep' }
    }
    if (!res && (!r || r.to.iata === '?' || r.from.iata === '?') && a.alt < 20000 && Math.abs(vr) > 500) {
      let best = null, bd = 60
      for (const p of airports) { if (!p.sched || Math.abs(p.lat - a.lat) > 0.6) continue; const d = kmBetween(a, p); if (d < bd) { bd = d; best = p } }
      if (best) res = { ap: best, kind: vr > 0 ? 'dep' : 'arr' }
    }
  }
  if (linkCache.size > 1500) linkCache.clear()
  linkCache.set(k, res)
  return res
}

// Traffic of the selected airport (on approach, arriving, departing), nearest first
function airportTraffic() {
  const ap = airportByIcao(selAirport); if (!ap) return []
  return aircraft.filter(a => airportLink(a)?.ap === ap).sort((p, q) => kmBetween(p, ap) - kmBetween(q, ap))
}

// Filters (cycled with the middle-left knob)
const FILTERS = [
  { name: T.filters[0], color: '#9fb0bd', test: () => true },
  { name: T.filters[1], color: '#8fe05a', test: a => isMilitary(a) },
  { name: T.filters[2], color: '#e58bff', test: a => a.category === 'A7' || /^H/.test(a.type) },
  { name: T.filters[3], color: '#ffb629', test: a => !a.ground && a.alt != null && a.alt < 10000 },
  AIRPORT && { name: AIRPORT.name, color: '#39d5ff', test: a => a.alt != null && a.alt < AIRPORT.below_ft && kmBetween(a, AIRPORT) < AIRPORT.radius_km },
  { name: T.filters[5], color: '#ffe14d', test: a => a.category === 'A5' },
  { name: T.filters[6], color: '#ffffff', test: a => a.d < 8 },
].filter(Boolean)


// ---------- Airline, route, aircraft (api.adsbdb.com, free, no key) ----------
const ICAO_COUNTRIES = [['008000','00FFFF','ZA'],['010000','017FFF','EG'],['018000','01FFFF','LY'],['020000','027FFF','MA'],['028000','02FFFF','TN'],['0A0000','0A7FFF','DZ'],['06A000','06A3FF','QA'],['300000','33FFFF','IT'],['340000','37FFFF','ES'],['380000','3BFFFF','FR'],['3C0000','3FFFFF','DE'],['400000','43FFFF','GB'],['440000','447FFF','AT'],['448000','44FFFF','BE'],['450000','457FFF','BG'],['458000','45FFFF','DK'],['460000','467FFF','FI'],['468000','46FFFF','GR'],['470000','477FFF','HU'],['478000','47FFFF','NO'],['480000','487FFF','NL'],['488000','48FFFF','PL'],['490000','497FFF','PT'],['498000','49FFFF','CZ'],['4A0000','4A7FFF','RO'],['4A8000','4AFFFF','SE'],['4B0000','4B7FFF','CH'],['4B8000','4BFFFF','TR'],['4C0000','4C7FFF','RS'],['4CA000','4CAFFF','IE'],['4D0000','4D03FF','LU'],['4D2000','4D23FF','MT'],['501C00','501FFF','HR'],['502C00','502FFF','LV'],['503C00','503FFF','LT'],['505C00','505FFF','SI'],['506000','5063FF','SK'],['508000','50FFFF','UA'],['510000','5103FF','BY'],['600000','6003FF','AM'],['683000','6833FF','KZ'],['700000','700FFF','AF'],['710000','717FFF','SA'],['738000','73FFFF','IL'],['740000','7407FF','JO'],['748000','7487FF','LB'],['750000','757FFF','MY'],['760000','767FFF','PK'],['768000','76FFFF','SG'],['780000','7BFFFF','CN'],['7C0000','7FFFFF','AU'],['800000','83FFFF','IN'],['840000','87FFFF','JP'],['880000','887FFF','TH'],['896000','896FFF','AE'],['8A0000','8A7FFF','ID'],['A00000','AFFFFF','US'],['C00000','C3FFFF','CA'],['E40000','E7FFFF','BR'],['140000','15FFFF','RU'],['0D0000','0D7FFF','MX']].map(([a, b, c]) => [parseInt(a, 16), parseInt(b, 16), c])
const regCountry = hex => { const h = parseInt(hex, 16); return (ICAO_COUNTRIES.find(([lo, hi]) => h >= lo && h <= hi) || [])[2] || '' }

const INFO_FILE = new URL('./infos-cache.json', import.meta.url)
let infoCache = {}
try { infoCache = JSON.parse(readFileSync(INFO_FILE)) } catch {}
const pruneInfo = () => { const old = Date.now() - 3 * 86400000; for (const k of Object.keys(infoCache)) if (infoCache[k].v !== 2 || !(infoCache[k].at > old)) { delete infoCache[k]; infoDirty = true } }
let infoDirty = false
pruneInfo() // drop entries from older versions and aircraft not seen for 3 days
const infoKey = a => `${a.hex}|${a.flight}`
const getInfo = a => infoCache[infoKey(a)]
const infoQueue = []
function wantInfo(a, priority = false) {
  const k = infoKey(a), c = infoCache[k]
  if (c && Date.now() - c.at < (c.route ? 12 : 2) * 3600000) return
  if (infoQueue.some(q => infoKey(q) === k)) { if (priority) { const i = infoQueue.findIndex(q => infoKey(q) === k); infoQueue.unshift(...infoQueue.splice(i, 1)) } return }
  priority ? infoQueue.unshift(a) : infoQueue.push(a)
  if (infoQueue.length > 40) infoQueue.length = 40
}
async function adsbdb(path) {
  const r = await fetch(`https://api.adsbdb.com/v0/${path}`, { headers: { 'User-Agent': 'loupedeck-ct-radar/1.0' }, signal: AbortSignal.timeout(6000) })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`adsbdb HTTP ${r.status}`)
  const j = await r.json()
  return typeof j.response === 'object' ? j.response : null
}
// adsb.lol route API: flags routes that are implausible for the current position (same source as tar1090's route display)
async function routeFromAdsbLol(a) {
  const r = await fetch('https://api.adsb.lol/api/0/routeset', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'loupedeck-ct-radar/1.0' },
    body: JSON.stringify({ planes: [{ callsign: a.flight, lat: a.lat, lng: a.lon }] }), signal: AbortSignal.timeout(6000),
  })
  if (!r.ok) return null
  const x = (await r.json())?.[0]
  const ap = x?._airports || []
  if (!x || x.plausible === false || ap.length < 2) return null
  const f = ap[0], t = ap[ap.length - 1]
  if (f.icao === t.icao) return null
  return { from: { iata: f.iata || f.icao, city: f.location, iso: f.countryiso2 }, to: { iata: t.iata || t.icao, city: t.location, iso: t.countryiso2 } }
}
async function processInfoQueue() {
  const a = infoQueue.shift()
  if (!a) return
  const info = { at: Date.now(), v: 2 }
  try {
    let res = a.flight ? await adsbdb(`aircraft/${a.hex}?callsign=${encodeURIComponent(a.flight)}`) : await adsbdb(`aircraft/${a.hex}`)
    if (!res && a.flight) { const r1 = await adsbdb(`callsign/${encodeURIComponent(a.flight)}`); const r2 = await adsbdb(`aircraft/${a.hex}`); res = { ...(r1 || {}), ...(r2 || {}) } }
    const ac = res?.aircraft, fr = res?.flightroute
    if (ac) info.aircraft = { type: ac.icao_type || ac.type, model: ac.type, reg: ac.registration, owner: ac.registered_owner, country: ac.registered_owner_country_iso_name }
    if (fr?.airline) info.airline = { name: fr.airline.name, iata: fr.airline.iata, country: fr.airline.country, iso: fr.airline.country_iso }
    // Route: adsb.lol first (checked against the aircraft position), adsbdb as fallback
    const lol = a.flight ? await routeFromAdsbLol(a).catch(() => null) : null
    if (lol) info.route = lol
    else if (fr?.origin && fr?.destination && (fr.origin.icao_code !== fr.destination.icao_code)) info.route = {
      from: { iata: fr.origin.iata_code || fr.origin.icao_code, city: fr.origin.municipality, iso: fr.origin.country_iso_name },
      to: { iata: fr.destination.iata_code || fr.destination.icao_code, city: fr.destination.municipality, iso: fr.destination.country_iso_name },
    }
    infoCache[infoKey(a)] = info; infoDirty = true
    if (a.hex === selectedHex || tileHexes.includes(a.hex)) refreshCenterNow()
  } catch (e) {
    infoCache[infoKey(a)] = { at: Date.now() - 1.5 * 3600000, v: 2 } // retry in 30 min
    if (cfg.debug) console.error('Info lookup:', e.message)
  }
}
if (!DEMO) setInterval(processInfoQueue, 1200)
if (!DEMO) setInterval(() => { if (infoDirty) { infoDirty = false; try { writeFileSync(INFO_FILE, JSON.stringify(infoCache)) } catch {} } }, 30000)
const countryOf = a => getInfo(a)?.airline?.iso || getInfo(a)?.aircraft?.country || regCountry(a.hex)

// Route to display. Callsigns get reused, so the route database can name an airport hundreds of kilometres away
// while the aircraft is plainly landing or taking off here. What the aircraft does wins over the database:
// an airport confirmed by the trajectory replaces the database one (kept for the rest of the flight),
// and a low descent or climb far from the declared airport shows "?" until the real one is known.
const localAirport = c => airports.find(p => (p.iata && p.iata === c) || p.icao === c)
const seenEnd = ap => ({ iata: ap.iata || ap.icao, city: ap.city || ap.name, obs: true })
const unknownEnd = () => ({ iata: '?', city: T.unknown, obs: true })
const doubted = new Set() // "to|key" / "from|key": doubt raised, kept while the aircraft stays low (no flicker during level-offs)
function routeOf(a) {
  const r = getInfo(a)?.route
  if (!r || !airports.length || a.alt == null || a.ground) return r || null
  const far = end => { const p = localAirport(end.iata); return !p || kmBetween(a, p) > 150 }
  const vr = a.vrate ?? 0, low = a.alt < 8000, kt = `to|${infoKey(a)}`, kf = `from|${infoKey(a)}`
  if (!low) { doubted.delete(kt); doubted.delete(kf) }
  let from = r.from, to = r.to
  const app = approachOf(a)
  if (app && localAirport(to.iata) !== app.ap && far(to)) { to = r.to = seenEnd(app.ap); infoDirty = true }
  else if (low && !to.obs && far(to) && (vr < -400 || doubted.has(kt))) { to = unknownEnd(); doubted.add(kt) }
  if (low && !from.obs && far(from) && (vr > 400 || doubted.has(kf))) {
    let best = null, bd = 15
    if (a.alt < 5000) for (const p of airports) { if (!p.sched || Math.abs(p.lat - a.lat) > 0.3) continue; const d = kmBetween(a, p); if (d < bd) { bd = d; best = p } }
    if (best) { from = r.from = seenEnd(best); infoDirty = true } else { from = unknownEnd(); doubted.add(kf) }
  }
  if (doubted.size > 500) doubted.clear()
  return from === r.from && to === r.to ? r : { from, to }
}

// ---------- RGB565 conversion ----------
const rgbBuffers = new Map() // one reusable output buffer per canvas (the device library copies it before sending)
function toRGB565(canvas, bigEndian) {
  const { width, height } = canvas
  const px = canvas.getContext('2d').getImageData(0, 0, width, height).data
  let buf = rgbBuffers.get(canvas)
  if (!buf) rgbBuffers.set(canvas, buf = Buffer.alloc(width * height * 2))
  for (let i = 0, o = 0; i < px.length; i += 4, o += 2) {
    let r = px[i], gg = px[i + 1], b = px[i + 2]
    if (night) { const l = Math.min(255, 0.35 * r + 0.55 * gg + 0.25 * b); r = l; gg = l * 0.12; b = l * 0.04 } // night mode: everything in red
    const v = ((r & 0xF8) << 8) | ((gg & 0xFC) << 3) | (b >> 3)
    bigEndian ? buf.writeUInt16BE(v, o) : buf.writeUInt16LE(v, o)
  }
  return buf
}

// ---------- Background map ----------
const C = 120, RMAX = 112
const MAP = Object.assign({ enabled: true, layers: [], brightness: 0.55 }, cfg.map || {})
if (!MAP.layers.length && MAP.tile_url) MAP.layers = [{ url: MAP.tile_url }]
const z0x = lon => (lon + 180) / 360 * 256
const z0y = lat => { const r = toRad(lat); return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 256 }
const pxPerZ0 = rangeKm => 156543.03 * Math.cos(toRad(cfg.lat)) / (rangeKm * 1000 / RMAX)

async function getTile(layerUrl, z, x, y) {
  const n = 2 ** z; x = ((x % n) + n) % n
  if (y < 0 || y >= n) return null
  const key = createHash('md5').update(layerUrl).digest('hex').slice(0, 10)
  const dir = new URL(`./tiles/${key}/${z}/${x}/`, import.meta.url), file = new URL(`${y}.img`, dir)
  if (existsSync(file)) return loadImage(readFileSync(file))
  const url = layerUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y)
  const r = await fetch(url, { headers: { 'User-Agent': 'loupedeck-ct-radar/1.0' }, signal: AbortSignal.timeout(10000) })
  if (!r.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  const img = await loadImage(buf) // validate the image before caching it
  mkdirSync(dir, { recursive: true }); writeFileSync(file, buf)
  return img
}

// Map redrawn every frame from in-memory tiles, so the view can follow an aircraft smoothly
const memTiles = new Map()   // 'url|z|x|y' -> image | null (missing); simple LRU
const loading = new Set()
function tileImg(url, z, x, y) {
  const k = `${url}|${z}|${x}|${y}`
  if (memTiles.has(k)) { const v = memTiles.get(k); memTiles.delete(k); memTiles.set(k, v); return v }
  if (!loading.has(k)) {
    loading.add(k)
    getTile(url, z, x, y).then(img => memTiles.set(k, img)).catch(e => { memTiles.set(k, null); console.error('Map:', e.message) })
      .finally(() => { loading.delete(k); if (memTiles.size > 400) memTiles.delete(memTiles.keys().next().value) })
  }
  return undefined
}
// Draws straight into the target context: copying one canvas onto another every frame is avoided on purpose
// (it used to leak a full snapshot per frame with older @napi-rs/canvas versions).
const mapCanvas = createCanvas(240, 240)
function drawMap(idx = rangeIdx, center = view, g = mapCanvas.getContext('2d')) {
  g.globalAlpha = 1; g.fillStyle = '#000'; g.fillRect(0, 0, 240, 240)
  if (!MAP.enabled) return { canvas: mapCanvas, complete: true }
  const K = pxPerZ0(RANGES[idx])
  const z = Math.min(17, Math.max(2, Math.ceil(Math.log2(K))))
  const scale = K / 2 ** z
  const cx = z0x(center.lon) * 2 ** z, cy = z0y(center.lat) * 2 ** z
  const half = 120 / scale
  let complete = true
  for (const layer of MAP.layers) {
    g.globalAlpha = layer.opacity ?? 1
    for (let tx = Math.floor((cx - half) / 256); tx <= Math.floor((cx + half) / 256); tx++)
      for (let ty = Math.floor((cy - half) / 256); ty <= Math.floor((cy + half) / 256); ty++) {
        const img = tileImg(layer.url, z, tx, ty)
        if (img === undefined) complete = false
        if (img) g.drawImage(img, 120 + (tx * 256 - cx) * scale, 120 + (ty * 256 - cy) * scale, 256 * scale + 0.5, 256 * scale + 0.5)
      }
    if (layer.dim) { g.globalAlpha = 1; g.fillStyle = `rgba(0,0,0,${layer.dim})`; g.fillRect(0, 0, 240, 240) }
  }
  g.globalAlpha = 1
  if (MAP.contrast) {
    const { black = 0, gain = 1 } = MAP.contrast
    const im = g.getImageData(0, 0, 240, 240), d = im.data
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = Math.max(0, Math.min(255, (d[i + k] - black) * gain))
    g.putImageData(im, 0, 0)
  }
  if (mapBright < 1) { g.fillStyle = `rgba(0,0,0,${1 - mapBright})`; g.fillRect(0, 0, 240, 240) }
  return { complete }
}
// Preload the home tiles for every range
async function buildAllMaps() {
  if (!MAP.enabled) return
  for (const i of RANGES.keys()) {
    for (let tries = 0; tries < 30; tries++) { if (drawMap(i, { lat: cfg.lat, lon: cfg.lon }).complete) break; await new Promise(r => setTimeout(r, 300)) }
    console.log(`Map ${RANGES[i]} km ready`)
  }
}

// ---------- Design tokens ----------
// Glass-cockpit conventions: white = data, cyan = selectable / navigation, green = engaged mode,
// amber = caution, red = warning, magenta = guidance. Altitude keeps its own colour scale.
const UI = {
  panel: '#0c1116', panelSel: '#082a35', panelWarn: '#2a0707', line: '#212d37',
  text: '#f3f6f8', sub: '#a3b3bf', mute: '#66757f',
  cyan: '#39d5ff', green: '#46e08a', amber: '#ffb629', red: '#ff3d3d', magenta: '#ff4dff',
  scrim: 'rgba(4,8,12,0.80)',
}
const font = (px, weight = 600) => `${weight} ${px}px ${FONT}`
const withAlpha = (c, a) => c.startsWith('rgb(') ? c.replace('rgb(', 'rgba(').replace(')', `,${a})`)
  : `rgba(${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)},${a})`

// Text that always fits: shrinks down to 7 px, then truncates. Returns the drawn width.
function txt(g, s, x, y, { px = 11, weight = 600, color = UI.text, align = 'left', max } = {}) {
  s = String(s ?? '')
  let size = px
  g.font = font(size, weight)
  if (max) {
    while (g.measureText(s).width > max && size > 7) g.font = font(--size, weight)
    while (g.measureText(s).width > max && s.length > 2) s = s.slice(0, -2) + '…'
  }
  g.textAlign = align; g.textBaseline = 'alphabetic'; g.fillStyle = color
  g.fillText(s, x, y)
  return g.measureText(s).width
}
function wrapText(g, s, cx, y, maxW, lineH, opts) {
  g.font = font(opts.px, opts.weight)
  const lines = []; let cur = ''
  for (const w of String(s).split(' ')) {
    const t = cur ? `${cur} ${w}` : w
    if (g.measureText(t).width > maxW && cur) { lines.push(cur); cur = w } else cur = t
  }
  if (cur) lines.push(cur)
  lines.forEach((l, i) => txt(g, l, cx, y + i * lineH, { ...opts, align: 'center', max: maxW }))
}
// Small rounded badge. x is the left edge (align left) or the right edge (align right). Returns its width.
function pill(g, s, x, y, { px = 9, fg = UI.text, bg = '#1a242d', align = 'left', padX = 4, h = 13 } = {}) {
  g.font = font(px, 700)
  const w = Math.ceil(g.measureText(s).width) + padX * 2
  const x0 = align === 'right' ? x - w : x
  g.fillStyle = bg; g.beginPath(); g.roundRect(x0, y - h + 3, w, h, h / 2); g.fill()
  g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = fg; g.fillText(s, x0 + padX, y)
  return w
}

// Aircraft glyphs (nose up at track 0)
const PLANE = [[0, -8], [1.3, -5.6], [1.3, -1.6], [8, 3], [8, 4.7], [1.3, 2.4], [1.3, 5.6], [3.7, 7.6], [3.7, 8.8], [0, 7.8]]
function glyph(g, a, x, y, { color, outline = 'rgba(0,0,0,0.85)', scale = 1, alpha = 1 } = {}) {
  const s = scale * (a.category === 'A5' ? 1.02 : a.category === 'A1' || a.category === 'A2' ? 0.7 : 0.84)
  g.save(); g.translate(x, y); g.globalAlpha = alpha; g.lineJoin = 'round'
  g.beginPath()
  if (a.track == null) { g.moveTo(0, -4.5 * s); g.lineTo(4.5 * s, 0); g.lineTo(0, 4.5 * s); g.lineTo(-4.5 * s, 0); g.closePath() } // no track: diamond
  else if (a.category === 'A7') { // helicopter: body + rotor disc
    g.rotate(toRad(a.track))
    g.moveTo(0, -4 * s); g.lineTo(2.4 * s, -1 * s); g.lineTo(1 * s, 3 * s); g.lineTo(0.7 * s, 8 * s); g.lineTo(-0.7 * s, 8 * s); g.lineTo(-1 * s, 3 * s); g.lineTo(-2.4 * s, -1 * s); g.closePath()
  } else {
    g.rotate(toRad(a.track))
    g.moveTo(PLANE[0][0] * s, PLANE[0][1] * s)
    for (let i = 1; i < PLANE.length; i++) g.lineTo(PLANE[i][0] * s, PLANE[i][1] * s)
    for (let i = PLANE.length - 2; i > 0; i--) g.lineTo(-PLANE[i][0] * s, PLANE[i][1] * s)
    g.closePath()
  }
  if (outline) { g.lineWidth = 2.2; g.strokeStyle = outline; g.stroke() }
  g.fillStyle = color; g.fill()
  if (a.category === 'A7' && a.track != null) { g.strokeStyle = color; g.lineWidth = 1; g.beginPath(); g.arc(0, -0.5 * s, 6 * s, 0, Math.PI * 2); g.stroke() }
  g.restore()
}

// ---------- Wheel screen: radar scope ----------
const knobCanvas = createCanvas(240, 240)
function plotXY(a) {
  const K = pxPerZ0(RANGES[rangeIdx])
  return [C + (z0x(a.lon) - z0x(view.lon)) * K, C + (z0y(a.lat) - z0y(view.lat)) * K]
}
const inDisc = (x, y, r) => (x - C) ** 2 + (y - C) ** 2 <= r * r
const SPOT = { x: 54, y: 180, w: 132, h: 34 } // spotlight banner box

// Label pill placed next to (x, y) at the first free spot. `occupied` collects rectangles already taken.
function placeLabel(g, text, x, y, occupied, { fg = UI.text, bg = UI.scrim, px = 9 } = {}) {
  g.font = font(px, 700)
  const w = Math.ceil(g.measureText(text).width) + 8, h = 13
  for (const [lx, ly] of [[x + 9, y - 15], [x + 9, y + 2], [x - 9 - w, y - 15], [x - 9 - w, y + 2], [x - w / 2, y - 23], [x - w / 2, y + 10]]) {
    if (![[lx, ly], [lx + w, ly], [lx, ly + h], [lx + w, ly + h]].every(([px2, py2]) => inDisc(px2, py2, 109))) continue
    if (occupied.some(o => lx < o.x + o.w && lx + w > o.x && ly < o.y + o.h && ly + h > o.y)) continue
    occupied.push({ x: lx, y: ly, w, h })
    g.fillStyle = bg; g.beginPath(); g.roundRect(lx, ly, w, h, 4); g.fill()
    g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = fg; g.fillText(text, lx + 4, ly + 10)
    return true
  }
  return false
}

function spotlightTarget(list) {
  if (cfg.spotlight === false) return null
  let a = aircraft.find(p => p.hex === selectedHex) || list.find(p => isEmergency(p.squawk))
  const nx = nextOverflight()
  if (!a && nx && nx.o.t <= (OV.spotlight_min ?? 5)) a = nx.a // an imminent overflight takes over the banner
  if (!a && airportMode) a = aircraft.filter(p => approachOf(p)?.ap.icao === selAirport).sort((p, q) => approachOf(p).along - approachOf(q).along)[0]
  if (!a) {
    const pool = list.slice().sort((p, q) => kmBetween(p, view) - kmBetween(q, view)).slice(0, cfg.spotlight_count ?? 8)
    if (!pool.length) return null
    if (Date.now() - spotAt > (cfg.spotlight_sec ?? 4) * 1000) { spotIdx = (spotIdx + 1) % pool.length; spotAt = Date.now() }
    a = pool[spotIdx % pool.length]
  }
  return a
}

function drawRadar() {
  const g = knobCanvas.getContext('2d')
  const range = RANGES[rangeIdx]
  drawMap(rangeIdx, view, g)

  // Vignette: keeps the centre bright and lets the bezel read as an instrument
  const vg = g.createRadialGradient(C, C, 45, C, C, 120)
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.42)')
  g.fillStyle = vg; g.fillRect(0, 0, 240, 240)

  // Sweep
  const sw = toRad(sweep) - Math.PI / 2, step = toRad(1.5)
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(70,224,138,${(0.13 * (1 - i / 40) ** 1.6).toFixed(3)})`
    g.beginPath(); g.moveTo(C, C); g.arc(C, C, RMAX, sw - (i + 1) * step, sw - i * step); g.closePath(); g.fill()
  }
  g.strokeStyle = 'rgba(120,255,180,0.5)'; g.lineWidth = 1
  g.beginPath(); g.moveTo(C, C); g.lineTo(C + RMAX * Math.cos(sw), C + RMAX * Math.sin(sw)); g.stroke()

  // Range rings
  g.strokeStyle = 'rgba(255,255,255,0.07)'
  g.beginPath(); g.moveTo(C, C - RMAX); g.lineTo(C, C + RMAX); g.moveTo(C - RMAX, C); g.lineTo(C + RMAX, C); g.stroke()
  g.strokeStyle = 'rgba(255,255,255,0.24)'; g.setLineDash([2, 4])
  for (let k = 1; k <= 2; k++) { g.beginPath(); g.arc(C, C, RMAX * k / 3, 0, Math.PI * 2); g.stroke() }
  g.setLineDash([])
  for (let k = 1; k <= 2; k++) {
    const label = String(Math.round(range * k / 3)), ry = C - RMAX * k / 3
    g.font = font(8, 600); g.textAlign = 'left'; g.lineWidth = 2.5; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.strokeText(label, C + 4, ry + 10)
    g.fillStyle = 'rgba(255,255,255,0.62)'; g.fillText(label, C + 4, ry + 10)
  }
  const ringLabels = [1, 2].map(k => ({ x: C + 2, y: C - RMAX * k / 3 + 2, w: 16, h: 10 }))

  const list = visible()
  const spot = spotlightTarget(list)
  // Areas labels must not cover: the banner, the chips, every aircraft glyph
  const occupied = [{ x: 62, y: 14, w: 116, h: 34 }, ...ringLabels]
  if (spot) occupied.push({ x: SPOT.x, y: SPOT.y - 2, w: SPOT.w, h: SPOT.h + 4 })
  const pts = list.map(a => { const [x, y] = plotXY(a); occupied.push({ x: x - 7, y: y - 7, w: 14, h: 14 }); return [a, x, y] })

  drawAirports(g, occupied)

  // Trails
  if (trailMin > 0) {
    const now = Date.now()
    g.lineCap = 'round'; g.lineWidth = 1.6
    for (const a of list) {
      const tr = trails.get(a.hex); if (!tr || tr.length < 2) continue
      const tp = tr.filter(p => now - p.t <= trailMin * 60000), col = altColor(a.alt)
      for (let i = 1; i < tp.length; i++) {
        const [x0, y0] = plotXY(tp[i - 1]), [x1, y1] = plotXY(tp[i])
        g.strokeStyle = withAlpha(col, (0.06 + 0.8 * (i / tp.length) ** 1.5).toFixed(2))
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke()
      }
    }
    g.lineCap = 'butt'
  }

  // Aircraft
  for (const [a, x, y] of pts) {
    if (!inDisc(x, y, 118)) continue
    const emerg = isEmergency(a.squawk), col = altColor(a.alt)
    if (emerg) { // red distress ring, pulsing from frame to frame
      const r = blink ? 14 : 11
      g.strokeStyle = UI.red; g.lineWidth = 2; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke()
      g.strokeStyle = withAlpha(UI.red, 0.4); g.lineWidth = 1; g.beginPath(); g.arc(x, y, r + 4, 0, Math.PI * 2); g.stroke()
    }
    if (a.hex === selectedHex) { // selection ring + one-minute velocity vector
      if (a.track != null && a.speed) {
        const len = a.speed * 1.852 / 60 / range * RMAX
        g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + len * Math.sin(toRad(a.track)), y - len * Math.cos(toRad(a.track))); g.stroke()
      }
      g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.stroke()
    } else if (a === spot) {
      g.strokeStyle = col; g.lineWidth = 1.3; g.setLineDash([3, 3]); g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.stroke(); g.setLineDash([])
    }
    glyph(g, a, x, y, { color: col, outline: emerg ? UI.red : 'rgba(0,0,0,0.85)', alpha: a.seenPos > 20 ? 0.45 : 1 })
  }

  // Predicted overflight path of the spotlight aircraft
  const ov = spot && overflight(spot)
  if (ov) {
    const [x, y] = plotXY(spot), [px, py] = plotXY(ov)
    g.strokeStyle = withAlpha(UI.amber, 0.9); g.lineWidth = 1.2; g.setLineDash([2, 3])
    g.beginPath(); g.moveTo(x, y); g.lineTo(px, py); g.stroke(); g.setLineDash([])
    g.fillStyle = UI.amber; g.beginPath(); g.arc(px, py, 2.2, 0, Math.PI * 2); g.fill()
  }

  // Callsign labels: the selected aircraft first, then the nearest ones
  const first = a => a.hex === selectedHex || isEmergency(a.squawk)
  const labelled = pts.filter(([a]) => a.flight).sort((p, q) => first(q[0]) - first(p[0]) || kmBetween(p[0], view) - kmBetween(q[0], view))
  for (const [a, x, y] of labelled.slice(0, labelsMax + labelled.filter(([a]) => first(a)).length)) {
    if (inDisc(x, y, 104)) placeLabel(g, a.flight, x, y, occupied, { fg: isEmergency(a.squawk) ? '#ffb3b3' : UI.text })
  }

  // Home
  const [hx, hy] = plotXY({ lat: cfg.lat, lon: cfg.lon })
  if (inDisc(hx, hy, 108)) {
    g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 3; g.beginPath(); g.arc(hx, hy, 4.5, 0, Math.PI * 2); g.stroke()
    g.strokeStyle = '#fff'; g.lineWidth = 1.4; g.beginPath(); g.arc(hx, hy, 4.5, 0, Math.PI * 2); g.stroke()
    g.fillStyle = UI.amber; g.beginPath(); g.arc(hx, hy, 2, 0, Math.PI * 2); g.fill()
  }

  drawBezel(g)
  drawChips(g)
  if (spot) drawSpotlight(g, spot, ov)
  return toRGB565(knobCanvas, true)
}

// Compass rose around the scope
function drawBezel(g) {
  g.fillStyle = 'rgba(3,6,9,0.84)'
  g.beginPath(); g.arc(C, C, 121, 0, Math.PI * 2); g.arc(C, C, RMAX - 1, 0, Math.PI * 2, true); g.fill('evenodd')
  g.strokeStyle = 'rgba(255,255,255,0.32)'; g.lineWidth = 1
  g.beginPath(); g.arc(C, C, RMAX - 1, 0, Math.PI * 2); g.stroke()
  for (let d = 0; d < 360; d += 10) {
    if (d % 90 === 0) continue
    const major = d % 30 === 0, a = toRad(d) - Math.PI / 2, r1 = RMAX + (major ? 5 : 2.5)
    g.strokeStyle = `rgba(255,255,255,${major ? 0.75 : 0.4})`
    g.beginPath(); g.moveTo(C + (RMAX - 1) * Math.cos(a), C + (RMAX - 1) * Math.sin(a)); g.lineTo(C + r1 * Math.cos(a), C + r1 * Math.sin(a)); g.stroke()
  }
  g.font = font(8, 700); g.textAlign = 'center'; g.textBaseline = 'middle'
  for (const [t, d] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
    const a = toRad(d) - Math.PI / 2
    g.fillStyle = d ? 'rgba(255,255,255,0.85)' : UI.green
    g.fillText(t, C + (RMAX + 4) * Math.cos(a), C + (RMAX + 4) * Math.sin(a) + 0.5)
  }
  g.textBaseline = 'alphabetic'
}

// Status chips at the top of the scope: range, then the active modes
function drawChips(g) {
  const row = (items, cy) => {
    g.font = font(9, 700)
    const ws = items.map(it => Math.ceil(g.measureText(it.text).width) + 12)
    let x = C - (ws.reduce((p, q) => p + q, 0) + 3 * (items.length - 1)) / 2
    items.forEach((it, i) => {
      g.fillStyle = UI.scrim; g.beginPath(); g.roundRect(x, cy - 7, ws[i], 14, 7); g.fill()
      g.strokeStyle = withAlpha(it.color, 0.55); g.lineWidth = 1; g.beginPath(); g.roundRect(x + 0.5, cy - 6.5, ws[i] - 1, 13, 6.5); g.stroke()
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = it.color; g.fillText(it.text, x + ws[i] / 2, cy + 0.5)
      x += ws[i] + 3
    })
    g.textBaseline = 'alphabetic'
  }
  row([{ text: `${RANGES[rangeIdx]} km`, color: UI.text }], 23)
  const modes = []
  if (selectedHex && follow) modes.push({ text: T.follow, color: UI.green })
  if (airportMode && selAirport) { const ap = airportByIcao(selAirport); modes.push({ text: ap?.iata || selAirport, color: UI.cyan }) }
  if (filterIdx) modes.push({ text: FILTERS[filterIdx].name, color: FILTERS[filterIdx].color })
  if (modes.length) row(modes, 39)
}

// Airports: runways to scale, labels, extended centrelines of the selected airport
function drawAirports(g, occupied) {
  if (!airports.length) return
  const range = RANGES[rangeIdx]
  const inUse = new Set(aircraft.map(approachOf).filter(Boolean).map(x => `${x.ap.icao}|${x.end.id}`))
  const shown = airports.filter(ap => { const [x, y] = plotXY(ap); return inDisc(x, y, 140) && (ap.icao === selAirport || ap.type === 'large_airport' || range <= 100) })
  for (const ap of shown.sort((p, q) => (p.icao === selAirport) - (q.icao === selAirport))) {
    const [x, y] = plotXY(ap), sel = ap.icao === selAirport
    if (sel) for (const e of ap.ends) { // extended centrelines; ticks and runway names when zoomed in or in use
      const [x0, y0] = plotXY(e), [x1, y1] = plotXY(offsetPt(e, e.course + 180, AP.approach_km))
      const active = inUse.has(`${ap.icao}|${e.id}`), close = range <= 25
      g.strokeStyle = withAlpha(UI.cyan, active ? 1 : close ? 0.5 : 0.3); g.lineWidth = active ? 1.6 : 1; g.setLineDash([4, 4])
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); g.setLineDash([])
      if (active || close) {
        for (let km = 5; km < AP.approach_km; km += 5) {
          const [tx, ty] = plotXY(offsetPt(e, e.course + 180, km)), n = toRad(e.course)
          g.beginPath(); g.moveTo(tx - 3 * Math.cos(n), ty - 3 * Math.sin(n)); g.lineTo(tx + 3 * Math.cos(n), ty + 3 * Math.sin(n)); g.stroke()
        }
        if (range <= 50 && inDisc(x1, y1, 100)) placeLabel(g, e.id, x1, y1, occupied, { fg: active ? '#001820' : UI.cyan, bg: active ? UI.cyan : UI.scrim, px: 8 })
      }
    }
    const col = sel ? UI.cyan : 'rgba(170,236,255,0.85)'
    if (range <= 50) { // runways to scale
      g.lineCap = 'round'
      for (const w of ap.runways) {
        const [ax, ay] = plotXY(w.a), [bx, by] = plotXY(w.b)
        g.strokeStyle = 'rgba(0,0,0,0.8)'; g.lineWidth = 5; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke()
        g.strokeStyle = col; g.lineWidth = 2.5; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke()
      }
      g.lineCap = 'butt'
    } else { // airport symbol: ring, plus the main runway direction as a bar
      const e = ap.ends[0], a = e ? toRad(e.course) : 0, r = sel ? 4.5 : 3.5
      g.strokeStyle = 'rgba(0,0,0,0.8)'; g.lineWidth = 3.5; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke()
      g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke()
      g.beginPath(); g.moveTo(x - (r + 3) * Math.sin(a), y + (r + 3) * Math.cos(a)); g.lineTo(x + (r + 3) * Math.sin(a), y - (r + 3) * Math.cos(a)); g.stroke()
    }
    if ((sel || ap.type === 'large_airport' || range <= 50) && inDisc(x, y, 104)) {
      occupied.push({ x: x - 6, y: y - 6, w: 12, h: 12 })
      placeLabel(g, ap.iata || ap.icao, x, y, occupied, { fg: sel ? '#001820' : UI.cyan, bg: sel ? UI.cyan : UI.scrim, px: sel ? 9 : 8 })
    }
  }
}

// Spotlight banner: one aircraft at a time, at the bottom of the scope
function drawSpotlight(g, a, ov) {
  const info = getInfo(a) || {}, emerg = isEmergency(a.squawk), route = routeOf(a)
  const col = emerg ? UI.red : altColor(a.alt), app = !ov && approachOf(a)
  const { x: bx, y: by, w: bw, h: bh } = SPOT
  g.fillStyle = 'rgba(4,8,12,0.86)'; g.beginPath(); g.roundRect(bx, by, bw, bh, 10); g.fill()
  g.strokeStyle = emerg ? UI.red : 'rgba(255,255,255,0.16)'; g.lineWidth = 1; g.beginPath(); g.roundRect(bx + 0.5, by + 0.5, bw - 1, bh - 1, 9.5); g.stroke()
  g.fillStyle = col; g.beginPath(); g.roundRect(bx + 7, by + 7, 3, bh - 14, 1.5); g.fill()
  const left = bx + 16, right = bx + bw - 10
  // line 1: callsign + flight level
  const fl = a.ground ? T.ground : a.alt != null ? `FL${String(Math.round(a.alt / 100)).padStart(3, '0')}` : ''
  const flw = txt(g, fl, right, by + 15, { px: 10, weight: 700, color: col, align: 'right' })
  txt(g, a.flight || a.hex.toUpperCase(), left, by + 15, { px: 12, weight: 700, max: right - left - flw - 6 })
  // line 2: what matters most right now
  const second = ov ? [T.overflight(ov.t < 1 ? '<1' : Math.round(ov.t)), UI.amber, T.at(ov.d.toFixed(1))]
    : app ? [`ILS ${app.end.id} ${app.ap.iata || app.ap.icao}`, UI.cyan, `${app.along.toFixed(1)} km`]
    : [route ? `${route.from.iata} › ${route.to.iata}` : (info.aircraft?.type || `${Math.round(kmBetween(a, view))} km`), UI.sub, isMilitary(a) ? T.mil : countryOf(a)]
  const rw = txt(g, second[2], right, by + 28, { px: 9, weight: 700, color: ov || app ? second[1] : UI.mute, align: 'right' })
  txt(g, second[0], left, by + 28, { px: 10, weight: ov || app ? 700 : 600, color: second[1], max: right - left - rw - 6 })
  if (a.hex !== selectedHex) wantInfo(a, true)
}

// ---------- Centre screen: 12 tiles of 90x90 aligned with the physical key grid ----------
const centerCanvas = createCanvas(360, 270)
const TILE = 90, PAD = 4, TW = TILE - 2 * PAD
let tileHexes = []    // aircraft shown on each tile
let tileAirports = [] // airport shown on each tile (picker)

function panel(g, i, { fill = UI.panel, border = UI.line, bw = 1, accent } = {}) {
  const x = (i % 4) * TILE + PAD, y = Math.floor(i / 4) * TILE + PAD
  g.save(); g.beginPath(); g.roundRect(x, y, TW, TW, 8); g.clip()
  g.fillStyle = fill; g.fillRect(x, y, TW, TW)
  if (accent) { g.fillStyle = accent; g.fillRect(x, y, 4, TW) }
  g.restore()
  g.strokeStyle = border; g.lineWidth = bw; g.beginPath(); g.roundRect(x + bw / 2, y + bw / 2, TW - bw, TW - bw, 8 - bw / 2); g.stroke()
  return { x, y, l: x + (accent ? 11 : 9), r: x + TW - 7, cx: x + TW / 2 }
}
const flText = a => a.ground ? T.ground : a.alt != null ? String(Math.round(a.alt / 100)).padStart(3, '0') : '---'
const fmtKm = d => `${d < 10 ? d.toFixed(1) : Math.round(d)} km`

function drawAircraftTile(g, i, a, refPoint) {
  const emerg = isEmergency(a.squawk), col = altColor(a.alt), app = approachOf(a), info = getInfo(a), route = routeOf(a)
  const b = panel(g, i, { accent: emerg ? UI.red : col, fill: emerg ? UI.panelWarn : UI.panel, border: emerg ? UI.red : UI.line, bw: emerg ? 2 : 1 })
  txt(g, a.flight || a.hex.toUpperCase(), b.l, b.y + 20, { px: 14, weight: 700, max: b.r - b.l })
  // flight level, vertical trend, heading
  let x = b.l
  if (!a.ground && a.alt != null) x += txt(g, 'FL', x, b.y + 43, { px: 8, weight: 700, color: UI.mute }) + 2
  x += txt(g, flText(a), x, b.y + 43, { px: 19, weight: 700, color: col }) + 5
  if (Math.abs(a.vrate ?? 0) > 300) { // climbing / descending
    const up = a.vrate > 0, ty = b.y + 36
    g.fillStyle = col; g.beginPath()
    if (up) { g.moveTo(x, ty + 4); g.lineTo(x + 4, ty - 3); g.lineTo(x + 8, ty + 4) } else { g.moveTo(x, ty - 3); g.lineTo(x + 4, ty + 4); g.lineTo(x + 8, ty - 3) }
    g.closePath(); g.fill()
  }
  // what it is doing: distress, approach, route or type
  if (emerg) pill(g, `SQK ${a.squawk}`, b.l, b.y + 59, { fg: '#fff', bg: UI.red })
  else if (app) pill(g, `ILS ${app.end.id} ${app.ap.iata || app.ap.icao}`, b.l, b.y + 59, { fg: UI.cyan, bg: '#0a3440' })
  else if (route) txt(g, `${route.from.iata} › ${route.to.iata}`, b.l, b.y + 59, { px: 12, weight: 600, color: '#d5e0e8', max: b.r - b.l })
  else if (info?.aircraft?.type) txt(g, info.aircraft.type, b.l, b.y + 59, { px: 11, weight: 600, color: UI.mute })
  // distance, country
  const ref = refPoint ? kmBetween(a, refPoint) : a.d
  txt(g, fmtKm(ref), b.l, b.y + 75, { px: 10, weight: 600, color: UI.sub })
  const mil = isMilitary(a)
  txt(g, mil ? T.mil : countryOf(a), b.r - 12, b.y + 75, { px: 9, weight: 700, color: mil ? '#8fe05a' : UI.mute, align: 'right' })
  glyph(g, { track: a.track, category: 'A3' }, b.r - 4, b.y + 71, { color: UI.sub, outline: null, scale: 0.6 })
}

function drawInfoTile(g, i, label, value, { color = UI.text, sub = '', sub2 = '', px = 21, fill, border } = {}) {
  const b = panel(g, i, { fill, border })
  txt(g, label, b.l, b.y + 16, { px: 9, weight: 700, color: UI.mute, max: b.r - b.l })
  txt(g, value, b.l, b.y + 43, { px, weight: 700, color, max: b.r - b.l })
  if (sub) txt(g, sub, b.l, b.y + 59, { px: 10, weight: 600, color: UI.sub, max: b.r - b.l })
  if (sub2) txt(g, sub2, b.l, b.y + 73, { px: 9, weight: 600, color: UI.mute, max: b.r - b.l })
  return b
}

// Navigation tile with a drawn icon (no font glyph dependency)
function drawNavTile(g, i, icon, label, { color = UI.sub, sub = '' } = {}) {
  const b = panel(g, i, { fill: '#080c10' })
  const cx = b.cx, cy = b.y + 33
  g.strokeStyle = color; g.lineWidth = 2.4; g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath()
  if (icon === 'back') { g.moveTo(cx + 5, cy - 9); g.lineTo(cx - 5, cy); g.lineTo(cx + 5, cy + 9) }
  else if (icon === 'next') { g.moveTo(cx - 5, cy - 9); g.lineTo(cx + 5, cy); g.lineTo(cx - 5, cy + 9) }
  else { g.moveTo(cx - 7, cy - 7); g.lineTo(cx + 7, cy + 7); g.moveTo(cx + 7, cy - 7); g.lineTo(cx - 7, cy + 7) }
  g.stroke(); g.lineCap = 'butt'
  txt(g, label, cx, b.y + 61, { px: 11, weight: 700, color, align: 'center', max: TW - 12 })
  if (sub) txt(g, sub, cx, b.y + 74, { px: 9, weight: 600, color: UI.mute, align: 'center' })
}

// Heading dial
function drawHeadingTile(g, i, a) {
  const b = panel(g, i)
  txt(g, T.hdg, b.l, b.y + 16, { px: 9, weight: 700, color: UI.mute })
  const cx = b.cx, cy = b.y + 50, r = 23
  g.strokeStyle = '#2c3a45'; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke()
  for (let d = 0; d < 360; d += 30) {
    const t = toRad(d) - Math.PI / 2, r0 = r - (d % 90 ? 3 : 5)
    g.strokeStyle = d ? '#52626e' : UI.green; g.lineWidth = d % 90 ? 1 : 1.6
    g.beginPath(); g.moveTo(cx + r0 * Math.cos(t), cy + r0 * Math.sin(t)); g.lineTo(cx + r * Math.cos(t), cy + r * Math.sin(t)); g.stroke()
  }
  if (a.track == null) { txt(g, '?', cx, cy + 5, { px: 14, weight: 700, align: 'center' }); return }
  g.save(); g.translate(cx, cy); g.rotate(toRad(a.track))
  g.fillStyle = UI.text; g.beginPath(); g.moveTo(0, -r - 4); g.lineTo(4.5, -r + 4); g.lineTo(-4.5, -r + 4); g.closePath(); g.fill()
  g.restore()
  txt(g, `${Math.round(a.track)}°`, cx + 1, cy + 5, { px: 14, weight: 700, align: 'center' })
}

// Cockpit-style deviation indicator: magenta needles, 2 dots = full scale (LOC 2.5°, GS 0.7°)
function drawIlsTile(g, i, app) {
  const b = panel(g, i, { border: withAlpha(UI.cyan, 0.5) })
  txt(g, 'LOC', b.l, b.y + 15, { px: 8, weight: 700, color: UI.mute })
  txt(g, 'GS', b.r, b.y + 15, { px: 8, weight: 700, color: UI.mute, align: 'right' })
  const cx = b.cx, cy = b.y + 47, dot = 13
  g.strokeStyle = '#8fa0ad'; g.lineWidth = 1
  for (let k = -2; k <= 2; k++) {
    if (!k) continue
    g.beginPath(); g.arc(cx + k * dot, cy, 2.2, 0, Math.PI * 2); g.stroke()
    g.beginPath(); g.arc(cx, cy + k * dot, 2.2, 0, Math.PI * 2); g.stroke()
  }
  g.fillStyle = UI.amber; g.fillRect(cx - 7, cy - 1, 14, 2); g.fillRect(cx - 1, cy - 6, 2, 12) // aircraft symbol
  const clamp = v => Math.max(-2.3, Math.min(2.3, v))
  const lx = cx - clamp(app.locDev / 1.25) * dot // aircraft right of the centreline -> needle left (fly left)
  const gy = cy + clamp(app.gsDev / 0.35) * dot  // aircraft above the glide path -> needle down (fly down)
  g.strokeStyle = UI.magenta; g.lineWidth = 2.5; g.lineCap = 'round'
  g.beginPath(); g.moveTo(lx, cy - 2.3 * dot); g.lineTo(lx, cy + 2.3 * dot); g.stroke()
  g.beginPath(); g.moveTo(cx - 2.3 * dot, gy); g.lineTo(cx + 2.3 * dot, gy); g.stroke()
  g.lineCap = 'butt'
}

function drawDetail(g, sel) {
  const info = getInfo(sel) || {}, emerg = isEmergency(sel.squawk)
  const col = altColor(sel.alt), r = routeOf(sel), al = info.airline, ac = info.aircraft
  // identity
  const b = panel(g, 0, { accent: emerg ? UI.red : col, fill: emerg ? UI.panelWarn : UI.panel, border: emerg ? UI.red : UI.line, bw: emerg ? 2 : 1 })
  txt(g, sel.flight || sel.hex.toUpperCase(), b.l, b.y + 23, { px: 16, weight: 700, max: b.r - b.l })
  txt(g, al?.name || ac?.owner || '', b.l, b.y + 38, { px: 10, weight: 600, color: UI.sub, max: b.r - b.l })
  let cx = b.l
  const iso = countryOf(sel)
  if (iso) cx += pill(g, iso, cx, b.y + 57, { fg: UI.sub }) + 3
  if (isMilitary(sel)) cx += pill(g, T.mil, cx, b.y + 57, { fg: '#b8f58a', bg: '#1f3a12' }) + 3
  if (emerg) pill(g, sel.squawk, cx, b.y + 57, { fg: '#fff', bg: UI.red })
  txt(g, sel.hex.toUpperCase(), b.l, b.y + 74, { px: 9, weight: 600, color: UI.mute })

  drawInfoTile(g, 1, T.from, r ? r.from.iata : '–', { color: r ? UI.text : UI.mute, sub: r ? r.from.city : T.unknown, sub2: r?.from.obs ? (r.from.iata === '?' ? '' : T.seen) : r?.from.iso })
  drawInfoTile(g, 2, T.to, r ? r.to.iata : '–', { color: r ? UI.text : UI.mute, sub: r ? r.to.city : T.unknown, sub2: r?.to.obs ? (r.to.iata === '?' ? '' : T.seen) : r?.to.iso })
  drawInfoTile(g, 3, T.type, ac?.type || '–', { color: ac?.type ? UI.text : UI.mute, sub: ac?.reg, sub2: ac?.model && ac.model !== ac.type ? ac.model : '' })
  drawInfoTile(g, 4, T.alt, sel.ground ? T.ground : sel.alt != null ? sel.alt.toLocaleString(T.locale) : '–', { color: col, sub: 'ft', sub2: sel.alt != null ? `${Math.round(sel.alt * 0.3048).toLocaleString(T.locale)} m` : '' })
  drawInfoTile(g, 5, T.spd, sel.speed != null ? String(Math.round(sel.speed * 1.852)) : '–', { sub: 'km/h', sub2: sel.speed != null ? `${Math.round(sel.speed)} kt` : '' })
  const vr = sel.vrate
  drawInfoTile(g, 6, T.vs, vr != null ? `${vr > 0 ? '+' : ''}${vr.toLocaleString(T.locale)}` : '–', { color: vr > 300 ? UI.green : vr < -300 ? UI.amber : UI.text, sub: 'ft/min', px: 19 })
  drawHeadingTile(g, 7, sel)
  const app = approachOf(sel)
  if (app) { // ILS-like approach: deviation indicator, runway, time to touchdown
    drawIlsTile(g, 8, app)
    drawInfoTile(g, 9, `ILS ${app.ap.iata || app.ap.icao}`, app.end.id, { color: UI.cyan, sub: `${app.along.toFixed(1)} km`, border: withAlpha(UI.cyan, 0.5) })
    drawInfoTile(g, 10, T.eta, app.eta < 1 ? '<1 min' : `${Math.round(app.eta)} min`, { sub: `${T.slope} ${app.glide.toFixed(1)}°`, px: 19, border: withAlpha(UI.cyan, 0.5) })
  } else {
    drawInfoTile(g, 8, T.dist, sel.d.toFixed(1), { sub: 'km', sub2: T.brgAt(Math.round(sel.brg)) })
    drawInfoTile(g, 9, T.squawk, sel.squawk || '––––', { color: emerg ? UI.red : UI.text })
    drawInfoTile(g, 10, T.airline, al?.iata || al?.name || '–', { color: al ? UI.text : UI.mute, sub: al?.iata ? al.name : '', sub2: al?.iso })
  }
  drawNavTile(g, 11, 'back', T.back, { color: UI.green })
}

// Airports
// Per airport: aircraft on final / arriving / departing, and which one lands next
function airportStats() {
  const m = new Map()
  for (const a of aircraft) {
    const l = airportLink(a); if (!l) continue
    const e = m.get(l.ap.icao) || { n: 0, app: 0, arr: 0, dep: 0, next: null }
    e.n++; e[l.kind]++
    if (l.kind === 'app') { const p = approachOf(a); if (!e.next || p.eta < e.next.eta) e.next = { name: a.flight || a.hex.toUpperCase(), eta: p.eta } }
    m.set(l.ap.icao, e)
  }
  return m
}
const runwayNames = ap => ap.runways.map(w => `${w.a.id}/${w.b.id}`).join('  ')
function drawBearing(g, x, y, brg, color) { glyph(g, { track: brg, category: 'A1' }, x, y, { color, outline: null, scale: 0.75 }) }

function drawAirportTile(g, i, ap, st) {
  const sel = ap.icao === selAirport, big = ap.type === 'large_airport'
  const b = panel(g, i, { fill: sel ? UI.panelSel : UI.panel, border: sel ? UI.cyan : UI.line, bw: sel ? 2 : 1 })
  // traffic badge: filled when an aircraft is on final, outlined for arrivals / departures only
  const nw = st ? pill(g, String(st.n), b.r, b.y + 21, { align: 'right', fg: st.app ? '#001820' : UI.cyan, bg: st.app ? UI.cyan : '#0a3440', px: 10, padX: 5, h: 15 }) + 4 : 0
  txt(g, ap.iata || ap.icao, b.l, b.y + 25, { px: 19, weight: 700, color: sel ? UI.cyan : big ? UI.text : '#c3ced6', max: b.r - b.l - nw })
  txt(g, ap.city || ap.name, b.l, b.y + 41, { px: 10, weight: 600, color: UI.sub, max: b.r - b.l })
  if (st?.next) { // next landing: callsign and time to touchdown
    const ew = txt(g, st.next.eta < 1 ? '<1 min' : `${Math.round(st.next.eta)} min`, b.r, b.y + 57, { px: 9, weight: 700, color: UI.text, align: 'right' })
    txt(g, st.next.name, b.l, b.y + 57, { px: 10, weight: 700, color: UI.cyan, max: b.r - b.l - ew - 4 })
  } else if (st) { // arrivals (down) and departures (up)
    let x = b.l
    for (const [n, up] of [[st.arr, false], [st.dep, true]]) {
      if (!n) continue
      const ty = b.y + 53
      g.fillStyle = UI.cyan; g.beginPath()
      if (up) { g.moveTo(x, ty + 3); g.lineTo(x + 4, ty - 4); g.lineTo(x + 8, ty + 3) } else { g.moveTo(x, ty - 4); g.lineTo(x + 4, ty + 3); g.lineTo(x + 8, ty - 4) }
      g.closePath(); g.fill()
      x += 11 + txt(g, String(n), x + 11, b.y + 57, { px: 10, weight: 700, color: UI.text }) + 8
    }
  } else txt(g, runwayNames(ap), b.l, b.y + 56, { px: 9, weight: 600, color: UI.mute, max: b.r - b.l })
  txt(g, fmtKm(ap.homeKm), b.l, b.y + 75, { px: 10, weight: 600, color: UI.sub })
  drawBearing(g, b.r - 5, b.y + 71, ap.homeBrg, UI.sub)
}

const PICK = 10 // airports per picker page
const pickerPages = () => Math.max(1, Math.ceil(airports.length / PICK))
function drawPicker(g) {
  const counts = airportStats()
  airports.slice(pickerPage * PICK, pickerPage * PICK + PICK).forEach((ap, k) => { tileAirports[k] = ap.icao; drawAirportTile(g, k, ap, counts.get(ap.icao)) })
  drawNavTile(g, 10, 'close', T.close)
  drawNavTile(g, 11, 'next', T.next, { color: UI.cyan, sub: `${pickerPage + 1} / ${pickerPages()}` })
}

// Airport mode: the first tile is the airport itself (tap it to pick another one)
function drawAirportHeader(g, i, ap, traffic) {
  const active = [...new Set(aircraft.map(approachOf).filter(p => p?.ap === ap).map(p => p.end.id))]
  const b = panel(g, i, { fill: UI.panelSel, border: UI.cyan, bw: 2 })
  txt(g, ap.iata || ap.icao, b.l, b.y + 25, { px: 19, weight: 700, color: UI.cyan })
  txt(g, ap.city || ap.name, b.l, b.y + 41, { px: 10, weight: 600, color: UI.sub, max: b.r - b.l })
  txt(g, active.length ? `${T.rwy} ${active.join(' ')}` : runwayNames(ap), b.l, b.y + 58, { px: active.length ? 11 : 9, weight: 700, color: active.length ? UI.text : UI.mute, max: b.r - b.l })
  txt(g, T.traffic(traffic), b.l, b.y + 75, { px: 9, weight: 600, color: UI.mute })
  g.strokeStyle = UI.cyan; g.lineWidth = 1.8; g.lineCap = 'round'; g.beginPath(); g.moveTo(b.r - 9, b.y + 69); g.lineTo(b.r - 5, b.y + 73); g.lineTo(b.r - 1, b.y + 69); g.stroke(); g.lineCap = 'butt'
}

const currentList = () => airportMode ? airportTraffic() : visible()
function drawList(g) {
  const list = currentList(), ap = airportMode && airportByIcao(selAirport), first = ap ? 1 : 0
  if (ap) drawAirportHeader(g, 0, ap, list.length)
  list.slice(0, 12 - first).forEach((a, k) => { tileHexes[k + first] = a.hex; drawAircraftTile(g, k + first, a, ap) })
  if (!list.length) wrapText(g, ap ? T.noTraffic : T.noAircraft(RANGES[rangeIdx]), first * TILE + TILE / 2, 36, TW - 10, 14, { px: 11, weight: 600, color: UI.mute })
}

function drawCenter() {
  const g = centerCanvas.getContext('2d')
  g.fillStyle = '#000'; g.fillRect(0, 0, 360, 270)
  tileHexes = []; tileAirports = []
  const sel = aircraft.find(a => a.hex === selectedHex)
  if (picker) drawPicker(g)
  else if (sel) drawDetail(g, sel)
  else drawList(g)
  return toRGB565(centerCanvas, false)
}

// ---------- Side strips 60x270 (one 90 px cell per knob): label, value, level bar ----------
const sideCanvas = createCanvas(60, 270)
function drawSide(cells) {
  const g = sideCanvas.getContext('2d')
  g.fillStyle = '#000'; g.fillRect(0, 0, 60, 270)
  cells.forEach(([label, value, color = UI.text, level], i) => {
    const y = i * 90
    txt(g, label, 30, y + 32, { px: 8, weight: 700, color: UI.mute, align: 'center', max: 56 })
    txt(g, value, 30, y + 51, { px: 13, weight: 700, color, align: 'center', max: 56 })
    if (level != null) {
      g.fillStyle = '#1a242d'; g.beginPath(); g.roundRect(12, y + 59, 36, 3, 1.5); g.fill()
      if (level > 0) { g.fillStyle = color; g.beginPath(); g.roundRect(12, y + 59, Math.max(3, 36 * Math.min(1, level)), 3, 1.5); g.fill() }
    }
  })
  return toRGB565(sideCanvas, false)
}
function leftCells() {
  return [
    [T.altMin, minAltFt ? `${minAltFt / 1000}k ft` : T.none, minAltFt ? UI.amber : UI.sub, minAltFt / 40000],
    [T.filter, FILTERS[filterIdx].name, FILTERS[filterIdx].color, FILTERS.length > 1 ? filterIdx / (FILTERS.length - 1) : 0],
    [T.bright, `${Math.round(brightness * 100)}%`, UI.text, brightness],
  ]
}
function rightCells() {
  return [
    [T.labels, String(labelsMax), UI.text, labelsMax / 20],
    [T.trails, trailMin ? `${trailMin} min` : 'off', trailMin ? UI.green : UI.sub, trailMin / 15],
    [T.map, `${Math.round(mapBright * 100)}%`, UI.text, mapBright],
  ]
}

// ---------- Alerts ----------
// Emergency (red), low military nearby (orange), low aircraft overhead / imminent overflight (yellow)
const A = Object.assign({ radius_km: 10, below_ft: 5000, military_radius_km: 30, military_below_ft: 10000, emergency: true, ha_notify: '' }, cfg.alert || {})
function classify(a) {
  if (A.emergency && isEmergency(a.squawk)) return ['emerg', `EMERGENCY squawk ${a.squawk}`]
  if (isMilitary(a) && a.d < A.military_radius_km && a.alt != null && a.alt < A.military_below_ft) return ['warn', 'low military']
  if (a.d < A.radius_km && a.alt != null && !a.ground && a.alt < A.below_ft) return ['info', 'low aircraft']
  const o = overflight(a)
  if (o && o.t <= OV.alert_min) return ['info', `overhead in ${Math.max(1, Math.round(o.t))} min at ${o.d.toFixed(1)} km`]
  return null
}
let ackUntil = 0
function checkAlert() {
  if (!device) return
  const rank = { info: 1, warn: 2, emerg: 3 }
  let best = null
  for (const a of aircraft) { const c = classify(a); if (c && (!best || rank[c[0]] > rank[best.c[0]])) best = { a, c } }
  alertLevel = best && Date.now() > ackUntil ? best.c[0] : null
  if (best && Date.now() - (alerted.get(best.a.hex) || 0) > 10 * 60000) {
    alerted.set(best.a.hex, Date.now())
    const a = best.a, msg = `${a.flight || a.hex.toUpperCase()} : ${best.c[1]}, ${a.alt ?? '?'} ft, ${a.d.toFixed(1)} km`
    console.log('Alert:', msg)
    if (best.c[0] !== 'info') { selectedHex = a.hex; picker = false; refreshCenterNow() }
    safe(() => device.vibrate(best.c[0] === 'emerg' ? 0x77 : best.c[0] === 'warn' ? 0x0a : 0x01))
    if (A.ha_notify && cfg.ha_url && cfg.ha_token && best.c[0] !== 'info') notifyHA(msg)
  }
}
async function notifyHA(msg) {
  try {
    const [domain, service] = A.ha_notify.split('.')
    await fetch(`${cfg.ha_url.replace(/\/$/, '')}/api/services/${domain}/${service}`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.ha_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Loupedeck radar', message: msg }), signal: AbortSignal.timeout(5000) })
  } catch (e) { console.error('Home Assistant notification:', e.message) }
}

// LEDs: button 1 = night mode, 2 = airport picker, 3 = airport mode, 8 = alert (blinking)
let blink = false
const lastLeds = []
function updateLeds() {
  const cols = Array(7).fill('#000000') // buttons 4 to 7 are free
  if (night) cols[0] = '#400000'
  if (airports.length) cols[1] = picker ? '#00c0ff' : '#003040'
  if (airportMode) cols[2] = '#00c0ff'
  const alertCol = { emerg: '#ff0000', warn: '#ff6a00', info: '#ffd000' }[alertLevel]
  cols.push(alertCol ? (blink || alertLevel === 'info' ? alertCol : '#000000') : '#000000')
  cols.forEach((color, id) => { if (lastLeds[id] !== color) { lastLeds[id] = color; safe(() => device.setButtonColor({ id, color })) } })
}

// ---------- Rendering ----------
// The wheel screen drops frames when flooded, so it is redrawn at most every INPUT_MS after an input
// (and once per tick otherwise). The touch panel and side strips answer inputs immediately.
const INPUT_MS = cfg.input_refresh_ms ?? 500
const SWEEP_DPS = (cfg.sweep_deg_per_frame ?? 30) * (cfg.fps ?? 1)
const withTimeout = (p, what) => {
  let timer
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`screen timeout: ${what}`)), 3000) })]).finally(() => clearTimeout(timer))
}
const lastSig = { center: '', left: '', right: '' }
let lastCenterAt = 0, lastWheelAt = 0, forceCenter = false, pending = false, wheelDue = false
function centerSig() {
  if (picker) return JSON.stringify(['P', pickerPage, selAirport, [...airportStats()].map(([k, v]) => [k, v.app, v.arr, v.dep, v.next?.name, Math.round(v.next?.eta ?? 0)])])
  const sel = aircraft.find(a => a.hex === selectedHex)
  if (sel) {
    const app = approachOf(sel) // on approach the needles move, so their position is part of the signature
    return JSON.stringify([sel.hex, getInfo(sel)?.at, app && [app.end.id, Math.round(app.locDev * 20), Math.round(app.gsDev * 20), Math.round(app.along * 10)], sel.alt, sel.speed, sel.vrate, Math.round(sel.d * 10), sel.track, sel.squawk])
  }
  return JSON.stringify([airportMode, selAirport, rangeIdx, minAltFt, filterIdx, currentList().slice(0, 12).map(a => [a.hex, routeOf(a)?.from.iata, routeOf(a)?.to.iata, countryOf(a), approachOf(a)?.end.id, Math.round((a.alt ?? 0) / 100), Math.round(a.d), a.track, Math.sign(Math.round((a.vrate ?? 0) / 300)), a.squawk])])
}
async function render({ wheel = true } = {}) {
  if (!device || busy) return
  busy = true
  try {
    updateFollow()
    const ls = JSON.stringify(leftCells())
    if (ls !== lastSig.left) { lastSig.left = ls; await withTimeout(device.drawBuffer({ id: 'left', width: 60, height: 270 }, drawSide(leftCells())), 'left') }
    const rs = JSON.stringify(rightCells())
    if (rs !== lastSig.right) { lastSig.right = rs; await withTimeout(device.drawBuffer({ id: 'right', width: 60, height: 270 }, drawSide(rightCells())), 'right') }
    const sig = centerSig()
    const selApp = selectedHex && !picker && approachOf(aircraft.find(a => a.hex === selectedHex) || {})
    const minGap = selApp ? Math.min(900, cfg.center_min_ms ?? 1500) : (cfg.center_min_ms ?? 1500) // an approach card follows every position update
    if (forceCenter || (sig !== lastSig.center && Date.now() - lastCenterAt > minGap)) {
      forceCenter = false; lastSig.center = sig; lastCenterAt = Date.now()
      await withTimeout(device.drawBuffer({ id: 'center', width: 360, height: 270 }, drawCenter()), 'centre')
    }
    if (wheel) {
      blink = !blink; sweep = (Date.now() / 1000 * SWEEP_DPS) % 360
      wheelDue = false; lastWheelAt = Date.now()
      await withTimeout(device.drawBuffer({ id: 'knob', width: 240, height: 240 }, drawRadar()), 'wheel')
    }
    updateLeds()
    if (!render.first) { render.first = true; console.log('First frames sent') }
  } catch (e) {
    console.error('Render:', e.message)
  } finally { busy = false }
}
// Ask for a redraw after an input: the touch panel right away, the wheel as soon as it may be redrawn
function refreshCenterNow() { forceCenter = true; pending = true }
function inputLoop() {
  if (busy) return
  const wheelOk = Date.now() - lastWheelAt >= INPUT_MS
  if (pending) { pending = false; if (!wheelOk) wheelDue = true; render({ wheel: wheelOk }) }
  else if (wheelDue && wheelOk) render({ wheel: true })
}

// ---------- Interaction ----------
function selectNearestTo(x, y) {
  let best = null, bd = 1e9
  for (const a of visible()) {
    const [px, py] = plotXY(a), d = (px - x) ** 2 + (py - y) ** 2
    if (d < bd) { bd = d; best = a }
  }
  let bestAp = null, bdAp = 1e9
  for (const ap of airports) { const [px, py] = plotXY(ap), d = (px - x) ** 2 + (py - y) ** 2; if (d < bdAp) { bdAp = d; bestAp = ap } }
  if (bestAp && bdAp < 20 ** 2 && bdAp < bd) selAirport = bestAp.icao // a tap on an airport selects it
  else selectedHex = best && bd < 30 ** 2 ? best.hex : null
  refreshCenterNow()
}
function cycleSelection() {
  const list = currentList()
  const i = list.findIndex(a => a.hex === selectedHex)
  selectedHex = !list.length || i + 1 >= list.length ? null : list[i + 1].hex
  refreshCenterNow()
}
function setAirportMode(on) {
  const ap = airportByIcao(selAirport)
  airportMode = on && !!ap
  selectedHex = null; lastSelected = null; follow = false
  if (airportMode) { view = { lat: ap.lat, lon: ap.lon }; rangeIdx = Math.max(0, RANGES.indexOf(cfg.airports?.mode_range_km ?? 25)) }
  else view = { lat: cfg.lat, lon: cfg.lon }
  refreshCenterNow()
}
function togglePicker(open = !picker) {
  picker = open && airports.length > 0
  if (picker) {
    selectedHex = null; lastSelected = null
    const i = airports.findIndex(a => a.icao === selAirport)
    pickerPage = i < 0 ? 0 : Math.floor(i / PICK)
  }
  refreshCenterNow()
}
function pickAirport(icao) {
  selAirport = icao; picker = false
  console.log('Airport:', icao)
  setAirportMode(true)
}

// ---------- Main ----------
async function main() {
  console.log('Looking for the Loupedeck CT... (the Loupedeck / Logi software must be closed)')
  device = await discover({ autoConnect: false })
  console.log('Device found:', device.type)
  device.on('connect', ({ address }) => console.log('Connected:', address))
  device.on('disconnect', e => console.log('Disconnected', e?.message || ''))
  await Promise.race([device.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('cannot connect to the CT: COM port busy? Unplug/replug the CT and try again')), 10000))])
  try { await device.setBrightness(1); console.log('Brightness: 100%') } catch (e) { console.log('setBrightness :', e.message) }
  try { console.log('Device info:', JSON.stringify(await device.getInfo())) } catch (e) { console.log('getInfo :', e.message) }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  device.on('rotate', ({ id, delta }) => {
    if (id === 'knobCT') { if (picker) pickerPage = clamp(pickerPage + delta, 0, pickerPages() - 1); else rangeIdx = clamp(rangeIdx + delta, 0, RANGES.length - 1) }
    else if (id === 'knobTL') minAltFt = clamp(minAltFt + delta * 1000, 0, 40000)
    else if (id === 'knobCL') filterIdx = (filterIdx + delta + FILTERS.length) % FILTERS.length
    else if (id === 'knobBL') { brightness = clamp(brightness + delta * 0.1, 0.1, 1); safe(() => device.setBrightness(brightness)) }
    else if (id === 'knobTR') labelsMax = clamp(labelsMax + delta, 0, 20)
    else if (id === 'knobCR') trailMin = clamp(trailMin + delta, 0, 15)
    else if (id === 'knobBR') mapBright = Math.round(clamp(mapBright + delta * 0.05, 0.1, 1) * 100) / 100
    refreshCenterNow()
  })
  const pan = (dx, dy) => { // dx, dy in thirds of the current range
    const km = RANGES[rangeIdx] / 3
    follow = false
    view = { lat: view.lat - dy * km / 111.32, lon: view.lon + dx * km / (111.32 * Math.cos(toRad(view.lat))) }
  }
  device.on('down', ({ id }) => {
    if (id === 0) { // button 1: night mode
      night = !night
      if (night) { dayBrightness = brightness; brightness = cfg.night_brightness ?? 0.3 } else brightness = dayBrightness
      safe(() => device.setBrightness(brightness))
      lastSig.center = lastSig.left = lastSig.right = ''
    }
    else if (id === 1) togglePicker()                 // button 2: airport picker
    else if (id === 2) { picker = false; setAirportMode(!airportMode) } // button 3: airport mode
    else if (id === 7) { ackUntil = Date.now() + 5 * 60000; alertLevel = null } // button 8: acknowledge alerts for 5 min
    else if (id === 'knobCT') { if (picker) togglePicker(false); else cycleSelection() }
    else if (id === 'knobTL') minAltFt = 0
    else if (id === 'knobCL') filterIdx = 0
    else if (id === 'knobTR') labelsMax = cfg.labels_max ?? 6
    else if (id === 'knobCR') trailMin = trailMin ? 0 : (cfg.trail_minutes ?? 3)
    else if (id === 'knobBR') mapBright = cfg.map?.brightness ?? 0.75
    else if (id === 'a') pan(0, -1)
    else if (id === 'b') pan(0, 1)
    else if (id === 'c') pan(-1, 0)
    else if (id === 'd') pan(1, 0)
    else if (id === 'e' || id === 'home') { picker = false; selAirport = defaultAirport; setAirportMode(false) } // back to home
    refreshCenterNow()
  })
  device.on('touchstart', ({ changedTouches }) => {
    const t = changedTouches[0]
    if (cfg.debug) console.log('touch', JSON.stringify({ x: t.x, y: t.y, target: t.target }))
    if (t.target?.screen === 'knob') selectNearestTo(t.x, t.y)
    else if (t.target?.screen === 'center') {
      const k = t.target.key
      if (picker) {
        if (k === 10) togglePicker(false)
        else if (k === 11) pickerPage = (pickerPage + 1) % pickerPages()
        else if (tileAirports[k]) pickAirport(tileAirports[k])
      }
      else if (selectedHex) { if (k === 11) selectedHex = null }
      else if (airportMode && k === 0) togglePicker(true)
      else if (tileHexes[k]) selectedHex = tileHexes[k]
      refreshCenterNow()
    }
  })

  buildAllMaps()
  await loadAirports().catch(e => console.error('Airports:', e.message))
  await poll()
  setInterval(poll, cfg.poll_ms)
  setInterval(() => render({ wheel: Date.now() - lastWheelAt >= INPUT_MS * 0.8 }), 1000 / (cfg.fps ?? 1))
  setInterval(inputLoop, 60)
  const MB = n => Math.round(n / 1048576)
  setInterval(() => global.gc?.(), 60000) // with --expose-gc: release the per-frame pixel buffers promptly
  setInterval(() => { // housekeeping + memory report every 10 minutes
    pruneInfo()
    for (const [hex, t] of alerted) if (Date.now() - t > 3600000) alerted.delete(hex)
    const m = process.memoryUsage()
    console.log(`Memory: ${MB(m.rss)} MB (heap ${MB(m.heapUsed)}, buffers ${MB(m.external)}, tiles ${memTiles.size}, trails ${trails.size}) at ${new Date().toTimeString().slice(0, 5)}`)
  }, 600000)
  console.log('Radar running. Ctrl+C to quit.')
}

process.on('SIGINT', async () => { try { await device?.close() } catch {} process.exit(0) })
if (DEMO) import('./tools/render-screenshots.js').then(async m => {
  await loadAirports().catch(e => console.error('Airports:', e.message))
  return m.render({ setAircraft: list => { aircraft = list }, setState, drawRadar, drawCenter, drawSide, leftCells, rightCells, knobCanvas, centerCanvas, sideCanvas, drawMap, infoCache, trails, cfg, toRad, offsetPt, getAirports: () => airports })
})
else main().catch(e => { console.error('Error:', e.message); process.exit(1) })

// State setter used by the screenshot tool
function setState(st) {
  if ('selectedHex' in st) { selectedHex = st.selectedHex; lastSelected = st.selectedHex; follow = st.follow ?? true }
  for (const [k, set] of Object.entries({
    rangeIdx: v => { rangeIdx = v }, filterIdx: v => { filterIdx = v }, labelsMax: v => { labelsMax = v }, sweep: v => { sweep = v },
    spotIdx: v => { spotIdx = v; spotAt = Date.now() }, blink: v => { blink = v }, view: v => { view = v }, selAirport: v => { selAirport = v },
    airportMode: v => { airportMode = v }, picker: v => { picker = v }, pickerPage: v => { pickerPage = v }, minAltFt: v => { minAltFt = v },
  })) if (k in st) set(st[k])
}
