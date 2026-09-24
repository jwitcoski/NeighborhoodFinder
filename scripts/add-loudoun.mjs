// Append Loudoun elementary schools to data/schools.json.
// Boundaries: Loudoun GIS elementary zones. Names: school sites.
// Prices: current Redfin detached listings (active, pending, coming soon),
// because the county does not publish a market-sale point layer.

import { readFileSync, writeFileSync } from "node:fs";

const ZONES =
  "https://logis.loudoun.gov/gis/rest/services/COL/Schools/MapServer/1/query";
const SITES =
  "https://logis.loudoun.gov/gis/rest/services/COL/Schools/MapServer/0/query";
const WORK = [-77.1036483, 38.8697627];

async function queryAll(base, params) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const q = new URLSearchParams({ ...params, resultOffset: String(offset), f: "json" });
    const res = await fetch(`${base}?${q}`);
    const json = await res.json();
    if (json.error) throw new Error(JSON.stringify(json.error));
    rows.push(...(json.features || []));
    if (!json.exceededTransferLimit) break;
    offset += json.features.length;
  }
  return rows;
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function centroid(ring) {
  let sx = 0, sy = 0;
  for (const [x, y] of ring) { sx += x; sy += y; }
  return [sx / ring.length, sy / ring.length];
}

function median(sorted) {
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function titleName(raw) {
  const base = raw
    .replace(/&#0*39;|&apos;|&#x27;/gi, "'")
    .replace(/\s+(elementary(\s+school)?|es)$/i, "")
    .trim();
  return base
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase())
    .replace(/\b(Of|And|The)\b/g, (w) => w.toLowerCase());
}

console.log("schools");
const sites = await queryAll(SITES, {
  where: "CLASS='ELEMENTARY'",
  outFields: "SCH_CODE,NAME",
  returnGeometry: "false",
  resultRecordCount: "200",
});
const names = new Map(sites.map((f) => [f.attributes.SCH_CODE, titleName(f.attributes.NAME)]));

const features = await queryAll(ZONES, {
  where: "1=1",
  outFields: "ES_SCH_CODE",
  returnGeometry: "true",
  outSR: "4326",
  geometryPrecision: "4",
  maxAllowableOffset: "0.0012",
  resultRecordCount: "100",
});

const schools = features.map((f) => {
  const code = f.attributes.ES_SCH_CODE;
  const rings = (f.geometry?.rings || []).map((ring) =>
    ring.map(([x, y]) => [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000])
  );
  return { name: names.get(code) || code, code, prices: [], rings };
}).filter((s) => names.has(s.code));
console.log("zones", schools.length, "named", schools.filter((s) => names.has(s.code)).length);

console.log("listings");
const points = [];
const seen = new Set();
for (let page = 1; page <= 8; page++) {
  const url =
    "https://www.redfin.com/stingray/api/gis?al=1&num_homes=350&page_number=" +
    page +
    "&region_id=2989&region_type=5&sf=1&status=9&uipt=1&v=8";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  let text = await res.text();
  const cut = text.indexOf("&&");
  text = cut >= 0 ? text.slice(cut + 2) : text;
  const batch = JSON.parse(text).payload?.homes || [];
  for (const h of batch) {
    if (h.uiPropertyType !== 1) continue;
    const lat = h.latLong?.value?.latitude;
    const lon = h.latLong?.value?.longitude;
    const price = h.price?.value;
    if (lat == null || lon == null || !price) continue;
    if (price < 150000 || price > 4000000) continue;
    const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({ lon, lat, price });
  }
  if (batch.length < 350) break;
}
console.log("detached listings", points.length);

for (const pt of points) {
  for (const s of schools) {
    if (s.rings.some((ring) => inRing(pt.lon, pt.lat, ring))) {
      s.prices.push(pt.price);
      break;
    }
  }
}

const centers = schools.map((s) => centroid(s.rings[0]));
const minutes = [];
for (let i = 0; i < centers.length; i += 20) {
  const slice = centers.slice(i, i + 20);
  const coords = [WORK, ...slice].map(([lon, lat]) => `${lon},${lat}`).join(";");
  const dest = slice.map((_, k) => k + 1).join(";");
  const json = await fetch(
    `https://router.project-osrm.org/table/v1/driving/${coords}?sources=0&destinations=${dest}&annotations=duration`
  ).then((r) => r.json());
  if (json.code !== "Ok") throw new Error(json.code || "osrm");
  json.durations[0].forEach((sec) => minutes.push(Math.round(sec / 60)));
}

let ratings = {};
try {
  const headers = { "User-Agent": "Mozilla/5.0" };
  const pages = [
    "https://www.publicschoolreview.com/virginia/loudoun-county/elementary",
    "https://www.publicschoolreview.com/virginia/loudoun/tab/elementary/num/2",
  ];
  const re = /tpl-school-link' href='[^']*'>(?:<span[^>]*><\/span>)?([^<]+)<\/a>[\s\S]{0,800}?data-rank-score="(\d+)"/g;
  for (const page of pages) {
    const res = await fetch(page, { headers });
    const body = res.headers.get("content-type")?.includes("json")
      ? (await res.json()).result || ""
      : await res.text();
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body))) {
      ratings[titleName(m[1].replace(/ Elementary School.*/, ""))] = Number(m[2]);
    }
  }
} catch (err) {
  console.warn("ratings", err.message);
}
console.log("ratings", Object.keys(ratings).length, Object.keys(ratings).slice(0, 12).join(" | "));

const added = schools.map((s, i) => {
  const prices = s.prices.filter((p) => p >= 200000).sort((a, b) => a - b);
  const [lon, lat] = centers[i];
  return {
    name: s.name,
    ms: "Loudoun",
    hs: "Loudoun",
    lon: Math.round(lon * 10000) / 10000,
    lat: Math.round(lat * 10000) / 10000,
    rating: ratings[s.name] ?? null,
    rings: s.rings,
    n: prices.length,
    p25: prices.length ? prices[Math.floor(prices.length * 0.25)] : null,
    median: median(prices),
    p75: prices.length ? prices[Math.floor(prices.length * 0.75)] : null,
    under800: prices.filter((p) => p <= 800000).length,
    under950: prices.filter((p) => p <= 950000).length,
    toMerrifield: null,
    toSouthArlington: null,
    toArlington: minutes[i],
    county: "Loudoun",
  };
}).filter((s) => s.n >= 3);

const data = JSON.parse(readFileSync("data/schools.json", "utf8"));
data.schools = data.schools.filter((s) => s.county !== "Loudoun").concat(added);
data.loudounNote =
  "Loudoun elementary boundaries from the county GIS. Prices are current Redfin asking prices for detached houses in each zone, not recorded sales.";
writeFileSync("data/schools.json", JSON.stringify(data));
console.log(added.map((s) => `${s.name} ${s.rating} n=${s.n} med=${s.median} ${s.toArlington}m`).join("\n"));
console.log("kept", added.length);
