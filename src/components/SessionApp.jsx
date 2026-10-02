import { useEffect, useState } from 'react';
import App from '@/App';

/** ล้างข้อมูลและ modal ของบัญชีเก่าทั้งหมดเมื่อเปลี่ยน session */
export default function SessionApp({ role }) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const reset = () => setRevision((value) => value + 1);
    const onStorage = (event) => {
      if (event.key === 'cctv_session' || event.key === 'cctv_user' || event.key === null) reset();
    };
    window.addEventListener('cctv:session-reset', reset);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('cctv:session-reset', reset);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return <App key={revision} role={role} />;
}
