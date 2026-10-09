/** ส่งออกรายการกล้องเป็น CSV โดยเลือกเฉพาะข้อมูลที่ไม่ใช่ credential */
const { lookup } = require('./regions');
const { nowIso } = require('./time');

const CAMERA_FIELDS = [
  'id', 'global_id', 'name', 'group_name', 'brand', 'type', 'ip',
  'onvifPort', 'rtspPort', 'lat', 'lng', 'province_code', 'district_code',
  'stream_type', 'always_on', 'enabled', 'nvr_channel',
  'source_id', 'source_ref',
  'source_missing_at', 'analytics_kind', 'analytics_probed_at',
];
const SOURCE_FIELDS = [
  'kind', 'label', 'host', 'port', 'rtsp_port', 'mode', 'remark',
  'remote_role', 'remote_node', 'remote_region', 'remote_build',
  'status', 'status_at', 'last_sync_at', 'created_at',
];
const COLUMNS = [
  ...CAMERA_FIELDS, 'province_name', 'district_name', 'rtsp', 'rtsp_sub',
  ...SOURCE_FIELDS.map((field) => `source_${field}`),
  'reachable', 'streaming', 'state_since', 'exported_at',
];

/** เก็บเฉพาะที่อยู่สตรีม ตัด user/password, query และ fragment ที่อาจมี token */
function safeStreamUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['rtsp:', 'rtsps:', 'http:', 'https:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

/** ครอบช่องตาม CSV และกันข้อความที่ Excel อาจตีความเป็นสูตร โดยคงเลขพิกัดติดลบ */
function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** อ่านเฉพาะคอลัมน์ที่อนุญาต รองรับ schema ใหม่/เก่าที่ไม่มีคอลัมน์เสริม */
function createCameraExport({ db, role, cameraState }) {
  const all = (sql, params = []) => new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));

  return async (req, res) => {
    if (!['central', 'regional'].includes(role)) {
      return res.status(403).json({ error: 'ส่งออกรายการกล้องได้เฉพาะ Regional และ Central' });
    }
    try {
      const cameraSchema = new Set((await all('PRAGMA table_info(cameras)')).map((c) => c.name));
      const sourceSchema = new Set((await all('PRAGMA table_info(camera_sources)')).map((c) => c.name));
      const cameraColumns = [...CAMERA_FIELDS, 'rtsp', 'rtsp_sub'].map((field) =>
        `${cameraSchema.has(field) ? `c.${field}` : 'NULL'} AS ${field}`);
      const sourceColumns = SOURCE_FIELDS.map((field) =>
        `${sourceSchema.has(field) ? `s.${field}` : 'NULL'} AS source_${field}`);
      const scoped = req.deviceIds instanceof Set;
      const ids = scoped ? [...req.deviceIds] : [];
      const where = scoped ? (ids.length ? `WHERE c.id IN (${ids.map(() => '?').join(',')})` : 'WHERE 0') : '';
      const rows = await all(`SELECT ${[...cameraColumns, ...sourceColumns].join(', ')}
        FROM cameras c LEFT JOIN camera_sources s ON s.id = c.source_id
        ${where} ORDER BY c.group_name, c.name, c.id`, ids);
      const exportedAt = nowIso();
      const records = rows.map((row) => {
        const state = cameraState.get(row.id);
        return {
          ...row,
          rtsp: safeStreamUrl(row.rtsp), rtsp_sub: safeStreamUrl(row.rtsp_sub),
          province_name: lookup(row.province_code)?.nameTh || '',
          district_name: lookup(row.district_code)?.nameTh || '',
          reachable: state?.reachable ?? null, streaming: state?.streaming ?? null,
          state_since: state?.at ?? null, exported_at: exportedAt,
        };
      });
      const csv = '\uFEFF' + [COLUMNS.map(csvCell).join(','),
        ...records.map((row) => COLUMNS.map((field) => csvCell(row[field])).join(','))].join('\r\n') + '\r\n';
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="cameras-${role}-${exportedAt.slice(0, 10)}.csv"`);
      res.set('Cache-Control', 'no-store');
      return res.send(csv);
    } catch {
      return res.status(500).json({ error: 'ส่งออกรายการกล้องไม่สำเร็จ' });
    }
  };
}

module.exports = { createCameraExport, safeStreamUrl, csvCell, COLUMNS, CAMERA_FIELDS, SOURCE_FIELDS };
