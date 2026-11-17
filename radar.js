// Loupedeck CT ADS-B radar
// Turns a Loupedeck CT into a live aircraft radar fed by a tar1090 / dump1090 receiver.
//   Wheel screen  : radar over a satellite map, trails, spotlight banner, overflight prediction
//   Centre screen : 12 tiles aligned with the physical grid (aircraft list or detail card)
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
  en: { filters: ['ALL', 'MILITARY', 'HELICOPTERS', 'LOW ALT.', 'AIRPORT', 'HEAVIES', 'OVERHEAD'], follow: 'FOLLOW', ground: 'GND',
    military: 'MILITARY', from: 'FROM', to: 'TO', airline: 'AIRLINE', altitude: 'ALTITUDE', speed: 'SPEED', vs: 'V/S', aircraft: 'AIRCRAFT',
    heading: 'HEADING', distance: 'DISTANCE', squawk: 'SQUAWK', back: '← Back', unknown: 'unknown', noAircraft: r => `No aircraft within ${r} km`,
    kmAt: b => `km at ${b}°`, altMin: 'MIN ALT', none: 'none', filter: 'FILTER', bright: 'BRIGHTN.', labels: 'LABELS', trails: 'TRAILS', map: 'MAP',
    overflight: t => `Overhead ${t} min`, at: d => `${d} km`, locale: 'en-GB' },
  fr: { filters: ['TOUS', 'MILITAIRES', 'HELICOS', 'BASSE ALT.', 'AEROPORT', 'GROS PORTEURS', 'AU-DESSUS'], follow: 'SUIVI', ground: 'SOL',
    military: 'MILITAIRE', from: 'DEPART', to: 'ARRIVEE', airline: 'COMPAGNIE', altitude: 'ALTITUDE', speed: 'VITESSE', vs: 'V/S', aircraft: 'APPAREIL',
    heading: 'CAP', distance: 'DISTANCE', squawk: 'SQUAWK', back: '← Retour', unknown: 'inconnu', noAircraft: r => `Aucun avion dans ${r} km`,
    kmAt: b => `km au ${b}°`, altMin: 'ALT MIN', none: 'aucun', filter: 'FILTRE', bright: 'LUMINOS.', labels: 'ETIQUETTES', trails: 'TRAINEES', map: 'CARTE',
    overflight: t => `Survol ${t} min`, at: d => `à ${d} km`, locale: 'fr-FR' },
}
const T = STRINGS[cfg.language] || STRINGS.en
const RANGES = cfg.ranges_km

