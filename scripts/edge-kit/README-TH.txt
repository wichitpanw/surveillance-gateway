Surveillance Gateway Edge — ชุดติดตั้งจาก flash drive (ไม่ต้องใช้ internet)

1. ที่ central: Edge Nodes → Add Edge → "Edge ต่อขึ้นมาเอง" → ใส่ชื่อ → ออก token
   → ติ๊กเส้นทางที่ edge นี้เข้าถึง central ได้ → กด "ดาวน์โหลด edge-<เลข>.json"
2. วางไฟล์ edge-<เลข>.json ไว้ในโฟลเดอร์นี้ (ข้าง install-windows.cmd) หรือที่ราก flash drive
3. ที่เครื่อง edge:
   - Windows mini PC : ดับเบิลคลิก install-windows.cmd แล้วกด Yes
   - Raspberry Pi 5  : เปิด Terminal ในโฟลเดอร์นี้ แล้วพิมพ์  sudo bash install-linux.sh
4. รอจนขึ้น "เสร็จ" — ตัวติดตั้งลบไฟล์ edge-<เลข>.json ออกจาก flash drive ให้เอง (ไฟล์นั้นมี token)
5. เปิดเว็บตามที่อยู่ที่ขึ้นบนจอ → login superadmin / superadmin → เปลี่ยนรหัสผ่านทันที → แอดกล้อง
   ที่ central หน้า Edge Nodes ต้องขึ้น edge นี้เป็น Online

อัปเดตเวอร์ชัน: ก๊อปชุดติดตั้งใหม่ลง flash drive แล้วรันไฟล์เดิมซ้ำ (ไม่ต้องใช้ edge-<เลข>.json) — ข้อมูลและกล้องยังอยู่ครบ
รายละเอียด: docs/EDGE-KIT.md ใน repo ของโครงการ
