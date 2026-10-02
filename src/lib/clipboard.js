/**
 * คัดลอกข้อความลงคลิปบอร์ด — ใช้ได้ทั้งบน HTTPS และ HTTP
 *
 * ทำไมต้องมีไฟล์นี้: `navigator.clipboard` มีอยู่เฉพาะใน **secure context** เท่านั้น
 * (HTTPS หรือ localhost) ระบบนี้เสิร์ฟผ่าน `http://203.0.113.80:5173` ซึ่งเป็น IP ใน LAN
 * ที่ไม่มีใบรับรอง เบราว์เซอร์จึงตั้ง `window.isSecureContext = false` และ
 * `navigator.clipboard` เป็น **undefined ไปเลย** ไม่ใช่แค่ถูกปฏิเสธสิทธิ์
 *
 * ผลของโค้ดเดิมที่เรียก `navigator.clipboard.writeText()` ตรง ๆ คือ TypeError ทุกครั้ง
 * แล้วตกไปเข้า catch ซึ่งขึ้นข้อความว่า "คัดลอกอัตโนมัติไม่ได้ กรุณาคัดลอกเอง" — ปุ่มจึง
 * ไม่เคยทำงานเลยบนเครื่องที่ใช้จริง ทั้งที่ทดสอบบน localhost ตอนพัฒนาแล้วผ่านทุกครั้ง
 *
 * ทางสำรองคือ `document.execCommand('copy')` ซึ่งถูกประกาศเลิกใช้แล้วก็จริง แต่ยังทำงาน
 * ได้ในเบราว์เซอร์ปัจจุบันทุกตัว และเป็นวิธีเดียวที่ใช้ได้บน HTTP ตราบใดที่ระบบนี้ยังไม่ได้
 * ขึ้น HTTPS ก็ยังต้องมีทางนี้ไว้
 *
 * ข้อจำกัดที่ผู้เรียกต้องรู้: ทั้งสองทางต้องถูกเรียกจาก **user gesture** เท่านั้น เรียกจาก
 * setTimeout หรือหลัง await ที่กินเวลานานแล้วเบราว์เซอร์จะปฏิเสธเงียบ ๆ (คืน false)
 * ฟังก์ชันนี้จึงต้องถูกเรียกในจังหวะแรกของ onClick ไม่ใช่หลังรอผลอย่างอื่นก่อน
 *
 * @param {string} text
 * @returns {Promise<boolean>} คัดลอกสำเร็จหรือไม่
 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;

  // ทางหลัก — ใช้ได้เมื่อขึ้น HTTPS แล้ว หรือตอนพัฒนาบน localhost
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // สิทธิ์ถูกปฏิเสธหรือหน้าไม่ได้โฟกัส — ลองทางสำรองต่อ ไม่ใช่ยอมแพ้ตรงนี้
    }
  }

  return legacyCopy(value);
}

/**
 * คัดลอกด้วย textarea ชั่วคราว + execCommand
 *
 * ต้องใช้ textarea จริงที่อยู่ใน DOM และถูก select ไว้ เพราะ execCommand คัดลอก
 * "สิ่งที่ถูกเลือกอยู่" ไม่ใช่ค่าที่เราส่งเข้าไป
 *
 * `position: fixed; top: 0` ไม่ใช่การจัดวางให้สวย แต่กันหน้าจอกระโดด — element ที่อยู่
 * นอกจอตอนถูก focus จะทำให้เบราว์เซอร์เลื่อนหน้าไปหามัน ส่วน opacity 0 ใช้แทน
 * display:none เพราะสิ่งที่ซ่อนด้วย display:none เลือกข้อความไม่ได้
 */
function legacyCopy(value) {
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(ta);

  const previous = document.activeElement;
  ta.select();
  // iOS ไม่สนใจ select() กับ readonly — ต้องระบุช่วงเองอีกที
  ta.setSelectionRange(0, value.length);

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }

  document.body.removeChild(ta);
  // คืนโฟกัสให้ที่เดิม ไม่งั้นการกดปุ่มคัดลอกจะทำให้ช่องที่ผู้ใช้พิมพ์ค้างไว้เสียโฟกัส
  if (previous && typeof previous.focus === 'function') previous.focus();

  return ok;
}