// ---------- Font: register a Windows UI font explicitly (otherwise the canvas falls back to a serif font)
const FONT_SETS = {
  segoe: ['C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/seguisb.ttf', 'C:/Windows/Fonts/segoeuib.ttf'],
  bahnschrift: ['C:/Windows/Fonts/bahnschrift.ttf'],
  arial: ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/arialbd.ttf'],
}
let FONT = 'sans-serif'
for (const name of [cfg.font || 'segoe', 'segoe', 'arial']) {
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
let follow = true                            // the view follows the selected aircraft
let lastSelected = null
let lostSince = 0
function goHome() { view = { lat: cfg.lat, lon: cfg.lon } }
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

// Filters (cycled with the middle-left knob)
const FILTERS = [
  { name: T.filters[0], color: '#2060ff', test: () => true },
  { name: T.filters[1], color: '#30c030', test: a => isMilitary(a) },
  { name: T.filters[2], color: '#ff40ff', test: a => a.category === 'A7' || /^H/.test(a.type) },
  { name: T.filters[3], color: '#ff8000', test: a => !a.ground && a.alt != null && a.alt < 10000 },
  AIRPORT && { name: AIRPORT.name, color: '#00e0e0', test: a => a.alt != null && a.alt < AIRPORT.below_ft && kmBetween(a, AIRPORT) < AIRPORT.radius_km },
  { name: T.filters[5], color: '#ffff00', test: a => a.category === 'A5' },
  { name: T.filters[6], color: '#ffffff', test: a => a.d < 8 },
].filter(Boolean)


// ---------- Airline, route, aircraft (api.adsbdb.com, free, no key) ----------
const ICAO_COUNTRIES = [['008000','00FFFF','ZA'],['010000','017FFF','EG'],['018000','01FFFF','LY'],['020000','027FFF','MA'],['028000','02FFFF','TN'],['0A0000','0A7FFF','DZ'],['06A000','06A3FF','QA'],['300000','33FFFF','IT'],['340000','37FFFF','ES'],['380000','3BFFFF','FR'],['3C0000','3FFFFF','DE'],['400000','43FFFF','GB'],['440000','447FFF','AT'],['448000','44FFFF','BE'],['450000','457FFF','BG'],['458000','45FFFF','DK'],['460000','467FFF','FI'],['468000','46FFFF','GR'],['470000','477FFF','HU'],['478000','47FFFF','NO'],['480000','487FFF','NL'],['488000','48FFFF','PL'],['490000','497FFF','PT'],['498000','49FFFF','CZ'],['4A0000','4A7FFF','RO'],['4A8000','4AFFFF','SE'],['4B0000','4B7FFF','CH'],['4B8000','4BFFFF','TR'],['4C0000','4C7FFF','RS'],['4CA000','4CAFFF','IE'],['4D0000','4D03FF','LU'],['4D2000','4D23FF','MT'],['501C00','501FFF','HR'],['502C00','502FFF','LV'],['503C00','503FFF','LT'],['505C00','505FFF','SI'],['506000','5063FF','SK'],['508000','50FFFF','UA'],['510000','5103FF','BY'],['600000','6003FF','AM'],['683000','6833FF','KZ'],['700000','700FFF','AF'],['710000','717FFF','SA'],['738000','73FFFF','IL'],['740000','7407FF','JO'],['748000','7487FF','LB'],['750000','757FFF','MY'],['760000','767FFF','PK'],['768000','76FFFF','SG'],['780000','7BFFFF','CN'],['7C0000','7FFFFF','AU'],['800000','83FFFF','IN'],['840000','87FFFF','JP'],['880000','887FFF','TH'],['896000','896FFF','AE'],['8A0000','8A7FFF','ID'],['A00000','AFFFFF','US'],['C00000','C3FFFF','CA'],['E40000','E7FFFF','BR'],['140000','15FFFF','RU'],['0D0000','0D7FFF','MX']].map(([a, b, c]) => [parseInt(a, 16), parseInt(b, 16), c])
const regCountry = hex => { const h = parseInt(hex, 16); return (ICAO_COUNTRIES.find(([lo, hi]) => h >= lo && h <= hi) || [])[2] || '' }

const INFO_FILE = new URL('./infos-cache.json', import.meta.url)
let infoCache = {}
try { infoCache = JSON.parse(readFileSync(INFO_FILE)) } catch {}
for (const k of Object.keys(infoCache)) if (infoCache[k].v !== 2) delete infoCache[k] // drop entries from older versions (routes without position check)
let infoDirty = false
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
    infoCache[infoKey(a)] = { at: Date.now() - 1.5 * 3600000 } // retry in 30 min
    if (cfg.debug) console.error('Info lookup:', e.message)
  }
}
if (!DEMO) setInterval(processInfoQueue, 1200)
if (!DEMO) setInterval(() => { if (infoDirty) { infoDirty = false; try { writeFileSync(INFO_FILE, JSON.stringify(infoCache)) } catch {} } }, 30000)
const countryOf = a => getInfo(a)?.airline?.iso || getInfo(a)?.aircraft?.country || regCountry(a.hex)

