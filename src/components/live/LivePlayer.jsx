import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, VideoOff } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

/** ขอ stream token จาก backend — คืน { url, type } หรือโยน Error พร้อมข้อความจากเซิร์ฟเวอร์ */
async function openStream(cameraId, type) {
  const res = await apiFetch(`/api/cameras/${encodeURIComponent(cameraId)}/stream/start?type=${type}`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `เปิดสตรีมไม่ได้ (HTTP ${res.status})`);
  if (!data.streamName || !data.streamToken) throw new Error('backend ไม่ส่ง stream token มา');
  return {
    url: `${window.location.origin}/stream/${encodeURIComponent(data.streamName)}.mp4?t=${encodeURIComponent(data.streamToken)}`,
    type: data.type || type,
  };
}

const STALL_MS = 10_000;
const MAX_RETRY_MS = 30_000;

/*
  ผู้เล่นภาพสดหนึ่งช่อง — <video> เล่น fMP4 ที่ backend proxy มาจาก go2rtc (/stream/<name>.mp4)

  ทำไมไม่ใช่ HLS/WebRTC: HLS ของ go2rtc 1.9.14 มัด segment ผิด (ได้เสียงล้วน) ส่วน WebRTC ต้องเปิด
  พอร์ต 8556 ให้ผู้ใช้ทุกคน fMP4 วิ่งผ่านพอร์ต 5173 ที่เปิดอยู่แล้ว และ token ผูกกับสตรีมเดียว

  ภาพค้าง/หลุด (error, ended, ไม่มีเฟรมใหม่เกิน 10 วิ) = ขอ token ใหม่แล้วต่อใหม่เอง backoff 2 → 30 วิ
  การถอด src ตอน unmount คือสิ่งที่ปิดสายไป go2rtc — ไม่ถอดแล้ว go2rtc จะดึงภาพค้างไว้ต่อ
*/
export default function LivePlayer({ cameraId, type = 'sub', className, fit = 'contain', onState }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | playing | error
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const retryMs = useRef(2000);

  const report = useCallback((s, extra) => onState?.(s, extra), [onState]);

  useEffect(() => {
    if (!cameraId) return undefined;
    const video = videoRef.current;
    let cancelled = false;
    let retryTimer = null;
    let stallTimer = null;
    let lastTime = -1;

    const scheduleRetry = (message) => {
      if (cancelled) return;
      setStatus('error');
      setError(message);
      report('error', message);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        setStatus('loading');
        setAttempt((n) => n + 1);
      }, retryMs.current);
      retryMs.current = Math.min(retryMs.current * 2, MAX_RETRY_MS);
    };

    const watchStall = () => {
      clearInterval(stallTimer);
      stallTimer = setInterval(() => {
        if (!video || video.paused) return;
        if (video.currentTime === lastTime) scheduleRetry('ภาพค้าง — กำลังต่อใหม่');
        lastTime = video.currentTime;
      }, STALL_MS);
    };

    const onPlaying = () => {
      if (cancelled) return;
      retryMs.current = 2000;
      setStatus('playing');
      setError(null);
      report('playing');
      watchStall();
    };
    const onFail = () => scheduleRetry('สตรีมหลุด — กำลังต่อใหม่');

    // เปลี่ยนกล้อง/ชนิดสตรีม = ผู้เรียกใส่ key ใหม่ (mount ใหม่ เริ่มที่ loading) ไม่ต้องตั้งสถานะตรงนี้
    report('loading');
    openStream(cameraId, type)
      .then(({ url }) => {
        if (cancelled || !video) return;
        video.addEventListener('playing', onPlaying);
        video.addEventListener('error', onFail);
        video.addEventListener('ended', onFail);
        video.src = url;
        video.play().catch(() => { /* autoplay ถูกบล็อก — muted แล้วไม่ควรเกิด รอ event แทน */ });
      })
      .catch((err) => scheduleRetry(err.message));

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      clearInterval(stallTimer);
      if (video) {
        video.removeEventListener('playing', onPlaying);
        video.removeEventListener('error', onFail);
        video.removeEventListener('ended', onFail);
        video.removeAttribute('src');
        video.load();
      }
    };
  }, [cameraId, type, attempt, report]);

  return (
    <div className={cn('relative size-full overflow-hidden bg-black', className)}>
      <video
        ref={videoRef}
        muted
        autoPlay
        playsInline
        disablePictureInPicture
        className={cn('size-full', fit === 'cover' ? 'object-cover' : 'object-contain')}
      />
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="size-6 animate-spin text-white/70" />
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
          <VideoOff className="size-6 text-white/60" />
          <p className="text-[11px] text-white/70">{error}</p>
        </div>
      )}
    </div>
  );
}
