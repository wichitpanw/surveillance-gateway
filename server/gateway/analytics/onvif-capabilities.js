/**
 * ถามกล้องตรง ๆ ว่า "เปิด AI อะไรไว้บ้าง" ผ่าน ONVIF
 *
 * ### ทำไมต้องถาม config ไม่ใช่รอฟัง event
 *
 * วิธีที่ดูตรงไปตรงมาที่สุดคือเปิด metadata track แล้วดูว่ามีอะไรวิ่งมา — แต่ใช้เป็นวิธี
 * "ค้นหา" ไม่ได้ กล้อง Cross Line ที่จับรถยนต์จะเงียบสนิทจนกว่าจะมีรถวิ่งผ่านเส้นจริง ๆ
 * ถ้าเอา "ฟังแล้วไม่เจออะไร" มาเป็นข้อสรุป กล้องที่ตั้งค่าถูกทุกอย่างแต่บังเอิญถนนว่าง
 * จะถูกบันทึกว่าไม่มี AI แล้วไม่มีใครรู้ว่ามันผิด
 *
 * การถาม config ตอบได้ทันทีและไม่ขึ้นกับว่ามีเหตุการณ์เกิดหรือไม่ ส่วน metadata track
 * มีไว้ "เก็บข้อมูล" ตอนใช้งานจริง ซึ่งเป็นคนละหน้าที่กัน
 *
 * ### แยก "ทำได้" ออกจาก "เปิดอยู่"
 *
 * GetSupportedRules บอกว่ากล้องรุ่นนี้ทำอะไรเป็น GetRules บอกว่าตอนนี้เปิดอะไรไว้จริง
 * สองอย่างนี้ตอบคนละคำถามและหน้าจอต้องบอกต่างกัน — กล้องที่ "นับคนเป็นแต่ยังไม่ได้เปิด"
 * ไม่ใช่กล้องที่ใช้ไม่ได้ แต่ก็ยังไม่มีข้อมูลให้ลูกค้า
 *
 * ### ไม่เพิ่ม dependency
 *
 * node-onvif 0.1.7 ไม่มีโมดูล Analytics เลย แต่ soap.js ของมันสร้าง WS-UsernameToken ได้ครบ
 * และ `_request` ถูก onvif_patch.js แพตช์ให้เลือก http/https ตาม xaddr แล้ว จึงยิง operation
 * ที่ไลบรารีไม่มีเมธอดให้ได้โดยไม่ต้องลากไลบรารีตัวใหม่เข้ามา
 *
 * ใช้ `_request` ตรง ๆ ไม่ผ่าน requestCommand เพราะตัวนั้นบังคับว่าต้องมี `<X>Response` ใน
 * body ไม่งั้นโยนทิ้ง — ซึ่งทำให้เราไม่เห็น SOAP Fault ที่กล้องส่งมาอธิบายว่าทำไมไม่รองรับ
 */
const mUrl = require('node:url');
const soap = require('node-onvif/lib/modules/soap.js');

const NS = {
  tds: 'xmlns:tds="http://www.onvif.org/ver10/device/wsdl"',
  trt: 'xmlns:trt="http://www.onvif.org/ver10/media/wsdl"',
  tan: 'xmlns:tan="http://www.onvif.org/ver20/analytics/wsdl"',
  tev: 'xmlns:tev="http://www.onvif.org/ver10/events/wsdl"',
  tt: 'xmlns:tt="http://www.onvif.org/ver10/schema"',
};

/** อ่าน attribute ตัวหนึ่ง รับทั้ง `x="1"` และ `x='1'` ตามที่ XML อนุญาต */
function attrOf(source, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(String(source || ''));
  if (!m) return undefined;
  return m[1] !== undefined ? m[1] : m[2];
}

/** เนื้อในของแท็กชื่อหนึ่ง โดยไม่สนใจ prefix ของ namespace */
function textOf(xml, tag) {
  const m = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(String(xml || ''));
  return m ? m[1].trim() : null;
}

