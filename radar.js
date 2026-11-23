// Loupedeck CT ADS-B radar
// Turns a Loupedeck CT into a live aircraft radar fed by a tar1090 / dump1090 receiver.
//   Wheel screen  : radar scope over a satellite map (compass rose, trails, spotlight banner, runway centrelines)
//   Centre screen : 12 tiles aligned with the physical key grid (aircraft list, detail card, airport picker)
//   Side strips   : current value of each side knob
import { discover } from 'loupedeck'
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, createReadStream } from 'node:fs'
import { createGunzip, gunzipSync } from 'node:zlib'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'

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
    traffic: n => `${n} aircraft`, airports: 'Airports', wind: 'WIND', calm: 'CALM', byWind: '(wind)', watch: 'WATCH',
    stTitle: 'RECEPTION', today: 'today', stSeen: 'AIRCRAFT', stNow: 'IN VIEW', stPeak: n => `peak ${n}`, stMil: n => `${n} military`, stRange: 'MAX RANGE',
    stRecord: 'RECORD', stHigh: 'HIGHEST', stFast: 'FASTEST', stCover: 'COVERAGE', stats: 'Stats' },
  fr: { filters: ['TOUS', 'MILITAIRES', 'HELICOS', 'BASSE ALT.', 'AEROPORT', 'GROS PORTEURS', 'AU-DESSUS'], follow: 'SUIVI', ground: 'SOL', mil: 'MIL',
    from: 'DEPART', to: 'ARRIVEE', airline: 'COMPAGNIE', alt: 'ALT', spd: 'VIT', vs: 'V/S', type: 'TYPE', hdg: 'CAP', dist: 'DIST', squawk: 'SQUAWK',
    back: 'Retour', close: 'Fermer', next: 'Suite', unknown: 'inconnu', seen: 'observé', noAircraft: r => `Aucun avion dans ${r} km`, noTraffic: 'Aucun trafic pour cet aéroport',
    brgAt: b => `au ${b}°`, altMin: 'ALT MIN', none: 'aucun', filter: 'FILTRE', bright: 'ECRAN', labels: 'ETIQUETTES', trails: 'TRAINEES', map: 'CARTE',
    overflight: t => `Survol ${t} min`, at: d => `à ${d} km`, locale: 'fr-FR', eta: 'TOUCHER', slope: 'pente', rwy: 'PISTE',
    traffic: n => `${n} avion${n > 1 ? 's' : ''}`, airports: 'Aéroports', wind: 'VENT', calm: 'CALME', byWind: '(vent)', watch: 'SURVEILLE',
    stTitle: 'RECEPTION', today: "aujourd'hui", stSeen: 'AVIONS', stNow: 'EN VUE', stPeak: n => `pic ${n}`, stMil: n => `${n} militaires`, stRange: 'PORTEE MAX',
    stRecord: 'RECORD', stHigh: 'PLUS HAUT', stFast: 'PLUS RAPIDE', stCover: 'COUVERTURE', stats: 'Stats' },
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
let alertLevel = null                        // null | 'watch' | 'info' | 'warn' | 'emerg'
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
    for (const a of aircraft) { a.watch = watched(a); a.cls = iconClass(a) }
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
    updateStats(j)
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
const AP = Object.assign({ enabled: true, radius_km: 350, small_radius_km: 100, types: ['large_airport', 'medium_airport'], min_runway_ft: 3000, approach_km: 18, default: '' }, cfg.airports || {})
const AP_CACHE = new URL(DEMO ? './airports-cache-demo.json' : './airports-cache.json', import.meta.url)
const OA = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/'
let airfields = []        // small airfields, only drawn on the scope: same shape, no approach logic
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
    if (c.v === 3 && Math.abs(c.lat - cfg.lat) < 0.5 && Math.abs(c.lon - cfg.lon) < 0.5 && c.radius >= AP.radius_km && c.small_radius === AP.small_radius_km && JSON.stringify(c.types) === JSON.stringify(AP.types)) { airports = c.airports; airfields = c.airfields || [] }
  } catch {}
  if (!airports.length) {
    console.log('Downloading airport and runway data (OurAirports, once)...')
    const get = async f => { const r = await fetch(OA + f, { signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.text() }
    const [aCsv, rCsv] = await Promise.all([get('airports.csv'), get('runways.csv')])
    const home = { lat: cfg.lat, lon: cfg.lon }
    const byId = new Map()
    for (const a of parseCSV(aCsv)) {
      const code = a.icao_code || a.gps_code || a.ident
      // Small airfields (grass strips included) are only drawn on the scope, around home, when they have a real ICAO code
      const minor = a.type === 'small_airport' && !AP.types.includes(a.type)
      if (minor ? !/^[A-Z]{4}$/.test(code) : !AP.types.includes(a.type)) continue
      const p = { lat: +a.latitude_deg, lon: +a.longitude_deg }
      if (kmBetween(home, p) > (minor ? AP.small_radius_km : AP.radius_km)) continue
      byId.set(a.id, { icao: code, iata: a.iata_code || '', name: a.name, city: a.municipality, type: a.type, sched: a.scheduled_service === 'yes', minor, ...p, elev: +a.elevation_ft || 0, runways: [] })
    }
    const paved = /ASP|CON|PEM|BIT|TAR|ASF|PAV|HARD/i
    for (const w of parseCSV(rCsv)) {
      const ap = byId.get(w.airport_ref)
      if (!ap || w.closed === '1' || !w.le_latitude_deg || !w.he_latitude_deg) continue
      if (!ap.minor && (+w.length_ft < AP.min_runway_ft || !paved.test(w.surface || ''))) continue
      const end = (id, la, lo, el, hd, disp) => ({ id, lat: +la, lon: +lo, elev: el ? +el : ap.elev, hdg: hd ? +hd : null, disp: disp ? +disp * 0.0003048 : 0 })
      ap.runways.push({ a: end(w.le_ident, w.le_latitude_deg, w.le_longitude_deg, w.le_elevation_ft, w.le_heading_degT, w.le_displaced_threshold_ft),
                        b: end(w.he_ident, w.he_latitude_deg, w.he_longitude_deg, w.he_elevation_ft, w.he_heading_degT, w.he_displaced_threshold_ft) })
    }
    airports = [...byId.values()].filter(a => !a.minor && a.runways.length)
    airfields = [...byId.values()].filter(a => a.minor)
    try { writeFileSync(AP_CACHE, JSON.stringify({ v: 3, lat: cfg.lat, lon: cfg.lon, radius: AP.radius_km, small_radius: AP.small_radius_km, types: AP.types, airports, airfields })) } catch {}
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
  console.log(`Airports loaded: ${airports.length}${airfields.length ? ` and ${airfields.length} small airfields` : ''}${selAirport ? `, selected ${selAirport}` : ''}`)
}
const airportByIcao = icao => airports.find(a => a.icao === icao)

// Is the aircraft flying an ILS-like final approach? (geometry from ADS-B position, not the real ILS signal)
const ilsCache = new Map()
function approachOf(a) {
  const k = `${a.hex}|${a.lat}|${a.lon}|${a.alt}|${a.track}|${a.vrate}` // everything the result depends on
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
  const info = getInfo(a), k = `${a.hex}|${a.lat}|${a.lon}|${a.alt}|${a.track}|${a.vrate}|${info?.at}`
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
  { name: T.filters[2], color: '#e58bff', test: a => (a.cls || iconClass(a)) === 'heli' },
  { name: T.filters[3], color: '#ffb629', test: a => !a.ground && a.alt != null && a.alt < 10000 },
  AIRPORT && { name: AIRPORT.name, color: '#39d5ff', test: a => a.alt != null && a.alt < AIRPORT.below_ft && kmBetween(a, AIRPORT) < AIRPORT.radius_km },
  { name: T.filters[5], color: '#ffe14d', test: a => (a.cls || iconClass(a)) === 'heavy' },
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

// ---------- Airline logos ----------
// The airline is read from the callsign (first three letters = ICAO airline code). Each logo is downloaded once,
// kept in logos/ (never shipped with the code) and shown as a round badge.
const LOGOS = Object.assign({ enabled: true, urls: [
  'https://raw.githubusercontent.com/Jxck-S/airline-logos/main/flightaware_logos/{icao}.png',
  'https://raw.githubusercontent.com/Jxck-S/airline-logos/main/radarbox_logos/{icao}.png',
] }, cfg.logos || {})
const LOGO_DIR = new URL('./logos/', import.meta.url)
const logged = new Set() // first success and first failure of each online feature go to the log, once
const logOnce = (key, msg) => { if (!logged.has(key)) { logged.add(key); console.log(msg) } }
const logoImgs = new Map() // ICAO code -> { img, bg, r }, or null while loading / when there is none
const logoQueue = []
let logoBusy = false
const airlineCode = a => /^[A-Z]{3}\d/.test(a.flight || '') ? a.flight.slice(0, 3) : null
const logoOf = a => logoByCode(airlineCode(a))
function logoByCode(code) {
  if (!LOGOS.enabled || DEMO || !code) return null
  if (!logoImgs.has(code)) { logoImgs.set(code, null); logoQueue.push(code); loadLogos() }
  return logoImgs.get(code)
}
async function loadLogos() {
  if (logoBusy) return
  logoBusy = true
  while (logoQueue.length) {
    const code = logoQueue.shift(), file = new URL(`${code}.png`, LOGO_DIR)
    try {
      let buf = null
      if (existsSync(file)) {
        const st = statSync(file)
        if (st.size) buf = readFileSync(file)
        else if (Date.now() - st.mtimeMs < 30 * 86400000) continue // empty file: no logo for this code, asked again after 30 days
      }
      if (!buf) {
        for (const u of LOGOS.urls) {
          const r = await fetch(u.replace('{icao}', code), { signal: AbortSignal.timeout(8000) })
          if (r.ok) { buf = Buffer.from(await r.arrayBuffer()); break }
          if (r.status !== 404) throw new Error(`HTTP ${r.status}`)
        }
        mkdirSync(LOGO_DIR, { recursive: true })
        writeFileSync(file, buf || Buffer.alloc(0))
      }
      if (buf) { logoImgs.set(code, measureLogo(await loadImage(buf))); refreshCenterNow(); logOnce('logo', 'Airline logos: working') }
    } catch (e) {
      setTimeout(() => logoImgs.delete(code), 600000).unref() // network trouble or unreadable file: try again in 10 minutes
      logOnce('logo-err', `Airline logos: ${code} failed (${e.message})`)
    }
  }
  logoBusy = false
}
// How a logo fills its round badge. A logo with its own solid background keeps that colour for the whole disc;
// a logo on a transparent background gets a white disc (what it was drawn for) and is scaled so that its
// outermost pixel touches the rim: a round logo fills the badge completely.
function measureLogo(img) {
  const w = img.width, h = img.height, c = createCanvas(w, h), cg = c.getContext('2d')
  cg.drawImage(img, 0, 0)
  const d = cg.getImageData(0, 0, w, h).data
  const at = (fx, fy) => { const i = (Math.round(fy * (h - 1)) * w + Math.round(fx * (w - 1))) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]] }
  const pts = [at(0.1, 0.1), at(0.9, 0.1), at(0.1, 0.9), at(0.9, 0.9)]
  if (pts.every(q => q[3] > 200 && Math.abs(q[0] - pts[0][0]) + Math.abs(q[1] - pts[0][1]) + Math.abs(q[2] - pts[0][2]) < 60))
    return { img, bg: `rgb(${pts[0][0]},${pts[0][1]},${pts[0][2]})`, r: Math.max(w, h) * 0.58 }
  let r2 = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 40) r2 = Math.max(r2, (x + 0.5 - w / 2) ** 2 + (y + 0.5 - h / 2) ** 2)
  return { img, bg: '#fff', r: Math.max(Math.sqrt(r2), Math.max(w, h) * 0.3) }
}
function drawLogo(g, logo, x, y, size) {
  const { img, bg, r } = logo, cx = x + size / 2, cy = y + size / 2, k = (size / 2) / r
  g.save()
  if (night) g.globalAlpha = 0.6 // a bright disc would glare in night mode
  g.beginPath(); g.arc(cx, cy, size / 2, 0, Math.PI * 2); g.fillStyle = bg; g.fill(); g.clip()
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'
  g.drawImage(img, cx - img.width * k / 2, cy - img.height * k / 2, img.width * k, img.height * k)
  g.restore()
  g.strokeStyle = 'rgba(255,255,255,0.2)'; g.lineWidth = 1; g.beginPath(); g.arc(cx, cy, size / 2 - 0.5, 0, Math.PI * 2); g.stroke() // hairline so dark logos stand out from the tile
}

