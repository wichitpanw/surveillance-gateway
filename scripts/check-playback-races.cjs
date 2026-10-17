const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../src/components/Playback.jsx'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start); const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('Missing source section');
  return source.slice(a, b);
}
const functions = section('  const invalidatePlayback =', '  const usable =')
  + section('  const loadRanges =', '  // ถอดวิดีโอเก่า')
  + section('  const tokenFor =', '  // เวลาที่รอเล่น')
  + section('  const onEnded =', '  const base =')
  + section('  const snapshotUrl =', '  const pct =');
const button = /disabled=\{([^}]+)\} onClick=\{snapshotUrl\}/.exec(source)[1];
const base = Date.parse('2026-10-10T00:00:00+07:00');
const range = { start: '2026-10-10T00:00:00+07:00', end: '2026-10-12T00:00:00+07:00' };
const response = (body, ok = true) => ({ ok, status: ok ? 200 : 403, json: async () => body });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
  const tokens = []; const errors = []; const popups = [];
  let rangesFetch = async () => response({ ranges: [range] });
  let layout; const state = { camera: { id: 'A' }, day: '2026-10-10', ranges: [range], src: null, playStart: null, nowMs: null, videoError: null, loadingRanges: false };
  const context = { Date, Math, Promise, Map, JSON, AbortController, encodeURIComponent,
    CHUNK_SECONDS: 600, DAY_SECONDS: 86400,
    isoBangkok: ms => new Date(ms + 7 * 3600000).toISOString().replace('Z', '+07:00'), dayStartMs: day => Date.parse(day + 'T00:00:00+07:00'),
    playReqRef: { current: 0 }, tokenRef: { current: null }, rangesReqRef: { current: 0 }, errorCtrlRef: { current: null }, rangesContextRef: { current: { cameraId: 'A', day: state.day } }, videoRef: { current: null },
    useCallback: fn => fn, useLayoutEffect: fn => { layout = fn; },
    apiFetch: url => { if (url.includes('/ranges?')) return rangesFetch(url); const token = deferred(); tokens.push({ ...token, url }); return token.promise; },
    fetch: (url, options) => { const error = deferred(); errors.push({ ...error, url, options }); return error.promise; },
    window: { open: () => { const popup = { location: { href: 'about:blank' }, opener: {}, closed: false, close() { this.closed = true; } }; popups.push(popup); return popup; } },
  };
  for (const name of ['camera','day','ranges','src','playStart','nowMs']) Object.defineProperty(context, name, { get: () => state[name], configurable: true });
  for (const name of ['Src','PlayStart','NowMs','VideoError','LoadingRanges','Ranges','RangeError']) context['set' + name] = value => { state[name[0].toLowerCase() + name.slice(1)] = value; };
  vm.createContext(context);
  vm.runInContext(functions + '\nglobalThis.operations = { playAt, tokenFor, snapshotUrl, onVideoError, onEnded, onTimeUpdate, invalidatePlayback, loadRanges };', context);
  const disabled = () => vm.runInContext(button, context);
  const resolveToken = (n, id = 'A') => tokens[n].resolve(response({ token: 'fixture-' + id, video: '/playback/' + id, frame: '/frame/' + id }));
  return { state, context, tokens, errors, popups, disabled, resolveToken, ...context.operations,
    async change(camera = 'B', day = state.day) { context.operations.invalidatePlayback(); state.camera = { id: camera }; state.day = day; layout(); await new Promise(setImmediate); },
    setRangesFetch: fn => { rangesFetch = fn; },
  };
}
let passed = 0;
async function check(name, action) { await action(fixture()); passed++; console.log('PASS ' + name); }
(async () => {
  await check('A token cannot overwrite B after camera switch', async f => {
    const a = f.playAt(base + 1000); await f.change('B'); const b = f.playAt(base + 2000);
    f.resolveToken(1, 'B'); await b; f.resolveToken(0, 'A'); await a;
    assert(f.state.src.startsWith('/playback/B?')); assert.equal(f.state.nowMs, base + 2000); assert.equal(f.context.tokenRef.current.id, 'B');
  });
  await check('Day switch rejects old success and keeps snapshot disabled', async f => {
    const old = f.playAt(base + 1000); await f.change('A', '2026-10-11'); f.resolveToken(0); await old;
    assert.equal(f.state.src, null); assert.equal(f.state.nowMs, null); assert(f.disabled());
  });
  await check('Two seeks resolved backwards retain only latest time', async f => {
    const a = f.playAt(base + 1000); const b = f.playAt(base + 9000); f.resolveToken(1); await b; f.resolveToken(0); await a;
    assert.equal(f.state.nowMs, base + 9000); assert(f.state.src.includes(encodeURIComponent('2026-10-10T00:00:09.000+07:00')));
  });
  await check('Stale token error does not overwrite successful new playback', async f => {
    const a = f.playAt(base + 1000); const b = f.playAt(base + 9000); f.resolveToken(1); await b; f.tokens[0].reject(new Error('old failure')); await a; assert.equal(f.state.videoError, null);
  });
  await check('Stale success does not clear latest error', async f => {
    const a = f.playAt(base + 1000); const b = f.playAt(base + 9000); f.tokens[1].reject(new Error('latest failure')); await b; f.resolveToken(0); await a;
    assert.equal(f.state.videoError, 'latest failure'); assert.equal(f.state.src, null);
  });
  await check('Unmount drops pending token success and cache write', async f => {
    const old = f.playAt(base + 1000); f.invalidatePlayback(); f.resolveToken(0); await old; assert.equal(f.state.src, null); assert.equal(f.context.tokenRef.current, null);
  });
  await check('Unmount drops pending token error', async f => {
    const old = f.playAt(base + 1000); f.invalidatePlayback(); f.tokens[0].reject(new Error('old error')); await old; assert.equal(f.state.videoError, null);
  });
  await check('Camera/day reset clears old timestamp and prevents snapshot popup', async f => {
    f.state.src = '/old'; f.state.playStart = base; f.state.nowMs = base + 1000; await f.change('B');
    assert.equal(f.state.nowMs, null); assert(f.disabled()); await f.snapshotUrl(); assert.equal(f.popups.length, 0);
  });
  await check('Seeking clears old timestamp while waiting for token', async f => {
    f.state.src = '/old'; f.state.playStart = base; f.state.nowMs = base; const pending = f.playAt(base + 5000);
    assert(f.disabled()); assert.equal(f.state.nowMs, null); f.resolveToken(0); await pending; assert(!f.disabled());
  });
  await check('Seek beyond last range invalidates earlier request', async f => {
    const a = f.playAt(base + 1000); await f.playAt(Date.parse(range.end) + 1); f.resolveToken(0); await a;
    assert.equal(f.state.src, null); assert(f.state.videoError.includes('ไม่มีภาพ')); assert(f.disabled());
  });
  await check('Snapshot uses current camera token and Bangkok timestamp', async f => {
    const playing = f.playAt(base + 5000); f.resolveToken(0); await playing; await f.snapshotUrl();
    assert(f.popups[0].location.href.startsWith('/frame/A?')); assert(f.popups[0].location.href.includes(encodeURIComponent('2026-10-10T00:00:05.000+07:00'))); assert.equal(f.popups[0].opener, null);
  });
  await check('Pending snapshot closes blank popup after context changes', async f => {
    f.state.src = '/current'; f.state.playStart = base; f.state.nowMs = base; const snapshot = f.snapshotUrl(); await f.change('B'); f.resolveToken(0); await snapshot;
    assert(f.popups[0].closed); assert.equal(f.popups[0].location.href, 'about:blank'); assert.equal(f.state.videoError, null);
  });
  await check('Pending snapshot error cannot overwrite new context', async f => {
    f.state.src = '/current'; f.state.playStart = base; f.state.nowMs = base; const snapshot = f.snapshotUrl(); await f.change('B'); f.tokens[0].reject(new Error('old snapshot')); await snapshot;
    assert(f.popups[0].closed); assert.equal(f.state.videoError, null);
  });
  await check('Video error diagnostic is aborted and cannot overwrite newer playback', async f => {
    const node = {}; f.context.videoRef.current = node; f.state.src = '/old'; const error = f.onVideoError({ currentTarget: node });
    const playing = f.playAt(base + 5000); assert(f.errors[0].options.signal.aborted); f.resolveToken(0); await playing;
    f.errors[0].resolve(response({ error: 'old video error' }, false)); await error; assert.equal(f.state.videoError, null);
  });
  await check('Old video DOM events cannot advance playback or timestamp', async f => {
    f.context.videoRef.current = { currentTime: 10 }; f.state.playStart = base; f.state.nowMs = base;
    f.onTimeUpdate({ currentTarget: {} }); f.onEnded({ currentTarget: {} }); assert.equal(f.state.nowMs, base); assert.equal(f.tokens.length, 0);
  });
  await check('Playback cannot use ranges owned by old camera/day', async f => {
    f.state.camera = { id: 'B' }; await f.playAt(base); assert.equal(f.tokens.length, 0);
    f.state.camera = { id: 'A' }; f.state.day = '2026-10-11'; await f.playAt(base); assert.equal(f.tokens.length, 0);
  });
  await check('Unmount drops pending ranges response', async f => {
    const pending = deferred(); f.setRangesFetch(() => pending.promise); const loading = f.loadRanges(f.state.camera, f.state.day); f.invalidatePlayback();
    pending.resolve(response({ ranges: [range] })); await loading; assert.equal(f.context.rangesContextRef.current, null);
  });
  console.log(JSON.stringify({ pass: passed, fail: 0, method: 'Exact source handlers/lifecycle with deferred API fixtures; not browser E2E' }));
})().catch(err => { console.error(err); process.exitCode = 1; });