// ---------- RGB565 conversion ----------
function toRGB565(canvas, bigEndian) {
  const { width, height } = canvas
  const px = canvas.getContext('2d').getImageData(0, 0, width, height).data
  const buf = Buffer.alloc(width * height * 2)
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
const mapCanvas = createCanvas(240, 240)
function drawMap(idx = rangeIdx, center = view) {
  const g = mapCanvas.getContext('2d')
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
  return { canvas: mapCanvas, complete }
}
// Preload the home tiles for every range
async function buildAllMaps() {
  if (!MAP.enabled) return
  for (const i of RANGES.keys()) {
    for (let tries = 0; tries < 30; tries++) { if (drawMap(i, { lat: cfg.lat, lon: cfg.lon }).complete) break; await new Promise(r => setTimeout(r, 300)) }
    console.log(`Map ${RANGES[i]} km ready`)
  }
}

// ---------- Wheel screen: radar ----------
const knobCanvas = createCanvas(240, 240)
function plotXY(a) {
  const K = pxPerZ0(RANGES[rangeIdx])
  return [C + (z0x(a.lon) - z0x(view.lon)) * K, C + (z0y(a.lat) - z0y(view.lat)) * K]
}

function drawRadar() {
  const g = knobCanvas.getContext('2d')
  updateFollow()
  g.drawImage(drawMap().canvas, 0, 0)

  // Sweep
  const sw = toRad(sweep)
  for (let i = 0; i < 30; i++) {
    const a0 = sw - toRad(i + 1), a1 = sw - toRad(i)
    g.fillStyle = `rgba(0,255,90,${0.18 * (1 - i / 30)})`
    g.beginPath(); g.moveTo(C, C)
    g.arc(C, C, RMAX, a0 - Math.PI / 2, a1 - Math.PI / 2)
    g.closePath(); g.fill()
  }

  // Range rings and axes
  g.strokeStyle = 'rgba(0,230,90,0.6)'; g.lineWidth = 1
  for (let k = 1; k <= 3; k++) { g.beginPath(); g.arc(C, C, RMAX * k / 3, 0, Math.PI * 2); g.stroke() }
  g.strokeStyle = 'rgba(0,230,90,0.3)'
  g.beginPath(); g.moveTo(C, C - RMAX); g.lineTo(C, C + RMAX); g.moveTo(C - RMAX, C); g.lineTo(C + RMAX, C); g.stroke()
  g.fillStyle = 'rgba(0,255,100,0.95)'; g.font = `bold 11px ${FONT}`; g.textAlign = 'center'
  g.fillText('N', C, 12)
  g.font = `10px ${FONT}`; g.textAlign = 'left'
  g.fillText(`${RANGES[rangeIdx]} km`, C + 3, C - RMAX + 22)
  if (selectedHex && follow) { g.textAlign = 'right'; g.font = `bold 9px ${FONT}`; g.fillStyle = '#fff'; g.fillText(T.follow, C - 4, C - RMAX + 22) }
  if (filterIdx) { g.textAlign = 'center'; g.font = `bold 9px ${FONT}`; g.fillStyle = FILTERS[filterIdx].color; g.fillText(FILTERS[filterIdx].name, C, 24) }

  const list = visible()
  // Trails
  if (trailMin > 0) {
    const now = Date.now()
    for (const a of list) {
      const tr = trails.get(a.hex); if (!tr || tr.length < 2) continue
      const pts = tr.filter(p => now - p.t <= trailMin * 60000)
      const col = altColor(a.alt).replace('rgb(', 'rgba(').replace(')', ',')
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = plotXY(pts[i - 1]), [x1, y1] = plotXY(pts[i])
        g.strokeStyle = col.startsWith('rgba') ? `${col}${(0.15 + 0.75 * i / pts.length).toFixed(2)})` : col
        g.lineWidth = 1.5
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke()
      }
    }
  }
  // Aircraft
  for (const a of list) {
    const [x, y] = plotXY(a)
    const emerg = isEmergency(a.squawk)
    const col = altColor(a.alt)
    if (emerg) { // red distress outline, pulsing from frame to frame
      const r = blink ? 13 : 10
      g.strokeStyle = '#ff1a1a'; g.lineWidth = 2
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke()
      g.strokeStyle = 'rgba(255,26,26,0.45)'; g.lineWidth = 1
      g.beginPath(); g.arc(x, y, r + 4, 0, Math.PI * 2); g.stroke()
    }
    g.save(); g.translate(x, y)
    g.globalAlpha = a.seenPos > 20 ? 0.45 : 1
    // outline: red in distress, dark otherwise (readability over the map)
    g.strokeStyle = emerg ? '#ff1a1a' : 'rgba(0,0,0,0.8)'; g.lineWidth = 2; g.fillStyle = col
    if (a.track != null) {
      g.rotate(toRad(a.track))
      g.beginPath(); g.moveTo(0, -7); g.lineTo(5, 6); g.lineTo(0, 3); g.lineTo(-5, 6); g.closePath(); g.stroke(); g.fill()
    } else {
      g.beginPath(); g.arc(0, 0, 3.5, 0, Math.PI * 2); g.stroke(); g.fill()
    }
    g.restore()
    if (a.hex === selectedHex) {
      g.strokeStyle = '#fff'; g.lineWidth = 1.5
      g.beginPath(); g.arc(x, y, 10, 0, Math.PI * 2); g.stroke()
    }
  }
  g.font = `bold 9px ${FONT}`; g.textAlign = 'left'
  for (const a of list.slice().sort((p, q) => kmBetween(p, view) - kmBetween(q, view)).slice(0, labelsMax)) {
    if (!a.flight) continue
    const [x, y] = plotXY(a)
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(a.flight, x + 7, y - 5)
    g.fillStyle = '#fff'; g.fillText(a.flight, x + 7, y - 5)
  }
  drawSpotlight(g, list)
  const [hx, hy] = plotXY({ lat: cfg.lat, lon: cfg.lon })
  g.fillStyle = '#ff3b3b'; g.beginPath(); g.arc(hx, hy, 3, 0, Math.PI * 2); g.fill()
  if (view.lat !== cfg.lat || view.lon !== cfg.lon) { g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.moveTo(C - 4, C); g.lineTo(C + 4, C); g.moveTo(C, C - 4); g.lineTo(C, C + 4); g.stroke() }
  return toRGB565(knobCanvas, true)
}