// ---------- Aircraft photo (planespotters.net public API, then airport-data.com when it has none) ----------
// Their terms: a descriptive User-Agent, the photographer credited next to the image, the image linked to its
// Planespotters page (tapping the photo opens that page in the browser), the image fetched from the returned URL
// and held in memory only while it is on screen, the JSON answer cached for 24 hours at most.
const PHOTOS = Object.assign({ enabled: true }, cfg.photos || {})
const UA = 'loupedeck-ct-adsb-radar (+https://github.com/gamani/loupedeck-ct-adsb-radar)'
const photoMeta = new Map() // hex -> { at, src, credit, link }, or { at } when there is no photo
let photoShown = null       // { hex, img, credit, link }: only the aircraft on screen
let photoBusy = false
function photoOf(a) {
  if (!PHOTOS.enabled || DEMO || !/^[0-9a-f]{6}$/.test(a.hex)) return null
  if (photoShown?.hex === a.hex) return photoShown
  photoShown = null
  loadPhoto(a.hex)
  return null
}
async function loadPhoto(hex) {
  if (photoBusy) return
  photoBusy = true
  try {
    let m = photoMeta.get(hex)
    if (!m || Date.now() - m.at > (m.src ? 24 : 6) * 3600000) {
      const r = await fetch(`https://api.planespotters.net/pub/photos/hex/${hex.toUpperCase()}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const ph = (await r.json())?.photos?.[0]
      m = { at: Date.now(), ...(ph?.thumbnail?.src ? { src: ph.thumbnail.src, credit: ph.photographer || '', link: ph.link, site: 'planespotters.net' } : {}) }
      if (!m.src) { // nothing on Planespotters: the airport-data.com thumbnail API, with the same courtesies (credit, link, nothing stored)
        const r2 = await fetch(`https://airport-data.com/api/ac_thumb.json?m=${hex.toUpperCase()}&n=1`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) })
        if (!r2.ok && r2.status !== 404) throw new Error(`airport-data HTTP ${r2.status}`)
        const ad = r2.ok ? (await r2.json().catch(() => null))?.data?.[0] : null
        if (ad?.image) m = { at: Date.now(), src: ad.image, credit: ad.photographer || '', link: ad.link, site: 'airport-data.com' }
      }
      photoMeta.set(hex, m)
      if (photoMeta.size > 300) photoMeta.delete(photoMeta.keys().next().value)
    }
    if (m.src && hex === selectedHex) {
      const r = await fetch(m.src, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) })
      if (!r.ok) throw new Error(`image HTTP ${r.status}`)
      const img = await loadImage(Buffer.from(await r.arrayBuffer()))
      if (hex === selectedHex) { photoShown = { hex, img, credit: m.credit, link: m.link, site: m.site }; refreshCenterNow(); logOnce(`photo-${m.site}`, `Aircraft photos: working (${m.site})`) }
    }
  } catch (e) {
    photoMeta.set(hex, { at: Date.now() - 6 * 3600000 + 5 * 60000 }) // try again in 5 minutes
    logOnce('photo-err', `Aircraft photos: lookup failed for ${hex} (${e.message})`)
  }
  photoBusy = false
}
function openPhotoPage(link) { // only ever opens a page of one of the two photo sites, without going through a shell
  try {
    const u = new URL(link)
    if (u.protocol !== 'https:' || !/(^|\.)(planespotters\.net|airport-data\.com)$/.test(u.hostname)) return
    const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', u.href]] : process.platform === 'darwin' ? ['open', [u.href]] : ['xdg-open', [u.href]]
    execFile(cmd, args, () => {})
  } catch {}
}

