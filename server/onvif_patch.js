const url = require('url');
const { redactUrls } = require('./shared/redact');

const MEDIA2_NS = 'http://www.onvif.org/ver20/media/wsdl';
// host:port ของอุปกรณ์ที่ต้องใช้ Media 2 (Media 1 GetProfiles ล้ม) — จำไว้ตลอดอายุ process
const media2Hosts = new Set();

const escapeXml = (v) => String(v).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/**
 * node-onvif's SOAP transport (lib/modules/soap.js) hardcodes Node's `http` module —
 * it never looks at the xaddr scheme, so an `https://` xaddr silently still goes out as
 * plain HTTP and fails against a real TLS listener. Real-world case: a user port-forwards
 * only HTTPS to an NVR (common when the router's admin only exposes an HTTPS rule), so the
 * ONVIF endpoint is reachable only over TLS even though the port number itself is "correct".
 * Patch `_request` to pick http vs https based on the parsed xaddr protocol, with
 * rejectUnauthorized:false since NVR/IPC self-signed certs are the norm, not the exception.
 */
function patchOnvifSoapHttps() {
  const soap = require('node-onvif/lib/modules/soap.js');
  if (soap.__cctvHttpsPatch) return;

  const http = require('http');
  const https = require('https');

  soap._request = function (oxaddr, body) {
    const isHttps = oxaddr.protocol === 'https:';
    const transport = isHttps ? https : http;
    return new Promise((resolve, reject) => {
      const postOpts = {
        hostname: oxaddr.hostname,
        port: oxaddr.port || (isHttps ? 443 : 80),
        path: oxaddr.pathname + (oxaddr.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8;',
          'Content-Length': Buffer.byteLength(body),
        },
        ...(isHttps ? { rejectUnauthorized: false } : {}),
      };

      let req = transport.request(postOpts, (res) => {
        res.setEncoding('utf8');
        let xml = '';
        res.on('data', (chunk) => { xml += chunk; });
        res.on('end', () => {
          if (req) { req.removeAllListeners('error'); req.removeAllListeners('timeout'); req = null; }
          if (res.statusCode === 200) {
            resolve(xml);
          } else if (xml) {
            soap.parse(xml).then((parsed) => {
              let msg = '';
              try {
                msg = parsed['Body']['Fault']['Reason']['Text'];
                if (typeof msg === 'object') msg = msg['_'];
              } catch (_) {}
              reject(new Error(`${res.statusCode} ${res.statusMessage}${msg ? ' - ' + msg : ''}`));
            }).catch(() => reject(new Error(`${res.statusCode} ${res.statusMessage}`)));
          } else {
            reject(new Error(`${res.statusCode} ${res.statusMessage}`));
          }
        });
      });

      req.setTimeout(soap.HTTP_TIMEOUT || 8000);
      req.on('timeout', () => req.abort());
      req.on('error', (error) => {
        req.removeAllListeners('error');
        req.removeAllListeners('timeout');
        reject(new Error('Network Error: ' + (error ? error.message : '')));
      });
      req.write(body, 'utf8');
      req.end();
    });
  };

  // อุปกรณ์ ONVIF ฝัง (Dahua/Uniview ฯลฯ) มักตอบช้ากว่า 3s ที่ค่า default กำหนดไว้ โดยเฉพาะ
  // ผ่าน TLS handshake — ขยายเป็น 8s กันหลุด timeout ก่อนอุปกรณ์ตอบจริง
  soap.HTTP_TIMEOUT = 8000;
  soap.__cctvHttpsPatch = true;
  console.log('[ONVIF] patched SOAP transport to support HTTPS xaddr (self-signed OK)');
}

