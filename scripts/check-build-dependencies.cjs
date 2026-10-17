const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
let pass = 0;
// ตรวจ graph ที่ติดตั้งจริงและ CSS compiler เพื่อกันสาย dependency เดิมกลับมา
function check(name, run) { run(); pass++; console.log('PASS ' + name); }
async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  check('Tailwind and PostCSS adapter versions agree', () => {
    assert.equal(manifest.devDependencies.tailwindcss, '4.3.3');
    assert.equal(manifest.devDependencies['@tailwindcss/postcss'], '4.3.3');
    assert.equal(require(path.join(root, 'node_modules/tailwindcss/package.json')).version, '4.3.3');
  });
  check('Legacy vulnerable graph removed from lockfile', () => {
    for (const p of Object.keys(lock.packages)) assert(!/(^|\/)(braces|micromatch|fast-glob|chokidar|postcss-nested|shadcn)$/.test(p), p);
    assert(!manifest.overrides);
  });
  check('Animation plugin is build-only', () => {
    assert(manifest.devDependencies['tailwindcss-animate']);
    assert(!manifest.dependencies['tailwindcss-animate']);
  });
  const postcss = require(path.join(root, 'node_modules/postcss'));
  const adapter = require('@tailwindcss/postcss');
  const input = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8') + '\n@source inline("shadow-xs outline-hidden rounded-sm bg-primary dark:bg-background coarse:h-11 animate-in fade-in-0 md:grid-cols-4");';
  const result = await postcss([adapter()]).process(input, { from: path.join(root, 'src/index.css') });
  const css = result.css;
  check('Custom theme and important map styles compile', () => {
    assert(css.includes('hsl(var(--primary))')); assert(css.includes('!important'));
  });
  check('Dark, responsive and touch variants compile', () => {
    assert(css.includes('.dark')); assert(css.includes('pointer: coarse')); assert(css.includes('48rem'));
  });
  check('Animation and renamed compatibility utilities compile', () => {
    for (const token of ['.animate-in', '.shadow-xs', '.outline-hidden']) assert(css.includes(token), token);
  });
  check('No unprocessed Tailwind directives remain', () => {
    assert(!/@(?:apply|config|source|tailwind)\s/.test(css));
  });
  console.log(JSON.stringify({ pass, fail: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
