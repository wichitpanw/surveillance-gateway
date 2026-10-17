/** ตรวจ Node ก่อน build เพื่อหยุดก่อนแก้ไฟล์หรือ restart production */
function supported(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
}
if (require.main === module) {
  if (!supported(process.versions.node)) {
    console.error('Build requires Node ^20.19.0 || >=22.12.0; current: ' + process.versions.node);
    process.exitCode = 1;
  } else console.log('Build runtime OK: Node ' + process.versions.node);
}
module.exports = { supported };
