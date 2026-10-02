# server/data

## thai-regions.csv

รหัสจังหวัด / อำเภอ / ตำบลของไทย (รหัสกรมการปกครอง, ระดับจังหวัดตาม มอก. 1099):
77 จังหวัด · 928 อำเภอ/เขต · 7,436 ตำบล/แขวง · คอลัมน์ `code,name_th,name_en,parent`

- ใช้โดย `server/shared/regions.js` → `GET /api/regions`, ฟอร์มกล้อง, และ global ID ของกล้อง
- สร้างใหม่ด้วย `node scripts/gen-thai-regions.cjs` (ดาวน์โหลดจากต้นทาง ตรวจ parent/prefix ทุกแถวก่อนเขียน)
- **ห้ามแก้มือ** — แก้ที่ต้นทางหรือสคริปต์ แล้วสร้างใหม่
- ไม่ใช้ `civilCode.csv` ของโปรเจค reference edge project (another province dataset) เพราะเลขผิด — รายละเอียดในหัวไฟล์สคริปต์
- **เป็นรหัสกรมการปกครอง ไม่ใช่รหัสไปรษณีย์** — เช่น เขตหลักสี่ `1041` แขวงทุ่งสองห้อง `104101` (รหัสไปรษณีย์ 10210 เป็นอีกระบบ ไม่ได้เก็บ)
- ตรวจซ้ำ 2026-09-23 เทียบ earthchie/jquery.Thailand.js และ civilCode.csv: ต่างกัน 8 ชื่อ ของเราถูกทุกตัวตามประกาศเปลี่ยนชื่อ
  (430111 โพนสว่าง, 501805 แม่หลอง, 550116 บ่อสวก, 441106 สร้างแซ่ง, 502202 ทุ่งปี๊, 341524 ห้วยขะยุง, 600113 วัดไทรย์, 400101 ในเมือง)

ที่มา: https://github.com/thailand-geography-data/thailand-geography-json ใช้ภายใต้ MIT License:

```
MIT License

Copyright (c) 2023-Present Joe Takara

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
