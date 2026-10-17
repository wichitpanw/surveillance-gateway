const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), crypto = require('crypto'), http = require('http');
const { spawn, spawnSync } = require('child_process');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-update-check-'));
const key = require(path.join(root, 'scripts/edge-update-key.cjs'));
const manifestApi = require(path.join(root, 'server/shared/edge-update-manifest'));
const stateApi = require(path.join(root, 'scripts/edge-update-state.cjs'));
const pair = crypto.generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({format:'pem',type:'spki'});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = []; let sequence = 0;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const newerState = {build:'2222222',issuedAt:'2026-10-10T10:00:00+07:00',sha256:'a'.repeat(64)};
function sign(bytes = Buffer.from('fixture'), build = '3333333', issuedAt = '2026-10-11T10:00:00+07:00') {
  const m = {build,platform:'windows-x64',file:`app-windows-x64-${build}.tar.gz`,size:bytes.length,sha256:hash(bytes),issuedAt,path:'/package'};
  m.signature = manifestApi.signManifest(m,pair.privateKey); m.sig2 = key.signManifestV2(m,pair.privateKey); return m;
}
async function until(predicate, timeout = 3000) { const end = Date.now()+timeout; while (Date.now()<end) { if (predicate()) return; await delay(20); } throw new Error('Fixture wait timed out'); }
function fixture(initial, fault) {
  let faultMode = fault;
  const dir = path.join(base, 'case-' + ++sequence); const updates = path.join(dir,'updates'); fs.mkdirSync(updates,{recursive:true});
  if (initial !== undefined) fs.writeFileSync(path.join(updates,'accepted-manifest.json'), typeof initial === 'string' ? initial : JSON.stringify(initial));
  const fakeFs = Object.create(fs);
  if (fault === 'read') fakeFs.readFileSync = (file,...args) => { if (String(file).endsWith('accepted-manifest.json')) throw Object.assign(new Error('fixture EACCES'),{code:'EACCES'}); return fs.readFileSync(file,...args); };
  fakeFs.openSync = (file,...args) => { if (faultMode === 'write' && String(file).endsWith('.tmp')) throw new Error('fixture EACCES'); return fs.openSync(file,...args); };
  if (fault === 'rename') fakeFs.renameSync = (from,to) => { if (String(to).endsWith('accepted-manifest.json')) throw new Error('fixture disk full'); return fs.renameSync(from,to); };
  const stateModule = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'scripts/edge-update-state.cjs'),'utf8'),{require:name=>name==='fs'?fakeFs:require(name),module:stateModule});
  const mod={exports:{}}; const timers = new Set();
  vm.runInNewContext(fs.readFileSync(path.join(root,'server/vms/edge-update-client.js'),'utf8'),{
    require:name=>name==='fs'?fakeFs:name==='../shared/instance'?{BUILD:'1111111',stateFile:file=>path.join(dir,file)}:name==='../shared/time'?{nowIso:()=> '2026-10-11T15:00:00+07:00'}:name==='../shared/edge-update-manifest'?{currentPlatform:()=> 'windows-x64'}:name.includes('edge-update-key')?{...key,verifyManifestV2:m=>key.verifyManifestV2(m,publicKey)}:name.includes('edge-update-state')?stateModule.exports:require(name),
    module:mod,__dirname:path.join(root,'server/vms'),process:{platform:'win32',env:{GW_EDGE_RUNNER:'edge-run'},pid:0},Buffer,console:{log(){},warn(){}},setInterval:()=>({unref(){}}),
    setTimeout:(fn,ms)=>{const t={fn,ms,unref(){}};timers.add(t);return t;},clearTimeout:t=>timers.delete(t),
  });
  return {dir,updates,updater:mod.exports.createEdgeUpdater(),timers,setFault:value=>{faultMode=value;}};
}
async function check(name, action) { await action(); results.push({name,status:'PASS'}); console.log('PASS '+name); }
let payload = Buffer.from('fixture'); let mode='ok'; let hits=0;
const server = http.createServer((req,res)=>{
  hits++; assert.equal(req.headers.authorization,'Bearer fixture-link');
  if (mode==='drop') { res.writeHead(200,{'Content-Length':payload.length}); res.write(payload.subarray(0,2)); res.destroy(); return; }
  const body=mode==='corrupt'?Buffer.from('corrupt'):payload;
  res.writeHead(200,{'Content-Length':body.length});res.end(body);
});
const context = {httpBase:null,token:'fixture-link'};
async function ready(f,m) { await f.updater.handleOffer(m,context); await until(()=>['ready','failed'].includes(f.updater.status().state)); }
function runnerVerify(f,m) {
  const appDir=path.join(f.dir,'app'); fs.mkdirSync(path.join(appDir,'scripts/edge-kit'),{recursive:true}); fs.writeFileSync(path.join(appDir,'scripts/edge-kit/edge-update.pub.pem'),publicKey);
  const source=fs.readFileSync(path.join(root,'scripts/edge-run.cjs'),'utf8');const start=source.indexOf('function verifyV2(m)');const end=source.indexOf('let applying =',start);
  const mod={exports:{}};vm.runInNewContext(source.slice(start,end)+'\nmodule.exports=verifyV2;',{fs,path,crypto,appDir,updDir:f.updates,readAccepted:stateApi.readAccepted,module:mod,Buffer});return mod.exports(m);
}
function fixtureApp(dir, state, build, healthy) {
  fs.mkdirSync(path.join(dir,'scripts/edge-kit'),{recursive:true}); fs.mkdirSync(path.join(dir,'server/shared'),{recursive:true});
  fs.writeFileSync(path.join(dir,'BUILD'),build);
  for (const file of ['edge-run.cjs','edge-update-state.cjs']) fs.copyFileSync(path.join(root,'scripts',file),path.join(dir,'scripts',file));
  fs.writeFileSync(path.join(dir,'scripts/edge-kit/edge-update.pub.pem'),publicKey);
  fs.copyFileSync(path.join(root,'server/shared/edge-update-manifest.js'),path.join(dir,'server/shared/edge-update-manifest.js'));
  fs.writeFileSync(path.join(dir,'fixture-worker.cjs'), `const fs=require('fs'),path=require('path');const state=${JSON.stringify(state)};fs.mkdirSync(path.join(state,'updates'),{recursive:true});fs.appendFileSync(path.join(state,'fixture-starts.jsonl'),JSON.stringify({pid:process.pid,build:${JSON.stringify(build)}})+'\\n');${healthy?`setTimeout(()=>fs.writeFileSync(path.join(state,'updates/link-ok.json'),JSON.stringify({build:${JSON.stringify(build)},at:Date.now()})),100);`:''}setInterval(()=>{},1000);`);
  fs.writeFileSync(path.join(dir,'ecosystem.edge.config.cjs'), `const path=require('path');module.exports={apps:[{name:'3-edge-gateway',script:path.join(__dirname,'fixture-worker.cjs'),cwd:__dirname,env:{GATEWAY_STATE_DIR:${JSON.stringify(state)},GATEWAY_PORT:0,GATEWAY_NODE_NUMBER:999}}]};`);
}
async function fullRunner(healthy) {
  const dir=path.join(base,'runner-'+healthy);const app=path.join(dir,'app');const state=path.join(dir,'state');const updates=path.join(state,'updates');fs.mkdirSync(updates,{recursive:true});
  fixtureApp(app,state,'1111111',true);const candidate=path.join(dir,'candidate');fixtureApp(candidate,state,'3333333',healthy);
  const pkg=path.join(updates,'app-windows-x64-3333333.tar.gz');const tar=process.platform==='win32'?path.join(process.env.SystemRoot,'System32/tar.exe'):'tar';
  const pack=spawnSync(tar,['-czf',pkg,'-C',candidate,'.'],{encoding:'utf8',windowsHide:true});assert.equal(pack.status,0,pack.stderr);
  const m=sign(fs.readFileSync(pkg));stateApi.writeAccepted(updates,m,'fixture');fs.writeFileSync(path.join(updates,'pending.json'),JSON.stringify(m));
  // state อยู่นอก app; marker นี้แทน DB/secret ที่ต้องไม่เปลี่ยนตอนสลับโปรแกรม
  fs.writeFileSync(path.join(state,'fixture-data-marker'),'KEEP-FIXTURE-STATE');
  const runner=spawn(process.execPath,[path.join(app,'scripts/edge-run.cjs')],{cwd:dir,windowsHide:true,env:{...process.env,NODE_OPTIONS:'--preserve-symlinks --preserve-symlinks-main',GW_EDGE_UPDATE_HEALTH_MS:'6000'},stdio:['ignore','pipe','pipe']});let output='';runner.stdout.on('data',d=>{output+=d;});runner.stderr.on('data',d=>{output+=d;});
  try {
    await until(()=>fs.existsSync(path.join(state,'fixture-starts.jsonl')),5000);
    fs.writeFileSync(path.join(updates,'apply.json'),JSON.stringify({build:m.build,sha256:m.sha256,file:m.file}));
    await until(()=>fs.existsSync(path.join(updates,'last-result.json')),22000);
    const result=JSON.parse(fs.readFileSync(path.join(updates,'last-result.json')));
    assert.equal(result.ok,healthy);assert.equal(fs.readFileSync(path.join(app,'BUILD'),'utf8'),healthy?'3333333':'1111111');
    if (!healthy) { assert(result.rolledBack); await until(()=>fs.readFileSync(path.join(state,'fixture-starts.jsonl'),'utf8').trim().split('\n').length>=3); }
    assert.equal(fs.readFileSync(path.join(state,'fixture-data-marker'),'utf8'),'KEEP-FIXTURE-STATE');
    assert.equal(stateApi.readAccepted(updates).build,'3333333');
    fs.writeFileSync(path.join(dir,'runner-evidence.json'),JSON.stringify({result,starts:fs.readFileSync(path.join(state,'fixture-starts.jsonl'),'utf8'),output},null,2));
  } finally {
    // ปิดเฉพาะ runner/worker ที่ fixture นี้สร้างและบันทึก PID เอง
    const owned = fs.existsSync(path.join(state,'edge-run.pids')) ? JSON.parse(fs.readFileSync(path.join(state,'edge-run.pids'),'utf8')) : [];
    runner.kill();
    for (const record of owned) { assert.equal(path.resolve(record.exe),path.resolve(process.execPath));try{process.kill(record.pid);}catch(err){if(err.code!=='ESRCH')throw err;} }
    await new Promise(resolve=>{if(runner.exitCode!==null||runner.signalCode!==null)resolve();else runner.once('exit',resolve);});
    for (const record of owned) await until(()=>{try{process.kill(record.pid,0);return false;}catch(err){if(err.code==='ESRCH')return true;throw err;}},3000);
  }
}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));context.httpBase='http://127.0.0.1:'+server.address().port;
  await check('First install persists valid accepted state and initialized marker',async()=>{const f=fixture();await ready(f,sign());assert.equal(f.updater.status().state,'ready');assert(stateApi.readAccepted(f.updates));assert(fs.existsSync(path.join(f.updates,'accepted-manifest.initialized')));});
  for (const [name,initial,fault] of [['corrupt JSON','{invalid'],['missing fields',{}],['invalid time',{...newerState,issuedAt:'bad'}],['invalid hash',{...newerState,sha256:'bad'}],['read EACCES',newerState,'read'],['write EACCES',newerState,'write']]) await check('Reject accepted state '+name,async()=>{const f=fixture(initial,fault);const before=hits;await f.updater.handleOffer(sign(),context);assert.equal(f.updater.status().state,'failed');assert.equal(hits,before);assert(!fs.existsSync(path.join(f.updates,'pending.json')));});
  await check('Missing accepted file after initialization is rejected',async()=>{const f=fixture();fs.writeFileSync(path.join(f.updates,'accepted-manifest.initialized'),'1');await f.updater.handleOffer(sign(),context);assert.equal(f.updater.status().state,'failed');});
  await check('Legacy update history with missing accepted state is not first install',async()=>{for(const name of ['pending.json','last-result.json']){const f=fixture();fs.writeFileSync(path.join(f.updates,name),JSON.stringify({build:'2222222'}));await f.updater.handleOffer(sign(),context);assert.equal(f.updater.status().state,'failed');}});
  await check('Atomic rename failure retains original high water mark',async()=>{const f=fixture(newerState,'rename');await f.updater.handleOffer(sign(),context);assert.equal(f.updater.status().state,'failed');assert.equal(stateApi.readAccepted(f.updates).build,newerState.build);assert(!fs.readdirSync(f.updates).some(n=>n.endsWith('.tmp')));});
  await check('Older signed manifest rejected and identical offer retry allowed',async()=>{const f=fixture(newerState);await f.updater.handleOffer(sign(payload,'3333333','2026-10-09T10:00:00+07:00'),context);assert.equal(f.updater.status().state,'failed');const m=sign();await ready(f,m);await ready(f,m);assert.equal(f.updater.status().state,'ready');});
  await check('Same issuedAt with different hash rejected',async()=>{const f=fixture(newerState);await f.updater.handleOffer(sign(payload,'3333333',newerState.issuedAt),context);assert.equal(f.updater.status().state,'failed');});
  await check('Unsigned or mutated manifest rejected before download',async()=>{for(const m of [{...sign(),sig2:''},{...sign(),sha256:'b'.repeat(64)}]){const f=fixture();const before=hits;await f.updater.handleOffer(m,context);assert.equal(f.updater.status().state,'failed');assert.equal(hits,before);}});
  await check('Corrupt package is not ready or applicable',async()=>{mode='corrupt';const f=fixture();await ready(f,sign());assert.equal(f.updater.status().state,'failed');assert.throws(()=>f.updater.requestApply('fixture'));mode='ok';});
  await check('Interrupted download retries successfully and cleans part file',async()=>{mode='drop';const f=fixture();await ready(f,sign());assert.equal(f.updater.status().state,'failed');assert(f.updater.status().retryable);mode='ok';f.updater.retryDownload();await until(()=>f.updater.status().state==='ready');assert(!fs.readdirSync(f.updates).some(n=>n.endsWith('.part')));});
  await check('Apply rechecks corrupt or missing accepted state',async()=>{for(const missing of [false,true]){const f=fixture();await ready(f,sign());if(missing)fs.unlinkSync(path.join(f.updates,'accepted-manifest.json'));else fs.writeFileSync(path.join(f.updates,'accepted-manifest.json'),'{invalid');assert.throws(()=>f.updater.requestApply('fixture'));assert(!fs.existsSync(path.join(f.updates,'apply.json')));}});
  await check('Apply requires persistent accepted state to be writable',async()=>{const f=fixture();await ready(f,sign());f.setFault('write');assert.throws(()=>f.updater.requestApply('fixture'));assert(!fs.existsSync(path.join(f.updates,'apply.json')));});
  await check('Runner rejects corrupt/missing state and older signed manifest',async()=>{const f=fixture('{invalid');assert(runnerVerify(f,sign()));fs.unlinkSync(path.join(f.updates,'accepted-manifest.json'));assert(runnerVerify(f,sign()));fs.writeFileSync(path.join(f.updates,'accepted-manifest.json'),JSON.stringify(newerState));assert(runnerVerify(f,sign(payload,'3333333','2026-10-09T10:00:00+07:00')));});
  await check('Full tar package update starts healthy fixture and keeps previous app',async()=>{await fullRunner(true);});
  await check('Full tar package health failure rolls back and restarts old fixture',async()=>{await fullRunner(false);});
  fs.writeFileSync(path.join(base,'results.json'),JSON.stringify({pass:results.length,fail:0,results},null,2));console.log(JSON.stringify({pass:results.length,fail:0,evidence:base}));
})().catch(err=>{console.error(err);process.exitCode=1;}).finally(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
