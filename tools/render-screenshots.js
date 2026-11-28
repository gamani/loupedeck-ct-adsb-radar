// Renders the README screenshots with fictitious demo traffic around Frankfurt (no device needed).
// Usage: node radar.js --screenshots        (English UI)
//        node radar.js --screenshots --fr   (French UI)
// Map tiles (Esri) and airport data (OurAirports) are downloaded, so an internet connection is required.
import { createCanvas } from '@napi-rs/canvas'
import { writeFileSync, mkdirSync } from 'node:fs'

// Fictitious traffic: positions relative to the demo home (km east, km north)
const DEMO = [
  { hex: '3c6586', flight: 'DLH4AB', x: 6, y: 14, alt: 6200, track: 250, speed: 230, vrate: -1100, cat: 'A3', type: 'A321', reg: 'D-AISA', al: ['LH', 'Lufthansa', 'DE'], from: ['MUC', 'Munich', 'DE'], to: ['FRA', 'Frankfurt', 'DE'] },
  { hex: '4ca7b1', flight: 'RYR82KD', x: -21, y: 9, alt: 31000, track: 115, speed: 440, vrate: 0, cat: 'A3', type: 'B38M', reg: 'EI-HEN', al: ['FR', 'Ryanair', 'IE'], from: ['DUB', 'Dublin', 'IE'], to: ['BUD', 'Budapest', 'HU'] },
  { hex: '4d0113', flight: 'LGL8012', x: 30, y: -24, alt: 18500, track: 25, speed: 330, vrate: 1500, cat: 'A2', type: 'DH8D', reg: 'LX-LQA', al: ['LG', 'Luxair', 'LU'], from: ['LUX', 'Luxembourg', 'LU'], to: ['MUC', 'Munich', 'DE'] },
  { hex: '39bdb7', flight: 'AFR1418', x: -38, y: -12, alt: 36000, track: 70, speed: 470, vrate: 0, cat: 'A3', type: 'A20N', reg: 'F-HPNB', al: ['AF', 'Air France', 'FR'], from: ['CDG', 'Paris', 'FR'], to: ['WAW', 'Warsaw', 'PL'] },
  { hex: '896439', flight: 'UAE45', x: 44, y: 31, alt: 38000, track: 290, speed: 500, vrate: 0, cat: 'A5', type: 'A388', reg: 'A6-EUD', al: ['EK', 'Emirates', 'AE'], from: ['DXB', 'Dubai', 'AE'], to: ['LHR', 'London', 'GB'] },
  { hex: '3e8f21', flight: 'CHX12', x: -7, y: -5, alt: 1800, track: 330, speed: 110, vrate: 400, cat: 'A7', type: 'EC35', reg: 'D-HDSB', al: null, from: null, to: null },
  { hex: '3f4a12', flight: 'GAF618', x: -15, y: 26, alt: 7500, track: 160, speed: 300, vrate: -800, cat: 'A3', type: 'A400', reg: '54+12', al: null, from: null, to: null },
  { hex: '4bab23', flight: 'THY1594', x: 28, y: -38, alt: 35000, track: 305, speed: 460, vrate: 0, cat: 'A3', type: 'A21N', reg: 'TC-LSA', al: ['TK', 'Turkish Airlines', 'TR'], from: ['IST', 'Istanbul', 'TR'], to: ['AMS', 'Amsterdam', 'NL'] },
  { hex: '406d7b', flight: 'BAW904', x: -42, y: 30, alt: 22000, track: 105, speed: 410, vrate: -1500, cat: 'A3', type: 'A320', reg: 'G-EUUA', al: ['BA', 'British Airways', 'GB'], from: ['LHR', 'London', 'GB'], to: ['FRA', 'Frankfurt', 'DE'] },
  { hex: '49d2c4', flight: 'NJE7FA', x: 22, y: 30, alt: 37000, track: 220, speed: 440, vrate: 0, cat: 'A1', type: 'C68A', reg: 'CS-LTA', al: ['1I', 'NetJets Europe', 'PT'], from: ['HAM', 'Hamburg', 'DE'], to: ['NCE', 'Nice', 'FR'] },
  { hex: '4d2403', flight: 'WZZ3TK', x: -34, y: -41, alt: 33000, track: 40, speed: 450, vrate: 500, cat: 'A3', type: 'A21N', reg: 'HA-LVA', al: ['W6', 'Wizz Air', 'HU'], from: ['LIS', 'Lisbon', 'PT'], to: ['GDN', 'Gdansk', 'PL'] },
]
// Two aircraft established on final for the demo airport: [callsign, hex, km from the threshold, km/h-ish speed in kt, glide angle]
const FINALS = [
  { hex: '3c4b26', flight: 'EWG7XK', km: 8.5, speed: 142, glide: 3.2, off: 0.25, type: 'A320', reg: 'D-AEWA', al: ['EW', 'Eurowings', 'DE'], from: ['PMI', 'Palma', 'ES'] },
  { hex: '4692d1', flight: 'AEE5QW', km: 15.5, speed: 178, glide: 3.0, off: -0.15, type: 'A20N', reg: 'SX-NEA', al: ['A3', 'Aegean', 'GR'], from: ['ATH', 'Athens', 'GR'] },
]

