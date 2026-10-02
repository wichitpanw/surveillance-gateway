"""ตัวติดตามวัตถุแบบ IoU + กฎเส้น/โซน ของกล้องหนึ่งตัว

tracker: จับคู่กล่องกับ track เดิมแบบ greedy ตาม IoU (คลาสเดียวกัน) — พอสำหรับ 5 fps ที่วัตถุขยับไม่มากต่อเฟรม
ไม่ต้องพึ่งไลบรารีเพิ่ม · track ที่ไม่เห็นเกิน LOST_SEC ถือว่าจบ

กฎใช้ "จุดล่างกลางกรอบ" (ตำแหน่งเท้า/ล้อ) ในพิกัดสัดส่วน 0–1 ของภาพ ตรงกับที่หน้า AI Rules วาด
  line  ข้ามเส้น = ส่วนของเส้นทางระหว่างเฟรมตัดกับเส้น · ab = จากซ้ายไปขวาเมื่อมองจาก A ไป B
  zone  intrusion ครั้งแรกที่เข้าโซน · loitering เมื่ออยู่ในโซนต่อเนื่องเกิน dwellSec (ครั้งเดียวต่อ track ต่อโซน)
"""
import itertools

LOST_SEC = 2.0
IOU_MATCH = 0.3
# กฎทำงานเมื่อ track ถูกเห็นแล้วอย่างน้อยเท่านี้เฟรม — วัตถุที่คะแนนก้ำกึ่งเกณฑ์ (เจอ/ไม่เจอสลับกัน)
# เกิดเป็น track ใหม่ซ้ำ ๆ แล้วยิง intrusion ซ้ำ (เห็นจริงกับเก้าอี้ในห้องมืด 2026-09-28)
MIN_HITS = 3
# track ที่หายไปไม่เกินนี้ แล้วมีวัตถุคลาสเดียวกันโผล่ที่ตำแหน่งเดิม (IoU ≥ REVIVE_IOU) = ตัวเดิมกลับมา
# ใช้ track เดิมต่อ (กฎที่ยิงแล้วไม่ยิงซ้ำ) — ของนิ่งในที่แสงน้อยตรวจเจอ/ไม่เจอสลับกันเป็นช่วง ๆ
REVIVE_SEC = 30.0
REVIVE_IOU = 0.5
_ids = itertools.count(1)


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _cross(o, a, p):
    return (a[0] - o[0]) * (p[1] - o[1]) - (a[1] - o[1]) * (p[0] - o[0])


def segments_intersect(p1, p2, a, b):
    d1, d2 = _cross(a, b, p1), _cross(a, b, p2)
    d3, d4 = _cross(p1, p2, a), _cross(p1, p2, b)
    return (d1 > 0) != (d2 > 0) and (d3 > 0) != (d4 > 0)


def point_in_polygon(p, poly):
    x, y = p
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def _center_dist(a, b):
    return (((a[0] + a[2]) - (b[0] + b[2])) ** 2 + ((a[1] + a[3]) - (b[1] + b[3])) ** 2) ** 0.5 / 2


def _diag(a):
    return ((a[2] - a[0]) ** 2 + (a[3] - a[1]) ** 2) ** 0.5


class Track:
    def __init__(self, box, score, label, ts):
        self.id = next(_ids)
        self.box = box
        self.label = label
        self.first = ts
        self.last = ts
        self.max_score = score
        self.best = None  # (คะแนน, เฟรม, กรอบ) ภาพที่ดีที่สุดไว้ทำภาพประกอบ
        self.hits = 0
        self.anchor = None
        self.prev_anchor = None
        self.zone_since = {}  # rule id → เวลาที่เข้าโซน (ยังอยู่ในโซน)
        self.fired = set()  # (rule id, ชนิด[, ทิศ]) ที่ส่ง event แล้ว


