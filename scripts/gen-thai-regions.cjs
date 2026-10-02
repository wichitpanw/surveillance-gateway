/**
 * Build server/data/thai-regions.csv: Thai province / district / subdistrict codes.
 *
 * Codes are the Department of Provincial Administration (DOPA) codes, TIS 1099 at province
 * level: province = 2 digits, district (amphoe / khet) = 4, subdistrict (tambon / khwaeng) = 6.
 *
 * Source: https://github.com/thailand-geography-data/thailand-geography-json (MIT).
 *
 * Why not another province dataset, which a reference edge project used: checked on
 * 2026-09-23 against this source and Wikipedia's DOPA geocode lists, it has every district and
 * subdistrict of Bueng Kan (38) under the wrong code (3802 is Phon Charoen, it says Seka), still
 * carries Bangkok's khwaeng from before the 2019 splits (Bang Na, Bang Bon, Don Mueang, ...),
 * lists tambons moved to new Nakhon Ratchasima districts under their old district as well, and
 * has two local-government rows (7074, 9077) posing as districts. Its totals, 930 districts and
 * 7,452 subdistricts, are above the official 928 and about 7,436.
 *
 * Usage:
 *   node scripts/gen-thai-regions.cjs                 download and write the CSV
 *   node scripts/gen-thai-regions.cjs --data-dir DIR  read provinces.json etc. from DIR instead
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = 'https://raw.githubusercontent.com/thailand-geography-data/thailand-geography-json/main/src/';
const OUT = path.join(__dirname, '..', 'server', 'data', 'thai-regions.csv');

const fetchJson = (url) => new Promise((resolve, reject) => {
  https.get(url, (res) => {
    if (res.statusCode !== 200) return reject(new Error(`${url}: HTTP ${res.statusCode}`));
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject);
});

async function load(name) {
  const i = process.argv.indexOf('--data-dir');
  if (i > 0) return JSON.parse(fs.readFileSync(path.join(process.argv[i + 1], name), 'utf8'));
  return fetchJson(BASE + name);
}

const csvField = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

async function main() {
  const [provinces, districts, subdistricts] = await Promise.all(
    ['provinces.json', 'districts.json', 'subdistricts.json'].map(load),
  );

  const rows = [];
  for (const p of provinces) rows.push([p.provinceCode, p.provinceNameTh, p.provinceNameEn, '']);
  for (const d of districts) rows.push([d.districtCode, d.districtNameTh, d.districtNameEn, d.provinceCode]);
  for (const s of subdistricts) rows.push([s.subdistrictCode, s.subdistrictNameTh, s.subdistrictNameEn, s.districtCode]);

  // Every code unique, every child under a parent that exists and whose code is its prefix
  const codes = new Set();
  for (const [code, , , parent] of rows) {
    const c = String(code);
    if (codes.has(c)) throw new Error(`duplicate code ${c}`);
    codes.add(c);
    if (parent !== '' && !c.startsWith(String(parent))) throw new Error(`${c} is not under its parent ${parent}`);
  }
  for (const [code, , , parent] of rows) {
    if (parent !== '' && !codes.has(String(parent))) throw new Error(`${code} has missing parent ${parent}`);
  }

  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const lines = ['code,name_th,name_en,parent', ...rows.map((r) => r.map((v) => csvField(String(v).trim())).join(','))];
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${lines.join('\n')}\n`);
  console.log(`${OUT}: ${provinces.length} provinces, ${districts.length} districts, ${subdistricts.length} subdistricts`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
