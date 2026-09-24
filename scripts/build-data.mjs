// One-shot snapshot. No dependencies. Rerun: node scripts/build-data.mjs
// School polygons: FCPS Student Planning Areas (revised 2026-08-01).
// Sales: Fairfax OpenData_S4 market-sale points (most recent sale, layer dated 2025-01-01),
// kept only when the parcel land use is Single-family, Detached.
// Drive times: public OSRM, school centroid to Merrifield and Crystal City.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const SPA =
  "https://services1.arcgis.com/ioennV6PpG5Xodq0/arcgis/rest/services/Student_Planning_Areas/FeatureServer/0/query";
const SALES =
  "https://services1.arcgis.com/ioennV6PpG5Xodq0/ArcGIS/rest/services/OpenData_S4/FeatureServer/1/query";
const PARCELS =
  "https://services1.arcgis.com/ioennV6PpG5Xodq0/ArcGIS/rest/services/OpenData_A6/FeatureServer/1/query";

const JOBS = {
  merrifield: [-77.2302, 38.8724],
  southArlington: [-77.0506, 38.8583],
};

async function queryAll(base, params) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const q = new URLSearchParams({ ...params, resultOffset: String(offset), f: "json" });
    const res = await fetch(`${base}?${q}`);
    if (!res.ok) throw new Error(`${res.status} ${base}`);
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