// Spotlight banner: one aircraft at a time, at the bottom of the wheel screen
function drawSpotlight(g, list) {
  if (cfg.spotlight === false) return
  let a = aircraft.find(p => p.hex === selectedHex)
  const nx = nextOverflight()
  if (!a && nx && nx.o.t <= (cfg.overflight?.spotlight_min ?? 5)) a = nx.a   // an imminent overflight takes over the banner
  if (!a) {
    const pool = list.slice().sort((p, q) => kmBetween(p, view) - kmBetween(q, view)).slice(0, cfg.spotlight_count ?? 8)
    if (!pool.length) return
    if (Date.now() - spotAt > (cfg.spotlight_sec ?? 4) * 1000) { spotIdx = (spotIdx + 1) % pool.length; spotAt = Date.now() }
    a = pool[spotIdx % pool.length]
  }
  const info = getInfo(a) || {}
  const [x, y] = plotXY(a)
  const col = isEmergency(a.squawk) ? '#ff2020' : altColor(a.alt)
  // marker around the aircraft
  if (a.hex !== selectedHex && x > 0 && x < 240 && y > 0 && y < 240) {
    g.strokeStyle = col; g.lineWidth = 1.5; g.setLineDash([3, 3])
    g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.stroke(); g.setLineDash([])
  }
  // banner
  const bx = 56, by = 188, bw = 128, bh = 34
  g.fillStyle = 'rgba(0,0,0,0.72)'
  g.beginPath(); g.roundRect(bx, by, bw, bh, 8); g.fill()
  g.fillStyle = col; g.fillRect(bx + 6, by + 5, 3, bh - 10)
  const name = a.flight || a.hex.toUpperCase()
  const iso = countryOf(a)
  g.textAlign = 'left'; g.fillStyle = '#fff'; g.font = `bold 12px ${FONT}`
  g.fillText(name, bx + 14, by + 15)
  if (iso) { g.textAlign = 'right'; g.fillStyle = '#fd5'; g.font = `bold 10px ${FONT}`; g.fillText(iso, bx + bw - 8, by + 15) }
  const alt = a.ground ? T.ground : a.alt != null ? `FL${String(Math.round(a.alt / 100)).padStart(3, '0')}` : ''
  const ov = overflight(a)
  if (ov) { // predicted path to the overflight point
    const [px, py] = plotXY(ov)
    g.strokeStyle = 'rgba(255,214,0,0.85)'; g.lineWidth = 1.2; g.setLineDash([2, 3])
    g.beginPath(); g.moveTo(x, y); g.lineTo(px, py); g.stroke(); g.setLineDash([])
    g.fillStyle = '#ffd600'; g.beginPath(); g.arc(px, py, 2, 0, Math.PI * 2); g.fill()
  }
  const mid = ov ? T.overflight(ov.t < 1 ? '<1' : Math.round(ov.t))
    : info.route ? `${info.route.from.iata} › ${info.route.to.iata}` : (info.aircraft?.type || `${a.d.toFixed(0)} km`)
  const right = ov ? T.at(ov.d.toFixed(1)) : alt
  g.textAlign = 'right'; g.fillStyle = ov ? '#ffd600' : col; g.font = `bold 10px ${FONT}`; g.fillText(right, bx + bw - 8, by + 28)
  const rw = g.measureText(right).width
  g.textAlign = 'left'; g.fillStyle = ov ? '#ffd600' : '#cde'
  fitText(g, mid, bw - 22 - rw - 6, 10, ov ? 'bold' : 'normal')
  g.fillText(mid, bx + 14, by + 28)
  if (a.hex !== selectedHex) wantInfo(a, true)
}

