// Snapshot of detached houses listed on Redfin. Rerun: node scripts/listings.mjs
import { writeFileSync } from "node:fs";

const REGIONS = [
  [2965, "Fairfax County"],
  [2943, "Arlington County"],
  [2989, "Loudoun County"],
];

async function regionHomes(id) {
  const homes = [];
  for (let page = 1; page <= 6; page++) {
    const url =
      "https://www.redfin.com/stingray/api/gis?al=1&num_homes=350&page_number=" +
      page +
      "&region_id=" +
      id +
      "&region_type=5&sf=1&status=9&uipt=1&v=8";
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    let text = await res.text();
    text = text.replace(/^[\s\S]*?&&/, "");
    const batch = JSON.parse(text).payload?.homes || [];
    homes.push(...batch);
    if (batch.length < 350) break;
  }
  return homes;
}

const listings = [];
const seen = new Set();
for (const [id, name] of REGIONS) {
  const homes = await regionHomes(id);
  let kept = 0;
  for (const h of homes) {
    if (h.uiPropertyType !== 1) continue;
    if (!/active|coming soon/i.test(h.mlsStatus || "")) continue;
    const lat = h.latLong?.value?.latitude;
    const lon = h.latLong?.value?.longitude;
    const price = h.price?.value;
    const url = h.url ? "https://www.redfin.com" + h.url : null;
    const address = [h.streetLine?.value, h.city, h.zip].filter(Boolean).join(", ");
    const key = url || address;
    if (lat == null || lon == null || !price || seen.has(key)) continue;
    seen.add(key);
    listings.push({ price, lat, lon, beds: h.beds ?? null, baths: h.baths ?? null, address, url });
    kept++;
  }
  console.log(name, homes.length, "kept", kept);
}

writeFileSync(
  "data/listings.json",
  JSON.stringify({
    generated: new Date().toISOString().slice(0, 10),
    note: "Detached houses listed on Redfin in Fairfax, Arlington, and Loudoun counties. Snapshot, rerun node scripts/listings.mjs to refresh.",
    listings,
  })
);
console.log("wrote", listings.length);