export async function render(api) {
  const { cfg, toRad, offsetPt, getAirports, setAircraft, setState, drawRadar, drawCenter, drawSide, leftCells, rightCells, knobCanvas, centerCanvas, sideCanvas, drawMap, infoCache, trails } = api
  const out = new URL('../docs/screenshots/', import.meta.url)
  mkdirSync(out, { recursive: true })
  const kmLat = 111.32, kmLon = 111.32 * Math.cos(toRad(cfg.lat))
  const now = Date.now(), home = { lat: cfg.lat, lon: cfg.lon }
  const mk = (d, lat, lon) => {
    const x = (lon - cfg.lon) * kmLon, y = (lat - cfg.lat) * kmLat
    return { hex: d.hex, flight: d.flight, alt: d.alt, ground: false, track: d.track, speed: d.speed, vrate: d.vrate, squawk: '1000', type: d.cat, category: d.cat, seenPos: 0.5, lat, lon, d: Math.hypot(x, y), brg: (Math.atan2(x, y) * 180 / Math.PI + 360) % 360 }
  }
  const list = DEMO.map(d => mk(d, cfg.lat + d.y / kmLat, cfg.lon + d.x / kmLon))
  const info = d => ({ at: now, v: 2, aircraft: { type: d.type, reg: d.reg, owner: d.al?.[1] }, airline: d.al ? { iata: d.al[0], name: d.al[1], iso: d.al[2] } : undefined,
    route: d.from ? { from: { iata: d.from[0], city: d.from[1], iso: d.from[2] }, to: { iata: d.to[0], city: d.to[1], iso: d.to[2] } } : undefined })
  for (const d of DEMO) infoCache[`${d.hex}|${d.flight}`] = info(d)

  // Traffic on final approach to the demo airport, placed on the extended centreline of a real runway
  const ap = getAirports().find(a => a.icao === String(cfg.airports?.default || '').toUpperCase()) || getAirports()[0]
  const end = ap?.ends.find(e => /^25/.test(e.id)) || ap?.ends[0]
  if (end) for (const f of FINALS) {
    const p = offsetPt(end, end.course + 180 + f.off, f.km)
    const alt = Math.round((end.elev + Math.tan(toRad(f.glide)) * f.km * 1000 / 0.3048) / 25) * 25
    list.push(mk({ ...f, alt, track: end.course, vrate: -Math.round(f.speed * 5.2), cat: 'A3' }, p.lat, p.lon))
    infoCache[`${f.hex}|${f.flight}`] = info({ ...f, to: [ap.iata, ap.city, 'DE'] })
  }
  list.sort((a, b) => a.d - b.d)

  // Trails: back-project 3 minutes along the current track
  for (const a of list) {
    const v = a.speed * 1.852 / 60, pts = []
    for (let m = 3; m >= 0; m -= 0.25) pts.push({ lat: a.lat - v * m * Math.cos(toRad(a.track)) / kmLat, lon: a.lon - v * m * Math.sin(toRad(a.track)) / kmLon, t: now - m * 60000 })
    trails.set(a.hex, pts)
  }
  setAircraft(list)

  const night = canvas => { // same transform as the night mode on the device
    const g = canvas.getContext('2d'), im = g.getImageData(0, 0, canvas.width, canvas.height), p = im.data
    for (let i = 0; i < p.length; i += 4) { const l = Math.min(255, 0.35 * p[i] + 0.55 * p[i + 1] + 0.25 * p[i + 2]); p[i] = l; p[i + 1] = l * 0.12; p[i + 2] = l * 0.04 }
    g.putImageData(im, 0, 0); return canvas
  }
  const clone = c => { const n = createCanvas(c.width, c.height); n.getContext('2d').drawImage(c, 0, 0); return n }

  // Device-like composite: touch panel (left strip + 12 keys + right strip) above the round wheel screen, at 2x
  async function shot(name, { nightMode = false } = {}) {
    for (let i = 0; i < 80; i++) { if (drawMap().complete) break; await new Promise(r => setTimeout(r, 250)) } // wait for the map tiles
    drawRadar(); const wheel = clone(knobCanvas)
    drawCenter(); const centre = clone(centerCanvas)
    drawSide(leftCells()); const left = clone(sideCanvas)
    drawSide(rightCells()); const right = clone(sideCanvas)
    if (nightMode) [wheel, centre, left, right].forEach(night)
    const S = 2, W = 560, H = 640, c = createCanvas(W * S, H * S), g = c.getContext('2d')
    g.imageSmoothingEnabled = false; g.scale(S, S)
    g.fillStyle = '#1b1d20'; g.beginPath(); g.roundRect(0, 0, W, H, 36); g.fill()
    g.fillStyle = '#000'; g.beginPath(); g.roundRect(30, 28, 500, 290, 10); g.fill()
    g.drawImage(left, 40, 38); g.drawImage(centre, 100, 38); g.drawImage(right, 460, 38)
    g.strokeStyle = '#1b1d20'; g.lineWidth = 3 // physical grid of the touch panel
    for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(100 + i * 90, 38); g.lineTo(100 + i * 90, 308); g.stroke() }
    for (let j = 1; j < 3; j++) { g.beginPath(); g.moveTo(100, 38 + j * 90); g.lineTo(460, 38 + j * 90); g.stroke() }
    const cx = W / 2, cy = 470
    g.fillStyle = '#0c0d0f'; g.beginPath(); g.arc(cx, cy, 150, 0, Math.PI * 2); g.fill() // wheel ring
    g.strokeStyle = '#2a2d31'; g.lineWidth = 6; g.beginPath(); g.arc(cx, cy, 147, 0, Math.PI * 2); g.stroke()
    g.save(); g.beginPath(); g.arc(cx, cy, 120, 0, Math.PI * 2); g.clip(); g.drawImage(wheel, cx - 120, cy - 120); g.restore()
    writeFileSync(new URL(name, out), await c.encode('png'))
    console.log('wrote docs/screenshots/' + name)
  }

  const base = { rangeIdx: 2, sweep: 300, labelsMax: 5, spotIdx: 2, selectedHex: null, view: home, airportMode: false, picker: false, statsMode: false, cockpit: false, selAirport: ap?.icao }
  setState(base)
  await shot('overview.png')

  setState({ ...base, selectedHex: '4bab23', follow: false })
  await shot('detail.png')

  setState({ ...base, picker: true, pickerPage: 0 })
  await shot('airports.png')

  if (ap) {
    setState({ ...base, airportMode: true, rangeIdx: 1, view: { lat: ap.lat, lon: ap.lon }, selectedHex: FINALS[0].hex, follow: false })
    await shot('approach.png')
    const flown = list.find(a => a.hex === FINALS[0].hex)
    if (flown) flown.bank = 4 // a gentle correction to the right, for the picture
    setState({ cockpit: true })
    await shot('cockpit.png')
    setState({ cockpit: false })
  }

  if (ap) { // airport mode: traffic of the airport with its weather tile (fictitious METAR)
    setState({ ...base, airportMode: true, rangeIdx: 1, view: { lat: ap.lat, lon: ap.lon } })
    await shot('airport-weather.png')
  }

  // Reception statistics, with fictitious figures
  const sectors = Array.from({ length: 36 }, (_, k) => Math.round(170 + 110 * Math.abs(Math.sin(k / 5)) - (k > 20 && k < 27 ? 120 : 0)))
  setState({ ...base, rangeIdx: 5, statsMode: true, stats: { day: new Date().toISOString().slice(0, 10), seen: Array.from({ length: 1284 }, (_, i) => [String(i), '']), mil: 17,
    airlines: { DLH: 143, RYR: 121, EWG: 96 }, range: { km: 318.4, brg: 244, name: 'IBE31KP', at: '11:42' }, high: { alt: 45000, name: 'NJE8XY' },
    fast: { kt: 562, name: 'UAE45' }, peak: { n: 104, at: '12:40' }, sectors, record: { km: 402.7, day: '2026-01-12', name: 'TAP1024' }, msgRate: 1184 } })
  await shot('stats.png')

  list.find(a => a.hex === '406d7b').squawk = '7700'
  setState({ ...base, blink: true })
  await shot('emergency.png')
  list.find(a => a.hex === '406d7b').squawk = '1000'

  setState({ ...base, sweep: 200 })
  await shot('night-mode.png', { nightMode: true })
  process.exit(0)
}
