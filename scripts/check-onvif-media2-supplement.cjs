/** จำลองการตอบ Media1/Media2 ด้วย transport จริงที่ mock เฉพาะ SOAP โดยไม่ต่ออุปกรณ์ */
const assert = require('node:assert/strict');
const url = require('node:url');
const onvif = require('../server/node_modules/node-onvif');
require('../server/onvif_patch').patchNodeOnvif(onvif);
const soap = require('../server/node_modules/node-onvif/lib/modules/soap');
const originalRequest = soap.requestCommand;
const encoder = (encoding = 'H265') => ({ $: { token: 'enc' }, Encoding: encoding, Resolution: { Width: 1920, Height: 1080 } });
const source = (token = 'cam0') => ({ $: { token: 'cfg' }, SourceToken: token });
const media1 = (enc) => ({ $: { token: 'main' }, Name: 'Main', VideoSourceConfiguration: source(), ...(enc ? { VideoEncoderConfiguration: enc } : {}) });
async function probe({ first = [media1()], second, error, auth = false, fault = false }) {
  const d = new onvif.OnvifDevice({ xaddr: 'http://fixture:80/onvif/device_service', user: 'fixture', pass: 'fixture' });
  let calls = 0;
  d.services = { media: { getProfiles: cb => cb(auth ? Error('401 Unauthorized') : fault ? Error('500 Invalid VideoEncoding H265') : null, { data: { GetProfilesResponse: { Profiles: first } } }) },
    device: { getServices: async () => { calls++; if (error) throw error; return { data: { GetServicesResponse: { Service: [{ Namespace: 'http://www.onvif.org/ver20/media/wsdl', XAddr: 'http://fixture/media2' }] } } }; } } };
  soap.requestCommand = async () => ({ data: { GetProfilesResponse: { Profiles: second || [{ $: { token: 'main' }, Configurations: { VideoSource: source(), VideoEncoder: encoder() } }] } } });
  await d._mediaGetProfiles();
  return { d, calls };
}
(async () => {
  try {
    const { d } = await probe({});
    assert.equal(d.profile_list[0].video.encoder?.encoding, 'H265', 'Media2 should fill a missing Media1 encoder');
    assert.equal(d.__cctvMedia2, undefined, 'URI transport remains Media1');
    assert.equal(d.current_profile, d.profile_list[0]);
    const complete = await probe({ first: [media1(encoder('H264'))] });
    assert.equal(complete.calls, 0, 'complete Media1 causes no extra requests');
    const mismatch = await probe({ second: [{ $: { token: 'other' }, Configurations: { VideoSource: source(), VideoEncoder: encoder() } }] });
    assert.equal(mismatch.d.profile_list.length, 1);
    assert.equal(mismatch.d.profile_list[0].video.encoder, null);
    const wrongSource = await probe({ second: [{ $: { token: 'main' }, Configurations: { VideoSource: source('other-camera'), VideoEncoder: encoder() } }] });
    assert.equal(wrongSource.d.profile_list[0].video.encoder, null);
    const denied = await probe({ error: Error('401 Unauthorized') });
    assert.equal(denied.d.profile_list[0].token, 'main', 'optional lookup failure preserves successful Media1');
    await assert.rejects(probe({ auth: true }), /401/);
    const partial = await probe({ first: [media1({ Encoding: 'H265', Resolution: { Width: 0, Height: 0 } })] });
    assert.equal(partial.d.profile_list[0].video.encoder.encoding, 'H265', 'known encoding is never overwritten');
    assert.equal(partial.d.profile_list[0].video.encoder.resolution.width, 1920);
    const duplicate = await probe({ second: [1,2].map(() => ({ $: { token: 'main' }, Configurations: { VideoSource: source(), VideoEncoder: encoder() } })) });
    assert.equal(duplicate.d.profile_list[0].video.encoder, null, 'ambiguous token is not merged');
    const conflict = await probe({ first: [media1({ Encoding: 'H264' })] });
    assert.equal(conflict.d.profile_list[0].video.encoder.encoding, 'H264');
    assert.equal(conflict.d.profile_list[0].video.encoder.resolution.width, 0, 'conflicting codec metadata is not merged');
    const fallback = await probe({ fault: true });
    assert.equal(fallback.d.profile_list[0].video.encoder.encoding, 'H265');
    assert.ok(fallback.d.__cctvMedia2, 'original Media1 fault still switches URI transport to Media2');
    console.log('PASS Media2 supplement: missing encoder, complete response, mismatched token/source, optional failure, auth, partial resolution');
  } finally { soap.requestCommand = originalRequest; }
})().catch(e => { console.error(e); process.exitCode = 1; });
