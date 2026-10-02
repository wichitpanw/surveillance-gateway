/**
 * snapshot ฐานข้อมูล SQLite ที่กำลังถูกเขียนอยู่ ให้เป็นไฟล์ที่สอดคล้องกัน
 *
 * นามสกุล .cjs เพราะ package.json ของ repo ตั้ง "type": "module" ไว้ — .js จะถูกอ่านเป็น
 * ES module แล้ว require ใช้ไม่ได้
 *
 * แยกมาเป็นไฟล์แทนที่จะฝัง `node -e "..."` ไว้ใน backup-windows.ps1 เพราะ PowerShell
 * กลืนเครื่องหมายคำพูดตอนส่ง argument ให้โปรแกรมภายนอก โค้ด JS ที่มี `"` จึงถึงปลายทาง
 * แบบพังทุกครั้ง — ไม่ใช่ปัญหาที่ escape เพิ่มแล้วจบ
 *
 * ใช้ `VACUUM INTO` ไม่ใช่การคัดลอกไฟล์ เพราะฐานข้อมูลเปิดโหมด WAL ไว้และมี backend
 * เขียนอยู่ตลอด การ copy ดิบ ๆ อาจได้ภาพครึ่ง ๆ กลาง ๆ หรือตกส่วนที่ยังค้างใน WAL
 * ผลคือไฟล์ที่ดูปกติดีจนถึงวันที่ต้องใช้จริง
 *
 *   node scripts/sqlite-backup.cjs <ต้นทาง> <ปลายทาง>
 */
const path = require('path');
const sqlite3 = require(path.join(__dirname, '..', 'server', 'node_modules', 'sqlite3'));

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('ใช้: node scripts/sqlite-backup.cjs <ต้นทาง> <ปลายทาง>');
  process.exit(2);
}

const db = new sqlite3.Database(src, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error(`เปิด ${src} ไม่ได้: ${err.message}`);
    process.exit(1);
  }
  db.run('VACUUM INTO ?', [dest], (e) => {
    if (e) {
      console.error(`สำรองไม่สำเร็จ: ${e.message}`);
      process.exit(1);
    }
    db.close();
  });
});