// ---------- Airport weather (METAR from aviationweather.gov, for the selected airport only) ----------
const WX = Object.assign({ enabled: true, refresh_min: 10 }, cfg.weather || {})
const metars = new Map() // ICAO -> { at, m }
let metarBusy = false
const DEMO_METAR = { wdir: 250, wspd: 12, wgst: null, vis: '10+', qnh: 1018, temp: 14, cat: 'VFR' }
function metarOf(ap) {
  if (!WX.enabled || !ap) return null
  if (DEMO) return DEMO_METAR
  const c = metars.get(ap.icao)
  if (!c || Date.now() - c.at > WX.refresh_min * 60000) loadMetar(ap.icao)
  return c?.m || null
}
async function loadMetar(icao) {
  if (metarBusy || !/^[A-Z]{4}$/.test(icao)) return
  metarBusy = true
  const prev = metars.get(icao)?.m || null
  metars.set(icao, { at: Date.now(), m: prev })
  try {
    const r = await fetch(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const body = (await r.text()).trim(), x = body ? JSON.parse(body)[0] : null // an airport without METAR answers with an empty body
    const fresh = x && (!x.obsTime || Date.now() - x.obsTime * 1000 < 3 * 3600000)
    metars.set(icao, { at: Date.now(), m: fresh ? { wdir: typeof x.wdir === 'number' ? x.wdir : (x.wdir ? 'VRB' : null), wspd: x.wspd || 0, wgst: x.wgst || null, vis: x.visib, qnh: x.altim ? Math.round(x.altim) : null, temp: x.temp, cat: x.fltCat || '' } : null })
    refreshCenterNow()
    logOnce(`metar-${icao}`, `Weather: ${icao} ${fresh ? 'METAR received' : 'has no recent METAR'}`)
  } catch (e) {
    metars.set(icao, { at: Date.now() - (WX.refresh_min - 2) * 60000, m: prev }) // try again in 2 minutes
    logOnce('metar-err', `Weather: METAR ${icao} failed (${e.message})`)
  }
  metarBusy = false
}
const visText = v => v == null || v === '' ? '' : String(v).includes('+') ? '10+ km' : (km => km >= 5 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`)(parseFloat(v) * 1.609)
// Runway end the wind favours (best headwind); null when the wind is light, variable or straight across
function windRunway(ap, m) {
  if (!m || typeof m.wdir !== 'number' || m.wspd < 4) return null
  let best = null, bh = 0.25
  for (const e of ap.ends) { const hw = Math.cos(toRad(m.wdir - e.course)); if (hw > bh) { bh = hw; best = e } }
  return best
}

// ---------- Watch list ----------
// Aircraft worth a heads-up wherever they are in range: by type or registration (looked up in the tar1090 aircraft
// database, downloaded once a month, so that it also works when the receiver does not send types), hex or callsign prefix.
const WATCH = Object.assign({ enabled: true, types: ['A124', 'A225', 'A3ST', 'A337', 'BLCF', 'AN22', 'C5M', 'B52', 'B1', 'B2', 'U2'], registrations: [], callsigns: [], hex: [], max_km: 0 }, cfg.watch || {})
const plain = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const watchTypes = new Set(WATCH.types.map(plain)), watchRegs = new Set(WATCH.registrations.map(plain))
const watchHex = new Set(WATCH.hex.map(h => String(h).toLowerCase())), watchCalls = WATCH.callsigns.map(plain).filter(Boolean)
const watchDb = new Map() // hex -> label, for every aircraft of the database matching a watched type or registration
const DB_FILE = new URL('./aircraft-db.csv.gz', import.meta.url)
// The same database gives the type of every known aircraft: one row per aircraft, kept as two compact arrays
// (sorted hex codes and an index into the list of type designators) so that half a million rows cost a few megabytes.
const TYPES_FILE = new URL('./aircraft-types.json.gz', import.meta.url)
const TDB = 'https://raw.githubusercontent.com/wiedehopf/tar1090-db/'
let dbHex = new Uint32Array(0), dbTypeIdx = new Uint16Array(0), dbTypes = []
let typeInfo = {} // type designator -> [name, ICAO description such as L2J, wake category]
async function loadAircraftDb() {
  if (cfg.aircraft_db === false) return
  try {
    const stale = f => !existsSync(f) || Date.now() - statSync(f).mtimeMs > 30 * 86400000
    const get = async (url, file) => {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) })
      if (r.ok) writeFileSync(file, Buffer.from(await r.arrayBuffer()))
      else if (!existsSync(file)) throw new Error(`HTTP ${r.status}`)
    }
    if (stale(TYPES_FILE) || (!DEMO && stale(DB_FILE))) {
      console.log('Downloading the aircraft database (tar1090-db, once a month)...')
      if (!DEMO) await get(TDB + 'csv/aircraft.csv.gz', DB_FILE)
      await get(TDB + 'master/db/icao_aircraft_types2.js', TYPES_FILE)
    }
    const raw = readFileSync(TYPES_FILE)
    typeInfo = JSON.parse(raw[0] === 0x1f ? gunzipSync(raw) : raw)
    typeClasses.clear()
    if (DEMO) return // the demo traffic is fictitious: only the type table is needed
    const seen = new Map(), types = []
    let hexes = new Uint32Array(600000), idxs = new Uint16Array(600000), n = 0, sorted = true, prev = -1
    for await (const line of createInterface({ input: createReadStream(DB_FILE).pipe(createGunzip()) })) { // hex;registration;type;flags;description
      const f = line.split(';'), t = f[2]
      if (WATCH.enabled && (watchTypes.has(t) || (f[1] && watchRegs.has(plain(f[1]))))) watchDb.set(f[0].toLowerCase(), [t, f[1]].filter(Boolean).join(' '))
      const h = parseInt(f[0], 16)
      if (!t || !(h >= 0)) continue
      let i = seen.get(t)
      if (i === undefined) { i = types.length; types.push(t); seen.set(t, i) }
      if (n === hexes.length) { const h2 = new Uint32Array(n * 2), i2 = new Uint16Array(n * 2); h2.set(hexes); i2.set(idxs); hexes = h2; idxs = i2 }
      if (h <= prev) sorted = false
      prev = h; hexes[n] = h; idxs[n++] = i
    }
    hexes = hexes.subarray(0, n); idxs = idxs.subarray(0, n)
    if (!sorted) { // the file is sorted today; keep the lookup right if that ever changes
      const order = Array.from({ length: n }, (_, k) => k).sort((p, q) => hexes[p] - hexes[q])
      hexes = Uint32Array.from(order, k => hexes[k]); idxs = Uint16Array.from(order, k => idxs[k])
    }
    dbHex = hexes; dbTypeIdx = idxs; dbTypes = types
    typeClasses.clear()
    console.log(`Aircraft database: ${dbHex.length} aircraft, ${dbTypes.length} types${WATCH.enabled ? `, watch list ${watchDb.size}` : ''}`)
  } catch (e) { console.error('Aircraft database:', e.message) }
}
function dbTypeOf(hex) { // type designator of an aircraft, '' when unknown
  const h = parseInt(hex, 16)
  let lo = 0, hi = dbHex.length - 1
  while (lo <= hi) { const m = (lo + hi) >> 1, v = dbHex[m]; if (v === h) return dbTypes[dbTypeIdx[m]]; if (v < h) lo = m + 1; else hi = m - 1 }
  return ''
}
const acType = a => dbTypeOf(a.hex) || getInfo(a)?.aircraft?.type || ''
function watched(a) {
  if (!WATCH.enabled || DEMO || (WATCH.max_km && a.d > WATCH.max_km)) return null
  const db = watchDb.get(a.hex)
  if (db) return db
  if (watchHex.has(a.hex)) return a.hex.toUpperCase()
  if (a.flight && watchCalls.some(c => a.flight.startsWith(c))) return a.flight
  const ac = getInfo(a)?.aircraft
  if (ac && (watchTypes.has(plain(ac.type)) || (ac.reg && watchRegs.has(plain(ac.reg))))) return [ac.type, ac.reg].filter(Boolean).join(' ')
  return null
}

// ---------- Reception statistics (today's figures, kept in stats.json) ----------
const STATS_FILE = new URL('./stats.json', import.meta.url)
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const newDay = () => ({ day: dayKey(), seen: new Map(), mil: 0, airlines: {}, range: null, high: null, fast: null, peak: null, sectors: Array(36).fill(0) })
let stats = newDay(), record = null, statsDirty = false, statsMode = false, statsSel = null, msgRate = null, lastMsgs = null
if (!DEMO) try {
  const j = JSON.parse(readFileSync(STATS_FILE))
  record = j.record || null
  if (j.today?.day === dayKey()) stats = { ...newDay(), ...j.today, seen: new Map(Object.entries(j.today.seen || {})) }
} catch {}
function updateStats(j) {
  if (DEMO) return
  if (stats.day !== dayKey()) stats = newDay()
  if (typeof j.messages === 'number' && typeof j.now === 'number') {
    if (lastMsgs && j.now > lastMsgs.now) msgRate = (j.messages - lastMsgs.messages) / (j.now - lastMsgs.now)
    lastMsgs = { now: j.now, messages: j.messages }
  }
  const hhmm = new Date().toTimeString().slice(0, 5)
  let n = 0
  for (const a of aircraft) {
    if (a.seenPos > 15 || !/^[0-9a-f]{6}$/.test(a.hex)) continue
    n++
    const name = a.flight || a.hex.toUpperCase(), code = airlineCode(a), known = stats.seen.get(a.hex)
    if (known === undefined) { stats.seen.set(a.hex, ''); if (isMilitary(a)) stats.mil++ }
    if (code && !known) { stats.seen.set(a.hex, code); stats.airlines[code] = (stats.airlines[code] || 0) + 1 }
    if (a.d < 600 && (trails.get(a.hex)?.length || 0) >= 3) { // a tracked aircraft at a plausible distance, not a one-off decoding error
      if (!stats.range || a.d > stats.range.km) stats.range = { km: a.d, brg: a.brg, name, at: hhmm }
      const sec = Math.floor((((a.brg % 360) + 360) % 360) / 10)
      if (a.d > stats.sectors[sec]) stats.sectors[sec] = Math.round(a.d)
      if (!record || a.d > record.km) record = { km: a.d, day: stats.day, name }
    }
    if (a.alt != null && !a.ground && a.alt < 60000 && (!stats.high || a.alt > stats.high.alt)) stats.high = { alt: a.alt, name }
    if (a.speed != null && a.speed < 1500 && (!stats.fast || a.speed > stats.fast.kt)) stats.fast = { kt: a.speed, name }
  }
  if (!stats.peak || n > stats.peak.n) stats.peak = { n, at: hhmm }
  statsDirty = true
}
const saveStats = () => { if (statsDirty) { statsDirty = false; try { writeFileSync(STATS_FILE, JSON.stringify({ record, today: { ...stats, seen: Object.fromEntries(stats.seen) } })) } catch {} } }
if (!DEMO) setInterval(saveStats, 300000)
const topAirlines = () => Object.entries(stats.airlines).sort((p, q) => q[1] - p[1]).slice(0, 3)

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
  cyan: '#39d5ff', green: '#46e08a', amber: '#ffb629', red: '#ff3d3d', magenta: '#ff4dff', violet: '#c05cff',
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

// Aircraft glyphs (nose up at track 0), one silhouette per kind of aircraft. Each outline is the right half, mirrored;
// `pods` are engines drawn ahead of the wing.
const SHAPES = {
  liner: { k: 0.84, pts: [[0, -8], [1.3, -5.6], [1.3, -1.6], [8, 3], [8, 4.7], [1.3, 2.4], [1.3, 5.6], [3.7, 7.6], [3.7, 8.8], [0, 7.8]] },                      // airliner: swept wings
  heavy: { k: 1.0, pts: [[0, -9.5], [1.7, -7], [1.7, -2.4], [9.8, 3.2], [9.8, 5.2], [1.7, 2.8], [1.7, 6.4], [4.6, 8.6], [4.6, 10], [0, 8.9]], pods: [[3.1, -3.3], [6.2, -1.2]] }, // wide-body: bigger, four engines
  small: { k: 0.82, pts: [[0, -7.6], [1, -5.2], [1, 0.4], [6.4, 3.8], [6.4, 5], [1, 3.4], [1, 4], [2.4, 4], [2.4, 6.6], [1, 6.6], [1, 7.2], [3.4, 8.4], [3.4, 9.4], [0, 8.8]] }, // business or regional jet: rear engines, T-tail
  light: { k: 0.86, pts: [[0, -6.2], [1, -4.8], [1, -2.6], [8.2, -2.6], [8.2, 0.2], [1, 0.2], [1, 5], [3.4, 5], [3.4, 7], [0, 7]] },                                 // light aircraft: straight wing
  prop: { k: 0.88, pts: [[0, -7.6], [1.1, -5.6], [1.1, -1.9], [8.8, -1.1], [8.8, 0.9], [1.1, 1.5], [1.1, 5.6], [3.8, 6.4], [3.8, 7.9], [0, 7.6]], pods: [[3, -3.9]] },                         // turboprop airliner or transport: straight wing, two engines
  fast: { k: 0.84, pts: [[0, -8.4], [1, -4.4], [1.4, 0], [6.2, 6], [6.2, 7.4], [1.7, 6.4], [1.2, 8.2], [0, 7.8]] },                                               // high performance: delta
}
// Kind of aircraft. The type wins when it is known (database, then adsbdb): ICAO describes every type by airframe,
// number and kind of engines (L2J = landplane, 2 jets) and wake category, which sorts out everything except
// business jets and fast jets, recognised by name. Without a type, the ADS-B emitter category decides.
const BIZ_NAMES = /CITATION|LEARJET|GULFSTREAM|FALCON|CHALLENGER|GLOBAL|HAWKER|PHENOM|PRAETOR|LEGACY|LINEAGE|PC-24|HONDA|BEECHJET|PREMIER|SABRELINER|JETSTAR|WESTWIND|ASTRA|ECLIPSE|GALAXY|LONGITUDE|LATITUDE|SOVEREIGN|MUSTANG|NEXTANT|SYBERJET|BAE-125|HS-125|DH-125|CORVETTE|MS-760|G-1159|BD-100|BD-700|JET COMMANDER|EMB-50[05]|EMB-545|EMB-550|SABRE [4-8]|COMMODORE|MU-300|HANSA/i
const FAST_NAMES = /\bF-\d|\bF\/?A-\d|TYPHOON|EUROFIGHTER|RAFALE|MIRAGE|TORNADO|GRIPEN|\bHAWK\b|GOSHAWK|ALPHA ?JET|HARRIER|\bA-10\b|\bSU-\d|\bMIG[- ]\d|\bL-39\b|\bL-159\b|\bL-29\b|\bM-346\b|\bT-38\b|\bAMX\b|JAGUAR|PHANTOM|VIGGEN|DRAKEN|\bT-45\b|MB-339|MB-326|LIGHTNING|ETENDARD|KFIR|\bJ-\d|\bJF-17|\bF-CK|TEJAS|\bT-50\b|YAK-130|\bB-1\b|\bB-2\b|HUNTER|STARFIGHTER|\bA-4\b|\bA-6\b|\bA-7\b|\bAV-8|\bT-2\b|\bT-4\b|\bK-8\b|\bS-211\b|\bC-101\b|SAAB (105|29|32|35|37|39)|JET PROVOST|STRIKEMASTER|VAMPIRE|VENOM|GNAT|TALON|\bEA-18|MYSTERE|\bFC-1\b|\bJH-7\b|\bQ-5\b|\bKF-21\b|\bT-33\b|METEOR|DELTA DART/i
const HELI_TYPES = /^(EC\d\d|H1[2-7]\d|AS[3-6]\d|A1[0-9]9|AW\d|R22|R44|R66|B06|B4[0-3]\d|B212|B412|S76|S92|NH90|TIGR|UH1|H60|H47|H53|G2CA|CABR|LAMA|ALO[23]|GAZL|PUMA|EH10|MI\d)/
const HEAVY_TYPES = /^(A33|A34|A35|A38|B74|B76|B77|B78|MD11|DC10|IL76|IL96|A124|A225|AN22|C17|C5M|A3ST|A337|BLCF|K35|A400|E3)/
const LIGHT_TYPES = /^(C1[2-9]\d|C2[01]\d|P28|PA\d|P32|P46|DA[24]\d|DR[2-4]\d|SR2\d|TB[12]\d|TB9|RV\d|M20|BE3[356]|BE23|AA5|TOBA|ULAC|GLID|DV20|AT3|WT9|CP30|D11|J3|PC6|PC12)/
const typeClasses = new Map()
function typeClass(t) {
  if (typeClasses.has(t)) return typeClasses.get(t)
  const [name = '', desc = '', wtc = ''] = typeInfo[t] || []
  let c = null
  if (desc.length >= 3) {
    const big = wtc === 'H' || wtc === 'J'
    if ('HGR'.includes(desc[0])) c = 'heli' // helicopters, gyrocopters, tiltrotors
    else if (desc[2] === 'J') c = FAST_NAMES.test(name) && !/FOKKER/i.test(name) ? 'fast' : big ? 'heavy' : wtc === 'L' || BIZ_NAMES.test(name) ? 'small' : 'liner'
    else c = big ? 'heavy' : wtc === 'M' && desc[1] !== '1' ? 'prop' : 'light'
  } else if (t) c = HELI_TYPES.test(t) ? 'heli' : HEAVY_TYPES.test(t) ? 'heavy' : LIGHT_TYPES.test(t) ? 'light' : null // type table not loaded
  typeClasses.set(t, c)
  return c
}
function iconClass(a) {
  const byType = typeClass(acType(a))
  if (byType) return byType
  const c = a.category
  return c === 'A7' ? 'heli' : c === 'A5' ? 'heavy' : c === 'A1' || c === 'B1' || c === 'B4' ? 'light' : c === 'A2' ? 'small' : c === 'A6' ? 'fast' : 'liner'
}
function glyph(g, a, x, y, { color, outline = 'rgba(0,0,0,0.85)', scale = 1, alpha = 1 } = {}) {
  const cls = a.cls || iconClass(a), shape = SHAPES[cls], s = scale * (shape ? shape.k : 0.84)
  g.save(); g.translate(x, y); g.globalAlpha = alpha; g.lineJoin = 'round'
  g.beginPath()
  if (a.track == null) { g.moveTo(0, -4.5 * s); g.lineTo(4.5 * s, 0); g.lineTo(0, 4.5 * s); g.lineTo(-4.5 * s, 0); g.closePath() } // no track: diamond
  else if (cls === 'heli') { // helicopter: body + rotor disc
    g.rotate(toRad(a.track))
    g.moveTo(0, -4 * s); g.lineTo(2.4 * s, -1 * s); g.lineTo(1 * s, 3 * s); g.lineTo(0.7 * s, 8 * s); g.lineTo(-0.7 * s, 8 * s); g.lineTo(-1 * s, 3 * s); g.lineTo(-2.4 * s, -1 * s); g.closePath()
  } else {
    const P = shape.pts
    g.rotate(toRad(a.track))
    g.moveTo(P[0][0] * s, P[0][1] * s)
    for (let i = 1; i < P.length; i++) g.lineTo(P[i][0] * s, P[i][1] * s)
    for (let i = P.length - 2; i > 0; i--) g.lineTo(-P[i][0] * s, P[i][1] * s)
    g.closePath()
    for (const [px, py] of shape.pods || []) { g.rect(px * s, py * s, 1.5 * s, 3 * s); g.rect((-px - 1.5) * s, py * s, 1.5 * s, 3 * s) } // engines ahead of the wing
  }
  if (outline) { g.lineWidth = 2.2; g.strokeStyle = outline; g.stroke() }
  g.fillStyle = color; g.fill()
  if (cls === 'heli' && a.track != null) { g.strokeStyle = color; g.lineWidth = 1; g.beginPath(); g.arc(0, -0.5 * s, 6 * s, 0, Math.PI * 2); g.stroke() }
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

  // Stats page: today's coverage (maximum range per 10 degree sector around home)
  if (statsMode && stats.sectors.some(Boolean)) {
    g.beginPath()
    stats.sectors.forEach((km, k) => { const [x, y] = plotXY(offsetPt({ lat: cfg.lat, lon: cfg.lon }, k * 10 + 5, Math.max(km, 0.5))); k ? g.lineTo(x, y) : g.moveTo(x, y) })
    g.closePath(); g.fillStyle = withAlpha(UI.cyan, 0.1); g.fill(); g.strokeStyle = withAlpha(UI.cyan, 0.85); g.lineWidth = 1.3; g.stroke()
  }

  // Aircraft
  for (const [a, x, y] of pts) {
    if (!inDisc(x, y, 118)) continue
    const emerg = isEmergency(a.squawk), col = altColor(a.alt)
    if (a.watch) { g.strokeStyle = UI.violet; g.lineWidth = 1.8; g.beginPath(); g.moveTo(x, y - 14); g.lineTo(x + 14, y); g.lineTo(x, y + 14); g.lineTo(x - 14, y); g.closePath(); g.stroke() } // watch list: violet diamond
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
  if (range <= 50) for (const ap of airfields) { // small airfields: runway to scale and code when zoomed in, a small ring otherwise
    const [x, y] = plotXY(ap)
    if (!inDisc(x, y, 116)) continue
    const col = 'rgba(190,225,235,0.8)'
    g.lineCap = 'round'
    if (range <= 25 && ap.runways.length) for (const w of ap.runways) {
      const [ax, ay] = plotXY(w.a), [bx, by] = plotXY(w.b)
      g.strokeStyle = 'rgba(0,0,0,0.8)'; g.lineWidth = 4; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke()
      g.strokeStyle = col; g.lineWidth = 1.6; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke()
    } else {
      g.strokeStyle = 'rgba(0,0,0,0.8)'; g.lineWidth = 3; g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.stroke()
      g.strokeStyle = col; g.lineWidth = 1.2; g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.stroke()
    }
    g.lineCap = 'butt'
    if (range <= 25 && inDisc(x, y, 100)) { occupied.push({ x: x - 5, y: y - 5, w: 10, h: 10 }); placeLabel(g, ap.icao, x, y, occupied, { fg: '#cfe3ea', px: 8 }) }
  }
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
  const logo = logoOf(a), left = bx + (logo ? 37 : 16), right = bx + bw - 10
  if (logo) drawLogo(g, logo, bx + 14, by + 7, 20)
  // line 1: callsign + flight level
  const fl = a.ground ? T.ground : a.alt != null ? `FL${String(Math.round(a.alt / 100)).padStart(3, '0')}` : ''
  const flw = txt(g, fl, right, by + 15, { px: 10, weight: 700, color: col, align: 'right' })
  txt(g, a.flight || a.hex.toUpperCase(), left, by + 15, { px: 12, weight: 700, max: right - left - flw - 6 })
  // line 2: what matters most right now
  const second = ov ? [T.overflight(ov.t < 1 ? '<1' : Math.round(ov.t)), UI.amber, T.at(ov.d.toFixed(1))]
    : app ? [`ILS ${app.end.id} ${app.ap.iata || app.ap.icao}`, UI.cyan, `${app.along.toFixed(1)} km`]
    : [route ? `${route.from.iata} › ${route.to.iata}` : (acType(a) || `${Math.round(kmBetween(a, view))} km`), UI.sub, isMilitary(a) ? T.mil : logo ? '' : countryOf(a)]
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
  const b = panel(g, i, { accent: emerg ? UI.red : col, fill: emerg ? UI.panelWarn : UI.panel, border: emerg ? UI.red : a.watch ? UI.violet : UI.line, bw: emerg || a.watch ? 2 : 1 })
  txt(g, a.flight || a.hex.toUpperCase(), b.l, b.y + 18, { px: 14, weight: 700, max: b.r - b.l })
  // flight level, vertical trend, heading
  let x = b.l
  if (!a.ground && a.alt != null) x += txt(g, 'FL', x, b.y + 40, { px: 8, weight: 700, color: UI.mute }) + 2
  x += txt(g, flText(a), x, b.y + 40, { px: 19, weight: 700, color: col }) + 5
  if (Math.abs(a.vrate ?? 0) > 300) { // climbing / descending
    const up = a.vrate > 0, ty = b.y + 33
    g.fillStyle = col; g.beginPath()
    if (up) { g.moveTo(x, ty + 4); g.lineTo(x + 4, ty - 3); g.lineTo(x + 8, ty + 4) } else { g.moveTo(x, ty - 3); g.lineTo(x + 4, ty + 4); g.lineTo(x + 8, ty - 3) }
    g.closePath(); g.fill()
  }
  // what it is doing: distress, approach, route or type
  if (emerg) pill(g, `SQK ${a.squawk}`, b.l, b.y + 53, { fg: '#fff', bg: UI.red })
  else if (app) pill(g, `ILS ${app.end.id} ${app.ap.iata || app.ap.icao}`, b.l, b.y + 53, { fg: UI.cyan, bg: '#0a3440' })
  else if (a.watch) txt(g, a.watch, b.l, b.y + 53, { px: 11, weight: 700, color: UI.violet, max: b.r - b.l })
  else if (route) txt(g, `${route.from.iata} › ${route.to.iata}`, b.l, b.y + 53, { px: 12, weight: 600, color: '#d5e0e8', max: b.r - b.l })
  else if (acType(a)) txt(g, acType(a), b.l, b.y + 53, { px: 11, weight: 600, color: UI.mute })
  // distance, country
  const ref = refPoint ? kmBetween(a, refPoint) : a.d
  txt(g, fmtKm(ref), b.l, b.y + 71, { px: 10, weight: 600, color: UI.sub })
  const mil = isMilitary(a), logo = logoOf(a)
  if (logo) return drawLogo(g, logo, b.r - 21, b.y + 57, 22) // the airline logo replaces the country code
  txt(g, mil ? T.mil : countryOf(a), b.r - 12, b.y + 71, { px: 9, weight: 700, color: mil ? '#8fe05a' : UI.mute, align: 'right' })
  glyph(g, { track: a.track, cls: a.cls || iconClass(a) }, b.r - 4, b.y + 67, { color: UI.sub, outline: null, scale: 0.6 })
}

// Photo across tiles i and i + 1, with the photographer credit and the name of the site it comes from
function drawPhotoTiles(g, i, ph) {
  const x = (i % 4) * TILE + PAD, y = Math.floor(i / 4) * TILE + PAD, w = TILE + TW, h = TW, img = ph.img
  g.save(); g.beginPath(); g.roundRect(x, y, w, h, 8); g.clip()
  const k = Math.max(w / img.width, h / img.height), iw = img.width * k, ih = img.height * k
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'
  g.drawImage(img, x + (w - iw) / 2, y + (h - ih) * 0.45, iw, ih)
  const shade = g.createLinearGradient(0, y + h - 30, 0, y + h)
  shade.addColorStop(0, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(0,0,0,0.82)')
  g.fillStyle = shade; g.fillRect(x, y + h - 30, w, 30)
  g.restore()
  g.strokeStyle = UI.line; g.lineWidth = 1; g.beginPath(); g.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 7.5); g.stroke()
  txt(g, `© ${ph.credit}`, x + 7, y + h - 6, { px: 8, weight: 600, color: '#eef2f5', max: TW - 12 })
  txt(g, ph.site, x + w - 7, y + h - 6, { px: 8, weight: 600, color: '#c3ccd3', align: 'right' })
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

let photoLink = null // page of the photo currently on tiles 9 and 10 (opened by a tap)
function drawDetail(g, sel) {
  const info = getInfo(sel) || {}, emerg = isEmergency(sel.squawk)
  const col = altColor(sel.alt), r = routeOf(sel), al = info.airline, ac = info.aircraft
  // identity
  const b = panel(g, 0, { accent: emerg ? UI.red : col, fill: emerg ? UI.panelWarn : UI.panel, border: emerg ? UI.red : sel.watch ? UI.violet : UI.line, bw: emerg || sel.watch ? 2 : 1 })
  txt(g, sel.flight || sel.hex.toUpperCase(), b.l, b.y + 23, { px: 16, weight: 700, max: b.r - b.l })
  txt(g, al?.name || ac?.owner || '', b.l, b.y + 38, { px: 10, weight: 600, color: UI.sub, max: b.r - b.l })
  let cx = b.l
  const iso = countryOf(sel)
  if (iso) cx += pill(g, iso, cx, b.y + 57, { fg: UI.sub }) + 3
  if (isMilitary(sel)) cx += pill(g, T.mil, cx, b.y + 57, { fg: '#b8f58a', bg: '#1f3a12' }) + 3
  if (emerg) pill(g, sel.squawk, cx, b.y + 57, { fg: '#fff', bg: UI.red })
  txt(g, sel.hex.toUpperCase(), b.l, b.y + 74, { px: 9, weight: 600, color: UI.mute })
  const logo = logoOf(sel)
  if (logo) drawLogo(g, logo, b.r - 24, b.y + 53, 26)

  drawInfoTile(g, 1, T.from, r ? r.from.iata : '–', { color: r ? UI.text : UI.mute, sub: r ? r.from.city : T.unknown, sub2: r?.from.obs ? (r.from.iata === '?' ? '' : T.seen) : r?.from.iso })
  drawInfoTile(g, 2, T.to, r ? r.to.iata : '–', { color: r ? UI.text : UI.mute, sub: r ? r.to.city : T.unknown, sub2: r?.to.obs ? (r.to.iata === '?' ? '' : T.seen) : r?.to.iso })
  const type = acType(sel), model = ac?.model && ac.model !== type ? ac.model : (typeInfo[type]?.[0] || '')
  drawInfoTile(g, 3, T.type, type || '–', { color: type ? UI.text : UI.mute, sub: ac?.reg, sub2: model })
  drawInfoTile(g, 4, T.alt, sel.ground ? T.ground : sel.alt != null ? sel.alt.toLocaleString(T.locale) : '–', { color: col, sub: 'ft', sub2: sel.alt != null ? `${Math.round(sel.alt * 0.3048).toLocaleString(T.locale)} m` : '' })
  drawInfoTile(g, 5, T.spd, sel.speed != null ? String(Math.round(sel.speed * 1.852)) : '–', { sub: 'km/h', sub2: sel.speed != null ? `${Math.round(sel.speed)} kt` : '' })
  const vr = sel.vrate
  drawInfoTile(g, 6, T.vs, vr != null ? `${vr > 0 ? '+' : ''}${vr.toLocaleString(T.locale)}` : '–', { color: vr > 300 ? UI.green : vr < -300 ? UI.amber : UI.text, sub: 'ft/min', px: 19 })
  drawHeadingTile(g, 7, sel)
  const app = approachOf(sel), photo = app ? null : photoOf(sel)
  photoLink = null
  if (app) { // ILS-like approach: deviation indicator, runway, time to touchdown
    drawIlsTile(g, 8, app)
    drawInfoTile(g, 9, `ILS ${app.ap.iata || app.ap.icao}`, app.end.id, { color: UI.cyan, sub: `${app.along.toFixed(1)} km`, border: withAlpha(UI.cyan, 0.5) })
    drawInfoTile(g, 10, T.eta, app.eta < 1 ? '<1 min' : `${Math.round(app.eta)} min`, { sub: `${T.slope} ${app.glide.toFixed(1)}°`, px: 19, border: withAlpha(UI.cyan, 0.5) })
  } else if (photo) { // photo on two tiles: distance and squawk share one tile, the airline is already on the identity tile
    drawInfoTile(g, 8, T.dist, sel.d.toFixed(1), { sub: `km ${T.brgAt(Math.round(sel.brg))}`, sub2: sel.squawk ? `SQK ${sel.squawk}` : '' })
    drawPhotoTiles(g, 9, photo)
    photoLink = photo.link
  } else {
    drawInfoTile(g, 8, T.dist, sel.d.toFixed(1), { sub: 'km', sub2: T.brgAt(Math.round(sel.brg)) })
    drawInfoTile(g, 9, T.squawk, sel.squawk || '––––', { color: emerg ? UI.red : UI.text })
    if (logo) { // airline tile with its logo
      const t = panel(g, 10)
      txt(g, T.airline, t.l, t.y + 16, { px: 9, weight: 700, color: UI.mute, max: t.r - t.l })
      drawLogo(g, logo, t.l, t.y + 23, 36)
      txt(g, al?.iata || airlineCode(sel), t.l + 42, t.y + 40, { px: 15, weight: 700, max: t.r - t.l - 42 })
      txt(g, al?.iso || countryOf(sel), t.l + 42, t.y + 54, { px: 9, weight: 700, color: UI.mute })
      txt(g, al?.name || '', t.l, t.y + 74, { px: 10, weight: 600, color: UI.sub, max: t.r - t.l })
    } else drawInfoTile(g, 10, T.airline, al?.iata || al?.name || '–', { color: al ? UI.text : UI.mute, sub: al?.iata ? al.name : '', sub2: al?.iso })
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
    if (l.kind === 'app') { const p = approachOf(a); if (p && (!e.next || p.eta < e.next.eta)) e.next = { name: a.flight || a.hex.toUpperCase(), eta: p.eta } }
    m.set(l.ap.icao, e)
  }
  return m
}
const runwayNames = ap => ap.runways.map(w => `${w.a.id}/${w.b.id}`).join('  ')
function drawBearing(g, x, y, brg, color) { glyph(g, { track: brg, cls: 'liner' }, x, y, { color, outline: null, scale: 0.62 }) }

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
// Weather of the selected airport: wind (with a dial showing it against the runways), flight category, QNH, visibility
function drawWeatherTile(g, i, ap, m) {
  const b = panel(g, i), cat = { VFR: UI.green, MVFR: UI.cyan, IFR: UI.red, LIFR: UI.magenta }[m.cat]
  txt(g, T.wind, b.l, b.y + 16, { px: 9, weight: 700, color: UI.mute })
  if (cat) pill(g, m.cat, b.r, b.y + 16, { px: 8, fg: cat, bg: withAlpha(cat, 0.16), align: 'right', h: 12 })
  const calm = !m.wspd, vrb = typeof m.wdir !== 'number'
  txt(g, calm ? T.calm : vrb ? 'VRB' : `${String(Math.round(m.wdir / 10) * 10 || 360).padStart(3, '0')}°`, b.l, b.y + 39, { px: calm ? 12 : 15, weight: 700, max: 32 })
  if (!calm) txt(g, m.wgst ? `${m.wspd}-${m.wgst} kt` : `${m.wspd} kt`, b.l, b.y + 54, { px: 10, weight: 700, color: m.wgst ? UI.amber : UI.sub, max: 32 })
  const cx = b.r - 15, cy = b.y + 41, r = 15
  g.strokeStyle = '#2c3a45'; g.lineWidth = 1.5; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke()
  g.strokeStyle = UI.green; g.lineWidth = 1.6; g.beginPath(); g.moveTo(cx, cy - r); g.lineTo(cx, cy - r + 4); g.stroke()
  g.lineCap = 'round'
  for (const w of ap.runways) { // runways, as seen from above
    const t = toRad(bearing(w.a, w.b)), dx = Math.sin(t) * r * 0.62, dy = -Math.cos(t) * r * 0.62
    g.strokeStyle = '#7d8c97'; g.lineWidth = 3; g.beginPath(); g.moveTo(cx - dx, cy - dy); g.lineTo(cx + dx, cy + dy); g.stroke()
  }
  if (!calm && !vrb) { // arrow flying with the wind, from the rim towards the centre
    const t = toRad(m.wdir), ux = Math.sin(t), uy = -Math.cos(t), x0 = cx + ux * (r + 3), y0 = cy + uy * (r + 3), x1 = cx + ux * 4, y1 = cy + uy * 4
    g.strokeStyle = UI.cyan; g.fillStyle = UI.cyan; g.lineWidth = 2; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1 + ux * 4, y1 + uy * 4); g.stroke()
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 + ux * 7 - uy * 4, y1 + uy * 7 + ux * 4); g.lineTo(x1 + ux * 7 + uy * 4, y1 + uy * 7 - ux * 4); g.closePath(); g.fill()
  }
  g.lineCap = 'butt'
  if (m.qnh) txt(g, `Q${m.qnh}`, b.l, b.y + 74, { px: 10, weight: 700, color: UI.sub })
  txt(g, visText(m.vis), b.r, b.y + 74, { px: 9, weight: 600, color: UI.mute, align: 'right' })
}

// ---------- Reception statistics page (button 4) ----------
function drawCoverageTile(g, i) { // today's maximum range in each 10 degree sector
  const b = panel(g, i), cx = b.cx, cy = b.y + 49, R = 27
  txt(g, T.stCover, b.l, b.y + 16, { px: 9, weight: 700, color: UI.mute, max: b.r - b.l })
  const top = Math.max(...stats.sectors, 1), scale = [50, 100, 150, 200, 300, 400, 500, 600].find(v => v >= top) || 600
  g.strokeStyle = '#2c3a45'; g.lineWidth = 1
  for (const k of [0.5, 1]) { g.beginPath(); g.arc(cx, cy, R * k, 0, Math.PI * 2); g.stroke() }
  g.strokeStyle = UI.green; g.lineWidth = 1.6; g.beginPath(); g.moveTo(cx, cy - R); g.lineTo(cx, cy - R + 4); g.stroke()
  g.beginPath()
  stats.sectors.forEach((km, k) => { const t = toRad(k * 10 + 5), rr = Math.max(1.5, km / scale * R), x = cx + rr * Math.sin(t), y = cy - rr * Math.cos(t); k ? g.lineTo(x, y) : g.moveTo(x, y) })
  g.closePath(); g.fillStyle = withAlpha(UI.cyan, 0.22); g.fill(); g.strokeStyle = UI.cyan; g.lineWidth = 1.2; g.stroke()
  txt(g, String(scale), b.r, b.y + 77, { px: 8, weight: 600, color: UI.mute, align: 'right' })
}
function drawStats(g) {
  const b = panel(g, 0, { fill: UI.panelSel, border: UI.cyan, bw: 2 }), [, mo, da] = stats.day.split('-')
  txt(g, T.stTitle, b.l, b.y + 22, { px: 12, weight: 700, color: UI.cyan, max: b.r - b.l })
  txt(g, T.today, b.l, b.y + 39, { px: 10, weight: 600, color: UI.sub, max: b.r - b.l })
  txt(g, `${da}/${mo}`, b.l, b.y + 56, { px: 11, weight: 700 })
  if (msgRate != null) txt(g, `${Math.round(msgRate).toLocaleString(T.locale)} msg/s`, b.l, b.y + 74, { px: 9, weight: 600, color: UI.mute, max: b.r - b.l })
  const now = aircraft.filter(a => a.seenPos <= 15).length, rg = stats.range, dm = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) : ''
  drawInfoTile(g, 1, T.stSeen, stats.seen.size.toLocaleString(T.locale), { sub: T.today, sub2: stats.mil ? T.stMil(stats.mil) : '' })
  drawInfoTile(g, 2, T.stNow, String(now), { sub: stats.peak ? T.stPeak(stats.peak.n) : '', sub2: stats.peak?.at })
  drawInfoTile(g, 3, T.stRange, rg ? String(Math.round(rg.km)) : '–', { color: rg ? UI.green : UI.mute, sub: rg ? `km ${T.brgAt(Math.round(rg.brg))}` : 'km', sub2: rg ? `${rg.name} ${rg.at}` : '' })
  drawInfoTile(g, 4, T.stRecord, record ? String(Math.round(record.km)) : '–', { color: record ? UI.text : UI.mute, sub: `km ${dm(record?.day)}`, sub2: record?.name })
  drawInfoTile(g, 5, T.stHigh, stats.high ? `FL${Math.round(stats.high.alt / 100)}` : '–', { color: stats.high ? altColor(stats.high.alt) : UI.mute, sub: stats.high?.name, px: 19 })
  drawInfoTile(g, 6, T.stFast, stats.fast ? String(Math.round(stats.fast.kt * 1.852)) : '–', { sub: 'km/h', sub2: stats.fast?.name })
  drawCoverageTile(g, 7)
  topAirlines().forEach(([code, n], k) => {
    const t = panel(g, 8 + k), logo = logoByCode(code)
    txt(g, `TOP ${k + 1}`, t.l, t.y + 16, { px: 9, weight: 700, color: UI.mute })
    if (logo) drawLogo(g, logo, t.l, t.y + 23, 36)
    txt(g, code, logo ? t.l + 42 : t.l, t.y + 44, { px: logo ? 13 : 19, weight: 700, max: t.r - t.l - (logo ? 42 : 0) })
    txt(g, T.traffic(n), t.l, t.y + 74, { px: 10, weight: 600, color: UI.sub, max: t.r - t.l })
  })
  drawNavTile(g, 11, 'back', T.back, { color: UI.green })
}

function drawAirportHeader(g, i, ap, traffic) {
  const active = [...new Set(aircraft.map(approachOf).filter(p => p?.ap === ap).map(p => p.end.id))]
  const b = panel(g, i, { fill: UI.panelSel, border: UI.cyan, bw: 2 })
  txt(g, ap.iata || ap.icao, b.l, b.y + 25, { px: 19, weight: 700, color: UI.cyan })
  txt(g, ap.city || ap.name, b.l, b.y + 41, { px: 10, weight: 600, color: UI.sub, max: b.r - b.l })
  const wr = !active.length && windRunway(ap, metarOf(ap)) // no landing in sight: the runway the wind favours
  txt(g, active.length ? `${T.rwy} ${active.join(' ')}` : wr ? `${T.rwy} ${wr.id} ${T.byWind}` : runwayNames(ap), b.l, b.y + 58, { px: active.length ? 11 : wr ? 10 : 9, weight: 700, color: active.length ? UI.text : wr ? UI.sub : UI.mute, max: b.r - b.l })
  txt(g, T.traffic(traffic), b.l, b.y + 75, { px: 9, weight: 600, color: UI.mute })
  g.strokeStyle = UI.cyan; g.lineWidth = 1.8; g.lineCap = 'round'; g.beginPath(); g.moveTo(b.r - 9, b.y + 69); g.lineTo(b.r - 5, b.y + 73); g.lineTo(b.r - 1, b.y + 69); g.stroke(); g.lineCap = 'butt'
}

const currentList = () => { // watched aircraft first, then nearest first
  const l = airportMode ? airportTraffic() : visible()
  return l.some(a => a.watch) ? [...l.filter(a => a.watch), ...l.filter(a => !a.watch)] : l
}
function drawList(g) {
  const list = currentList(), ap = airportMode && airportByIcao(selAirport), wx = ap && metarOf(ap), first = ap ? (wx ? 2 : 1) : 0
  if (ap) drawAirportHeader(g, 0, ap, list.length)
  if (wx) drawWeatherTile(g, 1, ap, wx)
  list.slice(0, 12 - first).forEach((a, k) => { tileHexes[k + first] = a.hex; drawAircraftTile(g, k + first, a, ap) })
  if (!list.length) wrapText(g, ap ? T.noTraffic : T.noAircraft(RANGES[rangeIdx]), first * TILE + TILE / 2, 36, TW - 10, 14, { px: 11, weight: 600, color: UI.mute })
}

function drawCenter() {
  const g = centerCanvas.getContext('2d')
  g.fillStyle = '#000'; g.fillRect(0, 0, 360, 270)
  tileHexes = []; tileAirports = []
  const sel = aircraft.find(a => a.hex === selectedHex)
  if (statsMode && selectedHex !== statsSel) { if (selectedHex) statsMode = false; else statsSel = null } // selecting an aircraft leaves the statistics page
  if (picker) drawPicker(g)
  else if (statsMode) drawStats(g)
  else if (sel) drawDetail(g, sel)
  else drawList(g)
  if (picker || statsMode || !sel) { photoShown = null; photoLink = null } // a photo is only kept while it is on screen
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
const watchAlerted = new Map(), watchAck = new Set()
function checkAlert() {
  if (!device) return
  const rank = { info: 1, warn: 2, emerg: 3 }
  let best = null
  for (const a of aircraft) { const c = classify(a); if (c && (!best || rank[c[0]] > rank[best.c[0]])) best = { a, c } }
  // Watch list: one heads-up per aircraft and per hour, wherever it is; LED 8 stays violet until button 8 is pressed
  const now = Date.now()
  for (const a of aircraft) if (a.watch && now - (watchAlerted.get(a.hex) || 0) > 3600000) {
    watchAlerted.set(a.hex, now); watchAck.delete(a.hex)
    const msg = `${a.flight || a.hex.toUpperCase()} : ${a.watch}, ${a.alt ?? '?'} ft, ${Math.round(a.d)} km`
    console.log('Watch:', msg)
    safe(() => device.vibrate(0x53))
    if (A.ha_notify && cfg.ha_url && cfg.ha_token) notifyHA(msg)
  }
  if (watchAlerted.size > 500) watchAlerted.clear()
  const watchNow = aircraft.some(a => a.watch && !watchAck.has(a.hex))
  alertLevel = best && now > ackUntil ? best.c[0] : watchNow ? 'watch' : null
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

// LEDs: button 1 = night mode, 2 = airport picker, 3 = airport mode, 4 = statistics, 8 = alert (blinking) or watch list (violet)
let blink = false
const lastLeds = []
function updateLeds() {
  const cols = Array(7).fill('#000000') // buttons 5 to 7 are free
  if (night) cols[0] = '#400000'
  if (airports.length) cols[1] = picker ? '#00c0ff' : '#003040'
  if (airportMode) cols[2] = '#00c0ff'
  if (statsMode) cols[3] = '#00c0ff'
  const alertCol = { emerg: '#ff0000', warn: '#ff6a00', info: '#ffd000', watch: '#9000ff' }[alertLevel]
  cols.push(alertCol ? (blink || alertLevel === 'info' || alertLevel === 'watch' ? alertCol : '#000000') : '#000000')
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
  if (statsMode && selectedHex === statsSel) return JSON.stringify(['S', stats.seen.size, aircraft.length, Math.round(stats.range?.km || 0), stats.high?.alt, Math.round(stats.fast?.kt || 0), stats.peak?.n, Math.round((msgRate || 0) / 25), topAirlines(), stats.sectors])
  const sel = aircraft.find(a => a.hex === selectedHex)
  if (sel) {
    const app = approachOf(sel) // on approach the needles move, so their position is part of the signature
    return JSON.stringify([sel.hex, getInfo(sel)?.at, app && [app.end.id, Math.round(app.locDev * 20), Math.round(app.gsDev * 20), Math.round(app.along * 10)], sel.alt, sel.speed, sel.vrate, Math.round(sel.d * 10), sel.track, sel.squawk])
  }
  return JSON.stringify([airportMode, selAirport, rangeIdx, minAltFt, filterIdx, metars.get(selAirport)?.at, currentList().slice(0, 12).map(a => [a.hex, a.watch, routeOf(a)?.from.iata, routeOf(a)?.to.iata, countryOf(a), approachOf(a)?.end.id, Math.round((a.alt ?? 0) / 100), Math.round(a.d), a.track, Math.sign(Math.round((a.vrate ?? 0) / 300)), a.squawk])])
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
    else if (id === 1) { statsMode = false; togglePicker() } // button 2: airport picker
    else if (id === 2) { picker = false; setAirportMode(!airportMode) } // button 3: airport mode
    else if (id === 3) { statsMode = !statsMode; picker = false; statsSel = selectedHex } // button 4: reception statistics
    else if (id === 7) { // button 8: show the watched aircraft if there is one, and acknowledge alerts for 5 min
      const w = aircraft.find(a => a.watch && !watchAck.has(a.hex))
      if (w) { selectedHex = w.hex; picker = false; statsMode = false }
      for (const a of aircraft) if (a.watch) watchAck.add(a.hex)
      if (watchAck.size > 300) watchAck.clear()
      ackUntil = Date.now() + 5 * 60000; alertLevel = null
    }
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
    else if (id === 'e' || id === 'home') { picker = false; statsMode = false; selAirport = defaultAirport; setAirportMode(false) } // back to home
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
      else if (statsMode) { if (k === 11) statsMode = false }
      else if (selectedHex) { if (k === 11) selectedHex = null; else if ((k === 9 || k === 10) && photoLink) openPhotoPage(photoLink) }
      else if (airportMode && k === 0) togglePicker(true)
      else if (tileHexes[k]) selectedHex = tileHexes[k]
      refreshCenterNow()
    }
  })

  buildAllMaps()
  await loadAirports().catch(e => console.error('Airports:', e.message))
  loadAircraftDb()
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

process.on('SIGINT', async () => { saveStats(); try { await device?.close() } catch {} process.exit(0) })
if (DEMO) import('./tools/render-screenshots.js').then(async m => {
  await loadAirports().catch(e => console.error('Airports:', e.message))
  await loadAircraftDb()
  return m.render({ setAircraft: list => { aircraft = list }, setState, drawRadar, drawCenter, drawSide, leftCells, rightCells, knobCanvas, centerCanvas, sideCanvas, drawMap, infoCache, trails, cfg, toRad, offsetPt, getAirports: () => airports })
})
else main().catch(e => { console.error('Error:', e.message); process.exit(1) })

// State setter used by the screenshot tool
function setState(st) {
  if ('selectedHex' in st) { selectedHex = st.selectedHex; lastSelected = st.selectedHex; follow = st.follow ?? true }
  for (const [k, set] of Object.entries({
    rangeIdx: v => { rangeIdx = v }, filterIdx: v => { filterIdx = v }, labelsMax: v => { labelsMax = v }, sweep: v => { sweep = v },
    spotIdx: v => { spotIdx = v; spotAt = Date.now() }, blink: v => { blink = v }, view: v => { view = v }, selAirport: v => { selAirport = v },
    airportMode: v => { airportMode = v }, picker: v => { picker = v }, statsMode: v => { statsMode = v; statsSel = selectedHex }, stats: v => { stats = { ...newDay(), ...v, seen: new Map(v.seen) }; record = v.record; msgRate = v.msgRate }, pickerPage: v => { pickerPage = v }, minAltFt: v => { minAltFt = v },
  })) if (k in st) set(st[k])
}
