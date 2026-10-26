import { getSettings } from './db.js'

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const USER_AGENT = 'LzTech/1.0 (contato@lztech.local)'
const CACHE_TTL_MS = 1000 * 60 * 60 * 24
const MIN_INTERVAL_MS = 1100

const cache = new Map()
let lastRequestAt = 0

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  return hit.value
}

function cacheSet(key, value) {
  cache.set(key, { value, at: Date.now() })
}

async function nominatim(query) {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt)
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
  return fetch(`${NOMINATIM_URL}?${query}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  })
}

export async function geocode(parts) {
  const query = (Array.isArray(parts) ? parts : [parts])
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .join(', ')
  if (query.length < 4) return null

  const key = query.toLowerCase()
  const cached = cacheGet(key)
  if (cached !== undefined) return cached

  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      limit: '1',
      countrycodes: 'br',
      'accept-language': 'pt-BR',
    })
    const res = await nominatim(params.toString())
    if (!res.ok) {
      cacheSet(key, null)
      return null
    }
    const data = await res.json()
    const first = Array.isArray(data) ? data[0] : null
    const value = first ? { lat: Number(first.lat), lon: Number(first.lon) } : null
    cacheSet(key, value)
    return value
  } catch {
    return null
  }
}

export function haversineKm(a, b) {
  const R = 6371
  const toRad = (deg) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function shippingConfig(settings = getSettings()) {
  return {
    freeKm: Math.max(0, Number(settings.deliveryFreeKm ?? 5) || 0),
    baseFee: Math.max(0, Number(settings.deliveryBaseFee ?? 5) || 0),
    perKm: Math.max(0, Number(settings.deliveryPerKm ?? 2) || 0),
  }
}

export function shippingFee(distanceKm, config = shippingConfig()) {
  const { freeKm, baseFee, perKm } = config
  if (!(distanceKm > freeKm)) return 0
  const km = Math.ceil(distanceKm)
  return baseFee + perKm * (km - (freeKm + 1))
}

export function storeQuery(settings = getSettings()) {
  return [settings.address, settings.city]
}

export async function quote(address, city, settings = getSettings()) {
  const config = shippingConfig(settings)
  if (!String(settings.address || '').trim()) {
    return { ok: false, reason: 'no-store-address', config }
  }
  if (!String(address || '').trim()) {
    return { ok: false, reason: 'no-address', config }
  }

  const [store, target] = await Promise.all([
    geocode(storeQuery(settings)),
    geocode([address, city]),
  ])
  if (!store || !target) {
    return { ok: false, reason: 'not-found', config }
  }

  const distanceKm = haversineKm(store, target)
  return {
    ok: true,
    distanceKm,
    fee: shippingFee(distanceKm, config),
    config,
  }
}