// ---------- Centre screen: 12 tiles of 90x90 aligned with the physical grid ----------
const centerCanvas = createCanvas(360, 270)
const TILE = 90, PAD = 5
let tileHexes = [] // aircraft shown on each tile in list mode

function tileOrigin(i) { return [(i % 4) * TILE, Math.floor(i / 4) * TILE] }
function fitText(g, text, maxW, size, weight = 'bold') {
  let s = size
  do { g.font = `${weight} ${s}px ${FONT}` } while (g.measureText(text).width > maxW && --s > 8)
}

function drawListTile(g, i, a) {
  const [x0, y0] = tileOrigin(i)
  const x = x0 + PAD, y = y0 + PAD, w = TILE - 2 * PAD
  if (!a) return
  const emerg = isEmergency(a.squawk)
  g.fillStyle = emerg ? '#4a0000' : '#0d1418'; g.fillRect(x, y, w, w)
  g.fillStyle = emerg ? '#ff2020' : altColor(a.alt); g.fillRect(x, y, w, 5)
  if (emerg) { g.strokeStyle = '#ff1a1a'; g.lineWidth = 3; g.strokeRect(x + 1.5, y + 1.5, w - 3, w - 3) }
  else if (a.hex === selectedHex) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, w - 2, w - 2) }
  const info = getInfo(a)
  g.textAlign = 'center'; g.fillStyle = '#fff'
  const name = a.flight || a.hex.toUpperCase()
  fitText(g, name, w - 6, 15); g.fillText(name, x + w / 2, y + 23)
  // line 2: flight level + country
  g.textAlign = 'left'; g.fillStyle = altColor(a.alt); g.font = `bold 13px ${FONT}`
  g.fillText(a.ground ? T.ground : a.alt != null ? `FL${String(Math.round(a.alt / 100)).padStart(3, '0')}` : '---', x + 4, y + 41)
  const iso = countryOf(a)
  if (iso) { g.textAlign = 'right'; g.fillStyle = '#fd5'; g.font = `bold 12px ${FONT}`; g.fillText(iso, x + w - 4, y + 41) }
  // line 3: route
  g.textAlign = 'center'
  if (info?.route) { g.fillStyle = '#cde'; fitText(g, `${info.route.from.iata}›${info.route.to.iata}`, w - 4, 13); g.fillText(`${info.route.from.iata}›${info.route.to.iata}`, x + w / 2, y + 59) }
  else if (info?.aircraft?.type) { g.fillStyle = '#789'; g.font = `12px ${FONT}`; g.fillText(info.aircraft.type, x + w / 2, y + 59) }
  // line 4: distance + heading
  g.fillStyle = '#9ab'; g.font = `11px ${FONT}`
  g.fillText(`${a.d < 10 ? a.d.toFixed(1) : Math.round(a.d)} km`, x + w / 2 - 8, y + 76)
  if (a.track != null) {
    g.save(); g.translate(x + w - 12, y + 72); g.rotate(toRad(a.track)); g.fillStyle = '#9ab'
    g.beginPath(); g.moveTo(0, -5); g.lineTo(3.5, 4); g.lineTo(0, 2); g.lineTo(-3.5, 4); g.closePath(); g.fill(); g.restore()
  }
}

function drawInfoTile(g, i, label, value, color = '#fff', sub = '') {
  const [x0, y0] = tileOrigin(i)
  const x = x0 + PAD, y = y0 + PAD, w = TILE - 2 * PAD
  g.fillStyle = '#0d1418'; g.fillRect(x, y, w, w)
  g.textAlign = 'center'
  g.fillStyle = '#6b7b86'; g.font = `11px ${FONT}`; g.fillText(label, x + w / 2, y + 16)
  g.fillStyle = color; fitText(g, value, w - 6, 22); g.fillText(value, x + w / 2, y + 50)
  if (sub) { g.fillStyle = '#9ab'; fitText(g, sub, w - 6, 12, 'normal'); g.fillText(sub, x + w / 2, y + 70) }
}