/**
 * ทุกก้อนของแท็กชื่อหนึ่ง (รวมแบบปิดในตัว `<X/>`) พร้อม attribute ดิบและเนื้อใน
 *
 * หาแท็กปิดที่คู่กันด้วยการนับความลึก ไม่ใช่จับด้วย regex ก้อนเดียว เพราะรูปแบบที่ให้เนื้อใน
 * เป็น optional จะถูก lazy match จับเป็นค่าว่างทันทีเสมอ — ก้อนที่มีลูกอยู่ข้างในจึงกลายเป็น
 * ว่างเปล่าโดยไม่มี error และพารามิเตอร์ของกฎทั้งหมดหายไปเงียบ ๆ
 */
function blocksOf(xml, tag) {
  const text = String(xml || '');
  const out = [];
  const open = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*?)(/?)>`, 'g');
  const boundary = new RegExp(`<(/?)(?:\\w+:)?${tag}\\b([^>]*?)(/?)>`, 'g');

  let m;
  while ((m = open.exec(text)) !== null) {
    if (m[2] === '/') {
      out.push({ attrs: m[1] || '', body: '' });
      continue;
    }
    const bodyStart = m.index + m[0].length;
    boundary.lastIndex = bodyStart;
    let depth = 1;
    let b;
    let bodyEnd = -1;
    while ((b = boundary.exec(text)) !== null) {
      if (b[3] === '/') continue;      // แท็กปิดในตัวชื่อเดียวกัน ไม่นับความลึก
      depth += b[1] === '/' ? -1 : 1;
      if (depth === 0) { bodyEnd = b.index; break; }
    }
    if (bodyEnd === -1) bodyEnd = text.length;
    out.push({ attrs: m[1] || '', body: text.slice(bodyStart, bodyEnd) });
    open.lastIndex = bodyEnd;
  }
  return out;
}

/**
 * ดึงหัวข้อทั้งหมดออกจาก TopicSet ของ GetEventProperties
 *
 * TopicSet เป็นต้นไม้ XML ที่ "ชื่อ path" คือชื่อแท็กที่ซ้อนกันลงไป ไม่ใช่ค่าใน attribute
 * เช่น RuleEngine > CountAggregation > Counter หมายถึง `tns1:RuleEngine/CountAggregation/Counter`
 * จึงต้องเดินต้นไม้เก็บ path ไม่ใช่จับด้วยรูปแบบตายตัว — และเก็บเฉพาะโหนดที่ประกาศ
 * `wstop:topic="true"` ซึ่งเป็นตัวบอกว่าโหนดนี้เป็นหัวข้อจริง ไม่ใช่แค่ชั้นจัดกลุ่ม
 */
function parseTopicSet(xml) {
  const set = textOf(xml, 'TopicSet');
  if (!set) return [];
  const topics = [];
  const stack = [];
  const re = /<(\/?)([\w.-]+:)?([\w.-]+)([^>]*?)(\/?)>/g;
  for (const m of set.matchAll(re)) {
    const [, closing, , name, attrs, selfClosing] = m;
    if (closing) {
      if (stack.length) stack.pop();
      continue;
    }
    stack.push(name);
    if (/\btopic\s*=\s*["']true["']/i.test(attrs)) topics.push(`tns1:${stack.join('/')}`);
    if (selfClosing) stack.pop();
  }
  return [...new Set(topics)];
}

/** ยิง SOAP หนึ่งครั้ง คืน XML ดิบ — ผู้เรียกจัดการ error เอง */
async function call(oxaddr, { body, xmlns, user, pass, diff = 0 }) {
  const envelope = soap.createRequestSoap({ body, xmlns, diff, user, pass });
  return soap._request(oxaddr, envelope);
}

/** ห่อการเรียกให้ล้มแยกกันได้ — กล้องที่ไม่รองรับเส้นหนึ่งต้องไม่ทำให้ทั้งการตรวจล้ม */
async function attempt(errors, key, fn) {
  try {
    return await fn();
  } catch (err) {
    errors[key] = String(err?.message || err);
    return null;
  }
}

/**
 * ตรวจความสามารถของกล้องหนึ่งตัว
 *
 * @param {{ip:string, port?:number, user?:string, pass?:string, scheme?:string}} cam
 * @returns ผลที่มีรูปร่างเดียวกันเสมอ ไม่ว่ากล้องจะยี่ห้อไหนหรือรองรับแค่ไหน
 */
async function probeCapabilities(cam) {
  const port = Number(cam.port) || 80;
  const user = cam.user || '';
  const pass = cam.pass || '';
  const errors = {};

  const auth = { user, pass };

  /*
    ลอง http ก่อนแล้วถอยไป https — แบบเดียวกับ initOnvifDeviceWithFallback ใน server.js

    กล้องบางรุ่นเสิร์ฟ ONVIF ผ่าน https เท่านั้น (มี onvif_patch.js รองรับใบรับรองที่เซ็นเอง
    ไว้แล้ว) ถ้าลองแค่ http กล้องกลุ่มนั้นจะถูกสรุปว่า "ถามไม่ได้" ทั้งที่ส่วนอื่นของระบบ
    คุยกับมันได้ตามปกติ — ความไม่ตรงกันแบบนี้ทำให้คนไปไล่แก้ผิดจุด
  */
  let oxaddr = null;
  for (const scheme of cam.scheme ? [cam.scheme] : ['http', 'https']) {
    const candidate = mUrl.parse(`${scheme}://${cam.ip}:${port}/onvif/device_service`);
    try {
      await call(candidate, { body: '<tds:GetSystemDateAndTime/>', xmlns: [NS.tds] });
      oxaddr = candidate;
      break;
    } catch (err) {
      errors[`probe:${scheme}`] = String(err?.message || err);
    }
  }
  if (!oxaddr) {
    // ต่อไม่ถึงทั้งสองทาง — คืนผลที่บอกว่า "ถามไม่ได้" ไม่ใช่ "ไม่มี AI"
    return {
      ok: false, probedAt: new Date().toISOString(), device: null,
      services: { analytics: null, events: null, media2: null },
      analyticsConfigs: [], supportedRules: [], activeRules: [], eventTopics: [], errors,
    };
  }
  // ต่อได้แล้ว ลบร่องรอยการลองที่ล้มเหลวทิ้ง ไม่ให้ปนกับ error จริงของ operation อื่น
  delete errors['probe:http'];
  delete errors['probe:https'];

  const result = {
    ok: false,
    probedAt: new Date().toISOString(),
    device: null,
    services: { analytics: null, events: null, media2: null },
    analyticsConfigs: [],
    supportedRules: [],
    activeRules: [],
    eventTopics: [],
    errors,
  };

  // 1. ตัวตนของกล้อง — ใช้ตรวจด้วยว่ายี่ห้อที่คนเลือกใน dropdown ตรงกับของจริงไหม
  const infoXml = await attempt(errors, 'GetDeviceInformation', () =>
    call(oxaddr, { body: '<tds:GetDeviceInformation/>', xmlns: [NS.tds], ...auth }));
  if (infoXml) {
    result.ok = true;
    result.device = {
      manufacturer: textOf(infoXml, 'Manufacturer'),
      model: textOf(infoXml, 'Model'),
      firmware: textOf(infoXml, 'FirmwareVersion'),
      serial: textOf(infoXml, 'SerialNumber'),
    };
  }

  // 2. บริการที่กล้องมี — เส้นที่ระบบนี้ไม่เคยเรียกเลยตลอดมา
  const servicesXml = await attempt(errors, 'GetServices', () =>
    call(oxaddr, {
      body: '<tds:GetServices><tds:IncludeCapability>true</tds:IncludeCapability></tds:GetServices>',
      xmlns: [NS.tds], ...auth,
    }));
  if (servicesXml) {
    result.ok = true;
    for (const svc of blocksOf(servicesXml, 'Service')) {
      const ns = textOf(svc.body, 'Namespace') || '';
      const xaddr = textOf(svc.body, 'XAddr');
      if (!xaddr) continue;
      if (/analytics/i.test(ns)) result.services.analytics = xaddr;
      else if (/events/i.test(ns)) result.services.events = xaddr;
      else if (/media\/wsdl|media2/i.test(ns) && /ver20/.test(ns)) result.services.media2 = xaddr;
    }
  }

  // 3. token ของ AnalyticsConfiguration — ข้อมูลที่ onvif_patch.js ทิ้งไปตอนแอดกล้อง
  //    จึงต้องอ่านจาก XML ดิบ ไม่ผ่าน parser ที่ถูกเขียนทับ
  const profilesXml = await attempt(errors, 'GetProfiles', () =>
    call(oxaddr, { body: '<trt:GetProfiles/>', xmlns: [NS.trt, NS.tt], ...auth }));
  if (profilesXml) {
    for (const cfg of blocksOf(profilesXml, 'AnalyticsConfiguration')) {
      const token = attrOf(cfg.attrs, 'token');
      if (token && !result.analyticsConfigs.includes(token)) result.analyticsConfigs.push(token);
    }
  }

  /*
    ถ้า GetProfiles ไม่ให้ token มา ลองถามรายการ analytics configuration ตรง ๆ

    กล้อง Uniview ที่ทดสอบ (MODEL-B) ตอบ GetProfiles สำเร็จแต่ไม่มี
    AnalyticsConfiguration ติดมาในนั้นเลย ทั้งที่มี /onvif/analytics service อยู่จริง —
    ถ้าหยุดแค่ GetProfiles จะสรุปผิดว่ากล้องไม่มี analytics ทั้งที่มันมี
  */
  if (result.analyticsConfigs.length === 0) {
    const cfgXml = await attempt(errors, 'GetVideoAnalyticsConfigurations', () =>
      call(oxaddr, { body: '<trt:GetVideoAnalyticsConfigurations/>', xmlns: [NS.trt, NS.tt], ...auth }));
    if (cfgXml) {
      for (const cfg of blocksOf(cfgXml, 'Configurations')) {
        const token = attrOf(cfg.attrs, 'token');
        if (token && !result.analyticsConfigs.includes(token)) result.analyticsConfigs.push(token);
      }
    }
  }

  // 4. กฎ — ถามที่ Analytics service ถ้ามี ไม่งั้นลองที่ device service เผื่อกล้องรวมไว้ที่เดียว
  const analyticsAddr = result.services.analytics ? mUrl.parse(result.services.analytics) : oxaddr;
  for (const token of result.analyticsConfigs) {
    const supXml = await attempt(errors, `GetSupportedRules:${token}`, () =>
      call(analyticsAddr, {
        body: `<tan:GetSupportedRules><tan:ConfigurationToken>${token}</tan:ConfigurationToken></tan:GetSupportedRules>`,
        xmlns: [NS.tan, NS.tt], ...auth,
      }));
    if (supXml) {
      for (const d of blocksOf(supXml, 'RuleDescription')) {
        const name = attrOf(d.attrs, 'Name');
        if (name) result.supportedRules.push({ token, type: name });
      }
    }

    const rulesXml = await attempt(errors, `GetRules:${token}`, () =>
      call(analyticsAddr, {
        body: `<tan:GetRules><tan:ConfigurationToken>${token}</tan:ConfigurationToken></tan:GetRules>`,
        xmlns: [NS.tan, NS.tt], ...auth,
      }));
    if (rulesXml) {
      result.ok = true;
      for (const r of blocksOf(rulesXml, 'Rule')) {
        const name = attrOf(r.attrs, 'Name');
        const type = attrOf(r.attrs, 'Type');
        if (!name && !type) continue;
        const params = {};
        for (const item of blocksOf(r.body, 'SimpleItem')) {
          const n = attrOf(item.attrs, 'Name');
          if (n) params[n] = attrOf(item.attrs, 'Value');
        }
        result.activeRules.push({ token, name: name || '', type: type || '', params });
      }
    }
  }

  // 5. หัวข้อที่กล้องประกาศว่าส่งได้ — ใช้ได้แม้กล้องไม่มี Analytics service
  const eventsAddr = result.services.events ? mUrl.parse(result.services.events) : oxaddr;
  const eventsXml = await attempt(errors, 'GetEventProperties', () =>
    call(eventsAddr, { body: '<tev:GetEventProperties/>', xmlns: [NS.tev, NS.tt], ...auth }));
  if (eventsXml) {
    result.ok = true;
    result.eventTopics = parseTopicSet(eventsXml);
  }

  return result;
}

module.exports = { probeCapabilities, parseTopicSet, blocksOf, textOf, attrOf };
