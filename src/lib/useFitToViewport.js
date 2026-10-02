import { useEffect, useState } from 'react';

/**
 * ความกว้างสูงสุดของกล่องภาพ/วิดีโอ ที่ทำให้ทั้งกล่องอยู่ในจอโดยไม่ต้องเลื่อน
 *
 * วัดจากตำแหน่งจริงของกล่องบนหน้า (ขอบบนถึงล่างจอ) ทุกครั้งที่ย่อ/ขยาย แล้วคูณด้วยสัดส่วนภาพ
 * — แบบเดียวกับ LiveWall แทนการเดาความสูง header เป็นเลขตายตัว (AGENTS.md: ห้าม h-[calc(100vh-Npx)])
 *
 * @param {React.RefObject<HTMLElement>} ref  กล่องที่จะให้พอดีจอ
 * @param {number} aspect  กว้าง/สูง ของภาพ (เช่น 16/9) — 0 หรือไม่รู้ = ไม่จำกัด
 * @param {number} [bottom=24]  ที่เว้นใต้กล่อง (px) เช่นให้เห็นขอบหรือปุ่มข้างล่าง
 * @returns {number|null} maxWidth เป็น px หรือ null ถ้ายังวัดไม่ได้
 */
export default function useFitToViewport(ref, aspect, bottom = 24) {
  const [maxWidth, setMaxWidth] = useState(null);

  useEffect(() => {
    if (!aspect) return undefined;
    const fit = () => {
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const avail = window.innerHeight - top - bottom;
      setMaxWidth(avail > 160 ? Math.floor(avail * aspect) : null);
    };
    fit();
    // วัดซ้ำเมื่อของข้างบนเปลี่ยนความสูง (แถบเตือน, แถวปุ่มตัดบรรทัด) ไม่ใช่แค่ตอนย่อหน้าต่าง
    const ro = new ResizeObserver(fit);
    if (ref.current?.parentElement) ro.observe(ref.current.parentElement);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [ref, aspect, bottom]);

  return maxWidth;
}