function drawCenter() {
  const g = centerCanvas.getContext('2d')
  g.fillStyle = '#000'; g.fillRect(0, 0, 360, 270)
  const sel = aircraft.find(a => a.hex === selectedHex)
  if (sel) {
    const info = getInfo(sel) || {}
    const col = isEmergency(sel.squawk) ? '#ff2020' : altColor(sel.alt)
    const [x0, y0] = tileOrigin(0), w = TILE - 2 * PAD
    g.fillStyle = '#0d1418'; g.fillRect(x0 + PAD, y0 + PAD, w, w)
    g.fillStyle = col; g.fillRect(x0 + PAD, y0 + PAD, w, 5)
    if (isEmergency(sel.squawk)) { g.strokeStyle = '#ff1a1a'; g.lineWidth = 3; g.strokeRect(x0 + PAD + 1.5, y0 + PAD + 1.5, w - 3, w - 3) }
    g.textAlign = 'center'; g.fillStyle = '#fff'
    const name = sel.flight || sel.hex.toUpperCase()
    fitText(g, name, w - 6, 18); g.fillText(name, x0 + TILE / 2, y0 + 38)
    const iso = countryOf(sel)
    g.fillStyle = '#fd5'; g.font = `bold 14px ${FONT}`; g.fillText(iso || '', x0 + TILE / 2, y0 + 60)
    g.fillStyle = '#789'; g.font = `10px ${FONT}`; g.fillText(isMilitary(sel) ? T.military : '', x0 + TILE / 2, y0 + 77)

    const r = info.route, al = info.airline, ac = info.aircraft
    drawInfoTile(g, 1, T.from, r ? r.from.iata : '?', '#cde', r ? `${r.from.city || ''} ${r.from.iso || ''}`.trim() : T.unknown)
    drawInfoTile(g, 2, T.to, r ? r.to.iata : '?', '#cde', r ? `${r.to.city || ''} ${r.to.iso || ''}`.trim() : T.unknown)
    drawInfoTile(g, 3, T.airline, al ? (al.iata || al.name) : (ac?.owner ? ac.owner.split(' ')[0] : '?'), '#fff', al ? `${al.name}` : (ac?.owner || ''))
    drawInfoTile(g, 4, T.altitude, sel.ground ? T.ground : sel.alt != null ? `${sel.alt.toLocaleString(T.locale)}` : '?', col, sel.alt != null ? `ft · ${Math.round(sel.alt * 0.3048).toLocaleString(T.locale)} m` : '')
    drawInfoTile(g, 5, T.speed, sel.speed != null ? `${Math.round(sel.speed * 1.852)}` : '?', '#fff', sel.speed != null ? `km/h · ${Math.round(sel.speed)} kt` : '')
    drawInfoTile(g, 6, T.vs, sel.vrate != null ? `${sel.vrate > 0 ? '+' : ''}${sel.vrate}` : '?', sel.vrate > 300 ? '#7f7' : sel.vrate < -300 ? '#fa5' : '#fff', 'ft/min')
    drawInfoTile(g, 7, T.aircraft, ac?.type || sel.type || '?', '#fff', ac?.reg || '')
    drawInfoTile(g, 8, T.heading, sel.track != null ? `${Math.round(sel.track)}°` : '?')
    drawInfoTile(g, 9, T.distance, `${sel.d.toFixed(1)}`, '#fff', T.kmAt(Math.round(sel.brg)))
    drawInfoTile(g, 10, T.squawk, sel.squawk || '----', isEmergency(sel.squawk) ? '#ff4040' : '#fff', sel.hex.toUpperCase())
    drawInfoTile(g, 11, '', T.back, '#8fa')
    tileHexes = []
  } else {
    const list = visible().slice(0, 12)
    tileHexes = list.map(a => a.hex)
    list.forEach((a, i) => drawListTile(g, i, a))
    if (!list.length) { g.fillStyle = '#6b7b86'; g.font = `16px ${FONT}`; g.textAlign = 'center'; g.fillText(T.noAircraft(RANGES[rangeIdx]), 180, 140) }
  }
  return toRGB565(centerCanvas, false)
}

