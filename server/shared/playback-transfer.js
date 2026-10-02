/** ส่งภาพโดยจบ HTTP เมื่อ stdout จบและ process สำเร็จเท่านั้น — ใช้ทั้งผู้ชมและ upload */
function transferPlayback(pb, destination, { start = () => {}, fail }) {
  const { proc } = pb;
  let started = false, ended = false, exited = false, done = false;
  const failure = () => {
    if (done) return;
    done = true;
    proc.stdout.unpipe(destination);
    pb.kill();
    fail();
  };
  const finish = () => {
    if (done || !ended || !exited) return;
    if (!started) return failure();
    done = true;
    destination.end();
  };
  destination.on('close', () => { if (!done) { done = true; pb.kill(); } });
  destination.on('error', failure);
  proc.stdout.on('error', failure);
  proc.on('error', failure);
  proc.on('close', (code, signal) => {
    if (code !== 0 || signal) return failure();
    exited = true;
    finish();
  });
  proc.stdout.once('end', () => { ended = true; finish(); });
  proc.stdout.once('data', (first) => {
    if (done || destination.destroyed || destination.writableEnded) { pb.kill(); return; }
    try {
      start();
      started = true;
      if (!destination.write(first)) {
        proc.stdout.pause();
        destination.once('drain', () => { if (!done) proc.stdout.resume(); });
      }
      proc.stdout.pipe(destination, { end: false });
    } catch { failure(); }
  });
  if (Number.isInteger(proc.exitCode)) {
    if (proc.exitCode !== 0 || proc.signalCode) failure();
    else { exited = true; finish(); }
  }
}

module.exports = { transferPlayback };
