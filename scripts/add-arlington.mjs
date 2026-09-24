// Append Arlington elementary schools to data/schools.json.
// Sales: latest blank-type (market) sale from Arlington SalesHistory.txt.
// Parcels: 511 single-family detached. Boundaries: APS elementary polygons.

import { readFileSync, writeFileSync } from "node:fs";

const ES =
  "https://arlgis.arlingtonva.us/arcgis/rest/services/Open_Data/od_School_Boundaries_Polygons/FeatureServer/0/query";
const PARCELS =
  "https://arlgis.arlingtonva.us/arcgis/rest/services/StaffMap/Property_Map_public/MapServer/3/query";
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
    process.stdout.write(`\r${rows.length}`);
  }
  process.stdout.write("\n");
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

console.log("sales");
const sales = new Map();
const lines = readFileSync(process.env.TEMP + "/arl-sales.txt", "utf8").split(/\r?\n/).slice(1);
for (const line of lines) {
  const p = line.split("|");
  if (p.length < 12 || p[5] !== "") continue;
  const amt = Number(p[10]);
  if (amt < 150000 || amt > 4000000) continue;
  const code = p[1];
  const date = p[11];
  const prev = sales.get(code);
  if (!prev || date > prev.date) sales.set(code, { amt, date });
}
console.log("market sales", sales.size);

console.log("parcels");
const parcels = await queryAll(PARCELS, {
  where: "PROPERTY_CLASS_DESC LIKE '511%'",
  outFields: "RPCMSTR",
  returnGeometry: "true",
  outSR: "4326",
  geometryPrecision: "4",
  maxAllowableOffset: "0.0004",
  resultRecordCount: "2000",
});
const points = [];
for (const f of parcels) {
  const sale = sales.get(f.attributes.RPCMSTR);
  const ring = f.geometry?.rings?.[0];
  if (!sale || !ring) continue;
  const [lon, lat] = centroid(ring);
  points.push({ lon, lat, price: sale.amt });
}
console.log("detached with a sale", points.length);

console.log("schools");
const features = await queryAll(ES, {
  where: "1=1",
  outFields: "ES_Name",
  returnGeometry: "true",
  outSR: "4326",
  geometryPrecision: "4",
  maxAllowableOffset: "0.0008",
  resultRecordCount: "50",
});

const schools = features.map((f) => {
  const rings = (f.geometry.rings ? [f.geometry.rings[0]] : []).map((ring) =>
    ring.map(([x, y]) => [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000])
  );
  return {
    name: f.attributes.ES_Name.replace(/ Elementary School$/, ""),
    prices: [],
    rings,
  };
});

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
  const html = await fetch("https://www.publicschoolreview.com/virginia/arlington-county/elementary", {
    headers: { "User-Agent": "Mozilla/5.0" },
  }).then((r) => r.text());
  const re = /tpl-school-link' href='[^']*'>(?:<span[^>]*><\/span>)?([^<]+)<\/a>[\s\S]{0,800}?data-rank-score="(\d+)"/g;
  let m;
  while ((m = re.exec(html))) {
    ratings[m[1].replace(/ Elementary School.*/, "").trim()] = Number(m[2]);
  }
  const more = await fetch("https://www.publicschoolreview.com/virginia/arlington/tab/elementary/num/2", {
    headers: { "User-Agent": "Mozilla/5.0" },
  }).then((r) => r.json());
  const html2 = more.result || "";
  while ((m = re.exec(html2))) {
    ratings[m[1].replace(/ Elementary School.*/, "").trim()] = Number(m[2]);
  }
} catch (err) {
  console.warn("ratings", err.message);
}
console.log("ratings", Object.keys(ratings).length);

const added = schools.map((s, i) => {
  const prices = s.prices.filter((p) => p >= 200000).sort((a, b) => a - b);
  const [lon, lat] = centers[i];
  return {
    name: s.name,
    ms: "Arlington",
    hs: "Arlington",
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
    county: "Arlington",
  };
}).filter((s) => s.n >= 8);

const data = JSON.parse(readFileSync("data/schools.json", "utf8"));
data.schools = data.schools.filter((s) => s.county !== "Arlington").concat(added);
data.arlingtonNote =
  "Arlington elementary boundaries from APS. Prices are the latest market sale on each single-family detached parcel in the county sales history, not a trailing-12-month MLS median.";
writeFileSync("data/schools.json", JSON.stringify(data));
console.log(added.map((s) => `${s.name} ${s.rating} n=${s.n} med=${s.median} p75=${s.p75} ${s.toArlington}m`).join("\n"));
