// Live chauffeur positions for the "on the way" map.
// Positions change every few seconds, so they never go into the SQLite snapshot (that would
// upload the whole database on every GPS ping). On Vercel they live in a small Supabase table
// (server/supabase/live_location.sql); locally, or until that table exists, in memory.
import { all, get } from './db.js';
import { coord, geocode, liveRoute, mapsEnabled } from './maps.js';

export const LIVE_STATUSES = ['on_the_way', 'arrived', 'started'];
const STALE_MS = 10 * 60000;

const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
const SECRET = process.env.ENCORE_SYNC_SECRET;
let remote = !!(URL_BASE && KEY && SECRET);
const memory = new Map(); // leg_id → position

async function rpc(name, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: SECRET, ...body }),
    signal: AbortSignal.timeout(6000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Table/functions not installed yet → stay in memory for this instance.
    if (data?.code === 'PGRST202' || res.status === 404) remote = false;
    throw new Error(`Live ${name} failed: ${data?.message || res.status}`);
  }
  return data;
}

export async function putPosition(legId, driverId, p) {
  const pos = { lat: p.lat, lng: p.lng, heading: p.heading, speed: p.speed, accuracy: p.accuracy, updated_at: new Date().toISOString() };
  memory.set(legId, pos);
  if (remote) {
    try {
      await rpc('encore_loc_put', { p_leg: legId, p_driver: driverId, p_lat: p.lat, p_lng: p.lng, p_heading: p.heading, p_speed: p.speed, p_accuracy: p.accuracy });
    } catch (e) { console.error('[live]', e.message); }
  }
}

async function positions(legIds) {
  const out = new Map();
  if (remote && legIds.length) {
    try {
      for (const row of await rpc('encore_loc_get', { p_legs: legIds }) || []) out.set(Number(row.leg_id), row);
    } catch (e) { console.error('[live]', e.message); }
  }
  for (const id of legIds) {
    const m = memory.get(id);
    const o = out.get(id);
    if (m && (!o || new Date(m.updated_at) > new Date(o.updated_at))) out.set(id, m);
  }
  for (const [id, p] of out) if (Date.now() - new Date(p.updated_at).getTime() > STALE_MS) out.delete(id);
  return out;
}

// Pickup/destination points: the customer's map pin if there is one, else geocode the address.
async function point(lat, lng, address) {
  const pinned = coord(lat, lng);
  if (pinned) return pinned;
  if (!mapsEnabled() || !address || /^as directed$/i.test(address)) return null;
  try { return await geocode(address); } catch { return null; }
}

// ETA is refreshed at most every 40 s per leg, or sooner once the car has moved ~400 m.
const etaCache = new Map();
const metres = (a, b) => {
  const R = 6371000; const toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR; const dLng = (b.lng - a.lng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
async function eta(legId, from, to) {
  if (!from || !to) return null;
  const hit = etaCache.get(legId);
  if (hit && hit.to.lat === to.lat && Date.now() - hit.at < 40000 && metres(hit.from, from) < 400) return hit.value;
  let value = null;
  if (mapsEnabled()) { try { value = await liveRoute(from, to); } catch (e) { console.error('[live eta]', e.message); } }
  if (!value) value = { distance_m: Math.round(metres(from, to) * 1.3), duration_s: Math.round((metres(from, to) * 1.3) / 11), polyline: null }; // ~25 mph estimate
  etaCache.set(legId, { at: Date.now(), from, to, value });
  if (etaCache.size > 500) etaCache.delete(etaCache.keys().next().value);
  return value;
}

/** What the customer (or management) sees on the live map for one booking. */
export async function liveView(b, user) {
  let legs = all('SELECT * FROM booking_legs WHERE booking_id = ? ORDER BY leg_no', b.id);
  if (user.role === 'driver') legs = legs.filter((l) => l.driver_id === user.id);
  const active = legs.filter((l) => LIVE_STATUSES.includes(l.status));
  const pos = await positions(active.map((l) => l.id));
  const out = [];
  for (const l of active) {
    const pickup = await point(l.pickup_lat, l.pickup_lng, l.pickup);
    const destination = await point(l.dest_lat, l.dest_lng, l.destination);
    const p = pos.get(l.id);
    const driver = p ? { lat: Number(p.lat), lng: Number(p.lng), heading: p.heading == null ? null : Number(p.heading), speed: p.speed == null ? null : Number(p.speed), updated_at: p.updated_at } : null;
    const target = l.status === 'started' ? destination : pickup;
    const route = l.status === 'arrived' ? null : await eta(l.id, driver, target);
    out.push({
      leg_id: l.id, label: l.label, status: l.status, pickup, destination, driver,
      heading_to: l.status === 'started' ? 'destination' : 'pickup',
      eta_s: route?.duration_s ?? null, distance_m: route?.distance_m ?? null, polyline: route?.polyline ?? null,
    });
  }
  return { legs: out, at: new Date().toISOString() };
}

/** Driver app → server: the chauffeur's latest GPS fix for one of their active legs. */
export async function recordDriverPosition(user, body) {
  const legId = Number(body.leg_id);
  const leg = get('SELECT l.id, l.status, l.driver_id, b.status AS booking_status FROM booking_legs l JOIN bookings b ON b.id = l.booking_id WHERE l.id = ?', legId);
  if (!leg || leg.driver_id !== user.id) return { ok: false, reason: 'not_your_leg' };
  if (!LIVE_STATUSES.includes(leg.status) || String(leg.booking_status).startsWith('cancelled')) return { ok: false, reason: 'not_live' };
  const c = coord(body.lat, body.lng);
  if (!c) return { ok: false, reason: 'bad_position' };
  const num = (v, max) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(max, Number(v))));
  await putPosition(legId, user.id, { ...c, heading: num(body.heading, 360), speed: num(body.speed, 100), accuracy: num(body.accuracy, 10000) });
  return { ok: true };
}
