"""ai-worker — AI บน GPU ของ edge (docs/EDGE-PLAN.md เฟส 5 ข้อ D)

process แยกจาก gateway (pm2 app `4-edge-ai`) — inference ล้มหรือกิน GPU หนักไม่ลากภาพ/API ของ gateway ลงไปด้วย

    gateway (/api/v1)                       ai-worker
    GET  /ai/config  ───────────────────▶  กล้องที่เปิด AI + กฎเส้น/โซน (ทุก 30 วิ)
    GET  /cameras/:id/streams  ─────────▶  RTSP ของ go2rtc บนเครื่องเดียวกัน (sub, เส้น raw)
                                           ffmpeg ถอดภาพ → 5 fps → YOLOX → tracker → กฎ
    POST /ai/events  ◀──────────────────   line_cross / intrusion / loitering / object (+ ภาพประกอบ, eventId กันซ้ำ)

key อ่านจากไฟล์ที่ gateway ออกให้เอง (<stateDir>/.ai-worker-key) · worker ไม่เห็นรหัสกล้อง
event `object` = หนึ่งแถวต่อวัตถุหนึ่งตัวที่ผ่านกล้อง (ประเภท: คน / จักรยาน / รถยนต์ / จักรยานยนต์ / รถบัส / รถบรรทุก, เวลา,
ภาพที่ชัดที่สุด) ใช้ค้นย้อนหลังที่ central · ไม่แยกสี (ตกลง 2026-09-28 — เน้นกฎ perimeter ก่อน)

ค่าจาก env: GATEWAY_URL, AI_KEY_FILE | AI_KEY, AI_MODEL, AI_FPS (5), AI_GPU (0), AI_CONF (0.4),
            AI_WIDTH (640), AI_HWDEC (cuda | none), FFMPEG_PATH
"""
import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from base64 import b64encode
from datetime import datetime, timedelta, timezone

import cv2
import numpy as np

from detector import Detector
from tracker import CameraTracker, evaluate_rules

BANGKOK = timezone(timedelta(hours=7))
GATEWAY = os.environ.get('GATEWAY_URL', 'http://127.0.0.1:5273').rstrip('/')
FPS = float(os.environ.get('AI_FPS', '5'))
WIDTH = int(os.environ.get('AI_WIDTH', '640'))
HWDEC = os.environ.get('AI_HWDEC', 'cuda')
FFMPEG = os.environ.get('FFMPEG_PATH', r'C:\ffmpeg\bin\ffmpeg.exe' if os.name == 'nt' else 'ffmpeg').replace('\\\\', '\\')
FFPROBE = os.path.join(os.path.dirname(FFMPEG), 'ffprobe' + ('.exe' if FFMPEG.lower().endswith('.exe') else '')) if os.path.dirname(FFMPEG) else 'ffprobe'
OBJECT_CLASSES = {'person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck'}
OBJECT_MIN_SEC = 1.0
CONFIG_EVERY = 30


def log(msg):
    print(f'[ai-worker] {msg}', flush=True)


def iso(ts):
    return datetime.fromtimestamp(ts, BANGKOK).isoformat(timespec='milliseconds')


def read_key():
    if os.environ.get('AI_KEY'):
        return os.environ['AI_KEY'].strip()
    path = os.environ.get('AI_KEY_FILE', '')
    for _ in range(60):  # gateway ออก key ตอนเริ่ม — รอได้ถ้า worker ขึ้นก่อน
        try:
            with open(path, encoding='utf-8') as f:
                return f.read().strip()
        except OSError:
            time.sleep(2)
    sys.exit(f'[ai-worker] อ่าน key ไม่ได้: {path} — เปิด aiWorker ใน edge.json แล้วเปิด gateway ใหม่')


KEY = read_key()


def api(method, path, body=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f'{GATEWAY}/api/v1{path}', data=data, method=method,
                                 headers={'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json',
                                          'X-Client-Name': 'ai-worker'})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read() or b'null')


# ─────────────────────────────────────────────── ส่ง event (คิว + ส่งเป็นชุด + ลองใหม่)
events = queue.Queue(maxsize=2000)
BATCH_MAX = 20  # gateway รับครั้งละไม่เกิน 100 — ชุดที่รอส่งซ้ำต้องไม่โตเกินนี้


