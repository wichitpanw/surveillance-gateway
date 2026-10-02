"""ตัวตรวจจับวัตถุ YOLOX (Apache-2.0) บน ONNX Runtime — docs/EDGE-PLAN.md เฟส 5 ข้อ D

ใช้โมเดลจาก release ทางการของ Megvii (yolox_s.onnx, อินพุต 1x3x640x640, เอาต์พุต 1x8400x85 แบบยังไม่ decode)
ไม่ใช้ Ultralytics เพราะเป็น AGPL — ระบบนี้แจกจ่ายให้หน่วยงานอื่น

preprocess ตาม YOLOX 0.1.1rc0: letterbox มุมซ้ายบน เติม 114, BGR 0–255 ไม่ normalize
"""
import numpy as np
import onnxruntime as ort

COCO = [
    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
    'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant',
    'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard',
    'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
    'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange', 'broccoli',
    'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet',
    'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
    'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
]


class Detector:
    def __init__(self, model_path, gpu=0, conf=0.35, nms=0.45):
        try:
            ort.preload_dlls()  # ไลบรารี CUDA/cuDNN จากแพ็กเกจ nvidia-* ใน venv
        except Exception:  # noqa: BLE001 — ort รุ่นเก่าไม่มีฟังก์ชันนี้
            pass
        providers = [('CUDAExecutionProvider', {'device_id': int(gpu)}), 'CPUExecutionProvider']
        self.session = ort.InferenceSession(model_path, providers=providers)
        self.provider = self.session.get_providers()[0]
        self.input_name = self.session.get_inputs()[0].name
        shape = self.session.get_inputs()[0].shape
        self.size = (int(shape[2]), int(shape[3]))
        self.conf = conf
        self.nms = nms
        self._grids, self._strides = self._make_grids()

    def _make_grids(self):
        grids, strides = [], []
        for stride in (8, 16, 32):
            h, w = self.size[0] // stride, self.size[1] // stride
            xv, yv = np.meshgrid(np.arange(w), np.arange(h))
            grids.append(np.stack((xv, yv), 2).reshape(1, -1, 2))
            strides.append(np.full((1, h * w, 1), stride))
        return np.concatenate(grids, 1).astype(np.float32), np.concatenate(strides, 1).astype(np.float32)

    def _preprocess(self, img):
        h, w = img.shape[:2]
        r = min(self.size[0] / h, self.size[1] / w)
        nh, nw = int(h * r), int(w * r)
        padded = np.full((self.size[0], self.size[1], 3), 114, dtype=np.uint8)
        import cv2  # noqa: PLC0415 — โหลดเมื่อใช้ ให้ทดสอบส่วนอื่นได้โดยไม่มี cv2
        padded[:nh, :nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
        return np.ascontiguousarray(padded.transpose(2, 0, 1)[None], dtype=np.float32), r

    def detect(self, img, classes=None):
        """คืน [(x1, y1, x2, y2, score, class_name)] เป็นพิกัดของภาพที่ส่งเข้ามา"""
        blob, ratio = self._preprocess(img)
        out = self.session.run(None, {self.input_name: blob})[0][0]
        # ตัดแถวที่ objectness ต่ำทิ้งก่อน — แถวส่วนใหญ่จาก 8400 เป็นพื้นหลัง คูณคลาสทั้งหมดเปลือง CPU
        pre = out[:, 4] >= self.conf * 0.5
        if not pre.any():
            return []
        out, grids, strides = out[pre], self._grids[0][pre], self._strides[0][pre]
        out[:, :2] = (out[:, :2] + grids) * strides
        out[:, 2:4] = np.exp(out[:, 2:4]) * strides
        scores_all = out[:, 4:5] * out[:, 5:]
        cls = scores_all.argmax(1)
        score = scores_all[np.arange(len(cls)), cls]
        keep = score >= self.conf
        if classes is not None:
            wanted = np.array([COCO[c] in classes for c in range(len(COCO))])
            keep &= wanted[cls]
        if not keep.any():
            return []
        boxes = out[keep, :4]
        cls, score = cls[keep], score[keep]
        xyxy = np.empty_like(boxes)
        xyxy[:, 0] = (boxes[:, 0] - boxes[:, 2] / 2) / ratio
        xyxy[:, 1] = (boxes[:, 1] - boxes[:, 3] / 2) / ratio
        xyxy[:, 2] = (boxes[:, 0] + boxes[:, 2] / 2) / ratio
        xyxy[:, 3] = (boxes[:, 1] + boxes[:, 3] / 2) / ratio
        # NMS แยกคลาส: เลื่อนกล่องของแต่ละคลาสออกจากกันแล้วทำครั้งเดียว
        offset = cls[:, None].astype(np.float32) * 4096
        idx = _nms(xyxy + offset, score, self.nms)
        h, w = img.shape[:2]
        res = []
        for i in idx:
            x1, y1, x2, y2 = xyxy[i]
            res.append((max(0.0, x1), max(0.0, y1), min(w - 1.0, x2), min(h - 1.0, y2), float(score[i]), COCO[int(cls[i])]))
        return res


def _nms(boxes, scores, thr):
    x1, y1, x2, y2 = boxes.T
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        order = order[1:][iou <= thr]
    return keep
