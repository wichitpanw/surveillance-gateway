// ผู้ให้บริการที่สแกนช่องผ่าน API ได้จริง เพิ่มรายการใหม่เมื่อมี route และตรวจอุปกรณ์แล้ว
export const API_CAMERA_PROVIDERS = {
  axis_s30: {
    label: 'AXIS S30 (VAPIX)',
    brand: 'axis',
    scanPath: '/api/nvr/axis/channels',
    importMode: 'axis_s30',
    offlineImport: false,
  },
  uniview: {
    label: 'Uniview (LAPI)',
    brand: 'uniview',
    scanPath: '/api/nvr/uniview/channels',
    importMode: 'uniview_api',
    offlineImport: true,
  },
};

export const DEFAULT_API_CAMERA_PROVIDER = 'uniview';