class Sender:
    """ส่ง event เป็นชุดไม่เกิน BATCH_MAX ตัว

    - ดึงจากคิวเฉพาะตอนไม่มีชุดค้าง — ชุดที่รอส่งซ้ำ (gateway ล่ม/สายหลุด) ไม่ถูกเติมเพิ่ม จึงไม่โตเกินที่ gateway รับ
    - gateway ตอบ 400/404 (event เสีย / กล้องถูกลบ): ถ้าบอก `index` มา ทิ้งเฉพาะตัวนั้นแล้วส่งที่เหลือ
      ไม่บอก = ส่งทีละตัวจนหมดชุด — event เสียตัวเดียวไม่ลากตัวอื่นทิ้งไปด้วย
    - ทุก event มี `eventId` (uuid) — gateway ไม่บันทึกซ้ำเมื่อส่งชุดเดิมอีกครั้งหลัง timeout
    """

    def __init__(self, q, post, sleep=time.sleep):
        self.q = q
        self.post = post
        self.sleep = sleep
        self.pending = []
        self.single = False
        self.backoff = 2

    def fill(self, wait=1):
        if self.pending:
            return
        self.single = False
        try:
            self.pending.append(self.q.get(timeout=wait))
            while len(self.pending) < BATCH_MAX:
                self.pending.append(self.q.get_nowait())
        except queue.Empty:
            pass

    def _drop(self, i, code, detail):
        ev = self.pending.pop(i)
        log(f'gateway ไม่รับ event ({code}) — ทิ้ง {ev.get("type")} ของกล้อง {ev.get("cameraId")}: {detail}')

    def step(self, wait=1):
        self.fill(wait)
        if not self.pending:
            return
        n = 1 if self.single else len(self.pending)
        try:
            self.post(self.pending[:n])
            del self.pending[:n]
            self.backoff = 2
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors='replace')
            detail = body[:200]
            if e.code not in (400, 404):
                log(f'gateway ตอบ {e.code}: {detail} — ลองใหม่ใน {self.backoff} วิ')
                self._wait()
                return
            try:
                index = json.loads(body).get('index')
            except (ValueError, AttributeError):
                index = None
            if n == 1:
                self._drop(0, e.code, detail)
            elif isinstance(index, int) and 0 <= index < n:
                self._drop(index, e.code, detail)
            else:
                log(f'gateway ไม่รับชุด {n} event ({e.code}) — ส่งทีละตัวเพื่อหาตัวที่เสีย')
                self.single = True
        except Exception as e:  # noqa: BLE001 — gateway รีสตาร์ต / สายหลุด: รอแล้วส่งชุดเดิม
            log(f'ส่ง event ไม่ได้: {e} — ลองใหม่ใน {self.backoff} วิ')
            self._wait()

    def _wait(self):
        self.sleep(self.backoff)
        self.backoff = min(self.backoff * 2, 60)


def sender():
    s = Sender(events, lambda batch: api('POST', '/ai/events', {'events': batch}, timeout=30))
    while True:
        s.step()


def emit(ev):
    ev.setdefault('eventId', str(uuid.uuid4()))
    try:
        events.put_nowait(ev)
    except queue.Full:
        log('คิว event เต็ม (gateway ติดต่อไม่ได้นาน) — ทิ้ง event ใหม่')


