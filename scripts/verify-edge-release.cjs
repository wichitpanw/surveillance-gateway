/** ตรวจแพ็กเกจครบทุกแพลตฟอร์มก่อนให้ deploy ข้าม publish หรือรายงานสำเร็จ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PLATFORMS } = require('../server/shared/edge-update-manifest');
const { verifyManifestV2 } = require('./edge-update-key.cjs');

function verifyRelease(dir, build) {
  for (const platform of PLATFORMS) {
    const folder = path.join(dir, platform);
    const m = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
    const problem = verifyManifestV2(m);
    if (problem || m.platform !== platform || m.build !== build) throw new Error(`${platform}: ${problem || 'platform/build ไม่ตรง'}`);
    const pkg = fs.readFileSync(path.join(folder, m.file));
    if (pkg.length !== m.size || crypto.createHash('sha256').update(pkg).digest('hex') !== m.sha256) throw new Error(`${platform}: ขนาดหรือ SHA-256 ไม่ตรง`);
  }
  return true;
}

if (require.main === module) {
  try {
    verifyRelease(require('../server/shared/instance').stateFile('edge-updates'), process.argv[2]);
    console.log('Release verified: all platforms, signature, size and SHA-256');
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { verifyRelease };
