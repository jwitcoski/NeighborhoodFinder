import { readFileSync, writeFileSync } from "node:fs";

let h = "";
for (const file of process.argv.slice(2)) {
  let raw = readFileSync(file, "utf8");
  if (raw.trim().startsWith("{")) {
    const json = JSON.parse(raw);
    raw = json.result || json.html || "";
  }
  h += raw;
}
const re =
  /tpl-school-link' href='[^']*'>(?:<span[^>]*><\/span>)?([^<]+)<\/a>[\s\S]{0,800}?data-rank-score="(\d+)"/g;
const ratings = {};
let m;
while ((m = re.exec(h))) {
  const name = m[1]
    .replace(/&#039;/g, "'")
    .replace(/ Elementary School.*/, "")
    .trim();
  ratings[name] = Number(m[2]);
}
console.log(Object.keys(ratings).length);
writeFileSync("data/ratings.json", JSON.stringify(ratings, null, 0));
