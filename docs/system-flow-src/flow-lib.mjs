// ตัวช่วยวาด SVG ตามกฎ diagram-design: กริด 4px, ตัวเชื่อมมุมฉากโค้ง r=8, label มี mask + ช่องว่าง 6px
export const C = {
  paper: '#f5f5f5', ink: '#2d3142', muted: '#4f5d75', soft: '#7a8399',
  accent: '#eb6c36', link: '#2e5aa8',
  accentTint: 'rgba(235,108,54,0.08)',
};
export const SANS = "'Geist','Noto Sans Thai',sans-serif";
export const MONO = "'Geist Mono','Noto Sans Thai',monospace";
export const SERIF = "'Instrument Serif','Noto Serif Thai',serif";

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const g4 = (n, what) => { if (n % 4 !== 0) throw new Error(`นอกกริด 4px: ${what}=${n}`); return n; };

const isMark = (c) => /[ัิ-ฺ็-๎]/.test(c);
export function tw(s, size = 12, mono = false, bold = false) {
  let w = 0;
  for (const ch of String(s)) {
    if (isMark(ch)) continue;
    if (/[฀-๿]/.test(ch)) w += 0.56 * size;
    else if (mono) w += 0.6 * size;
    else if (/[ilj.,:;|!'() ]/.test(ch)) w += 0.34 * size;
    else if (/[A-Z0-9mwMW]/.test(ch)) w += 0.66 * size;
    else w += 0.56 * size;
  }
  return w * (bold ? 1.06 : 1) * 1.04;
}
// segs: สตริง หรือ [สตริง,'m'] (m = mono)
export const segW = (segs, size = 12) => (Array.isArray(segs) ? segs : [segs]).reduce((a, s) => a + (Array.isArray(s) ? tw(s[0], size, true) : tw(s, size)), 0);
export function rt(segs, x, y, { size = 12, fill = C.ink, anchor = 'middle', weight = 400, italic = false } = {}) {
  const parts = (Array.isArray(segs) ? segs : [segs]).map((s) => (Array.isArray(s)
    ? `<tspan font-family="${MONO}" font-size="${size}">${esc(s[0])}</tspan>`
    : `<tspan>${esc(s)}</tspan>`)).join('');
  return `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" font-family="${SANS}" text-anchor="${anchor}"${italic ? ' font-style="italic"' : ''}>${parts}</text>`;
}

export const KINDS = {
  focal: { fill: C.accentTint, stroke: C.accent, dash: '' },
  backend: { fill: '#ffffff', stroke: C.ink, dash: '' },
  store: { fill: 'rgba(45,49,66,0.05)', stroke: C.muted, dash: '' },
  external: { fill: 'rgba(45,49,66,0.03)', stroke: 'rgba(45,49,66,0.30)', dash: '' },
  input: { fill: 'rgba(79,93,117,0.10)', stroke: C.soft, dash: '' },
  optional: { fill: 'rgba(45,49,66,0.02)', stroke: 'rgba(45,49,66,0.20)', dash: '4,3' },
};

export function node({ x, y, w, h, kind = 'backend', tag, name, subs = [], nameSize = 12 }) {
  g4(x, 'node.x'); g4(y, 'node.y'); g4(w, 'node.w'); g4(h, 'node.h');
  const need = subs.length ? 56 + 16 * (subs.length - 1) + 12 : 52;
  if (h < need) throw new Error(`node "${name}" เตี้ยเกิน: h=${h} ต้อง ≥ ${need}`);
  if (tw(name, nameSize, false, true) > w - 16) throw new Error(`ชื่อ node ยาวเกิน: ${name}`);
  for (const s of subs) if (segW(s) > w - 16) throw new Error(`sub ยาวเกินใน "${name}": ${Array.isArray(s) ? s.map((p) => (Array.isArray(p) ? p[0] : p)).join('') : s}`);
  const k = KINDS[kind];
  const cx = x + w / 2;
  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${C.paper}"/>`;
  out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${k.fill}" stroke="${k.stroke}" stroke-width="1"${k.dash ? ` stroke-dasharray="${k.dash}"` : ''}/>`;
  if (tag) {
    const tgw = Math.ceil((tw(tag, 8, true) + 12) / 4) * 4;
    out += `<rect x="${x + 8}" y="${y + 6}" width="${tgw}" height="12" rx="2" fill="transparent" stroke="${k.stroke}" stroke-opacity="0.6" stroke-width="0.8"/>`;
    out += `<text x="${x + 8 + tgw / 2}" y="${y + 15}" fill="${k.stroke}" font-size="8" font-family="${MONO}" text-anchor="middle" letter-spacing="0.08em">${esc(tag)}</text>`;
  }
  out += `<text x="${cx}" y="${y + 40}" fill="${C.ink}" font-size="${nameSize}" font-weight="600" font-family="${SANS}" text-anchor="middle">${esc(name)}</text>`;
  subs.forEach((s, i) => { out += rt(s, cx, y + 56 + 16 * i, { fill: C.muted }); });
  return out;
}

export function zone({ x, y, w, h, label }) {
  g4(x, 'zone.x'); g4(y, 'zone.y'); g4(w, 'zone.w'); g4(h, 'zone.h');
  const lw = Math.ceil(tw(label, 12) + 16);
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="rgba(45,49,66,0.02)" stroke="rgba(45,49,66,0.10)" stroke-width="0.8"/>`
    + `<rect x="${x + 12}" y="${y + 4}" width="${lw}" height="16" rx="2" fill="${C.paper}"/>`
    + `<text x="${x + 12 + lw / 2}" y="${y + 16}" fill="${C.soft}" font-size="12" font-family="${SANS}" text-anchor="middle">${esc(label)}</text>`;
}

// ตัวเชื่อมมุมฉาก มุมโค้ง r=8 · จุดทุกจุดอยู่บนกริด 4px
export function pathD(pts, r = 8) {
  pts.forEach(([x, y], i) => { g4(x, `path[${i}].x`); g4(y, `path[${i}].y`); });
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i += 1) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (x0 !== x1 && y0 !== y1) throw new Error(`เส้นทแยง: (${x0},${y0})→(${x1},${y1})`);
    const len = Math.abs(x1 - x0) + Math.abs(y1 - y0);
    if (i < pts.length - 1) {
      const [x2, y2] = pts[i + 1];
      const d1 = [Math.sign(x1 - x0), Math.sign(y1 - y0)];
      const d2 = [Math.sign(x2 - x1), Math.sign(y2 - y1)];
      if (len < (i === 1 ? 8 : 16)) throw new Error(`ช่วงสั้นเกินมุม: (${x0},${y0})→(${x1},${y1})`);
      d += ` L${x1 - d1[0] * r},${y1 - d1[1] * r} Q${x1},${y1} ${x1 + d2[0] * r},${y1 + d2[1] * r}`;
    } else d += ` L${x1},${y1}`;
  }
  return d;
}

const STYLES = {
  video: { stroke: C.ink, w: 1.8, marker: 'arrow-ink', dash: '' },
  ctrl: { stroke: C.link, w: 1.2, marker: 'arrow-link', dash: '' },
  muted: { stroke: C.muted, w: 1.2, marker: 'arrow', dash: '' },
  optional: { stroke: C.muted, w: 1, marker: 'arrow', dash: '5,4' },
  accent: { stroke: C.accent, w: 1.8, marker: 'arrow-accent', dash: '' },
  ret: { stroke: C.muted, w: 1, marker: 'arrow', dash: '4,3' },
};
export function route(pts, kind = 'muted') {
  const s = STYLES[kind];
  return `<path d="${pathD(pts)}" fill="none" stroke="${s.stroke}" stroke-width="${s.w}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round" marker-end="url(#${s.marker})"/>`;
}

export function badge(n, cx, cy) {
  return `<circle cx="${cx}" cy="${cy}" r="8" fill="${C.ink}"/><text x="${cx}" y="${cy + 3}" fill="${C.paper}" font-size="8" font-weight="600" font-family="${MONO}" text-anchor="middle">${n}</text>`;
}

// label เหนือเส้นแนวนอน ที่ y=ly : mask สูง 16 ห่างเส้น 6px
export function labelH({ segs, cx, ly, num = null, fill = C.muted }) {
  const textW = segW(segs);
  const bw = num ? 16 + 4 : 0;
  const w = Math.ceil(textW + bw + 8);
  const x0 = Math.round(cx - w / 2);
  let out = `<rect x="${x0}" y="${ly - 22}" width="${w}" height="16" rx="2" fill="${C.paper}"/>`;
  if (num) out += badge(num, x0 + 4 + 8, ly - 14);
  out += rt(segs, x0 + 4 + bw + textW / 2, ly - 10, { fill });
  return { svg: out, box: { x: x0, y: ly - 22, w, h: 16 } };
}
// label ข้างเส้นแนวตั้งที่ x=lx (ด้านขวา) กึ่งกลางที่ cy
export function labelV({ segs, lx, cy, num = null, fill = C.muted, side = 'right' }) {
  const textW = segW(segs);
  const bw = num ? 20 : 0;
  const w = Math.ceil(textW + bw + 8);
  const x0 = side === 'right' ? lx + 10 : lx - 10 - w;
  let out = `<rect x="${x0}" y="${cy - 8}" width="${w}" height="16" rx="2" fill="${C.paper}"/>`;
  if (num) out += badge(num, x0 + 12, cy);
  out += rt(segs, x0 + 4 + bw + textW / 2, cy + 4, { fill });
  return { svg: out, box: { x: x0, y: cy - 8, w, h: 16 } };
}

export function legend({ y, w, items }) {
  let out = `<line x1="40" y1="${y - 8}" x2="${w - 40}" y2="${y - 8}" stroke="rgba(45,49,66,0.10)" stroke-width="0.8"/>`;
  out += `<text x="40" y="${y + 12}" fill="${C.muted}" font-size="8" font-family="${MONO}" letter-spacing="0.14em">LEGEND</text>`;
  let x = 120;
  for (const it of items) {
    if (it.line) {
      const s = STYLES[it.line];
      out += `<line x1="${x}" y1="${y + 8}" x2="${x + 32}" y2="${y + 8}" stroke="${s.stroke}" stroke-width="${s.w}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`;
      out += `<polygon points="${x + 32},${y + 8} ${x + 25},${y + 5} ${x + 25},${y + 11}" fill="${s.stroke}"/>`;
      x += 44;
    } else if (it.box) {
      const k = KINDS[it.box];
      out += `<rect x="${x}" y="${y + 2}" width="20" height="12" rx="3" fill="${k.fill}" stroke="${k.stroke}" stroke-width="1"${k.dash ? ` stroke-dasharray="${k.dash}"` : ''}/>`;
      x += 30;
    }
    out += rt(it.text, x, y + 12, { anchor: 'start', fill: C.muted });
    x += Math.ceil(segW(it.text)) + 28;
  }
  return out;
}

