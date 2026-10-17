/** ตรวจกรณีเลือกบางช่องและค่าที่ส่งเข้า INSERT จริง โดยไม่เปิด server หรือ DB */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { nvrImportIdentity } from '../src/lib/nvr-import.js'
const source = fs.readFileSync(new URL('../server/server.js', import.meta.url), 'utf8')
const from = source.indexOf('const nvrChannelNumber = ')
const to = source.indexOf('/** ตัดรหัสผ่าน', from)
const begin = source.indexOf('  channels.forEach((ch, i) => {')
const end = source.indexOf('  // Previously this always answered success', begin)
assert.ok(from >= 0 && to > from && begin >= 0 && end > begin)
const read = {}
vm.runInNewContext(`${source.slice(from, to)}; this.number = nvrChannelNumber`, read)
const unknown = { id: 'source-8', name: 'Loading bay', main: { rtsp: 'rtsp://fixture/private-layout', token: 'profile-8' } }
assert.deepEqual(nvrImportIdentity(unknown, 'Site'), { channel: null, name: 'Site Loading bay' })
assert.equal(nvrImportIdentity(unknown, 'Site').name, [unknown].map(c => nvrImportIdentity(c, 'Site'))[0].name)
assert.deepEqual(nvrImportIdentity({ channel: 8, name: 'Loading bay' }, 'Site'), { channel: 8, name: 'Site CH 8 (Loading bay)' })
assert.equal(nvrImportIdentity({ channel: 0 }).channel, null)
const insert = (ch, options = {}) => {
  let values
  const context = { channels: [ch], univiewImport: false, axisImport: false, baseName: '', baseTs: 1,
    addedIds: [], insertErr: null, group: 'Fixture', brand: 'tiandy', ip: 'fixture', onvifPort: 80,
    rtspPort: 554, user: 'fixture', pass: 'fixture', onvifXaddrs: null, region: { province: '10', district: '1001' },
    nvrChannelNumber: read.number, stmt: { run: (args, cb) => { values = args; cb(null) } }, ...options }
  vm.runInNewContext(source.slice(begin, end), context, { timeout: 1000 })
  return values
}
const actual = insert({ channel: 1, main: { rtsp: 'rtsp://fixture/live?channel=8', token: 'profile-8' } })
assert.equal(actual[17], 8, 'stored channel comes from URI, not forged browser number')
assert.equal(actual[15], 'profile-8', 'profile identity remains unchanged')
assert.equal(insert({ channel: 1, main: unknown.main })[17], null)
assert.equal(insert({ main: unknown.main })[1], 'ช่องไม่ระบุหมายเลข')
assert.equal(insert({ channel: 8 }, { univiewImport: true })[17], 8)
assert.equal(insert({ main: { rtsp: 'rtsp://fixture/live?channel=8' } }, { axisImport: true, req: { body: { apiPort: 80 } } })[17], null)
console.log('PASS NVR import: subset label, unknown/zero channel, verified URI channel, preserved profile, UNV and AXIS behavior')
