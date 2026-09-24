// Same idea as GlobalSkiAtlas DriveTimeMap: polar sample points, road times, one ring per cutoff.
// Public OSRM, typical speeds (not rush hour).

import { writeFileSync } from "node:fs";

const ORIGIN_QUERY = "4000 Arlington Blvd, Arlington, VA 22204";
const MINUTES = [15, 30, 45];
const EARTH_KM = 6371;

function destAt(lon, lat, bearingDeg, radiusKm) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const φ0 = toRad(lat);
  const λ0 = toRad(lon);
  const δ = radiusKm / EARTH_KM;
  const θ = toRad(bearingDeg);
  const φ1 = Math.asin(Math.sin(φ0) * Math.cos(δ) + Math.cos(φ0) * Math.sin(δ) * Math.cos(θ));
  const λ1 = λ0 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ0), Math.cos(δ) - Math.sin(φ0) * Math.sin(φ1));
  return [toDeg(λ1), toDeg(φ1)];
}

function radiusAlongBearing(samples, targetMin) {
  const seq = samples.slice().sort((a, b) => a.dist - b.dist);
  if (!seq.length) return 0;
  if (seq[0].minutes >= targetMin) return seq[0].dist * (targetMin / Math.max(seq[0].minutes, 1));
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1];
    const b = seq[i];
    if (b.minutes >= targetMin) {
      const t = (targetMin - a.minutes) / Math.max(b.minutes - a.minutes, 0.01);
      return a.dist + t * (b.dist - a.dist);
    }
  }
  const last = seq[seq.length - 1];
  return Math.min(last.dist * (targetMin / Math.max(last.minutes, 1)), last.dist * 1.15);
}

const geo = await fetch(
  "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(ORIGIN_QUERY),
  { headers: { "User-Agent": "NeighborhoodFinder/1.0" } }
).then((r) => r.json());
if (!geo[0]) throw new Error("geocode failed");
const origin = [Number(geo[0].lon), Number(geo[0].lat)];
console.log("origin", origin, geo[0].display_name);

const radiusKm = 42;
const rings = [0.2, 0.4, 0.6, 0.8, 1];
const nBearings = 16;
const samples = [];
for (const frac of rings) {
  for (let i = 0; i < nBearings; i++) {
    const bearing = i * (360 / nBearings);
    samples.push({ xy: destAt(origin[0], origin[1], bearing, radiusKm * frac), bearing, dist: radiusKm * frac });
  }
}

const timed = [];
for (let i = 0; i < samples.length; i += 70) {
  const slice = samples.slice(i, i + 70);
  const coords = [origin, ...slice.map((s) => s.xy)].map(([lon, lat]) => `${lon},${lat}`).join(";");
  const sources = "0";
  const dest = slice.map((_, k) => k + 1).join(";");
  const url = `https://router.project-osrm.org/table/v1/driving/${coords}?sources=${sources}&destinations=${dest}&annotations=duration`;
  const json = await fetch(url).then((r) => r.json());
  if (json.code !== "Ok") throw new Error(json.code || "osrm");
  json.durations[0].forEach((sec, k) => {
    if (sec == null) return;
    timed.push({ ...slice[k], minutes: sec / 60 });
  });
  console.log("timed", timed.length);
}

const byBearing = new Map();
for (const s of timed) {
  const key = s.bearing.toFixed(2);
  if (!byBearing.has(key)) byBearing.set(key, []);
  byBearing.get(key).push(s);
}
const bearings = [...byBearing.keys()].map(Number).sort((a, b) => a - b);

const features = MINUTES.slice().reverse().map((minutes) => {
  const ring = bearings.map((b) => {
    const km = radiusAlongBearing(byBearing.get(b.toFixed(2)), minutes);
    return destAt(origin[0], origin[1], b, Math.max(km, 0.4));
  });
  ring.push(ring[0]);
  return {
    type: "Feature",
    properties: { minutes },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
});

writeFileSync(
  "data/drive-rings.json",
  JSON.stringify({
    label: "4000 Arlington Blvd",
    display: geo[0].display_name,
    lon: origin[0],
    lat: origin[1],
    note: "15/30/45 minute drive zones at typical speeds, sampled the same way as the ski drive-time map. Rush hour is longer.",
    features,
  })
);
console.log("wrote rings", features.map((f) => f.properties.minutes).join(","));