/**
 * NAT / port-forward fix: `GetCapabilities` makes the NVR self-report the XAddr of each
 * sub-service (media/ptz/events) — for a device behind NAT this is its own LAN-internal
 * IP (e.g. `http://192.168.10.254:80/onvif/media_service`), completely unreachable from
 * outside. node-onvif has a `keepAddr` option meant to work around exactly this, but (a) it
 * only activates when the device is constructed with `address` instead of `xaddr` (we need
 * `xaddr` to specify a custom port), and (b) even then it hardcodes the rebuilt URL to
 * `http://`, which breaks again for devices only reachable over HTTPS. Real symptom without
 * this patch: ONVIF connects fine (GetSystemDateAndTime works), then hangs/resets on the
 * very next step (GetProfiles/GetStreamUri) because it's silently trying to reach the
 * NVR's private LAN address. Fix: always rebuild per-service XAddr using the host/port/
 * scheme that was actually dialed successfully (`this.oxaddr`), keeping only the path the
 * device reported. For the actual RTSP/snapshot media URIs, same idea but keep the URI's
 * own scheme+port (RTSP normally runs on a different port than the ONVIF HTTP(S) service)
 * and swap only the host — the common case where the device reports its private RTSP IP.
 */
function patchOnvifNatAddressing(onvif) {
  const proto = onvif.OnvifDevice && onvif.OnvifDevice.prototype;
  if (!proto || proto.__cctvNatPatch) return;

  const unwrap = (v) => (v && typeof v === 'object' && v['_']) ? v['_'] : v;

  proto._getXaddr = function (directXaddr) {
    const raw = unwrap(directXaddr);
    if (!raw) return raw;
    try {
      const parsed = new URL(raw);
      return `${this.oxaddr.protocol}//${this.oxaddr.host}${parsed.pathname}${parsed.search || ''}`;
    } catch (_) {
      return raw;
    }
  };

  const rewriteUriHostOnly = function (directUri) {
    const raw = unwrap(directUri);
    if (!raw) return raw;
    try {
      const parsed = new URL(raw);
      const auth = parsed.username ? `${parsed.username}${parsed.password ? ':' + parsed.password : ''}@` : '';
      const port = parsed.port ? `:${parsed.port}` : '';
      const hostname = this.oxaddr.hostname.includes(':') ? `[${this.oxaddr.hostname}]` : this.oxaddr.hostname;
      return `${parsed.protocol}//${auth}${hostname}${port}${parsed.pathname}${parsed.search || ''}`;
    } catch (_) {
      return raw;
    }
  };
  proto._getUri = rewriteUriHostOnly;
  proto._getSnapshotUri = rewriteUriHostOnly;

  proto.__cctvNatPatch = true;
  console.log('[ONVIF] patched NAT addressing (use dialed host for service XAddr + media URIs, not device-reported LAN address)');
}

/**
 * Harden node-onvif profile parsing — Dahua NVR often omits Resolution/RateControl
 * and crashes init with: Cannot read properties of undefined (reading 'Width')
 */
