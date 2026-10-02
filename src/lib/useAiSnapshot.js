import { useEffect, useState } from 'react';
import { apiFetch, getAuthHeaders } from '@/lib/api';

/**
 * ภาพประกอบของ AI event — endpoint อยู่หลัง checkAuth จึง fetch พร้อม header แล้วแปลงเป็น blob URL
 * คืน { url, failed } · seq เป็น null = ไม่โหลด · blob URL คืนหน่วยความจำเองเมื่อ seq เปลี่ยนหรือ component หาย
 */
export function useAiSnapshot(seq) {
  const [state, setState] = useState({ seq: null, url: null, failed: false });
  useEffect(() => {
    if (seq == null) return undefined;
    let created = null;
    let cancelled = false;
    apiFetch(`/api/ai/events/${seq}/snapshot.jpg`, { headers: getAuthHeaders(), cache: 'no-store' })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (cancelled) return;
        created = URL.createObjectURL(b);
        setState({ seq, url: created, failed: false });
      })
      .catch(() => { if (!cancelled) setState({ seq, url: null, failed: true }); });
    return () => { cancelled = true; if (created) URL.revokeObjectURL(created); };
  }, [seq]);
  // ค่าของ seq ก่อนหน้าไม่นับ — กันภาพเก่าค้างตอนเลื่อนไป event ถัดไป
  return state.seq === seq ? state : { url: null, failed: false };
}
