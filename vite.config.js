import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      /*
        สอง entry ไม่ใช่หนึ่ง

        index.html คือหน้าเว็บบริหารจัดการ ส่วน client-map.html คือหน้าแผนที่ที่ client บน
        Windows เปิดผ่าน WebView2 มันถูก build จากที่นี่เพราะ Gateway เสิร์ฟไทล์อยู่แล้วและ
        maplibre เป็น dependency ของ repo นี้อยู่แล้ว — ตัวโปรแกรมจึงไม่ต้องแบก JS bundle
        ไปเอง และแผนที่กับไทล์อัปเดตพร้อมกันเสมอ

        เป็นคนละ entry กันจริง ๆ ไม่ใช่ route ในแอปเดียว เพราะหน้าแผนที่ไม่มี React, ไม่มี
        การล็อกอิน และไม่ได้แชร์โค้ดกับหน้าเว็บเลย การรวมเข้าไปจะลาก bundle ทั้งก้อนของหน้าเว็บ
        ไปให้ WebView2 โหลดโดยไม่ได้ใช้
      */
      input: {
        // สามโปรแกรม: Central, Regional และ Edge — backend เลือกหน้าตาม GATEWAY_ROLE
        main: path.resolve(__dirname, 'index.html'),
        regional: path.resolve(__dirname, 'regional.html'),
        edge: path.resolve(__dirname, 'edge.html'),
        clientMap: path.resolve(__dirname, 'client-map.html'),
      },
    },
  },
})