function bbox(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
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

function inGeom(x, y, geom) {
  const polys = geom.rings ? [geom.rings] : geom;
  for (const rings of polys) {
    if (!inRing(x, y, rings[0])) continue;
    let hole = false;
    for (let h = 1; h < rings.length; h++) if (inRing(x, y, rings[h])) hole = true;
    if (!hole) return true;
  }
  return false;
}

function median(sorted) {
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

console.log("schools");
const spas = await queryAll(SPA, {
  where: "ES_NAME IS NOT NULL",
  outFields: "ES_NAME,MS_NAME,HS_NAME",
  returnGeometry: "true",
  outSR: "4326",
  geometryPrecision: "4",
  maxAllowableOffset: "0.0015",
  resultRecordCount: "400",
});

const schools = new Map();
for (const f of spas) {
  const name = f.attributes.ES_NAME;
  if (!schools.has(name)) {
    schools.set(name, {
      name,
      ms: f.attributes.MS_NAME,
      hs: f.attributes.HS_NAME,
      parts: [],
    });
  }
  const g = f.geometry;
  const polys = g.rings ? [g.rings] : [];
  for (const rings of polys) {
    const box = bbox(rings);
    schools.get(name).parts.push({ rings, box });
  }
}

console.log("detached parcels");
const parcels = await queryAll(PARCELS, {
  where: "LUC_DESC LIKE 'Single-family, Detached%'",
  outFields: "PARID",
  returnGeometry: "false",
  resultRecordCount: "2000",
});
const detached = new Set(parcels.map((f) => f.attributes.PARID));
console.log("detached", detached.size);

console.log("sales", "parts", spas.length);
const sales = await queryAll(SALES, {
  where: "SALES_VALUE > 150000 AND SALES_VALUE < 4000000",
  outFields: "PIN,SALES_VALUE",
  returnGeometry: "true",
  outSR: "4326",
  resultRecordCount: "2000",
});

const list = [...schools.values()];
for (const s of list) s.prices = [];

let missed = 0;
for (const f of sales) {
  const [x, y] = f.geometry?.x != null ? [f.geometry.x, f.geometry.y] : [];
  if (x == null) continue;
  if (!detached.has(f.attributes.PIN)) continue;
  const price = f.attributes.SALES_VALUE;
  let hit = false;
  for (const s of list) {
    for (const p of s.parts) {
      const [minX, minY, maxX, maxY] = p.box;
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      if (inRing(x, y, p.rings[0])) {
        s.prices.push(price);
        hit = true;
        break;
      }
    }
    if (hit) break;
  }
  if (!hit) missed++;
}
console.log("unmatched sales", missed, "of", sales.length);

function centroid(s) {
  let sx = 0, sy = 0, n = 0;
  for (const p of s.parts) {
    for (const [x, y] of p.rings[0]) {
      sx += x;
      sy += y;
      n++;
    }
  }
  return [sx / n, sy / n];
}

async function driveMinutes(points) {
  const minutes = new Array(points.length);
  const chunk = 80;
  for (let i = 0; i < points.length; i += chunk) {
    const slice = points.slice(i, i + chunk);
    const coords = [...slice, JOBS.merrifield, JOBS.southArlington]
      .map(([lon, lat]) => `${lon},${lat}`)
      .join(";");
    const sources = slice.map((_, k) => k).join(";");
    const dest = `${slice.length};${slice.length + 1}`;
    const url = `https://router.project-osrm.org/table/v1/driving/${coords}?sources=${sources}&destinations=${dest}&annotations=duration`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.code !== "Ok") throw new Error(json.code || "osrm");
    json.durations.forEach((row, k) => {
      minutes[i + k] = {
        merrifield: Math.round(row[0] / 60),
        southArlington: Math.round(row[1] / 60),
      };
    });
    process.stdout.write(`\rroutes ${Math.min(i + chunk, points.length)}`);
  }
  process.stdout.write("\n");
  return minutes;
}

const centers = list.map(centroid);
console.log("routes");
let drives;
try {
  drives = await driveMinutes(centers);
} catch (err) {
  console.warn("OSRM failed, using straight-line estimate:", err.message);
  drives = centers.map(([lon, lat]) => {
    const est = (job) => {
      const dx = (lon - job[0]) * 54;
      const dy = (lat - job[1]) * 69;
      const miles = Math.hypot(dx, dy) * 1.45;
      return Math.round((miles / 22) * 60);
    };
    return { merrifield: est(JOBS.merrifield), southArlington: est(JOBS.southArlington) };
  });
}

const ratings = JSON.parse(readFileSync("data/ratings.json", "utf8"));
const ALIAS = {
  McNair: "Mcnair",
  "Louise Archer": "Archer",
  "Franklin Sherman": "Sherman",
  "Fort Belvoir Primary": "Fort Belvoir",
  "Hunters Woods": "Hunters Woods",
};
function ratingFor(name) {
  if (ratings[name] != null) return ratings[name];
  if (ALIAS[name] && ratings[ALIAS[name]] != null) return ratings[ALIAS[name]];
  const hit = Object.keys(ratings).find((k) => k.startsWith(name));
  return hit ? ratings[hit] : null;
}

const out = list
  .map((s, i) => {
    const prices = s.prices.filter((p) => p >= 200000).sort((a, b) => a - b);
    return {
      name: s.name,
      ms: s.ms,
      hs: s.hs,
      lon: Math.round(centers[i][0] * 10000) / 10000,
      lat: Math.round(centers[i][1] * 10000) / 10000,
      rating: ratingFor(s.name),
      rings: s.parts.map((p) =>
        p.rings[0].map(([x, y]) => [
          Math.round(x * 10000) / 10000,
          Math.round(y * 10000) / 10000,
        ])
      ),
      n: prices.length,
      p25: prices.length ? prices[Math.floor(prices.length * 0.25)] : null,
      median: median(prices),
      p75: prices.length ? prices[Math.floor(prices.length * 0.75)] : null,
      under800: prices.filter((p) => p <= 800000).length,
      under950: prices.filter((p) => p <= 950000).length,
      toMerrifield: drives[i].merrifield,
      toSouthArlington: drives[i].southArlington,
    };
  })
  .filter((s) => s.n >= 8)
  .sort((a, b) => a.median - b.median);

mkdirSync("data", { recursive: true });
writeFileSync(
  "data/schools.json",
  JSON.stringify(
    {
      generated: new Date().toISOString().slice(0, 10),
      ratingNote:
        "1–10 test-score rank from Public School Review, 2026-27 Fairfax elementary list (combined math and reading proficiency). Unrated boundaries stay gray.",
      salesNote:
        "Most recent recorded sale on Single-family, Detached parcels only (townhouses and condos excluded), Fairfax market-sale points through 2025-01-01, $150k–$4M, assigned to the FCPS elementary boundary. Not a trailing-12-month MLS median.",
      commuteNote:
        "Typical driving minutes from the school-boundary centroid to Merrifield (Gallows Rd) and Crystal City. Rush hour runs longer.",
      schools: out,
    },
    null,
    0
  )
);
const shreve = out.find((s) => s.name === "Shrevewood");
const kent = out.find((s) => s.name === "Kent Gardens");
if (!shreve || shreve.toMerrifield > 12) throw new Error("Shrevewood commute check failed");
if (!kent || kent.median < 1500000) throw new Error("Kent Gardens price check failed");
console.log("wrote", out.length, "schools");
