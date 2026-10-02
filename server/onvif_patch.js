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
        path: oxaddr.pathname,
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
      return `${parsed.protocol}//${auth}${this.oxaddr.hostname}${port}${parsed.pathname}${parsed.search || ''}`;
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
  const OnvifDevice = onvif.OnvifDevice;
  if (!OnvifDevice || OnvifDevice.prototype.__cctvEncoderPatch) return;

  const orig = OnvifDevice.prototype._mediaGetProfiles;
  OnvifDevice.prototype._mediaGetProfiles = function () {
    return orig.call(this).catch((err) => {
      // If still failing, rethrow
      throw err;
    });
  };

  // Patch the encoder block by wrapping forEach path via monkey-patch of method body:
  // Replace _mediaGetProfiles entirely with safe version based on library logic.
  OnvifDevice.prototype._mediaGetProfiles = function () {
    return new Promise((resolve, reject) => {
      this.services.media.getProfiles((error, result) => {
        this.lastResponse = result;
        if (error) {
          reject(new Error('Failed to initialize the device: ' + error.toString()));
          return;
        }
        let profiles = result?.data?.GetProfilesResponse?.Profiles;
        if (!profiles) {
          reject(new Error('Failed to initialize the device: The targeted device does not any media profiles.'));
          return;
        }
        profiles = [].concat(profiles);
        this.profile_list = [];
        this.current_profile = null;

        profiles.forEach((p) => {
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

          this.profile_list.push(profile);
          if (!this.current_profile) this.current_profile = profile;
        });

        resolve();
      });
    });
  };

  OnvifDevice.prototype.__cctvEncoderPatch = true;
  console.log('[ONVIF] patched node-onvif profile parser (safe Resolution/RateControl)');
}

module.exports = { patchNodeOnvif };
