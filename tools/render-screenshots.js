// Renders the README screenshots with fictitious demo traffic around Frankfurt (no device needed).
// Usage: node radar.js --screenshots        (English UI)
//        node radar.js --screenshots --fr   (French UI)
// The satellite map tiles are downloaded from Esri, so an internet connection is required.
import { createCanvas } from '@napi-rs/canvas'
import { writeFileSync, mkdirSync } from 'node:fs'

// Fictitious traffic: positions relative to the demo home (km east, km north)
const DEMO = [
  { hex: '3c6586', flight: 'DLH4AB', x: 6, y: 14, alt: 6200, track: 250, speed: 230, vrate: -1100, cat: 'A3', type: 'A321', reg: 'D-AISA', al: ['LH', 'Lufthansa', 'DE'], from: ['MUC', 'Munich', 'DE'], to: ['FRA', 'Frankfurt', 'DE'] },
  { hex: '4ca7b1', flight: 'RYR82KD', x: -21, y: 9, alt: 31000, track: 115, speed: 440, vrate: 0, cat: 'A3', type: 'B38M', reg: 'EI-HEN', al: ['FR', 'Ryanair', 'IE'], from: ['DUB', 'Dublin', 'IE'], to: ['BUD', 'Budapest', 'HU'] },
  { hex: '4b1814', flight: 'SWR17V', x: 30, y: -24, alt: 18500, track: 25, speed: 380, vrate: 1900, cat: 'A3', type: 'BCS3', reg: 'HB-JCA', al: ['LX', 'Swiss', 'CH'], from: ['ZRH', 'Zurich', 'CH'], to: ['HAM', 'Hamburg', 'DE'] },
  { hex: '39bdb7', flight: 'AFR1418', x: -38, y: -12, alt: 36000, track: 70, speed: 470, vrate: 0, cat: 'A3', type: 'A20N', reg: 'F-HPNB', al: ['AF', 'Air France', 'FR'], from: ['CDG', 'Paris', 'FR'], to: ['WAW', 'Warsaw', 'PL'] },
  { hex: '896439', flight: 'UAE45', x: 44, y: 31, alt: 38000, track: 290, speed: 500, vrate: 0, cat: 'A5', type: 'A388', reg: 'A6-EUD', al: ['EK', 'Emirates', 'AE'], from: ['DXB', 'Dubai', 'AE'], to: ['FRA', 'Frankfurt', 'DE'] },
  { hex: '3e8f21', flight: 'CHX12', x: -7, y: -5, alt: 1800, track: 330, speed: 110, vrate: 300, cat: 'A7', type: 'EC35', reg: 'D-HDSB', al: null, from: null, to: null },
  { hex: '3f4a12', flight: 'GAF618', x: -15, y: 26, alt: 7500, track: 160, speed: 300, vrate: -800, cat: 'A3', type: 'A400', reg: '54+12', al: ['', 'German Air Force', 'DE'], from: null, to: null },
  { hex: '4bab23', flight: 'THY1594', x: 58, y: -48, alt: 35000, track: 305, speed: 460, vrate: 0, cat: 'A3', type: 'A21N', reg: 'TC-LSA', al: ['TK', 'Turkish Airlines', 'TR'], from: ['IST', 'Istanbul', 'TR'], to: ['AMS', 'Amsterdam', 'NL'] },
  { hex: '406d7b', flight: 'BAW904', x: -52, y: 40, alt: 22000, track: 105, speed: 410, vrate: -1500, cat: 'A3', type: 'A320', reg: 'G-EUUA', al: ['BA', 'British Airways', 'GB'], from: ['LHR', 'London', 'GB'], to: ['FRA', 'Frankfurt', 'DE'] },
  { hex: '461f9c', flight: 'FIN1AB', x: 70, y: 62, alt: 37000, track: 220, speed: 480, vrate: 0, cat: 'A3', type: 'A321', reg: 'OH-LZC', al: ['AY', 'Finnair', 'FI'], from: ['HEL', 'Helsinki', 'FI'], to: ['BCN', 'Barcelona', 'ES'] },
  { hex: '4d2403', flight: 'WZZ3TK', x: -64, y: -55, alt: 33000, track: 40, speed: 450, vrate: 500, cat: 'A3', type: 'A21N', reg: 'HA-LVA', al: ['W6', 'Wizz Air', 'HU'], from: ['LIS', 'Lisbon', 'PT'], to: ['GDN', 'Gdansk', 'PL'] },
  { hex: '3c4b26', flight: 'EWG7XK', x: 3, y: 9, alt: 4800, track: 185, speed: 200, vrate: 0, cat: 'A3', type: 'A320', reg: 'D-AEWA', al: ['EW', 'Eurowings', 'DE'], from: ['BER', 'Berlin', 'DE'], to: ['PMI', 'Palma', 'ES'] },
]

