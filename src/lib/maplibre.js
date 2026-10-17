import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// ให้ Vite bundle worker และ shared module พร้อม URL ที่ตรงกับไฟล์ release จริง
maplibregl.setWorkerUrl(workerUrl);

export * from 'maplibre-gl';