function patchNodeOnvif(onvif) {
  patchOnvifSoapHttps();
  patchOnvifNatAddressing(onvif);
  const soapModule = require('node-onvif/lib/modules/soap.js');
  const OnvifDevice = onvif.OnvifDevice;
  if (!OnvifDevice || OnvifDevice.prototype.__cctvEncoderPatch) return;

  /** แปลง Profile ของ Media 1 (หรือของ Media 2 ที่ map ชื่อแล้ว) เป็นรูปแบบ profile ของ node-onvif */
  const buildProfile = (p) => {
    const profile = {
      token: p?.$?.token || '',
      name: p?.Name || '',
      snapshot: '',
      stream: { udp: '', http: '', rtsp: '' },
      video: { source: null, encoder: null },
      audio: { source: null, encoder: null },
      ptz: { range: { x: { min: 0, max: 0 }, y: { min: 0, max: 0 }, z: { min: 0, max: 0 } } },
    };

    try {
      if (p.VideoSourceConfiguration) {
        const vs = p.VideoSourceConfiguration;
        const b = vs.Bounds?.$ || {};
        profile.video.source = {
          token: vs.$?.token || '',
          // token ของ VideoSource จริง (ตรงกับ GetVideoSources) — token ด้านบนเป็นของ configuration บางรุ่นไม่ซ้ำกัน
          sourceToken: (typeof vs.SourceToken === 'object' ? vs.SourceToken?._ : vs.SourceToken) || '',
          name: vs.Name || '',
          bounds: {
            width: parseInt(b.width || 0, 10) || 0,
            height: parseInt(b.height || 0, 10) || 0,
            x: parseInt(b.x || 0, 10) || 0,
            y: parseInt(b.y || 0, 10) || 0,
          },
        };
      }
    } catch (_) {}

    try {
      if (p.VideoEncoderConfiguration) {
        const enc = p.VideoEncoderConfiguration;
        const res = enc.Resolution || {};
        const rate = enc.RateControl || {};
        profile.video.encoder = {
          token: enc.$?.token || '',
          name: enc.Name || '',
          resolution: {
            width: parseInt(res.Width || 0, 10) || 0,
            height: parseInt(res.Height || 0, 10) || 0,
          },
          quality: parseInt(enc.Quality || 0, 10) || 0,
          framerate: parseInt(rate.FrameRateLimit || 0, 10) || 0,
          bitrate: parseInt(rate.BitrateLimit || 0, 10) || 0,
          encoding: enc.Encoding || '',
        };
      }
    } catch (_) {
      profile.video.encoder = {
        token: '', name: '', resolution: { width: 0, height: 0 },
        quality: 0, framerate: 0, bitrate: 0, encoding: '',
      };
    }

    try {
      if (p.AudioSourceConfiguration) {
        profile.audio.source = {
          token: p.AudioSourceConfiguration.$?.token || '',
          name: p.AudioSourceConfiguration.Name || '',
        };
      }
    } catch (_) {}

    try {
      if (p.AudioEncoderConfiguration) {
        const ae = p.AudioEncoderConfiguration;
        profile.audio.encoder = {
          token: ae.$?.token || '',
          name: ae.Name || '',
          bitrate: parseInt(ae.Bitrate || 0, 10) || 0,
          samplerate: parseInt(ae.SampleRate || 0, 10) || 0,
          encoding: ae.Encoding || '',
        };
      }
    } catch (_) {}

    // PTZ optional — ignore errors
    try {
      if (p.PTZConfiguration) {
        const r = p.PTZConfiguration.PanTiltLimits?.Range;
        if (r?.XRange) {
          profile.ptz.range.x.min = parseFloat(r.XRange.Min);
          profile.ptz.range.x.max = parseFloat(r.XRange.Max);
        }
        if (r?.YRange) {
          profile.ptz.range.y.min = parseFloat(r.YRange.Min);
          profile.ptz.range.y.max = parseFloat(r.YRange.Max);
        }
        const zr = p.PTZConfiguration.ZoomLimits?.Range?.XRange;
        if (zr) {
          profile.ptz.range.z.min = parseFloat(zr.Min);
          profile.ptz.range.z.max = parseFloat(zr.Max);
        }
      }
    } catch (_) {}

    return profile;
  };

  /** ตั้ง profile_list / current_profile ของ device จากรายการ Profile ดิบ */
  const applyProfiles = (device, profiles) => {
    device.profile_list = [];
    device.current_profile = null;
    [].concat(profiles).forEach((p) => {
      const profile = buildProfile(p);
      device.profile_list.push(profile);
      if (!device.current_profile) device.current_profile = profile;
    });
  };

  /** ส่งคำสั่ง ONVIF Media 2 (ver20) ไปที่ XAddr ที่หาไว้แล้ว — ใช้ WS-Security และ time_diff เดียวกับ node-onvif */
  const media2Request = (device, method, body) => {
    const xml = soapModule.createRequestSoap({
      body,
      xmlns: [`xmlns:tr2="${MEDIA2_NS}"`, 'xmlns:tt="http://www.onvif.org/ver10/schema"'],
      diff: device.time_diff,
      user: device.user,
      pass: device.pass,
    });
    return soapModule.requestCommand(device.__cctvMedia2.oxaddr, method, xml);
  };

  /** หา XAddr ของ Media 2 จาก GetServices — อุปกรณ์ที่ไม่มี service นี้ = ถอยต่อไม่ได้ */
  const findMedia2Xaddr = async (device) => {
    const res = await device.services.device.getServices({ IncludeCapability: false });
    const services = [].concat(res?.data?.GetServicesResponse?.Service || []);
    const media2 = services.find((s) => String(s?.Namespace || '').trim() === MEDIA2_NS);
    const raw = media2?.XAddr;
    if (!raw) throw new Error('device has no ONVIF Media2 service');
    return device._getXaddr(raw);
  };

  /**
   * GetProfiles ผ่าน Media 2 แล้ว map เป็นโครงของ Media 1 — Media 1 ไม่มีนิยาม H.265 อุปกรณ์บางรุ่นจึงปฏิเสธทั้งคำสั่ง
   * เมื่อ encoder ตั้งเป็น H.265 (Avigilon H5SL: "Invalid VideoEncoding H265 for Media 1")
   */
  const media2GetProfiles = async (device) => {
    const xaddr = await findMedia2Xaddr(device);
    device.__cctvMedia2 = { oxaddr: url.parse(xaddr) };
    const res = await media2Request(device, 'GetProfiles', '<tr2:GetProfiles><tr2:Type>All</tr2:Type></tr2:GetProfiles>');
    device.lastResponse = res;
    const profiles = res?.data?.GetProfilesResponse?.Profiles;
    if (!profiles) throw new Error('Media2 GetProfiles returned no profiles');
    applyProfiles(device, [].concat(profiles).map((p) => {
      const cfg = p?.Configurations || {};
      return {
        $: p?.$,
        Name: p?.Name,
        VideoSourceConfiguration: cfg.VideoSource,
        VideoEncoderConfiguration: cfg.VideoEncoder,
        AudioSourceConfiguration: cfg.AudioSource,
        AudioEncoderConfiguration: cfg.AudioEncoder,
        PTZConfiguration: cfg.PTZ,
      };
    }));
  };

  /** ถอยไป Media 2 เฉพาะเมื่ออุปกรณ์ตอบ fault มาชัด ๆ — ไม่ใช่เครือข่ายล่มหรือรหัสผิด (ห้ามยิงซ้ำตอน login ผิด) */
  const canTryMedia2 = (error) => {
    const msg = String(error?.message || error || '');
    if (/not ?authori[sz]ed|unauthori[sz]ed|^40[13]\b/i.test(msg)) return false;
    return /^(400|500)\b/.test(msg) || /does not any media profiles|seems to not support/i.test(msg);
  };

  const media1GetProfiles = function () {
    return new Promise((resolve, reject) => {
      this.services.media.getProfiles((error, result) => {
        this.lastResponse = result;
        if (error) {
          reject(error);
          return;
        }
        const profiles = result?.data?.GetProfilesResponse?.Profiles;
        if (!profiles) {
          reject(new Error('The targeted device does not any media profiles.'));
          return;
        }
        applyProfiles(this, profiles);
        resolve();
      });
    });
  };

  /** เติม encoder ที่ Media1 ให้ไม่ครบจาก Media2 เฉพาะ profile/source เดียวกัน โดยไม่เปลี่ยนทาง URI */
  const supplementMedia1Encoders = async (device) => {
    const incomplete = (p) => p.video?.source && (!p.video.encoder?.encoding
      || !(p.video.encoder?.resolution?.width > 0) || !(p.video.encoder?.resolution?.height > 0));
    const missing = device.profile_list.filter(incomplete);
    if (!missing.length) return;
    // ใช้ device ชั่วคราวเพื่อไม่ให้การอ่านเสริมทับ profile/current_profile/Media1 transport ที่สำเร็จแล้ว
    const candidate = Object.create(device);
    try {
      await media2GetProfiles(candidate);
      for (const profile of missing) {
        if (!profile.token) continue;
        const matches = candidate.profile_list.filter((p) => p.token === profile.token);
        if (matches.length !== 1) continue;
        const other = matches[0];
        const src = profile.video.source;
        const alt = other.video?.source;
        if (!alt || (src.sourceToken ? src.sourceToken !== alt.sourceToken : !src.token || src.token !== alt.token)) continue;
        const known = profile.video.encoder;
        const extra = other.video.encoder;
        if (!extra?.encoding || (known?.encoding && known.encoding !== extra.encoding)) continue;
        profile.video.encoder = {
          ...extra, ...known,
          encoding: known?.encoding || extra.encoding,
          resolution: {
            width: known?.resolution?.width > 0 ? known.resolution.width : extra.resolution?.width || 0,
            height: known?.resolution?.height > 0 ? known.resolution.height : extra.resolution?.height || 0,
          },
        };
      }
    } catch (error) {
      console.warn(`[ONVIF] ${device.oxaddr?.host}: optional Media2 encoder lookup failed — ${redactUrls(error.message)}`);
    }
  };

  OnvifDevice.prototype._mediaGetProfiles = async function () {
    const host = this.oxaddr?.host || '?';
    // จำต่อเครื่อง — ครั้งถัดไปไป Media 2 เลย ไม่เสียรอบกับคำสั่งที่รู้ว่าล้ม
    if (media2Hosts.has(host)) {
      try {
        await media2GetProfiles(this);
        return;
      } catch (e) {
        media2Hosts.delete(host);
        this.__cctvMedia2 = null;
        console.warn(`[ONVIF] ${host}: Media2 GetProfiles failed (${redactUrls(e.message)}) — back to Media1`);
      }
    }
    try {
      await media1GetProfiles.call(this);
      await supplementMedia1Encoders(this);
    } catch (err1) {
      if (!canTryMedia2(err1)) throw new Error('Failed to initialize the device: ' + err1.toString());
      console.warn(`[ONVIF] ${host}: Media1 GetProfiles failed (${redactUrls(err1.message)}) — trying Media2`);
      try {
        await media2GetProfiles(this);
      } catch (err2) {
        this.__cctvMedia2 = null;
        throw new Error(`Failed to initialize the device: ${err1.toString()} · Media2: ${err2.message}`);
      }
      media2Hosts.add(host);
      console.log(`[ONVIF] ${host}: using Media2 (${this.profile_list.length} profile(s): ${this.profile_list.map((p) => `${p.token}/${p.video.encoder?.encoding || '?'}`).join(', ')})`);
    }
  };

  /** device ที่ได้ profile จาก Media 2 ต้องขอ RTSP/snapshot URI จาก Media 2 ด้วย — token ของ Media 2 อาจไม่มีใน Media 1 */
  const origGetStreamUri = OnvifDevice.prototype._mediaGetStreamURI;
  OnvifDevice.prototype._mediaGetStreamURI = async function () {
    if (!this.__cctvMedia2) return origGetStreamUri.call(this);
    for (const profile of this.profile_list) {
      const token = escapeXml(profile.token);
      try {
        const res = await media2Request(this, 'GetStreamUri',
          `<tr2:GetStreamUri><tr2:Protocol>RTSP</tr2:Protocol><tr2:ProfileToken>${token}</tr2:ProfileToken></tr2:GetStreamUri>`);
        const uri = res?.data?.GetStreamUriResponse?.Uri;
        if (uri) profile.stream.rtsp = this._getUri(uri);
      } catch (e) {
        console.warn(`[ONVIF] ${this.oxaddr?.host}: Media2 GetStreamUri ${profile.token} failed — ${redactUrls(e.message)}`);
      }
      try {
        const res = await media2Request(this, 'GetSnapshotUri',
          `<tr2:GetSnapshotUri><tr2:ProfileToken>${token}</tr2:ProfileToken></tr2:GetSnapshotUri>`);
        const uri = res?.data?.GetSnapshotUriResponse?.Uri;
        if (uri) profile.snapshot = this._getSnapshotUri(uri);
      } catch (_) {}
    }
  };

  const origGetSnapshotUri = OnvifDevice.prototype._mediaGetSnapshotUri;
  OnvifDevice.prototype._mediaGetSnapshotUri = function () {
    // Media 2 ขอ snapshot ไปพร้อม stream URI แล้ว
    if (this.__cctvMedia2) return Promise.resolve();
    return origGetSnapshotUri.call(this);
  };

  OnvifDevice.prototype.__cctvEncoderPatch = true;
  console.log('[ONVIF] patched node-onvif profile parser (safe Resolution/RateControl, Media2 fallback for H.265)');
}

module.exports = { patchNodeOnvif };