class CameraTracker:
    def __init__(self, width, height):
        self.w = width
        self.h = height
        self.tracks = []
        self.lost = []  # track ที่หายไป รอ REVIVE_SEC ก่อนถือว่าจบจริง

    def _anchor(self, box):
        return ((box[0] + box[2]) / 2 / self.w, box[3] / self.h)

    def update(self, dets, ts, frame=None):
        """dets = [(x1,y1,x2,y2,score,label)] · คืน (track ที่อัปเดตรอบนี้, track ที่จบแล้ว)"""
        # รอบแรกจับคู่ด้วย IoU · รอบสองจับคู่ที่เหลือด้วยระยะจุดกลาง (ไม่เกินเส้นทแยงกรอบ) — ที่ 5 fps
        # วัตถุเร็ว (รถ) ขยับเกินกรอบเดิมจน IoU เป็นศูนย์ ถ้าไม่มีรอบสอง track แตกเป็นตัวใหม่ทุกเฟรม: event ซ้ำ และข้ามเส้นไม่ติด
        used_t, used_d, updated = set(), set(), []
        same = [(ti, di) for ti, t in enumerate(self.tracks) for di in range(len(dets)) if t.label == dets[di][5]]
        by_iou = sorted(((iou(self.tracks[ti].box, dets[di][:4]), ti, di) for ti, di in same), reverse=True)
        by_dist = sorted((_center_dist(self.tracks[ti].box, dets[di][:4]), ti, di) for ti, di in same)
        candidates = [(ti, di) for s, ti, di in by_iou if s >= IOU_MATCH] +                      [(ti, di) for d, ti, di in by_dist if d <= _diag(self.tracks[ti].box)]
        for ti, di in candidates:
            if ti in used_t or di in used_d:
                continue
            used_t.add(ti)
            used_d.add(di)
            t = self.tracks[ti]
            self._apply(t, dets[di], ts, frame)
            updated.append(t)
        for di in range(len(dets)):
            if di in used_d:
                continue
            x1, y1, x2, y2, s, label = dets[di]
            box = (x1, y1, x2, y2)
            revived = max((t for t in self.lost if t.label == label and iou(t.box, box) >= REVIVE_IOU),
                          key=lambda t: iou(t.box, box), default=None)
            if revived is not None:
                self.lost.remove(revived)
                t = revived
                t.prev_anchor = None  # ช่วงที่หายไปไม่นับเป็นการเคลื่อนที่ข้ามเส้น
                t.anchor = None
            else:
                t = Track(box, s, label, ts)
            self._apply(t, dets[di], ts, frame)
            self.tracks.append(t)
            updated.append(t)
        self.lost += [t for t in self.tracks if ts - t.last > LOST_SEC]
        self.tracks = [t for t in self.tracks if ts - t.last <= LOST_SEC]
        ended = [t for t in self.lost if ts - t.last > REVIVE_SEC]
        self.lost = [t for t in self.lost if ts - t.last <= REVIVE_SEC]
        return updated, ended

    def _apply(self, t, det, ts, frame):
        x1, y1, x2, y2, s, _ = det
        t.box = (x1, y1, x2, y2)
        t.last = ts
        t.hits += 1
        t.max_score = max(t.max_score, s)
        t.prev_anchor = t.anchor
        t.anchor = self._anchor(t.box)
        quality = s * (x2 - x1) * (y2 - y1)
        if frame is not None and (t.best is None or quality > t.best[0]):
            t.best = (quality, frame, t.box)

    def end_all(self):
        ended, self.tracks, self.lost = self.tracks + self.lost, [], []
        return ended


def evaluate_rules(track, rules, ts):
    """กฎที่ track นี้ทำให้เกิดในเฟรมนี้ — คืน [(rule, type, attrs)]"""
    hits = []
    if track.hits < MIN_HITS:
        return hits
    for rule in rules:
        if track.label not in rule['classes'] or track.anchor is None:
            continue
        pts = rule['points']
        if rule['type'] == 'line':
            if track.prev_anchor is None:
                continue
            a, b = pts
            if not segments_intersect(track.prev_anchor, track.anchor, a, b):
                continue
            # พิกัดภาพแกน y ชี้ลง: cross < 0 = อยู่ซ้ายเมื่อมองจาก A ไป B · ออกจากซ้ายไปขวา = ab
            direction = 'ab' if _cross(a, b, track.prev_anchor) < 0 else 'ba'
            if rule.get('direction', 'any') not in ('any', direction):
                continue
            key = (rule['id'], 'line', direction)
            if key in track.fired:
                continue
            track.fired.add(key)
            hits.append((rule, 'line_cross', {'direction': direction}))
        else:
            inside = point_in_polygon(track.anchor, pts)
            if not inside:
                track.zone_since.pop(rule['id'], None)
                continue
            since = track.zone_since.setdefault(rule['id'], ts)
            if (rule['id'], 'intrusion') not in track.fired:
                track.fired.add((rule['id'], 'intrusion'))
                hits.append((rule, 'intrusion', {}))
            dwell = rule.get('dwellSec') or 0
            if dwell and ts - since >= dwell and (rule['id'], 'loitering') not in track.fired:
                track.fired.add((rule['id'], 'loitering'))
                hits.append((rule, 'loitering', {'dwellSec': round(ts - since, 1)}))
    return hits