export function defs() {
  const mk = (id, c) => `<marker id="${id}" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="${c}"/></marker>`;
  return `<defs>${mk('arrow', C.muted)}${mk('arrow-ink', C.ink)}${mk('arrow-link', C.link)}${mk('arrow-accent', C.accent)}</defs>`;
}

export function svgWrap({ slug, title, desc, w, h, body }) {
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="${slug}-title ${slug}-desc" style="max-width:${w}px">`
    + `<title id="${slug}-title">${esc(title)}</title><desc id="${slug}-desc">${esc(desc)}</desc>${defs()}`
    + `<rect width="100%" height="100%" fill="${C.paper}"/>${body}</svg>`;
}

// ---------------------------------------------------------------- sequence
export function sequence({ slug, title, desc, w, heads, headY = 24, headH = 56, bottom, items, legendItems }) {
  const parts = { life: '', notes: '', msgs: '', heads: '' };
  heads.forEach((hd) => {
    const x = hd.x - hd.w / 2;
    parts.heads += node({ x, y: headY, w: hd.w, h: headH, kind: hd.kind || 'backend', tag: hd.tag, name: hd.name });
    parts.life += `<line x1="${hd.x}" y1="${headY + headH}" x2="${hd.x}" y2="${bottom}" stroke="rgba(45,49,66,0.20)" stroke-width="1" stroke-dasharray="3,3"/>`;
  });
  const boxes = [];
  for (const it of items) {
    if (it.type === 'note') {
      const cx = heads[it.at].x;
      const lines = it.lines;
      const nw = Math.max(...lines.map((l) => Math.ceil(segW(l) + 24)), 80);
      const nW = Math.ceil(nw / 4) * 4;
      const nh = 12 + 16 * lines.length + 4;
      const nH = Math.ceil(nh / 4) * 4;
      g4(it.y, 'note.y');
      parts.notes += `<rect x="${cx - nW / 2}" y="${it.y}" width="${nW}" height="${nH}" rx="4" fill="${C.paper}"/>`
        + `<rect x="${cx - nW / 2}" y="${it.y}" width="${nW}" height="${nH}" rx="4" fill="rgba(45,49,66,0.05)" stroke="${C.muted}" stroke-width="0.8"/>`;
      lines.forEach((l, i) => { parts.notes += rt(l, cx, it.y + 20 + 16 * i, { fill: C.ink }); });
      boxes.push({ y0: it.y, y1: it.y + nH, x0: cx - nW / 2, x1: cx + nW / 2, kind: 'note' });
    } else {
      const a = heads[it.from].x;
      const b = heads[it.to].x;
      const dir = Math.sign(b - a);
      g4(it.y, 'msg.y');
      const style = it.accent ? 'accent' : (it.ret ? 'ret' : (it.kind || 'ctrl'));
      const s = STYLES[style];
      parts.msgs += `<line x1="${a}" y1="${it.y}" x2="${b - dir * 1}" y2="${it.y}" stroke="${s.stroke}" stroke-width="${s.w}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} marker-end="url(#${s.marker})"/>`;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const lab = labelH({ segs: it.segs, cx: (a + b) / 2, ly: it.y, num: it.num, fill: it.accent ? C.accent : C.muted });
      if (lab.box.x < lo + 8 || lab.box.x + lab.box.w > hi - 8) throw new Error(`label ยาวเกินช่วง lifeline (${lo}–${hi}): ${JSON.stringify(it.segs)} w=${lab.box.w}`);
      parts.msgs += lab.svg;
      boxes.push({ y0: it.y - 22, y1: it.y, x0: lo, x1: hi, kind: 'msg' });
    }
  }
  // กันข้อความซ้อนกัน/ซ้อนโน้ตคนละประเภท
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const p = boxes[i]; const q = boxes[j];
      if (p.kind === 'msg' && q.kind === 'msg') {
        if (p.y0 < q.y1 && q.y0 < p.y1) throw new Error(`message ซ้อนกันที่ y=${p.y1}/${q.y1}`);
      } else if (p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1) throw new Error(`message/note ซ้อนกัน y=${p.y0}-${p.y1} vs ${q.y0}-${q.y1}`);
    }
  }
  const lgY = bottom + 32;
  const body = parts.life + parts.notes + parts.msgs + parts.heads + legend({ y: lgY, w, items: legendItems });
  return svgWrap({ slug, title, desc, w, h: lgY + 36, body });
}
