/**
 * HTTP client พร้อม Digest authentication สำหรับคุยกับ API ของหัวกล้อง
 *
 * ยกมาจากโปรเจค People Counting (`src/vendors/http-digest.js`) แบบเกือบทั้งดุ้น
 * เพราะรายละเอียดสองอย่างในนี้เรียนรู้มาจากฮาร์ดแวร์จริงและถอดออกไม่ได้:
 * `insecureHTTPParser` (กล้องตอบ 401 ด้วย bare LF คั่น header ซึ่ง undici/fetch ปฏิเสธ)
 * และการรับประกันว่า promise ถูก settle เพียงครั้งเดียวทุกเส้นทาง (เคยทำ poll loop ค้าง
 * ถาวรโดยไม่มี error ให้เห็น) — เขียนใหม่ให้สั้นกว่านี้เมื่อไรก็จะเจอบั๊กเดิมอีก
 */
const { createHash, randomBytes } = require('node:crypto');
const http = require('node:http');

const md5 = (s) => createHash('md5').update(s).digest('hex');

/** Parse a `WWW-Authenticate: Digest ...` header into a key/value map. */
function parseDigestChallenge(header) {
  const challenge = header
    .split(/,\s*(?=[A-Za-z]+=)/)
    .join(',')
    .replace(/^Digest\s+/i, '');
  const out = {};
  for (const part of challenge.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/**
 * Shared across vendors on purpose: the nonce count only has to be monotonic
 * for a given nonce, and a counter that never goes backwards satisfies that
 * whichever camera happens to be asking.
 */
let nonceCount = 0;

function buildDigestHeader(challenge, { method, uri, user, pass }) {
  const { realm, nonce, qop, opaque, algorithm } = challenge;
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);

  const fields = [
    `username="${user}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
  ];

  let response;
  if (qop) {
    const nc = String(++nonceCount).padStart(8, '0');
    const cnonce = randomBytes(8).toString('hex');
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
    fields.push(`qop=auth`, `nc=${nc}`, `cnonce="${cnonce}"`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }
  fields.push(`response="${response}"`);
  if (opaque) fields.push(`opaque="${opaque}"`);
  if (algorithm) fields.push(`algorithm=${algorithm}`);

  return `Digest ${fields.join(', ')}`;
}

/**
 * One raw HTTP request.
 *
 * We use `node:http` rather than global fetch on purpose: the camera's 401
 * response contains a bare LF between headers, which undici rejects outright
 * with HPE_INVALID_HEADER_TOKEN. `insecureHTTPParser` tolerates it.
 */
function rawRequest(cam, path, { method, body, headers, timeoutMs, maxBytes = Infinity }) {
  return new Promise((resolve, reject) => {
    /*
      Every path out of here has to settle this promise exactly once.

      It used to listen for errors on the request but not on the response, and a
      response aborted part-way through its body emits neither `end` nor an error
      the request object hears — so the promise simply stayed pending. One flaky
      moment while pulling a ~600KB frame was enough to wedge the poll loop for
      good: `nonOverlapping` kept its "still running" flag set, every later tick
      was skipped, and snapshots froze at a fixed timestamp while the cameras
      themselves were perfectly healthy. Nothing was logged, because nothing had
      thrown.
    */
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };

    const req = http.request(
      {
        host: cam.host,
        port: cam.port ?? 80,
        path,
        method,
        headers,
        insecureHTTPParser: true,
        timeout: timeoutMs,
      },
      (res) => {
        // Collected as Buffers, not a utf8 string: the snapshot endpoint returns
        // JPEG, and decoding that as text corrupts every byte above 0x7f.
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) { settle(reject, new Error('Camera response exceeds size limit')); res.destroy(); req.destroy(); }
          else chunks.push(chunk);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          settle(resolve, {
            status: res.statusCode,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            body,
            get text() {
              return body.toString('utf8');
            },
          });
        });
        res.on('error', (err) => settle(reject, err));
        res.on('aborted', () => settle(reject, new Error(`response from ${path} was cut short`)));
      },
    );

    /*
      A last-resort ceiling. `timeout` above is socket *inactivity*, which a
      trickling or half-open connection can keep resetting for ever; this bounds
      the whole exchange no matter how it misbehaves.
    */
    const deadline = setTimeout(() => {
      req.destroy();
      settle(reject, new Error(`no complete response from ${path} after ${timeoutMs * 2}ms`));
    }, timeoutMs * 2);

    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', (err) => settle(reject, err));
    // Fires on every request, successful or not. Harmless once settled, and the
    // backstop for a socket that closes with nothing useful having arrived.
    req.on('close', () => settle(reject, new Error(`connection to ${cam.host} closed early`)));

    if (body) req.write(body);
    req.end();
  });
}

/** The camera sends two WWW-Authenticate headers (Basic + Digest); pick Digest. */
function findDigestChallenge(res) {
  const values = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    if (res.rawHeaders[i].toLowerCase() === 'www-authenticate') values.push(res.rawHeaders[i + 1]);
  }
  // Some responses fold both schemes into a single header value.
  const candidates = values.flatMap((v) => v.split(/,?\s*(?=Digest\s|Basic\s)/i));
  return candidates.find((v) => /^Digest\s/i.test(v.trim()));
}

const basicHeader = (cam) =>
  `Basic ${Buffer.from(`${cam.user}:${cam.pass}`).toString('base64')}`;

/**
 * Perform an authenticated request: fire once unauthenticated, read the challenge
 * from the 401, then replay with the Authorization header.
 *
 * `basicFirst` skips the challenge round trip for endpoints already known to take
 * Basic (the ONVIF snapshot handler), falling back to the challenge if refused.
 * Returns the whole response so binary callers can reach `body`.
 */
async function authedRequest(
  cam,
  path,
  { method = 'GET', body = null, contentType = 'application/xml', timeoutMs = 8000, basicFirst = false, maxBytes = Infinity } = {},
) {
  const baseHeaders = { Connection: 'close' };
  if (body) {
    baseHeaders['Content-Type'] = contentType;
    baseHeaders['Content-Length'] = Buffer.byteLength(body);
  }
  if (basicFirst) baseHeaders.Authorization = basicHeader(cam);

  let res = await rawRequest(cam, path, { method, body, headers: baseHeaders, timeoutMs, maxBytes });

  if (res.status === 401) {
    delete baseHeaders.Authorization;
    const digestPart = findDigestChallenge(res);
    if (!digestPart) throw new Error(`Camera did not offer Digest auth for ${path}`);
    const challenge = parseDigestChallenge(digestPart.trim());
    res = await rawRequest(cam, path, {
      method,
      body,
      timeoutMs,
      maxBytes,
      headers: {
        ...baseHeaders,
        Authorization: buildDigestHeader(challenge, {
          method,
          uri: path,
          user: cam.user,
          pass: cam.pass,
        }),
      },
    });
  }

  if (res.status < 200 || res.status >= 300) {
    const sub = /<subStatusCode>([^<]*)<\/subStatusCode>/.exec(res.text)?.[1];
    throw new Error(`Camera ${method} ${path} -> HTTP ${res.status}${sub ? ` (${sub})` : ''}`);
  }
  return res;
}

/** Authenticated request whose body is XML, JSON or text. */
async function digestRequest(cam, path, opts) {
  return (await authedRequest(cam, path, opts)).text;
}

module.exports = {
  parseDigestChallenge,
  buildDigestHeader,
  rawRequest,
  findDigestChallenge,
  basicHeader,
  authedRequest,
  digestRequest,
};