export async function render(api) {
  const { cfg, toRad, setAircraft, setState, drawRadar, drawCenter, drawSide, leftCells, rightCells, knobCanvas, centerCanvas, sideCanvas, drawMap, infoCache, trails } = api
  const out = new URL('../docs/screenshots/', import.meta.url)
  mkdirSync(out, { recursive: true })
  const kmLat = 111.32, kmLon = 111.32 * Math.cos(toRad(cfg.lat))
  const now = Date.now()

  const list = DEMO.map(d => {
    const lat = cfg.lat + d.y / kmLat, lon = cfg.lon + d.x / kmLon
    const dist = Math.hypot(d.x, d.y), brg = (Math.atan2(d.x, d.y) * 180 / Math.PI + 360) % 360
    return { hex: d.hex, flight: d.flight, alt: d.alt, ground: false, track: d.track, speed: d.speed, vrate: d.vrate, squawk: '1000', type: d.cat, category: d.cat, seenPos: 0.5, lat, lon, d: dist, brg }
  }).sort((a, b) => a.d - b.d)

  // Trails: back-project 3 minutes along the current track
  for (const a of list) {
    const v = a.speed * 1.852 / 60, pts = []
    for (let m = 3; m >= 0; m -= 0.25) {
      const dx = -v * m * Math.sin(toRad(a.track)), dy = -v * m * Math.cos(toRad(a.track))
      pts.push({ lat: a.lat + dy / kmLat, lon: a.lon + dx / kmLon, t: now - m * 60000 })
    }
    trails.set(a.hex, pts)
  }
  // Airline / route info (normally fetched from adsbdb.com)
  for (const d of DEMO) {
    infoCache[`${d.hex}|${d.flight}`] = {
      at: now,
      aircraft: { type: d.type, reg: d.reg, owner: d.al?.[1] },
      airline: d.al ? { iata: d.al[0], name: d.al[1], iso: d.al[2] } : undefined,
      route: d.from ? { from: { iata: d.from[0], city: d.from[1], iso: d.from[2] }, to: { iata: d.to[0], city: d.to[1], iso: d.to[2] } } : undefined,
    }
  }
  setAircraft(list)

  // Wait for the satellite tiles of the demo view
  for (let i = 0; i < 60; i++) { if (drawMap().complete) break; await new Promise(r => setTimeout(r, 250)) }

  const save = async (canvas, name) => { writeFileSync(new URL(name, out), await canvas.encode('png')); console.log('wrote docs/screenshots/' + name) }
  const night = canvas => { // same transform as the night mode on the device
    const g = canvas.getContext('2d'), im = g.getImageData(0, 0, canvas.width, canvas.height), p = im.data
    for (let i = 0; i < p.length; i += 4) { const l = Math.min(255, 0.35 * p[i] + 0.55 * p[i + 1] + 0.25 * p[i + 2]); p[i] = l; p[i + 1] = l * 0.12; p[i + 2] = l * 0.04 }
    g.putImageData(im, 0, 0); return canvas
  }
  const clone = c => { const n = createCanvas(c.width, c.height); n.getContext('2d').drawImage(c, 0, 0); return n }

  // Device-like composite: touch panel (left strip + 12 tiles + right strip) above the round wheel screen
  async function composite(name, { nightMode = false } = {}) {
    drawRadar(); const wheel = clone(knobCanvas)
    drawCenter(); const centre = clone(centerCanvas)
    drawSide(leftCells()); const left = clone(sideCanvas)
    drawSide(rightCells()); const right = clone(sideCanvas)
    if (nightMode) [wheel, centre, left, right].forEach(night)
    const W = 560, H = 640, c = createCanvas(W, H), g = c.getContext('2d')
    g.fillStyle = '#1b1d20'; g.beginPath(); g.roundRect(0, 0, W, H, 36); g.fill()
    g.fillStyle = '#000'; g.beginPath(); g.roundRect(30, 28, 500, 290, 10); g.fill()
    g.drawImage(left, 40, 38); g.drawImage(centre, 100, 38); g.drawImage(right, 460, 38)
    g.strokeStyle = '#1b1d20'; g.lineWidth = 3                       // physical grid of the touch panel
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(100 + i * 90, 38); g.lineTo(100 + i * 90, 308); g.stroke() }
    for (let j = 1; j < 3; j++) { g.beginPath(); g.moveTo(100, 38 + j * 90); g.lineTo(460, 38 + j * 90); g.stroke() }
    g.beginPath(); g.moveTo(100, 38); g.lineTo(100, 308); g.moveTo(460, 38); g.lineTo(460, 308); g.stroke()
    const cx = W / 2, cy = 470
    g.fillStyle = '#0c0d0f'; g.beginPath(); g.arc(cx, cy, 150, 0, Math.PI * 2); g.fill()       // wheel ring
    g.strokeStyle = '#2a2d31'; g.lineWidth = 6; g.beginPath(); g.arc(cx, cy, 147, 0, Math.PI * 2); g.stroke()
    g.save(); g.beginPath(); g.arc(cx, cy, 120, 0, Math.PI * 2); g.clip(); g.drawImage(wheel, cx - 120, cy - 120); g.restore()
    await save(c, name)
  }

  setState({ rangeIdx: 2, sweep: 50, labelsMax: 4, spotIdx: 1, selectedHex: null })
  drawRadar(); await save(knobCanvas, 'wheel.png')
  await composite('overview.png')

  setState({ selectedHex: '4bab23', follow: false, rangeIdx: 3 })
  await composite('detail.png')
  drawCenter(); await save(centerCanvas, 'centre-detail.png')

  setState({ selectedHex: null, rangeIdx: 2, spotIdx: 0 })
  list.find(a => a.hex === '3c4b26').squawk = '7700'
  setState({ blink: true })
  await composite('emergency.png')
  list.find(a => a.hex === '3c4b26').squawk = '1000'

  setState({ selectedHex: null, rangeIdx: 2, sweep: 200 })
  await composite('night-mode.png', { nightMode: true })
  process.exit(0)
}
