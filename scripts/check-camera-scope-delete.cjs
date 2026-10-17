const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const sqlite3 = require(path.join(root, 'server/node_modules/sqlite3'));
const source = fs.readFileSync(path.join(root, 'server/server.js'), 'utf8');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-removal-check-'));
const run = (db, sql) => new Promise((resolve, reject) => db.exec(sql, e => e ? reject(e) : resolve()));
const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (e, rows) => e ? reject(e) : resolve(rows)));
const close = db => new Promise((resolve, reject) => db.close(e => e ? reject(e) : resolve()));
let passed = 0;
function pass(name) { passed++; console.log('PASS ' + name); }
function handlers(context) {
  const routes = new Map();
  Object.assign(context, { app: Object.fromEntries(['get','post','delete'].map(method => [method, (route, ...h) => routes.set(route, h.at(-1))])), requirePerm: () => () => {}, checkAuth() {} });
  vm.createContext(context);
  for (const [start, end] of [
    ["app.get('/api/status'", "app.post('/api/system/resync-streams'"],
    ["app.delete('/api/cameras/:id'", "app.post('/api/cameras/bulk-add'"],
    ["app.post('/api/cameras/bulk-delete'", "app.post('/api/cameras/rename-group'"],
  ]) { const a = source.indexOf(start), b = source.indexOf(end, a); assert(a >= 0 && b > a); vm.runInContext(source.slice(a,b), context); }
  return routes;
}
async function invoke(handler, req) {
  let status = 200;
  return new Promise((resolve, reject) => {
    const res = {
      status(n) { status = n; return this; },
      json(b) { resolve({ status, body: JSON.parse(JSON.stringify(b)) }); return this; },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
(async () => {
  const state = { A: { id: 'A', name: 'Allowed', health: 'ok' }, B: { id: 'B', name: 'Hidden', health: 'offline' }, C: { id: 'C', health: 'degraded' }, D: { id: 'D', health: 'no_stream' }, E: { id: 'E', health: 'idle' } };
  const routes = handlers({ camLastStatus: { A:'online', B:'offline', C:'online', D:'offline', E:'online' }, cameraState: { all: () => new Map(Object.entries(state)) }, publicCameraState: s => s,
    streamHealthState: state, streamHealthSummary: { total:5, online:4, degraded:2, offline:1, updatedAt:123 },
    cameraInScope: (req,id) => !(req.deviceIds instanceof Set) || req.deviceIds.has(String(id)), Set,
  });
  for (const scope of [null, new Set(['A','C']), new Set()]) {
    const req = { deviceIds: scope }, expected = scope ? [...scope] : ['A','B','C','D','E'];
    for (const route of ['/api/status','/api/camera-states']) {
      assert.deepEqual(Object.keys((await invoke(routes.get(route),req)).body), expected);
    }
    const health = (await invoke(routes.get('/api/system/stream-health'),req)).body;
    assert.deepEqual(health.cameras.map(c=>c.id), expected);
    assert.equal(health.summary.total,expected.length);
    assert.equal(health.summary.online,expected.filter(id=>id!=='B').length);
    assert.equal(health.summary.degraded,expected.filter(id=>id==='C'||id==='D').length);
    assert.equal(health.summary.offline,expected.includes('B')?1:0);
    assert.equal(health.summary.updatedAt,123);
  }
  pass('Exact status handlers filter limited/empty scope and preserve unrestricted summary');
  const { removeCameras } = require(path.join(root, 'server/shared/camera-removal'));
  let index=0;
  async function fixture(trigger='') {
    const dbPath=path.join(base, (++index)+'.db'), db=new sqlite3.Database(dbPath);
    await run(db, "CREATE TABLE cameras(id TEXT PRIMARY KEY,global_id TEXT,name TEXT,type TEXT); INSERT INTO cameras VALUES('A','GA','Camera A','rtsp'),('B','GB','Camera B','edge_relay'); CREATE TABLE camera_deletions(camera_id TEXT PRIMARY KEY,global_id TEXT,name TEXT,deleted_at TEXT NOT NULL,deleted_by TEXT);" + trigger);
    return { db, dbPath, remove: (ids,recordDeletions=true) => removeCameras({dbPath,sqlite3,ids,username:'fixture',recordDeletions}) };
  }
  for (const trigger of ["CREATE TRIGGER blocked BEFORE DELETE ON cameras BEGIN SELECT RAISE(ABORT,'delete blocked'); END;", "CREATE TRIGGER blocked BEFORE INSERT ON camera_deletions BEGIN SELECT RAISE(ABORT,'tombstone blocked'); END;"]) {
    const f=await fixture(trigger);
    try { await assert.rejects(f.remove(['A','B'])); assert.equal((await all(f.db,'SELECT * FROM cameras')).length,2); assert.equal((await all(f.db,'SELECT * FROM camera_deletions')).length,0); await run(f.db,"INSERT INTO cameras VALUES('C','GC','Unrelated','rtsp')"); }
    finally { await close(f.db); }
  }
  pass('Actual SQLite rolls back both DELETE and tombstone failures; unrelated writes remain usable');
  const f=await fixture();
  try {
    const removed=await f.remove(['A','A','missing','B']); assert.deepEqual(removed.sort(),['A','B']);
    const rows=await all(f.db,'SELECT * FROM camera_deletions'); assert.equal(rows.length,1); assert.equal(rows[0].camera_id,'A'); assert.equal(rows[0].global_id,'GA'); assert.equal(rows[0].deleted_by,'fixture'); assert.match(rows[0].deleted_at,/\+07:00$/);
    assert.equal((await all(f.db,'SELECT * FROM cameras')).length,0); assert.deepEqual(await f.remove(['missing']),[]);
  } finally { await close(f.db); }
  pass('Atomic success preserves identity, excludes relay tombstones, deduplicates IDs and returns actual removals');
  const retained=await fixture("CREATE TRIGGER blocked BEFORE DELETE ON cameras BEGIN SELECT RAISE(ABORT,'delete blocked'); END;");
  try {
    await run(retained.db, "INSERT INTO camera_deletions VALUES('A','OLD','Original','2026-10-15T00:00:00+07:00','original')");
    await assert.rejects(retained.remove(['A']));
    assert.equal((await all(retained.db,'SELECT * FROM camera_deletions'))[0].global_id,'OLD');
  } finally { await close(retained.db); }
  pass('Failed delete restores pre-existing tombstone instead of keeping replacement');
  const concurrent=await fixture();
  try {
    const results=await Promise.all([concurrent.remove(['A']),concurrent.remove(['A'])]);
    assert.equal(results.flat().length,1);
    assert.equal((await all(concurrent.db,'SELECT * FROM camera_deletions')).length,1);
    assert.deepEqual((await all(concurrent.db,'SELECT id FROM cameras')).map(r=>r.id),['B']);
  } finally { await close(concurrent.db); }
  pass('Concurrent removals serialize and only one reports the actual deletion');
  const collector=await fixture();
  try { await collector.remove(['A'],false); assert.equal((await all(collector.db,'SELECT * FROM camera_deletions')).length,0); assert.equal((await all(collector.db,'SELECT * FROM cameras')).length,1); }
  finally { await close(collector.db); }
  pass('Collector removal does not create owner Edge tombstones');
  for (const route of ['/api/cameras/:id','/api/cameras/bulk-delete']) {
    for (const failure of [false,true]) {
      const effects=[], req={deviceIds:new Set(['A']),params:{id:'A'},body:{ids:['A','B','A','missing']},user:{username:'fixture'}};
      const context={ Set, cameraInScope:(req,id)=>req.deviceIds.has(String(id)),sendOutOfScope:res=>res.status(404).json({error:'scope'}),
        removeCameras:async opts=>{assert.deepEqual(Array.from(opts.ids),['A']);assert.equal(opts.recordDeletions,true);if(failure)throw Error('fixture DB error');return ['A'];},
        db:{get:(_s,_p,cb)=>cb(null,{id:'A',type:'rtsp'}),all:(_s,_p,cb)=>cb(null,[{id:'A',type:'rtsp'}])},
        EDGE_TYPE:'edge_relay',PUBLIC_TYPE:'public_hls',dbPath:'fixture',sqlite3,GATEWAY_ROLE:'edge',
        camLastStatus:{A:true,B:true},streamHealthState:{A:{},B:{}},invalidateRoleCache:()=>effects.push('cache'),saveLog:()=>effects.push('log'),setTimeout:()=>effects.push('sync'),syncCamerasToStreamCore(){},notifyCatalogChanged:()=>effects.push('catalog') };
      const response=await invoke(handlers(context).get(route),req);
      assert.equal(response.status,failure?500:200);
      if(failure){assert(!response.body.success);assert.equal(effects.length,0);assert(context.camLastStatus.A);}else{assert(response.body.success);assert.equal(context.camLastStatus.A,undefined);assert(context.camLastStatus.B);assert(effects.includes('catalog'));if(route.endsWith('bulk-delete')){assert.equal(response.body.deleted,1);assert.equal(response.body.skipped,2);}}
    }
  }
  pass('Exact single/bulk routes return DB failure without side effects; success filters scope and reports actual count');
  console.log(JSON.stringify({pass:passed,fail:0,method:'Exact route handlers + isolated real SQLite databases; no production writes'}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(base,{recursive:true,force:true}));