// ---------- Side strips 60x270 (one 90 px cell per knob) ----------
const sideCanvas = createCanvas(60, 270)
function drawSide(cells) {
  const g = sideCanvas.getContext('2d')
  g.fillStyle = '#000'; g.fillRect(0, 0, 60, 270)
  cells.forEach(([label, value, color = '#fff'], i) => {
    const y = i * 90
    g.textAlign = 'center'
    g.fillStyle = '#6b7b86'; g.font = `10px ${FONT}`; g.fillText(label, 30, y + 34)
    g.fillStyle = color; fitText(g, value, 54, 15); g.fillText(value, 30, y + 56)
  })
  return toRGB565(sideCanvas, false)
}
function leftCells() {
  return [[T.altMin, minAltFt ? `${minAltFt / 1000}k ft` : T.none, minAltFt ? '#fd5' : '#9ab'], [T.filter, FILTERS[filterIdx].name, FILTERS[filterIdx].color], [T.bright, `${Math.round(brightness * 100)}%`]]
}
function rightCells() {
  return [[T.labels, String(labelsMax), '#fff'], [T.trails, trailMin ? `${trailMin} min` : 'off', trailMin ? '#8fa' : '#9ab'], [T.map, `${Math.round(mapBright * 100)}%`, '#fff']]
}
function drawRightLegend() { return drawSide(rightCells()) }

// ---------- Alerts ----------
// Alerts: emergency (red), low military nearby (orange), low aircraft overhead / imminent overflight (yellow)
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
    if (best.c[0] !== 'info') { selectedHex = a.hex; refreshCenterNow() }
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

// LEDs: button 1 = night mode, button 8 = alert (blinking)
let blink = false, lastLeds = ''
function updateLeds() {
  blink = !blink
  const cols = Array(7).fill('#000000') // buttons 2 to 7 are free
  if (night) cols[0] = '#400000'          // button 1 = night mode
  const alertCol = { emerg: '#ff0000', warn: '#ff6a00', info: '#ffd000' }[alertLevel]
  cols.push(alertCol ? (blink || alertLevel === 'info' ? alertCol : '#000000') : '#000000')
  const sig = cols.join()
  if (sig === lastLeds) return
  lastLeds = sig
  cols.forEach((color, id) => safe(() => device.setButtonColor({ id, color })))
}

// ---------- Rendering (sequential: the wheel screen does not like being flooded) ----------
const withTimeout = (p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`screen timeout: ${what}`)), 3000))])
const lastSig = { center: '', left: '', right: '' }
let lastCenterAt = 0
function centerSig() {
  const sel = aircraft.find(a => a.hex === selectedHex)
  if (sel) return JSON.stringify([sel.hex, !!getInfo(sel), sel.alt, sel.speed, sel.vrate, Math.round(sel.d * 10), sel.track, Math.round(sel.seenPos / 5)])
  return JSON.stringify([rangeIdx, minAltFt, filterIdx, visible().slice(0, 12).map(a => [a.hex, !!getInfo(a)?.route, countryOf(a), Math.round((a.alt ?? 0) / 100), Math.round(a.d), a.track])])
}
async function render() {
  if (!device || busy) return
  busy = true
  try {
    sweep = (sweep + cfg.sweep_deg_per_frame) % 360
    await withTimeout(device.drawBuffer({ id: 'knob', width: 240, height: 240 }, drawRadar()), 'wheel')
    const sig = centerSig()
    if (sig !== lastSig.center && Date.now() - lastCenterAt > (cfg.center_min_ms ?? 1500) || cfg._forceCenter) {
      cfg._forceCenter = false; lastSig.center = sig; lastCenterAt = Date.now()
      await withTimeout(device.drawBuffer({ id: 'center', width: 360, height: 270 }, drawCenter()), 'centre')
    }
    const ls = JSON.stringify(leftCells())
    if (ls !== lastSig.left) { lastSig.left = ls; await withTimeout(device.drawBuffer({ id: 'left', width: 60, height: 270 }, drawSide(leftCells())), 'left') }
    const rs = JSON.stringify(rightCells())
    if (rs !== lastSig.right) { lastSig.right = rs; await withTimeout(device.drawBuffer({ id: 'right', width: 60, height: 270 }, drawRightLegend()), 'right') }
    updateLeds()
    if (!render.first) { render.first = true; console.log('First frames sent') }
  } catch (e) {
    console.error('Render:', e.message)
  } finally { busy = false }
}
const refreshCenterNow = () => { cfg._forceCenter = true }