def jpeg_b64(frame, box=None, label=None, rule=None):
    img = frame.copy()
    h, w = img.shape[:2]
    if rule is not None:
        pts = np.array([[int(x * w), int(y * h)] for x, y in rule['points']], np.int32)
        cv2.polylines(img, [pts], rule['type'] == 'zone', (0, 200, 255), 2)
    if box is not None:
        x1, y1, x2, y2 = (int(v) for v in box)
        cv2.rectangle(img, (x1, y1), (x2, y2), (0, 0, 255), 2)
        if label:
            cv2.putText(img, label, (x1, max(12, y1 - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1, cv2.LINE_AA)
    ok, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return b64encode(buf.tobytes()).decode() if ok else None


# ─────────────────────────────────────────────── อ่านภาพกล้อง (ffmpeg → BGR ที่ FPS กำหนด)
STALL_SEC = 30  # ffmpeg เปิดอยู่แต่ไม่มีเฟรมนานเกินนี้ = ค้าง — main() สั่งปิดแล้ว reader เปิดใหม่เอง
_rtsp_timeout = None


def rtsp_timeout_args():
    """ตัวเลือก timeout ของ socket RTSP (10 วิ) ตามรุ่น ffmpeg — ≥ 5.0 ใช้ -timeout, รุ่นเก่าใช้ -stimeout
    (ffmpeg 4.x ตีความ -timeout ของ RTSP เป็นโหมด listen — ใส่ผิดรุ่นแล้วเปิดกล้องไม่ได้เลย)"""
    global _rtsp_timeout
    if _rtsp_timeout is None:
        try:
            out = subprocess.run([FFMPEG, '-hide_banner', '-h', 'demuxer=rtsp'], capture_output=True, text=True,
                                 timeout=10, check=False, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout
        except (OSError, subprocess.SubprocessError):
            out = ''
        line = next((l for l in out.splitlines() if l.strip().startswith('-timeout ')), '')
        if 'socket' in line:
            _rtsp_timeout = ['-timeout', '10000000']
        elif '-stimeout ' in out:
            _rtsp_timeout = ['-stimeout', '10000000']
        else:
            _rtsp_timeout = []
            log('ffmpeg ไม่มีตัวเลือก timeout ของ RTSP — พึ่ง watchdog อย่างเดียว')
    return _rtsp_timeout


class CameraReader(threading.Thread):
    def __init__(self, cam):
        super().__init__(daemon=True, name=f'cam-{cam["id"]}')
        self.cam = cam
        self.stopped = False
        self.proc = None
        self.frame = None
        self.frame_ts = 0.0
        self.alive_ts = 0.0  # ตอนเปิด ffmpeg หรือได้เฟรมล่าสุด — watchdog ใช้ตัดสินว่าค้าง
        self.size = None
        self.lock = threading.Lock()

    def stop(self):
        self.stopped = True
        self.kick()

    def kick(self):
        """ปิด ffmpeg ตัวปัจจุบัน — ลูปใน run() เปิดใหม่เอง (ถ้ายังไม่ได้ stop)"""
        proc = self.proc
        if proc and proc.poll() is None:
            proc.kill()

    def stalled(self, now):
        proc = self.proc
        return proc is not None and proc.poll() is None and self.alive_ts and now - self.alive_ts > STALL_SEC

    def _url(self):
        s = api('GET', f'/cameras/{urllib.request.quote(self.cam["id"])}/streams')
        best = s.get('sub') or s.get('main') or {}
        urls = best.get('urls') or {}
        return urls.get('rtspRaw') or urls.get('rtsp')

    def _probe(self, url):
        out = subprocess.run([FFPROBE, '-v', 'error', '-rtsp_transport', 'tcp', *rtsp_timeout_args(), '-select_streams', 'v:0',
                              '-show_entries', 'stream=width,height', '-of', 'csv=p=0', url],
                             capture_output=True, text=True, timeout=20, check=False).stdout.strip().split(',')
        w, h = int(out[0]), int(out[1])
        return WIDTH, max(2, round(WIDTH * h / w / 2) * 2)

    def run(self):
        backoff = 2
        while not self.stopped:
            try:
                url = self._url()
                w, h = self._probe(url)
                # timeout ของ socket: กล้อง/go2rtc เงียบไปเฉย ๆ แล้ว ffmpeg จบเอง ไม่ค้างรอตลอดไป
                args = [FFMPEG, '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', *rtsp_timeout_args()]
                if HWDEC != 'none':
                    # ถอดภาพบนการ์ดเดียวกับที่รันโมเดล — เครื่องที่การ์ด 0 ต่อจอ ควรตั้ง aiGpu เป็นการ์ดอื่น
                    args += ['-hwaccel', HWDEC, '-hwaccel_device', os.environ.get('AI_GPU', '0')]
                args += ['-i', url, '-an', '-vf', f'fps={FPS},scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'bgr24', 'pipe:1']
                self.alive_ts = time.time()  # ตั้งก่อน self.proc — watchdog ไม่เห็น proc ใหม่คู่กับเวลาเก่า
                self.proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                self.size = (w, h)
                n = w * h * 3
                log(f'{self.cam["name"]}: เริ่มอ่านภาพ {w}x{h} @ {FPS} fps')
                while not self.stopped:
                    raw = self.proc.stdout.read(n)
                    if len(raw) < n:
                        break
                    with self.lock:
                        self.frame = np.frombuffer(raw, np.uint8).reshape(h, w, 3)
                        self.frame_ts = self.alive_ts = time.time()
                    backoff = 2
            except Exception as e:  # noqa: BLE001
                log(f'{self.cam["name"]}: อ่านภาพไม่ได้ — {e}')
            if self.proc and self.proc.poll() is None:
                self.proc.kill()
            if not self.stopped:
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)

    def take(self):
        with self.lock:
            f, ts = self.frame, self.frame_ts
            self.frame = None
        return f, ts


# ─────────────────────────────────────────────── วนหลัก
def main():
    det = Detector(os.environ.get('AI_MODEL', 'models/yolox_s.onnx'), gpu=os.environ.get('AI_GPU', '0'),
                   conf=float(os.environ.get('AI_CONF', '0.4')))
    log(f'โมเดลพร้อม ({det.provider}) · gateway {GATEWAY}')
    threading.Thread(target=sender, daemon=True, name='sender').start()

    readers, trackers, cams = {}, {}, {}
    next_config = 0
    next_watchdog = 0
    stats = {'frames': 0, 'since': time.time()}

    def finish(cam_id, tracks, cam=None):
        # cam: ค่าของกล้องตอนที่วัตถุถูกติดตาม — กล้องที่เพิ่งถูกเอาออกจาก config ไม่อยู่ใน cams แล้ว
        cam = cam or cams.get(cam_id)
        if not cam or not cam.get('objects'):
            return
        for t in tracks:
            if t.label not in OBJECT_CLASSES or t.last - t.first < OBJECT_MIN_SEC or t.best is None:
                continue
            _, frame, box = t.best
            emit({'cameraId': cam_id, 'type': 'object', 'label': t.label, 'trackId': str(t.id), 'ts': iso(t.first),
                  'attrs': {'firstSeen': iso(t.first), 'lastSeen': iso(t.last), 'durationSec': round(t.last - t.first, 1),
                            'maxScore': round(t.max_score, 2)},
                  'snapshot': jpeg_b64(frame, box, t.label)})

    while True:
        now = time.time()
        if now >= next_config:
            next_config = now + CONFIG_EVERY
            old_cams = cams
            try:
                cfg = api('GET', '/ai/config')
                cams = {c['id']: c for c in cfg.get('cameras', [])}
            except Exception as e:  # noqa: BLE001 — ใช้ค่าเดิมต่อไป
                log(f'อ่านค่าจาก gateway ไม่ได้: {e}')
            for cid in list(readers):
                if cid not in cams:
                    readers.pop(cid).stop()
                    # ปิดวัตถุที่ยังติดตามอยู่ด้วยค่าเดิมของกล้อง ก่อนทิ้ง tracker — ไม่งั้น event object หาย
                    finish(cid, trackers.pop(cid).end_all() if cid in trackers else [], old_cams.get(cid))
                    log(f'หยุดกล้อง {cid}')
            for cid, cam in cams.items():
                if cid not in readers:
                    readers[cid] = CameraReader(cam)
                    readers[cid].start()
                else:
                    readers[cid].cam = cam

        if now >= next_watchdog:
            next_watchdog = now + 5
            for cid, reader in readers.items():
                if reader.stalled(now):
                    log(f'{reader.cam["name"]}: ไม่มีภาพเกิน {STALL_SEC} วิ — ปิด ffmpeg แล้วเปิดใหม่')
                    reader.alive_ts = now  # กันสั่งปิดซ้ำก่อน reader เปิดตัวใหม่
                    reader.kick()

        busy = False
        for cid, reader in list(readers.items()):
            frame, ts = reader.take()
            if frame is None:
                continue
            busy = True
            cam = cams.get(cid, {})
            rules = cam.get('rules', [])
            wanted = OBJECT_CLASSES | {c for r in rules for c in r.get('classes', [])}
            dets = det.detect(frame, wanted)
            h, w = frame.shape[:2]
            tr = trackers.get(cid)
            if tr is None or (tr.w, tr.h) != (w, h):
                if tr is not None:
                    finish(cid, tr.end_all())  # ความละเอียดเปลี่ยน — ปิดวัตถุชุดเดิมก่อนเริ่ม tracker ใหม่
                tr = trackers[cid] = CameraTracker(w, h)
            updated, ended = tr.update(dets, ts, frame)
            for t in updated:
                for rule, kind, attrs in evaluate_rules(t, rules, ts):
                    emit({'cameraId': cid, 'type': kind, 'label': t.label, 'rule': rule['name'], 'trackId': str(t.id),
                          'ts': iso(ts), 'attrs': {**attrs, 'score': round(t.max_score, 2)},
                          'snapshot': jpeg_b64(frame, t.box, t.label, rule)})
            finish(cid, ended)
            stats['frames'] += 1
        if time.time() - stats['since'] >= 60:
            log(f'{len(readers)} กล้อง · {stats["frames"] / (time.time() - stats["since"]):.1f} เฟรม/วิ · คิว event {events.qsize()}')
            stats.update(frames=0, since=time.time())
        if not busy:
            time.sleep(0.01)


if __name__ == '__main__':
    main()
