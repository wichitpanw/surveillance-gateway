// SSE ตรวจ key จาก DB ใหม่เสมอ และยกเลิกข้อมูลค้างเมื่อสิทธิ์เปลี่ยน
function createEventStream({ db, auth, scopeClause, cameraState, aiEvents, edgeAlerts, cameraInfo, withCamera, streamPathName, nowIso }) {
  return async (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    if (!cameraState) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'สถานะกล้องยังไม่พร้อม' })}\n\n`);
      return res.end();
    }
    let closed = false;
    let refreshing = false;
    let generation = 0;
    let scope = new Map();
    const subscriptions = [];
    let ping;
    let refreshTimer;
    // ลงทะเบียน cleanup ก่อน query แรก ป้องกันผู้ชมปิดระหว่างรอ DB แล้ว listener ค้าง
    const stop = () => {
      if (closed) return;
      closed = true;
      generation++;
      scope.clear();
      for (const unsubscribe of subscriptions) unsubscribe();
      clearInterval(ping);
      clearInterval(refreshTimer);
      req.off('aborted', stop);
      res.off('close', stop);
      if (!res.writableEnded && !res.destroyed) res.end();
    };
    req.on('aborted', stop);
    res.on('close', stop);
    subscriptions.push(auth.subscribeInvalidation(clientId => {
      if (!clientId || clientId === req.apiClient.id) stop();
    }));
    // ไม่ใช้ cache ของ HTTP auth; ระหว่างตรวจใหม่หยุดส่งและล้าง scope เดิม
    const refresh = async () => {
      if (closed || refreshing) return;
      refreshing = true;
      const current = ++generation;
      scope.clear();
      try {
        const client = await auth.revalidate(req.apiClient.id, req.apiKeyHash);
        if (closed) return;
        if (!client) { stop(); return; }
        const { sql, params } = scopeClause(client);
        const rows = await new Promise((resolve, reject) => {
          db.all(`SELECT id, name FROM cameras ${sql}`, params, (err, rows) => err ? reject(err) : resolve(rows));
        });
        if (closed || current !== generation) return;
        req.apiClient = client;
        scope = new Map((rows || []).map(row => [row.id, row.name]));
      } catch (_) {
        // อ่าน key หรือ scope ไม่ได้ = ปิด ไม่ใช้สิทธิ์เก่าต่อ
        stop();
      } finally {
        refreshing = false;
      }
    };
    const send = event => {
      if (!closed && !refreshing && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const onChange = (id, next, prev) => {
      if (!scope.has(id)) return;
      const cameraName = scope.get(id);
      send({ type: 'camera_state', cameraId: id, cameraName, enabled: next.enabled, reachable: next.reachable, streaming: next.streaming, at: next.at });
      const was = prev ? prev.reachable === true : null;
      const now = next.reachable === true;
      if (was !== now) send({ type: 'camera_status', cameraId: id, cameraName, streamType: 'main', path: streamPathName(id, 'main'), from: was === null ? 'unknown' : was ? 'online' : 'offline', to: now ? 'online' : 'offline', at: next.at });
    };
    const onRemove = id => {
      if (!scope.has(id)) return;
      send({ type: 'camera_removed', cameraId: id, cameraName: scope.get(id), at: nowIso() });
      scope.delete(id);
    };
    await refresh();
    if (closed) return;
    subscriptions.push(cameraState.subscribe({ onChange, onRemove }));
    subscriptions.push(aiEvents ? aiEvents.subscribe(row => {
      if (!scope.has(row.camera_id)) return;
      const current = generation;
      void cameraInfo([row.camera_id]).then(info => {
        if (current === generation && scope.has(row.camera_id)) send({ type: 'ai_event', event: withCamera([row], info)[0] });
      }).catch(() => console.warn('[API v1] AI event metadata lookup failed'));
    }) : () => {});
    subscriptions.push(edgeAlerts ? edgeAlerts.subscribe(event => send({ type: 'edge_state', ...event })) : () => {});
    res.write(`event: hello\ndata: ${JSON.stringify({ cameras: scope.size })}\n\n`);
    ping = setInterval(() => { if (!closed && !res.destroyed) res.write(': ping\n\n'); }, 20_000);
    refreshTimer = setInterval(refresh, 30_000);
  };
}

module.exports = { createEventStream };