function selectNearestTo(x, y) {
  let best = null, bd = 1e9
  for (const a of visible()) {
    const [px, py] = plotXY(a)
    const d = (px - x) ** 2 + (py - y) ** 2
    if (d < bd) { bd = d; best = a }
  }
  selectedHex = best && bd < 30 ** 2 ? best.hex : null
  refreshCenterNow()
}

function cycleSelection() {
  const list = visible()
  if (!list.length) { selectedHex = null; return }
  const i = list.findIndex(a => a.hex === selectedHex)
  selectedHex = i + 1 >= list.length ? null : list[i + 1].hex
  refreshCenterNow()
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
    if (id === 'knobCT') rangeIdx = clamp(rangeIdx + delta, 0, RANGES.length - 1)
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
    refreshCenterNow()
  }
  device.on('down', ({ id }) => {
    if (id === 0) { // button 1: night mode
      night = !night
      if (night) { dayBrightness = brightness; brightness = cfg.night_brightness ?? 0.3 } else brightness = dayBrightness
      safe(() => device.setBrightness(brightness))
      lastSig.center = lastSig.left = lastSig.right = ''; refreshCenterNow()
    }
    else if (id === 7) { ackUntil = Date.now() + 5 * 60000; alertLevel = null }   // acknowledge alerts for 5 min
    else if (id === 'knobCT') cycleSelection()
    else if (id === 'knobTL') { minAltFt = 0; refreshCenterNow() }
    else if (id === 'knobCL') { filterIdx = 0; refreshCenterNow() }
    else if (id === 'knobTR') labelsMax = cfg.labels_max ?? 6
    else if (id === 'knobCR') trailMin = trailMin ? 0 : (cfg.trail_minutes ?? 3)
    else if (id === 'knobBR') mapBright = cfg.map?.brightness ?? 0.75
    else if (id === 'a') pan(0, -1)
    else if (id === 'b') pan(0, 1)
    else if (id === 'c') pan(-1, 0)
    else if (id === 'd') pan(1, 0)
    else if (id === 'e' || id === 'home') { follow = false; view = { lat: cfg.lat, lon: cfg.lon }; selectedHex = null; lastSelected = null; refreshCenterNow() }
  })
  device.on('touchstart', ({ changedTouches }) => {
    const t = changedTouches[0]
    if (cfg.debug) console.log('touch', JSON.stringify({ x: t.x, y: t.y, target: t.target }))
    if (t.target?.screen === 'knob') selectNearestTo(t.x, t.y)
    else if (t.target?.screen === 'center') {
      const k = t.target.key
      if (selectedHex) { if (k === 11 || k === 0) selectedHex = null }
      else if (tileHexes[k]) selectedHex = tileHexes[k]
      refreshCenterNow()
    }
  })

  buildAllMaps()
  await poll()
  setInterval(poll, cfg.poll_ms)
  setInterval(render, 1000 / cfg.fps)
  console.log('Radar running. Ctrl+C to quit.')
}

process.on('SIGINT', async () => { try { await device?.close() } catch {} process.exit(0) })
if (DEMO) import('./tools/render-screenshots.js').then(m => m.render({ setAircraft: list => { aircraft = list }, setState, drawRadar, drawCenter, drawSide, leftCells, rightCells, knobCanvas, centerCanvas, sideCanvas, drawMap, infoCache, trails, cfg, toRad }))
else main().catch(e => { console.error('Error:', e.message); process.exit(1) })

// State setter used by the screenshot tool
function setState(st) {
  if ('selectedHex' in st) { selectedHex = st.selectedHex; lastSelected = st.selectedHex; follow = st.follow ?? true }
  if ('rangeIdx' in st) rangeIdx = st.rangeIdx
  if ('filterIdx' in st) filterIdx = st.filterIdx
  if ('labelsMax' in st) labelsMax = st.labelsMax
  if ('sweep' in st) sweep = st.sweep
  if ('spotIdx' in st) { spotIdx = st.spotIdx; spotAt = Date.now() }
  if ('blink' in st) blink = st.blink
  if ('view' in st) view = st.view
}
