/**
 * สไตล์แผนที่ของ client — เขียนไว้ที่นี่ ไม่ได้ขอจาก /api/map-style.json
 *
 * สไตล์ฝั่งเซิร์ฟเวอร์ตอบตามค่า MAP_TYPE ที่ผู้ดูแลเลือก ซึ่งตอนนี้เป็นภาพ raster และถูกใช้โดย
 * ตัวเลือกพิกัดในหน้า Cameras ด้วย หน้านี้ต้องการคนละอย่าง: ไทล์ vector ที่มีเลเยอร์ building
 * ให้ยกเป็นสามมิติได้ การไปแก้สไตล์กลางให้ตอบ vector จะเปลี่ยนพื้นหลังของตัวเลือกพิกัดไปด้วย
 * ทั้งที่นั่นไม่ได้ขออะไร และแผนที่เอียงทำให้ปักหมุดยากขึ้น ไม่ใช่ง่ายขึ้น
 *
 * ไทล์มาจาก /api/vector-tiles ซึ่งตรึงไว้ที่ไฟล์ OpenMapTiles v3.11 เสมอ ส่วน glyph มาจาก
 * /fonts ที่เซิร์ฟเวอร์เสิร์ฟอยู่แล้ว ทั้งสองเส้นไม่ต้องยืนยันตัวตน หน้านี้จึงไม่ต้องถือคีย์
 */

/** ฟอนต์เดียวสำหรับทุกป้าย — โฟลเดอร์ glyph มีชุดละฟอนต์ ไม่มีชุดผสม และชุดนี้ครอบคลุมทั้งไทยและละติน */
const FONT = ['Noto Sans Thai Regular'];

export function buildStyle({ origin, light }) {
  const c = light
    ? {
        bg: '#f2f1ec',
        water: '#c9d9ef',
        green: '#dfe7d3',
        land: '#e9e7e0',
        roadCasing: '#d8d4cb',
        road: '#ffffff',
        building: '#d6d1c2',
        buildingTop: '#e6e2d6',
        text: '#3f4149',
        textMuted: '#6b6d75',
        halo: '#ffffff',
      }
    : {
        bg: '#0e0f12',
        water: '#131f33',
        green: '#131a14',
        land: '#15161a',
        roadCasing: '#202127',
        road: '#33353d',
        building: '#26272e',
        buildingTop: '#3a3c46',
        text: '#c9ccd4',
        textMuted: '#8b8f99',
        halo: '#0e0f12',
      };

  return {
    version: 8,
    glyphs: `${origin}/fonts/{fontstack}/{range}.pbf`,
    sources: {
      openmaptiles: {
        type: 'vector',
        tiles: [`${origin}/api/vector-tiles/{z}/{x}/{y}.pbf`],
        minzoom: 0,
        // ไฟล์จบที่ z14 การประกาศเกินจริงทำให้ MapLibre ไล่ขอไทล์ที่ไม่มีแทนที่จะขยายของ z14
        // ขึ้นมาใช้ต่อ ผลคือแผนที่ว่างเปล่าตอนซูมลึก
        maxzoom: 14,
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': c.bg } },
      {
        id: 'landcover',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landcover',
        paint: { 'fill-color': c.green, 'fill-opacity': 0.6 },
      },
      {
        id: 'landuse',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landuse',
        paint: { 'fill-color': c.land },
      },
      {
        id: 'park',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'park',
        paint: { 'fill-color': c.green, 'fill-opacity': 0.8 },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'water',
        paint: { 'fill-color': c.water },
      },
      {
        id: 'waterway',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'waterway',
        paint: { 'line-color': c.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 16, 3] },
      },
      {
        id: 'roads-casing',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 10,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': c.roadCasing,
          'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 10, 1.2, 14, 5, 18, 22],
        },
      },
      {
        id: 'roads',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 10,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': c.road,
          'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 10, 0.5, 14, 3, 18, 16],
        },
      },
      /*
        อาคารสามมิติ

        `render_height` ของ OpenMapTiles มีค่าจริงเฉพาะอาคารที่ OSM บันทึกความสูงหรือจำนวนชั้น
        ไว้ ในกรุงเทพฯ ส่วนใหญ่ไม่มี จึงต้องมีค่าสำรอง ไม่งั้นตึกที่ไม่มีข้อมูลจะสูงศูนย์แล้วหายไป
        ทั้งเมือง เหลือแต่ตึกไม่กี่หลังลอยอยู่ ซึ่งอ่านผิดยิ่งกว่าการที่ทุกตึกสูงเท่ากัน

        ไทล์ตัดที่ z14 อาคารจึงมีตั้งแต่ z14 ขึ้นไปเท่านั้น ต่ำกว่านั้นไม่มีรูปทรงให้ยกอยู่แล้ว
      */
      {
        id: 'buildings-3d',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 14,
        paint: {
          'fill-extrusion-color': [
            'interpolate',
            ['linear'],
            ['coalesce', ['get', 'render_height'], 8],
            0, c.building,
            60, c.buildingTop,
          ],
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          // โปร่งเล็กน้อยเพื่อให้ยังเห็นถนนและหมุดหลังตึกได้ ไม่ใช่เมืองทึบตัน
          'fill-extrusion-opacity': 0.9,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      {
        id: 'road-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'transportation_name',
        minzoom: 13,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': FONT,
          'text-size': 11,
          'symbol-placement': 'line',
          'text-max-angle': 30,
        },
        paint: { 'text-color': c.textMuted, 'text-halo-color': c.halo, 'text-halo-width': 1.2 },
      },
      {
        id: 'poi-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'poi',
        minzoom: 15,
        // rank ของ OpenMapTiles คือลำดับความเด่น การเอาทุกจุดขึ้นทำให้ป้ายทับกันจนอ่านไม่ออก
        filter: ['<=', ['get', 'rank'], 12],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': FONT,
          'text-size': 10,
          'text-offset': [0, 0.8],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: { 'text-color': c.textMuted, 'text-halo-color': c.halo, 'text-halo-width': 1 },
      },
      {
        id: 'place-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 15],
          'text-max-width': 8,
        },
        paint: { 'text-color': c.text, 'text-halo-color': c.halo, 'text-halo-width': 1.4 },
      },
    ],
  };
}
