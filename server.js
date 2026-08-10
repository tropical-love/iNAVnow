// ETF 실시간 추정 iNAV — 운용사별 PDF 어댑터 구조
// iNAV = NAV기준가 × (1 + Σ 비중i × (주수i×현재가i×환율i / PDF평가금액i − 1))
// PDF 평가금액이 기준시점 가격×환율을 내포하므로 환율 기준값을 따로 알 필요가 없다.
//
// ---------- 플랫폼 shim ----------
// 이 파일은 세 환경에서 그대로 돈다: ① 로컬 Node ② 공개 서버(auth.js가 감쌈) ③ 안드로이드 WebView.
// 환경마다 다른 건 셋뿐이다 — (a) 외부 통신 (b) 영속화 (c) HTTP 표면. 계산 로직 2천 줄은 공유한다.
// 안드로이드에서는 브라우저가 CORS로 외부 도메인을 막으므로 네이티브(OkHttp)가 대신 받아 준다.
// 엔진을 <script src>로 싣기 전에 window.__net(url, opts) → Promise<Response>를 넣어 두면 된다.
const NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
const http = NODE ? require('http') : null;
const https = NODE ? require('https') : null;
const zlib = NODE ? require('zlib') : null;

// 응답 압축 — GCP 무료 티어 월 1GB 아웃바운드 제한이 있어 JSON/HTML을 그냥 보내면 낭비가 크다
function send(req, res, body, type) {
  const buf = Buffer.from(body);
  const h = { 'Content-Type': type };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    return zlib.gzip(buf, (err, gz) => {
      if (err) { res.writeHead(200, h); return res.end(buf); }
      res.writeHead(200, { ...h, 'Content-Encoding': 'gzip' });
      res.end(gz);
    });
  }
  res.writeHead(200, h);
  res.end(buf);
}
const JSON_T = 'application/json; charset=utf-8';
const HTML_T = 'text/html; charset=utf-8';

// 파비콘 — 외부 파일 없이 서버 하나로 배포하려고 SVG를 인라인으로 둔다(작은 크기에서도 보이게 단순화).
// 색은 런처 아이콘과 같은 팔레트: 테두리·막대는 녹색 계열, 화살표는 진한 녹색.
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#3fbf8a"/><stop offset="1" stop-color="#006030"/></linearGradient></defs>
<circle cx="32" cy="32" r="29" fill="#fff" stroke="url(#g)" stroke-width="5"/>
<rect x="15" y="39" width="9" height="12" rx="2" fill="#8fd0b6"/>
<rect x="27.5" y="31" width="9" height="20" rx="2" fill="#3fae83"/>
<rect x="40" y="23" width="9" height="28" rx="2" fill="#00693c"/>
<path d="M14 35 L25 25 L33 31 L49 15" stroke="#1f9d4d" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M41 15 L49 15 L49 23" stroke="#1f9d4d" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// kiwoometf.com은 중간 인증서가 누락된 체인을 보낸다(UNABLE_TO_VERIFY_LEAF_SIGNATURE) — 잎은 Sectigo OV
// 정품인데 서버가 중간만 안 보내는 것(잎의 AIA 필드로 확인). 검증을 끄면 아무 인증서나 통과하므로,
// 누락된 중간 인증서를 여기 내장해 ca로 보태고 **정상 체인 검증을 켠 채** 호출한다.
// 출처: 잎 인증서 AIA의 http://crt.sectigo.com/SectigoRSAOrganizationValidationSecureServerCA.crt (2030-12-31까지 유효)
const SECTIGO_OV_CA = `-----BEGIN CERTIFICATE-----
MIIGGTCCBAGgAwIBAgIQE31TnKp8MamkM3AZaIR6jTANBgkqhkiG9w0BAQwFADCB
iDELMAkGA1UEBhMCVVMxEzARBgNVBAgTCk5ldyBKZXJzZXkxFDASBgNVBAcTC0pl
cnNleSBDaXR5MR4wHAYDVQQKExVUaGUgVVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNV
BAMTJVVTRVJUcnVzdCBSU0EgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkwHhcNMTgx
MTAyMDAwMDAwWhcNMzAxMjMxMjM1OTU5WjCBlTELMAkGA1UEBhMCR0IxGzAZBgNV
BAgTEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4GA1UEBxMHU2FsZm9yZDEYMBYGA1UE
ChMPU2VjdGlnbyBMaW1pdGVkMT0wOwYDVQQDEzRTZWN0aWdvIFJTQSBPcmdhbml6
YXRpb24gVmFsaWRhdGlvbiBTZWN1cmUgU2VydmVyIENBMIIBIjANBgkqhkiG9w0B
AQEFAAOCAQ8AMIIBCgKCAQEAnJMCRkVKUkiS/FeN+S3qU76zLNXYqKXsW2kDwB0Q
9lkz3v4HSKjojHpnSvH1jcM3ZtAykffEnQRgxLVK4oOLp64m1F06XvjRFnG7ir1x
on3IzqJgJLBSoDpFUd54k2xiYPHkVpy3O/c8Vdjf1XoxfDV/ElFw4Sy+BKzL+k/h
fGVqwECn2XylY4QZ4ffK76q06Fha2ZnjJt+OErK43DOyNtoUHZZYQkBuCyKFHFEi
rsTIBkVtkuZntxkj5Ng2a4XQf8dS48+wdQHgibSov4o2TqPgbOuEQc6lL0giE5dQ
YkUeCaXMn2xXcEAG2yDoG9bzk4unMp63RBUJ16/9fAEc2wIDAQABo4IBbjCCAWow
HwYDVR0jBBgwFoAUU3m/WqorSs9UgOHYm8Cd8rIDZsswHQYDVR0OBBYEFBfZ1iUn
Z/kxwklD2TA2RIxsqU/rMA4GA1UdDwEB/wQEAwIBhjASBgNVHRMBAf8ECDAGAQH/
AgEAMB0GA1UdJQQWMBQGCCsGAQUFBwMBBggrBgEFBQcDAjAbBgNVHSAEFDASMAYG
BFUdIAAwCAYGZ4EMAQICMFAGA1UdHwRJMEcwRaBDoEGGP2h0dHA6Ly9jcmwudXNl
cnRydXN0LmNvbS9VU0VSVHJ1c3RSU0FDZXJ0aWZpY2F0aW9uQXV0aG9yaXR5LmNy
bDB2BggrBgEFBQcBAQRqMGgwPwYIKwYBBQUHMAKGM2h0dHA6Ly9jcnQudXNlcnRy
dXN0LmNvbS9VU0VSVHJ1c3RSU0FBZGRUcnVzdENBLmNydDAlBggrBgEFBQcwAYYZ
aHR0cDovL29jc3AudXNlcnRydXN0LmNvbTANBgkqhkiG9w0BAQwFAAOCAgEAThNA
lsnD5m5bwOO69Bfhrgkfyb/LDCUW8nNTs3Yat6tIBtbNAHwgRUNFbBZaGxNh10m6
pAKkrOjOzi3JKnSj3N6uq9BoNviRrzwB93fVC8+Xq+uH5xWo+jBaYXEgscBDxLmP
bYox6xU2JPti1Qucj+lmveZhUZeTth2HvbC1bP6mESkGYTQxMD0gJ3NR0N6Fg9N3
OSBGltqnxloWJ4Wyz04PToxcvr44APhL+XJ71PJ616IphdAEutNCLFGIUi7RPSRn
R+xVzBv0yjTqJsHe3cQhifa6ezIejpZehEU4z4CqN2mLYBd0FUiRnG3wTqN3yhsc
SPr5z0noX0+FCuKPkBurcEya67emP7SsXaRfz+bYipaQ908mgWB2XQ8kd5GzKjGf
FlqyXYwcKapInI5v03hAcNt37N3j0VcFcC3mSZiIBYRiBXBWdoY5TtMibx3+bfEO
s2LEPMvAhblhHrrhFYBZlAyuBbuMf1a+HNJav5fyakywxnB2sJCNwQs2uRHY1ihc
6k/+JLcYCpsM0MF8XPtpvcyiTcaQvKZN8rG61ppnW5YCUtCC+cQKXA0o4D/I+pWV
idWkvklsQLI+qGu41SWyxP7x09fn1txDAXYw+zuLXfdKiXyaNb78yvBXAfCNP6CH
MntHWpdLgtJmwsQt6j8k9Kf5qLnjatkYYaA7jBU=
-----END CERTIFICATE-----
`;
const KIWOOM_CA = NODE ? [...require('tls').rootCertificates, SECTIGO_OV_CA] : null;
async function kiwoomPostJson(url, body) {
  if (!NODE) {
    // 안드로이드: 요청별 CA를 브라우저에서 지정할 수 없다 → extraCa로 표시해 네이티브가 붙여 준다.
    // 브리지가 이 옵션을 모르면(구버전) 검증이 실패하고, 이 어댑터만 폴백 체인으로 넘어간다.
    const res = await fetchOrThrow(url, {
      method: 'POST', extraCa: 'sectigo-ov', body,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!res.ok) throw new Error(`${res.status} POST ${url}`);
    return res.json();
  }
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', ca: KIWOOM_CA,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let t = '';
      res.on('data', c => t += c);
      res.on('end', () => { try { resolve(JSON.parse(t)); } catch (e) { reject(new Error(`JSON 파싱 실패: ${url}`)); } });
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error(`타임아웃 ${url}`)));
    req.on('error', reject);
    req.end(body);
  });
}

const DEFAULT_CODE = '457480';
const PORT = NODE ? (process.env.PORT || 3456) : null;
// 비밀번호가 없으므로 127.0.0.1에만 연다 — 안 그러면 같은 사내망·공유기의 아무나 들어온다.
// 같은 와이파이의 폰에서 보려면 HOST=0.0.0.0 으로 띄울 것(그 네트워크에 공개된다는 뜻).
// (공개 서버 배포는 이 파일이 아니라 인증 래퍼 auth.js로 띄운다 — GitHub 배포판에는 없는 파일)
const HOST = NODE ? (process.env.HOST || '127.0.0.1') : null;
// 외부 호출 계측 (무료 티어 부하 확인용) — /api/stats 로 조회
const stats = { calls: 0, byHost: {}, since: new Date().toISOString(), reqs: 0, bytesOut: 0 };

// 네트워크 실패도 URL을 담아 던진다 — 'fetch failed'만 보면 어느 소스가 죽었는지 알 수 없다
// 타임아웃이 없으면 응답을 물고 있는 소스 하나가 요청 전체를 무한정 붙잡는다(브라우저는 계속 로딩).
const FETCH_TIMEOUT_MS = 8000;
// 실제로 밖으로 나가는 유일한 통로. 안드로이드에서는 브라우저 fetch가 CORS로 막히므로
// 네이티브가 넣어 준 window.__net을 쓴다(같은 (url, opts) → Promise<Response> 규약).
const rawFetch = NODE
  ? (url, opts) => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...opts })
  : (url, opts) => globalThis.__net(url, { timeout: FETCH_TIMEOUT_MS, ...opts });
async function fetchOrThrow(url, opts) {
  stats.calls++;
  const host = (url.match(/^https?:\/\/([^/]+)/) || [, '?'])[1];
  stats.byHost[host] = (stats.byHost[host] || 0) + 1;
  try {
    return await rawFetch(url, opts);
  } catch (e) {
    throw new Error(`${e.cause?.code || e.message} ${url}`);
  }
}

async function getJson(url) {
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  if (url.includes('papi.aceetf.co.kr')) headers.Origin = 'https://www.aceetf.co.kr';
  const res = await fetchOrThrow(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function postJson(url, body, type = 'application/x-www-form-urlencoded') {
  const res = await fetchOrThrow(url, {
    method: 'POST',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': type },
    body,
  });
  if (!res.ok) throw new Error(`${res.status} POST ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetchOrThrow(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function postText(url, body) {
  const res = await fetchOrThrow(url, {
    method: 'POST',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`${res.status} POST ${url}`);
  return res.text();
}

function parseTrRows(html) { // <tr>의 <td> 텍스트 배열로 (TIGER·RISE 공용)
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m =>
    [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(t => t[1].replace(/<[^>]*>/g, '').trim()));
}

function krIsin(code) { // 6자리 종목코드 → KR ISIN (표준 체크디지트)
  const base = 'KR7' + code + '00';
  const digits = base.split('').map(c => /\d/.test(c) ? c : String(c.charCodeAt(0) - 55)).join('');
  let sum = 0, dbl = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = +digits[i];
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return base + ((10 - (sum % 10)) % 10);
}

function todayYmd(sep = '') {
  const kst = new Date(Date.now() + 9 * 3600e3);
  return [kst.getUTCFullYear(), String(kst.getUTCMonth() + 1).padStart(2, '0'), String(kst.getUTCDate()).padStart(2, '0')].join(sep);
}

// ---------- 캐시 (목록·매핑류는 영속화 — 재시작 시 운용사 사이트 429 방지) ----------
// Node는 cache.json, 안드로이드는 localStorage. 담는 내용과 키 규칙은 같다.
const fs = NODE ? require('fs') : null;
const CACHE_FILE = NODE ? __dirname + '/cache.json' : null;
const CACHE_LS = 'engineCache';
const cache = new Map(); // key -> {ts, ttl, data}
// fxfix·navfix(기준환율 역산값)도 보존 — 재시작하면 표본이 사라져 아침마다 보정이 풀리던 문제
// pdfset(전일 PDF 구성)도 보존 — 재시작하면 비교 대상이 사라져 리밸런싱을 못 잡는다
// ⚠ 선언이 아래 로드 코드보다 뒤에 있으면 TDZ ReferenceError가 catch에 삼켜져 캐시가 통째로
// 로드되지 않는다(실측 2026-08-10: 디스크에 39개가 있는데 메모리는 0개 — 앱이 켤 때마다 PDF를
// 다시 받던 원인). 반드시 로드보다 위에 둔다.
const PERSIST_RE = /(:list$|^acefunds$|^etflist$|^krbiz$|^pdf:|^blk:|^isin:|^tosscode:|^rise:id:|^plus:id:|^fxfix:|^navfix:|^provnav:|^fxclose:|^pdfset:)/;
const PERSIST = k => PERSIST_RE.test(k);
try {
  const raw = NODE ? fs.readFileSync(CACHE_FILE, 'utf8') : localStorage.getItem(CACHE_LS);
  // 만료된 단기 캐시는 싣지 않는다 — 안 그러면 저장분이 계속 자라 용량 한계에 부딪힌다
  if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) {
    if (PERSIST_RE.test(k) || Date.now() - v.ts < v.ttl) cache.set(k, v);
  }
} catch (e) { console.error('캐시 로드 실패:', e.message); } // 조용히 삼키면 위와 같은 버그를 못 본다
// 숨김 작업(세션 0)으로 돌면 콘솔이 없어 오류를 확인할 방법이 아예 없다 — 파일에도 남긴다.
// 출력은 시작 로그와 오류뿐이라 거의 안 자라지만, 시작할 때 1MB를 넘으면 비운다.
// isTTY로 숨김 실행만 골라내려 했지만 세션 0에서도 참으로 나와 로그가 안 남았다 — 그냥 항상 남긴다.
if (NODE && require.main === module) { // test.js가 require할 때만 제외
  const LOG = __dirname + '/server.log';
  try { if (fs.statSync(LOG).size > 1e6) fs.truncateSync(LOG, 0); } catch (e) {}
  for (const k of ['log', 'error']) {
    const orig = console[k].bind(console);
    // 파일에 먼저 쓴다 — 세션 0에서는 stdout이 없어 orig()이 던질 수 있고, 그러면 로그가 남지 않는다
    console[k] = (...a) => {
      try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${a.join(' ')}\n`); } catch (e) {}
      try { orig(...a); } catch (e) {}
    };
  }
}

let saveTimer = null;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const disk = {};
    // 안드로이드는 페이지를 새로 로드할 때마다 메모리 캐시가 사라진다(홈↔종목 이동이 전부 새 문서).
    // 그래서 시세·환율 같은 짧은 TTL까지 담는다 — 만료분은 읽을 때 어차피 걸러진다.
    for (const [k, v] of cache) if (!NODE || PERSIST(k)) disk[k] = v;
    const json = JSON.stringify(disk);
    if (!NODE) {
      try { localStorage.setItem(CACHE_LS, json); }
      catch (e) { // 용량 초과(보통 5MB) — 오래 쓰는 것만 남기고 다시 시도
        const slim = {};
        for (const [k, v] of cache) if (PERSIST(k)) slim[k] = v;
        try { localStorage.setItem(CACHE_LS, JSON.stringify(slim)); }
        catch (e2) { console.error('캐시 저장 실패:', e2.message); }
      }
      return;
    }
    // 임시 파일에 쓰고 rename — 쓰는 중에 죽으면 반쪽 JSON이 남아 캐시가 통째로 날아간다
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFile(tmp, json, e => {
      if (e) return console.error('캐시 저장 실패:', e.message);
      fs.rename(tmp, CACHE_FILE, e2 => e2 && console.error('캐시 rename 실패:', e2.message));
    });
  }, 1000);
}
// 진행 중인 호출을 합친다 — 없으면 동시 요청마다 같은 외부 API를 새로 때린다
// (실측: 같은 ETF 단일 요청 57회 → 동시 5요청 239회. 야후·운용사 차단 유발)
const inflight = new Map();
function cached(key, ttl, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.ts < c.ttl) return Promise.resolve(c.data);
  const hit = inflight.get(key);
  if (hit) return hit;
  const p = (async () => {
    const data = await fn();
    cache.set(key, { ts: Date.now(), ttl, data });
    if (PERSIST(key) || !NODE) saveCache(); // 안드로이드는 단기 캐시도 남긴다(1초 디바운스)
    return data;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- 전체 ETF 목록 (네이버, 전 운용사) — 검색·합성형 기초 ETF 매칭 공용 ----------
async function etfList() {
  return cached('etflist', 86400e3, async () => {
    const res = await fetchOrThrow('https://finance.naver.com/api/sise/etfItemList.nhn', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`${res.status} etfItemList`);
    const d = JSON.parse(new TextDecoder('euc-kr').decode(await res.arrayBuffer()));
    return (d.result?.etfItemList || []).map(x => ({ code: x.itemcode, name: x.itemname }));
  });
}

// 브랜드 접두어를 뗀 같은 상품의 타 운용사 ETF (운용사 사이트가 막혔을 때의 폴백)
// 같은 기초지수를 추종하므로 바스켓 수익률이 동일 — 예: KODEX 200(차단) → TIGER 200
const BRAND = /^(KODEX|TIGER|ACE|SOL|PLUS|RISE|KIWOOM|1Q|KBSTAR|ARIRANG|HANARO|KOSEF|TIMEFOLIO|히어로즈|파워|마이다스)\s*/i;
async function findSiblingCode(nm, selfCode) {
  const key = s => s.replace(BRAND, '').replace(/\s+/g, '').toUpperCase();
  const k = key(nm || '');
  if (!k || !BRAND.test(nm)) return null;
  const f = (await etfList()).find(x => x.code !== selfCode && BRAND.test(x.name) && key(x.name) === k);
  return f ? f.code : null;
}

// PDF는 하루 한 번 갱신되는 자료다. 10분으로 두면 5분 주기 포트폴리오 계산에서 두 번째마다 다시 받고,
// 운용사 사이트가 느려 그때마다 홈이 2.5초 → 13초로 늘어난다(실측 2026-08-06).
const PDF_TTL = 60 * 60e3;
const getAnalysis = code => cached(`an:${code}`, 30 * 60e3,
  () => getJson(`https://m.stock.naver.com/api/stock/${code}/etfAnalysis`));

// 기초지수 이름에서 배수·표기 차이를 걷어내 비교용 열쇠로 만든다
// 예) 'PHLX Semiconductor 2.0x Daily Leveraged Index' → 'phlxsemiconductor'
const idxKey = s => (s || '').toLowerCase()
  .replace(/\b(2\.?0?x|1x|2x|daily|leverages?|leveraged|inverse|short|long|index|er|tr|pr|excess|return|레버리지|인버스)\b/g, '')
  .replace(/[^a-z0-9가-힣]/g, '');

// 합성 레버리지·인버스 → 기초 ETF 자동 매칭 (이름에서 레버리지/인버스/(합성)/(H) 제거 후 전체 목록 검색)
async function findBaseCode(nm, selfCode, selfIndex) {
  const norm = s => s.replace(/\s+/g, '');
  const baseNm = nm.replace(/\(합성\s*H?\)|\(H\)/g, '').replace(/레버리지|인버스\s?2X|인버스/g, '').replace(/\s+/g, ' ').trim();
  const list = await etfList();
  const exact = list.find(x => x.code !== selfCode && norm(x.name) === norm(baseNm));
  if (exact) return exact.code;
  // 이름이 정확히 안 맞는 경우(예: '…필라델피아반도체레버리지(합성)' vs '…필라델피아반도체나스닥')
  // 접두 일치로 넓히되, 후보가 유일하고 기초지수까지 같을 때만 받는다.
  // 이름만 믿으면 'TIGER 유로스탁스레버리지(합성 H)' → 'TIGER 유로스탁스배당30'처럼 엉뚱한 걸 잡는다(실측).
  const cands = list.filter(x => x.code !== selfCode
    && norm(x.name).startsWith(norm(baseNm)) && !/레버리지|인버스|합성/.test(x.name));
  if (cands.length !== 1 || !selfIndex) return null;
  const a = idxKey(selfIndex);
  const b = idxKey((await getAnalysis(cands[0].code).catch(() => ({}))).etfBaseIndex);
  if (!a || !b || !(a.includes(b) || b.includes(a))) return null;
  return cands[0].code;
}

// ---------- ACE PDF ----------
async function aceFundList() {
  return cached('acefunds', 86400e3, async () => {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const d = await getJson(`https://papi.aceetf.co.kr/api/funds?page=${page}&size=100`);
      out.push(...d.data);
      if (page >= (d.page.totalPages || 1)) break;
    }
    return out;
  });
}

async function fundCdOf(stockCode) {
  const list = await aceFundList();
  const f = list.find(f => (f.stockCd || '').slice(3, 9) === stockCode);
  if (!f) throw new Error(`ACE ETF 목록에 ${stockCode} 없음`);
  return f;
}

// ---------- 운용사 어댑터 ----------
// pdf(stockCode) → { list: [{jm, name, qty, valAm, wg}], stdDt, fundNm }
// findBase(fundNm) → 합성 레버리지·인버스의 기초 ETF 종목코드 (선택 구현)
const ADAPTERS = {
  ace: {
    async pdf(stockCode) {
      const fund = await fundCdOf(stockCode);
      const pdf = await cached(`pdf:ace:${fund.fundCd}`, PDF_TTL, () =>
        getJson(`https://papi.aceetf.co.kr/api/funds/${fund.fundCd}/pdf?page=1&size=100`));
      return {
        fundNm: fund.fundNm, stdDt: pdf.std_DT,
        list: pdf.pdfList.map(r => ({
          jm: r.jm_KSC_CD, name: r.sec_NM,
          qty: parseFloat(String(r.cu_ITEM_CNT).replace(/,/g, '')), valAm: r.val_AM, wg: r.wg,
        })),
      };
    },
  },

  kodex: { // 삼성자산운용 (samsungfund.com)
    async pdf(stockCode) {
      const list = await cached('kodex:list', 86400e3, async () => {
        const out = [];
        for (let p = 1; p <= 20; p++) {
          const d = await getJson(`https://www.samsungfund.com/api/v1/kodex/product.do?ordrColm=NAV&ordrSort=DESC&pageNo=${p}&srchTerm=w`);
          const arr = Array.isArray(d) ? d : d.list || [];
          out.push(...arr);
          if (arr.length < 20) break;
          await new Promise(r => setTimeout(r, 400)); // 삼성펀드 요청 제한(429) 회피
        }
        return out;
      });
      const f = list.find(x => x.stkTicker === stockCode);
      if (!f) throw new Error(`KODEX 목록에 ${stockCode} 없음`);
      const d = await cached(`pdf:kodex:${f.fId}`, PDF_TTL, () =>
        getJson(`https://www.samsungfund.com/api/v1/kodex/product-pdf/${f.fId}.do?gijunYMD=${todayYmd('.')}`));
      return {
        fundNm: f.fNm, stdDt: d.pdf.gijunYMD,
        list: d.pdf.list
          .filter(r => !/^(CASH|KRD)/.test(r.itmNo || '') && r.ratio != null)
          .map(r => ({
            jm: (r.itmNo || '').replace(/ Equity$/i, ''), name: r.secNm,
            qty: parseFloat(String(r.applyQ).replace(/,/g, '')),
            valAm: parseFloat(String(r.evalA).replace(/,/g, '')),
            wg: parseFloat(r.ratio),
          })),
      };
    },
  },

  sol: { // 신한자산운용 (soletf.com)
    async pdf(stockCode) {
      const list = await cached('sol:list', 86400e3, async () => {
        const out = [];
        for (let p = 1; p <= 10; p++) {
          const d = await getJson(`https://www.soletf.com/api/etf/pds?page=${p}`);
          const arr = d.items || [];
          out.push(...arr);
          if (arr.length < 20) break;
        }
        return out;
      });
      const f = list.find(x => x.ETF_CD6 === stockCode);
      if (!f) throw new Error(`SOL 목록에 ${stockCode} 없음`);
      const d = await cached(`pdf:sol:${f.FUND_CD}`, PDF_TTL, () =>
        getJson(`https://www.soletf.com/api/etf/pds/pdf/${f.FUND_CD}`));
      return {
        fundNm: d.fundName || f.ETF_NAME, stdDt: d.workDt,
        list: (d.items || [])
          .filter(r => !/^CASH/.test(r.STOCK_CODE || ''))
          .map(r => ({
            jm: (r.STOCK_CODE || '').trim(), name: (r.SEC_NM || '').trim(),
            qty: parseFloat(r.QTY), valAm: parseFloat(r.PRICE),
            wg: parseFloat(String(r.WT_DISP).replace(/[%\s]/g, '')) || 0,
          })),
      };
    },
  },

  kiwoom: { // 키움투자자산운용 (kiwoometf.com) — 전 종목 ISIN
    async pdf(stockCode) {
      const list = await cached('kiwoom:list', 86400e3, () =>
        kiwoomPostJson('https://www.kiwoometf.com/service/main/productListAjax', ''));
      const f = (list.products || []).find(x => x.gcode === stockCode);
      const d = await cached(`pdf:kiwoom:${stockCode}`, PDF_TTL, () =>
        kiwoomPostJson('https://www.kiwoometf.com/service/etf/KO02010200MAjax4', `schGubun1=${stockCode}&startDate=${todayYmd()}`));
      if (!d.pdfList || !d.pdfList.length) throw new Error(`KIWOOM PDF 없음 (${stockCode})`);
      return {
        fundNm: f?.goodsNm || '', stdDt: d.pdfList[0]?.businessDate,
        list: d.pdfList
          .filter(r => !/^(CASH|KRD)/.test(r.itemCode || ''))
          .map(r => ({
            jm: r.itemCode, name: r.itemTitle,
            qty: parseFloat(String(r.volume).replace(/,/g, '')),
            valAm: parseFloat(String(r.assessment).replace(/,/g, '')),
            wg: parseFloat(String(r.ratio).replace(/[%,]/g, '')) || 0,
          })),
      };
    },
  },

  tiger: { // 미래에셋자산운용 (investments.miraeasset.com) — HTML 조각 응답, 내부ID=국내 ISIN
    async pdf(stockCode) {
      const ksd = krIsin(stockCode);
      const html = await cached(`pdf:tiger:${ksd}`, PDF_TTL, () =>
        getText(`https://investments.miraeasset.com/tigeretf/ko/product/search/detail/pdfListAjax.ajax?ksdFund=${ksd}&listCnt=9999`));
      const list = parseTrRows(html)
        .filter(r => r.length >= 5 && r[0] && !/^(KRD|CASH)/.test(r[0]))
        .map(r => ({
          jm: r[0].replace(/ EQUITY$/i, ''), name: r[1],
          qty: parseFloat(r[2].replace(/,/g, '')), valAm: parseFloat(r[3].replace(/,/g, '')),
          wg: parseFloat(r[4]) || 0,
        }));
      if (!list.length) throw new Error(`TIGER PDF 응답 없음/파싱 실패 (${stockCode})`);
      return { fundNm: '', stdDt: todayYmd('-'), list };
    },
  },

  rise: { // KB자산운용 (riseetf.co.kr) — HTML 조각 응답, 전 종목 ISIN
    async pdf(stockCode) {
      const fundCd = await cached(`rise:id:${stockCode}`, 86400e3, async () => {
        const html = await postText('https://www.riseetf.co.kr/prod/finder/listJquery',
          `searchText=${stockCode}&searchFieldType=list&page=1`);
        const m = html.match(new RegExp(`finderDetail/([0-9A-Z]+)[\\s\\S]{0,500}?\\(${stockCode}\\)`))
          || html.match(/finderDetail\/([0-9A-Z]+)/);
        return m ? m[1] : null;
      });
      if (!fundCd) throw new Error(`RISE 목록에 ${stockCode} 없음`);
      const html = await cached(`pdf:rise:${fundCd}`, PDF_TTL, () =>
        postText('https://www.riseetf.co.kr/prod/finder/productViewSearchTabJquery3', `fundCd=${fundCd}&searchDate=`));
      const list = parseTrRows(html)
        .filter(r => r.length >= 5 && r[1] && !/^(CASH|KRD)/.test(r[1]))
        .map(r => ({
          jm: r[1], name: r[0],
          qty: parseFloat(r[2].replace(/,/g, '')),
          wg: parseFloat(r[3].replace(/,/g, '')) || 0,
          valAm: parseFloat(r[4].replace(/,/g, '')),
        }));
      if (!list.length) throw new Error(`RISE PDF 응답 없음/파싱 실패 (${stockCode})`);
      return { fundNm: '', stdDt: todayYmd('-'), list };
    },
  },

  oneq: { // 하나자산운용 (1qetf.com) — 코스콤 F-필드 포맷, etf_code=단축코드 직통
    async pdf(stockCode) {
      const d = await cached(`pdf:1q:${stockCode}`, PDF_TTL, () =>
        postJson('https://www.1qetf.com/pages/ETFproducts/ajax/process.php', `mode=get.pdf&etf_code=${stockCode}`));
      if (!d.success || !d.results || !d.results.length) throw new Error(`1Q PDF 없음 (${stockCode})`);
      return {
        fundNm: '', stdDt: d.results[0]?.F12506,
        list: d.results
          // 채권·현금은 수량 0 → 제외(정적 자산 취급). 9999는 설정현금액 센티널.
          .filter(r => r.F34743 !== '9999' && !/^(CASH|KRD)/.test(r.F16316 || '') && parseFloat(r.F16499) > 0)
          .map(r => ({
            jm: (r.F16316 || '').trim(), name: r.F16004,
            qty: parseFloat(r.F16499), valAm: parseFloat(r.F16588),
            wg: parseInt(r.F34743, 10) / 100,
          })),
      };
    },
  },

  plus: { // 한화자산운용 (plusetf.co.kr) — 평가금액 미제공(전일종가로 근사)
    async pdf(stockCode) {
      const found = await cached(`plus:id:${stockCode}`, 86400e3, async () => {
        const d = await postJson('https://www.plusetf.co.kr/api/v1/product/find/list',
          JSON.stringify({ searchWord: stockCode, page: 0 }), 'application/json');
        return (d.content || []).find(x => x.nameCode === stockCode) || null;
      });
      if (!found) throw new Error(`PLUS 목록에 ${stockCode} 없음`);
      const d = await cached(`pdf:plus:${found.id}`, PDF_TTL, () =>
        getJson(`https://www.plusetf.co.kr/api/v1/product/pdf/list?n=${found.id}&page=0&d=${todayYmd()}&pageSize=1000`));
      return {
        fundNm: found.displayName, stdDt: d.content?.[0]?.wkdate,
        list: (d.content || [])
          .filter(r => !/^(KRD|CASH)/.test(r.krJmCd || ''))
          .map(r => ({ jm: r.jmCd || r.krJmCd, name: r.jmNm, qty: r.amount, valAm: null, wg: r.ratio })),
      };
    },
  },
};

// FunETF(한국포스증권) — 전 운용사 전체 PDF를 ISIN 하나로 조회. 운용사 사이트가 막혔을 때의 주력 대체 소스.
// 페이지에서 _csrf 토큰과 기준일을 뽑아 같은 세션 쿠키로 API를 호출해야 한다(토큰 없이 부르면 빈 배열).
async function funetfPdf(stockCode) {
  const isin = krIsin(stockCode);
  return cached(`pdf:funetf:${isin}`, PDF_TTL, async () => {
    const pageUrl = `https://www.funetf.co.kr/product/etf/view/${isin}`;
    const res = await fetchOrThrow(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`${res.status} funetf page`);
    // 브라우저(안드로이드)에서 new Response(...,{headers})는 Set-Cookie를 통째로 버린다(실측:
    // 헤더 목록에 안 남고 getSetCookie()도 빈 배열). 그래서 네이티브 브리지가 res.__setCookie에
    // 따로 담아 준다 — 없으면 이 어댑터가 csrf 토큰을 못 찾아 조용히 폴백으로 밀린다.
    const setCookie = res.__setCookie
      || (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || '']);
    const cookie = setCookie.filter(Boolean).map(c => c.split(';')[0]).join('; ');
    const html = await res.text();
    const pick = n => (html.match(new RegExp(`name="${n}"[^>]*value="([^"]*)"`)) || [])[1] || '';
    const csrf = pick('_csrf');
    const ymd = pick('kodexPdfYmd') || pick('gijunYmd');
    if (!csrf) throw new Error('funetf: csrf 토큰 없음');
    const api = `https://www.funetf.co.kr/api/public/product/view/etfpdf?itemId=${isin}`
      + `&etfPdfYmd=${ymd}&kodexPdfYmd=${ymd}&_csrf=${csrf}&roleGroupType=ANONYMOUS&roleType=ROLE_ANONYMOUS`;
    const r2 = await fetchOrThrow(api, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: pageUrl, Cookie: cookie } });
    if (!r2.ok) throw new Error(`${r2.status} funetf pdf`);
    const arr = await r2.json();
    // ticker 없는 행(채권 등)은 시세 추적 불가라 제외 → 남는 게 없으면 다음 폴백으로
    const list = (arr || []).filter(r => (r.ticker || '').trim()).map(r => ({
      jm: r.ticker.trim(), name: r.citmNm, qty: r.icuStkc, valAm: r.evAmt, wg: r.evP,
    }));
    if (!list.length) throw new Error('funetf: 추적 가능한 구성종목 없음(채권·합성형)');
    return { fundNm: '', stdDt: ymd, list };
  });
}

// 최후 폴백: 네이버 상위10 구성종목 (전 운용사 공통, 차단 없음)
// 국내주식형은 종목코드·수량·비중이 모두 있어 계산 가능. 해외형은 종목코드가 비어 있고
// 채권형은 수량까지 '-'라 불가 → 그 경우 throw 하고 공식 iNAV 표시로 넘어간다.
async function naverTop10Pdf(stockCode, analysis) {
  const top = analysis.etfTop10MajorConstituentAssets || [];
  const list = top
    .filter(r => /^\d{6}$/.test(r.itemCode || '') && String(r.stockCount) !== '-')
    .map(r => ({
      jm: r.itemCode, name: r.itemName,
      qty: num(r.stockCount), valAm: null,
      wg: parseFloat(String(r.etfWeight).replace(/[%,]/g, '')) || 0,
    }))
    .filter(r => r.qty > 0 && r.wg > 0);
  if (!list.length) throw new Error('네이버 상위10으로도 추적 불가(해외형·채권형)');
  return { fundNm: '', stdDt: analysis.navPerformanceReferenceDate || '-', list, partial: true };
}

// 운용사 사이트가 막혀 있으면(이 PC 한국 IP에서 KODEX가 Cloudflare에 걸린다) 매 조회마다 실패를
// 되풀이해 호출과 대기 시간만 쓴다. 차단성 실패는 그날 하루 기억하고 곧바로 폴백으로 간다.
// 일시적 네트워크 오류(타임아웃 등)는 10분만 쉬어, 잠깐 끊긴 것을 하루치로 오판하지 않는다.
const issuerBlocked = key => {
  const r = cache.get(`blk:${key}`);
  return !!(r && Date.now() - r.ts < r.ttl);
};
function noteIssuerFail(key, err) {
  if (!key) return;
  const m = String(err && err.message || '');
  // 잠깐 끊긴 것(타임아웃·연결 리셋·DNS)만 10분 쉬고, 그 밖의 실패는 하루 쉰다.
  // 차단은 403·429뿐 아니라 빈 응답·형식 변경 등 여러 모습으로 오기 때문에 이쪽을 기본으로 둔다.
  const soft = /타임아웃|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|aborted/i.test(m);
  cache.set(`blk:${key}`, { ts: Date.now(), ttl: soft ? 600e3 : 24 * 3600e3, data: m.slice(0, 120) });
  saveCache();
}

function adapterOf(issuerName) {
  const k = issuerName || '';
  if (/한국투신|한국투자/.test(k)) return ['ace', ADAPTERS.ace];
  if (/삼성/.test(k)) return ['kodex', ADAPTERS.kodex];
  if (/미래에셋/.test(k)) return ['tiger', ADAPTERS.tiger];
  if (/신한/.test(k)) return ['sol', ADAPTERS.sol];
  if (/한화/.test(k)) return ['plus', ADAPTERS.plus];
  if (/키움/.test(k)) return ['kiwoom', ADAPTERS.kiwoom];
  if (/하나/.test(k)) return ['1q', ADAPTERS.oneq];
  if (/케이비|KB/.test(k)) return ['rise', ADAPTERS.rise];
  return [k, undefined];
}

// ---------- 종목코드 → 시세 소스 ----------
// 야후 ISIN 검색이 미국 상장을 못 찾는 알려진 케이스 (멀티클래스라 이름 검색도 모호)
const ISIN_OVERRIDE = {
  US02079K3059: 'GOOGL', // Alphabet Class A
  US02079K1079: 'GOOG',  // Alphabet Class C
};
async function resolveTicker(jm, name) {
  let m;
  if ((m = jm.match(/^([A-Z0-9.]+) US$/))) return { src: 'yahoo', sym: m[1], cur: 'USD' };
  // 도쿄증권거래소 코드는 4자리 숫자 외에 영숫자 혼합도 있다(2024년~, 예: 키옥시아 285A)
  if ((m = jm.match(/^(\d[0-9A-Z]{3}) JP$/))) return { src: 'yahoo', sym: m[1] + '.T', cur: 'JPY' };
  if ((m = jm.match(/^(\d+) HK$/))) return { src: 'yahoo', sym: m[1].padStart(4, '0') + '.HK', cur: 'HKD' };
  if (/^\d{6}$/.test(jm)) return { src: 'kr', sym: jm, cur: 'KRW' };
  if ((m = jm.match(/^KR7(\d{6})\d{3}$/))) return { src: 'kr', sym: m[1], cur: 'KRW' }; // 국내 ISIN
  if (/^[A-Z]{2}[A-Z0-9]{10}$/.test(jm)) { // 해외 ISIN → 야후 검색으로 해석
    if (ISIN_OVERRIDE[jm]) return { src: 'yahoo', sym: ISIN_OVERRIDE[jm], cur: 'USD' };
    return cached(`isin:${jm}`, 86400e3, async () => {
      const d = await getJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${jm}&quotesCount=6&newsCount=0`);
      const qs = d.quotes || [];
      if (!qs.length) throw new Error(`ISIN 해석 실패: ${jm} (${name})`);
      // 상장이 여러 곳이면 ISIN 국가에 맞는 거래소 우선 (예: 미국 ISIN이 밀라노 상장으로 풀리는 오매핑 방지)
      const prefer = jm.startsWith('CN') ? (s => /\.(SZ|SS)$/.test(s))
        : jm.startsWith('HK') ? (s => /\.HK$/.test(s))
        : jm.startsWith('JP') ? (s => /\.T$/.test(s))
        : (s => !s.includes('.')); // 그 외(US/IE 등)는 미국 상장(무접미사) 우선
      let q = qs.find(x => prefer(x.symbol));
      if (!q) { // ISIN 검색에 원하는 거래소가 없으면 종목명(법인 접미사 제거)으로 2차 검색
        const clean = name.replace(/[-_]/g, ' ').replace(/\b(INC|CORP|CO|LTD|PLC|CL\s?[A-C]|CLASS\s?[A-C])\b\.?/gi, '').replace(/\s+/g, ' ').trim();
        const d2 = await getJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(clean)}&quotesCount=6&newsCount=0`);
        q = (d2.quotes || []).find(x => prefer(x.symbol) && x.quoteType === 'EQUITY');
      }
      // 미국계 ISIN인데 끝내 외국 상장만 나오면 미추적(외삽 처리)이 오염된 가격보다 안전
      if (!q) throw new Error(`ISIN 거래소 매칭 실패: ${jm} (${name})`);
      const cur = q.symbol.endsWith('.SZ') || q.symbol.endsWith('.SS') ? 'CNY'
        : q.symbol.endsWith('.HK') ? 'HKD' : q.symbol.endsWith('.T') ? 'JPY' : 'USD';
      return { src: 'yahoo', sym: q.symbol, cur };
    });
  }
  return null; // 미지원 코드 → 추적 제외(변동 0으로 처리)
}

// ---------- 시세 ----------
// 시세 캐시는 화면 갱신 주기(REFRESH_MS)보다 반드시 길게 — 짧으면 갱신마다 전 종목을 다시 긁어
// 야후가 시간당 1만 회를 넘고 차단된다. 환율은 종목 수와 무관하게 1회라 더 자주 갱신.
// 로컬(비밀번호 없이 실행)에서는 혼자 쓰므로 더 촘촘하게, 공개 서버는 보수적으로.
// 단 로컬이라도 야후 rate limit은 똑같이 걸리므로 "무제한"은 두지 않는다(차단당하면 로컬도 못 씀).
// 공개 서버(auth.js)로 띄우면 ETF_SERVER=1이 설정돼 갱신 주기가 보수적으로 바뀐다. 직접 실행은 항상 로컬.
// 안드로이드 에셋 빌드(tools/build-android.js)는 ETF_TARGET=android로 이 파일을 읽는다.
// 지인에게 나눠 주는 앱이라 공개 소스 부담을 줄이려고 갱신 주기는 서버판만큼 보수적으로 잡고,
// 포트폴리오는 기기 안(localStorage)에 둔다 — 저장 API가 없으므로 PF_REMOTE는 거짓.
const ANDROID = NODE && process.env.ETF_TARGET === 'android';
const LOCAL = NODE ? (!process.env.ETF_SERVER && !ANDROID) : false;
const QUOTE_TTL = LOCAL ? 30e3 : 60e3;
const FX_TTL = LOCAL ? 15e3 : 30e3;
const REFRESH_MS = LOCAL ? 10000 : 20000;
const MAX_FRN_TRACK = LOCAL ? 120 : 60; // 해외 종목 추적 상한(야후는 종목별 호출)
function yahooQuote(sym) {
  return cached(`yq:${sym}`, /=X$/.test(sym) ? FX_TTL : QUOTE_TTL, () => yahooQuoteRaw(sym));
}

// 최근 일봉 종가 [{d:'2026-07-29', c:338.19}, ...]. 지난 종가는 변하지 않으므로 길게 캐시한다.
function dailyCloses(sym) {
  return cached(`yd:${sym}`, 6 * 3600e3, async () => {
    const d = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=10d&interval=1d`);
    const r = d.chart.result[0];
    // 야후는 직전 거래일 봉의 close를 한동안 null로 준다(실측 2026-08-04 18시 AAPL의 08-03).
    // 그 봉을 버리면 기준 시점이 하루 뒤처져, 장마감 후 '어제 기준가 vs 오늘 종가'를 비교하게 되고
    // 괴리율이 하루치만큼 튄다(실측 ACE 미국빅테크TOP7 +3.33%, 공식은 +0.06%).
    // meta의 확정 종가(regularMarketTime/Price)가 그 날짜면 그것으로 메운다 — 같은 값이다.
    const mt = r.meta.regularMarketTime, mp = r.meta.regularMarketPrice;
    const mDay = mt ? new Date(mt * 1000).toISOString().slice(0, 10) : null;
    const out = [];
    (r.timestamp || []).forEach((t, i) => {
      let c = r.indicators?.quote?.[0]?.close?.[i];
      const day = new Date(t * 1000).toISOString().slice(0, 10);
      if (c == null && day === mDay && mp > 0) c = mp;
      if (c != null) out.push({ d: day, c });
    });
    return out.slice(-6);
  });
}

// ---------- PDF 기준환율 역산 ----------
// PDF 평가금액 = 주수 × (기준일 종가) × (기준 환율). 여기서 환율만 남기려면 '기준일 종가'로 나눠야 한다.
//
// 예전엔 야후의 chartPreviousClose로 나눴는데, 이건 미국장이 새 세션을 열면 한 칸 밀린다.
// 그래서 한국 저녁(미국장 개장, 22:30 KST 무렵)부터 다음 PDF가 나올 때까지 기준환율이 틀어졌다.
// 실측 2026-07-31 23:11 KST — 07-29 종가로 나누면 10종목 전부 1437.4로 일치,
// 07-30 종가로 나누면 1214~1562로 흩어지고 중앙값 1400.3 → 환율변동이 +0.05%가 아닌 +2.70%로 표시.
//
// 어느 세션이 기준인지는 달력으로 못 맞춘다(서머타임·현지 휴장·운용사 관행이 섞인다).
// 대신 자기검증을 쓴다 — 기준일이 맞으면 모든 종목이 같은 환율을 내놓는다. 산포가 최소인 날짜가 정답.
const MAD = arr => { // 중앙값 대비 상대 산포
  const s = [...arr].sort((a, b) => a - b), m = s[Math.floor(s.length / 2)];
  if (!m) return Infinity;
  return s.reduce((acc, v) => acc + Math.abs(v - m), 0) / s.length / m;
};
const medOf = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// 특정 영업일 15:30(한국장 마감) 시점의 환율 스팟 — 잠정(마감 iNAV) 프레임의 환율 기준.
// 마감 iNAV는 마감 시점 순자산이므로, 그 이후의 환율 변동은 마감 스팟에서 재야 한다(사용자 요청).
async function fxCloseSpot(cur, d8) { // d8 = '20260803'
  return cached(`fxclose:${cur}:${d8}`, 30 * 86400e3, async () => {
    const t = Date.UTC(+d8.slice(0, 4), +d8.slice(4, 6) - 1, +d8.slice(6, 8), 6, 30) / 1000; // 15:30 KST
    const old = Date.now() / 1000 - t > 0.8 * 86400;
    const dd = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${cur}KRW=X?range=${old ? '5d' : '1d'}&interval=${old ? '5m' : '1m'}`);
    const r = dd.chart.result[0];
    let best = null, gap = Infinity;
    (r.timestamp || []).forEach((ts, i) => {
      const c = r.indicators?.quote?.[0]?.close?.[i];
      if (c != null && ts <= t + 300 && Math.abs(ts - t) < gap) { gap = Math.abs(ts - t); best = c; }
    });
    if (best == null || gap > 3600) throw new Error('마감 시점 환율 없음');
    return best;
  });
}

const fxKeyD = s => String(s || '').replace(/\D/g, '').slice(0, 8);
// 특정 일자의 원화 환율 근사: ① 다른 ETF의 PDF에서 역산해 둔 정확값(fxfix 캐시)
// ② 해당 통화 일봉 ③ USD 교차환율 — CNYKRW=X처럼 야후에 과거 일봉이 없는 통화가 있다(실측).
async function fxFixOf(cur, dateStr) {
  // 키는 숫자만 남겨 통일한다 — 호출처가 '2026-08-05'와 '20260805'를 섞어 쓰면 같은 날이 다른 칸에 저장된다
  const hit = cache.get(`fxfix:${cur}:${fxKeyD(dateStr)}`);
  if (hit && Date.now() - hit.ts < hit.ttl && hit.data) return hit.data;
  const dig = s => String(s || '').replace(/\D/g, '');
  const direct = ((await dailyCloses(`${cur}KRW=X`).catch(() => null)) || [])
    .filter(x => dig(x.d) <= dig(dateStr)).pop();
  if (direct) return direct.c;
  if (cur === 'USD') return null;
  const usd = await fxFixOf('USD', dateStr);
  const perUsd = ((await dailyCloses(`${cur}=X`).catch(() => null)) || []) // 예: CNY=X = USD당 위안
    .filter(x => dig(x.d) <= dig(dateStr)).pop();
  return usd && perUsd ? usd / perUsd.c : null;
}
async function resolveFxRef(holdings, quoteOf) {
  const byCur = {};
  for (const h of holdings) {
    if (!h.t || h.t.cur === 'KRW' || !h.valRef || !h.qty) continue;
    (byCur[h.t.cur] ||= []).push(h);
  }
  // 판정에는 비중 큰 몇 종목이면 충분하다(기준일이 맞으면 전부 일치하므로). 야후 호출을 아낀다.
  const info = {};
  for (const [cur, hs] of Object.entries(byCur)) {
    const top = [...hs].sort((a, b) => b.wg - a.wg).slice(0, 8);
    const hist = await Promise.all(top.map(h => dailyCloses(h.t.sym).catch(() => null)));
    info[cur] = top.map((h, i) => ({ unit: h.valRef / h.qty, days: hist[i] })).filter(r => r.days?.length);
  }
  const fxAt = (rows, date) => rows
    .map(r => { const f = r.days.find(x => x.d === date); return f && f.c ? r.unit / f.c : null; })
    .filter(Boolean);
  const pick = rows => { // 산포가 가장 작은 기준일. 종목이 1개면 판정 불가(어느 날짜든 산포 0).
    if (rows.length < 2) return null;
    let best = null;
    for (const date of [...new Set(rows.flatMap(r => r.days.map(x => x.d)))].sort().slice(-5)) {
      const vals = fxAt(rows, date);
      if (vals.length < 2) continue;
      const spread = MAD(vals);
      if (!best || spread < best.spread) best = { date, spread };
    }
    return best && best.spread < 0.01 ? best : null;
  };
  // PDF는 한 시점에 만들어지므로 기준 세션은 통화 공통이다(실측: USD·HKD·CNY·JPY 모두 같은 날짜).
  // 종목이 가장 많은 통화에서 정하고, 종목 1개뿐인 통화는 그 날짜를 물려받는다.
  const shared = Object.values(info).sort((a, b) => b.length - a.length).map(pick).find(Boolean);
  const fxRef = {}, fxRefDate = {};
  for (const [cur, rows] of Object.entries(info)) {
    const chosen = pick(rows) || shared;
    const vals = chosen ? fxAt(rows, chosen.date) : [];
    if (vals.length) {
      fxRef[cur] = medOf(vals); fxRefDate[cur] = chosen.date;
      // 역산한 고시환율을 날짜별로 남겨 둔다 — 평가금액이 없는 운용사(PLUS)의 기준액 합성에 재사용
      cache.set(`fxfix:${cur}:${fxKeyD(chosen.date)}`, { ts: Date.now(), ttl: 7 * 86400e3, data: fxRef[cur] });
      saveCache();
      continue;
    }
    // 일봉을 못 구했을 때만 예전 방식(야후 chartPreviousClose)으로 물러난다 — 세션이 밀릴 수 있다.
    const arr = byCur[cur].map(h => { const q = quoteOf(h); return q?.prevClose ? (h.valRef / h.qty) / q.prevClose : null; })
      .filter(Boolean);
    if (arr.length) fxRef[cur] = medOf(arr);
  }
  return { fxRef, fxRefDate };
}
async function yahooQuoteRaw(sym) {
  const d = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1d&interval=1m&includePrePost=true`);
  const r = d.chart.result[0];
  const closes = r.indicators.quote[0].close || [];
  let last = null;
  for (let i = closes.length - 1; i >= 0; i--) if (closes[i] != null) { last = closes[i]; break; }
  if (last == null) last = r.meta.regularMarketPrice;
  const p = r.meta.currentTradingPeriod, now = Date.now() / 1000;
  let session = '휴장';
  if (p) {
    if (now >= p.regular.start && now < p.regular.end) session = '본장';
    else if (p.pre.start !== p.regular.start && now >= p.pre.start && now < p.pre.end) session = '프리';
    else if (p.post.start !== p.post.end && now >= p.post.start && now < p.post.end) session = '애프터';
  }
  // 마지막 체결이 '그 거래소의 오늘'이면 휴장이 아니라 장마감 — 일본·홍콩처럼 프리·애프터가
  // 없는 시장이 오후에 전부 '휴장'으로 보이던 문제(실제 휴장일·주말과 구분)
  if (session === '휴장' && r.meta.regularMarketTime) {
    const off = r.meta.gmtoffset || 0;
    const day = t => new Date((t + off) * 1000).toISOString().slice(0, 10);
    if (day(r.meta.regularMarketTime) === day(now)) session = '장마감';
  }
  return { last, prevClose: r.meta.chartPreviousClose, regClose: r.meta.regularMarketPrice, session };
}

// ---------- KRX 거래일 달력 ----------
// 공휴일 표를 손으로 관리하면 매년 썩는다. 'KOSPI 일봉이 있는 날 = 거래일'이라는 사실을 그대로 쓴다.
// 당일 일봉은 개장 직후엔 아직 없을 수 있으므로 이 달력으로는 과거 날짜만 판정한다(오늘은 marketStatus로).
let krDays = null;
// close가 null인 봉을 걸러내면 안 된다 — 야후는 실거래일에도 값을 비워 보낼 때가 있고
// (실측 2026-08-03: timestamp는 있는데 close/open/volume 전부 null) 그걸 휴장으로 오인하면
// 존재하는 기준가 날짜를 건너뛴다. 휴장일은 timestamp 자체가 없다
// (실측: 05-05 어린이날·05-25 부처님오신날·06-03 지방선거·07-17 제헌절만 빠짐).
function parseKrDays(json) {
  const r = json.chart.result[0], off = r.meta.gmtoffset || 32400;
  return (r.timestamp || []).map(t => new Date((t + off) * 1000).toISOString().slice(0, 10).replace(/-/g, ''));
}
// 달력으로도 '오늘 공휴일'을 판정한다 — marketStatus 방식(noteKrStatus)은 요청이 본장 시간대(09:10~15:20)에
// 와야만 잡는데, 공휴일 저녁에 처음 접속하거나 서버가 그 사이 재시작되면 그 창을 놓친다.
// 거래일 봉은 개장 직후부터 달력에 잡히므로(실측), 개장(09:10 KST) 이후 받아온 달력에
// 오늘 봉이 없으면 오늘은 휴장이다. 반환: 휴장이면 오늘 날짜, 거래일 확정이면 'open', 판단 불가면 null.
function calClosedToday(daysSet, fetchedTs, now = Date.now()) {
  const kst = new Date(now + 9 * 3600e3);
  if (kst.getUTCDay() === 0 || kst.getUTCDay() === 6) return null; // 주말은 krSession이 이미 처리
  const t = [kst.getUTCFullYear(), String(kst.getUTCMonth() + 1).padStart(2, '0'), String(kst.getUTCDate()).padStart(2, '0')].join('');
  const openTs = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), 0, 10); // 09:10 KST
  if (fetchedTs < openTs) return null; // 개장 전에 받은 달력엔 오늘 봉이 원래 없다 — 판단 불가
  return daysSet.has(t) ? 'open' : t;
}
async function loadKrDays() {
  // 매번 cached()를 거친다 — 여기서 krDays를 보고 일찍 반환하면 첫 로드 이후 영원히 갱신되지 않아
  // 서버를 며칠 켜두면 달력이 과거에 멈춘다. TTL 안에서는 메모리 Map 히트라 비용이 없다.
  const days = await cached('krbiz', 6 * 3600e3, async () =>
    parseKrDays(await getJson('https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?range=3mo&interval=1d'))
  ).catch(() => null);
  if (days && days.length > 40) { // 3개월치(≈60거래일)가 안 오면 직전 성공분 유지
    krDays = new Set(days);
    const v = calClosedToday(krDays, cache.get('krbiz')?.ts ?? 0);
    if (v && v !== 'open') krClosedToday = v;
    else if (v === 'open' && krClosedToday === todayYmd()) krClosedToday = null; // 봉이 있다 = 거래일 확정
  }
  return krDays;
}
// 달력이 없거나 오늘 이후 날짜면 판단 보류(true) — 주말만 걸러지던 기존 동작으로 안전하게 떨어진다.
// 단 오늘이 공휴일로 판정됐으면(marketStatus) 라벨뿐 아니라 날짜 계산에서도 거래일에서 뺀다 —
// 안 그러면 targetDt·nextBizYmd가 존재하지 않는 오늘 기준가를 목표로 삼는다.
const isKrBiz = d8 => {
  if (krClosedToday && d8 === krClosedToday) return false;
  return (!krDays || d8 >= todayYmd()) ? true : krDays.has(d8);
};

// 오늘이 공휴일인지는 시계로도, 아직 안 나온 당일 일봉으로도 알 수 없다.
// 네이버 basic의 marketStatus가 즉시 알려주므로 요청마다 기록해 두고 krSession()이 참고한다.
let krClosedToday = null;
function noteKrStatus(status) {
  if (!status) return;
  const kst = new Date(Date.now() + 9 * 3600e3);
  const hm = kst.getUTCHours() * 100 + kst.getUTCMinutes();
  if (hm < 910 || hm >= 1520) return; // 본장 시간대에서만 판단 — 그 밖에서는 CLOSE가 정상이다
  krClosedToday = status === 'OPEN' ? null : todayYmd();
}

// KST 기준 HHMM (0930 = 9시 30분)
const kstHm = (now = Date.now()) => {
  const k = new Date(now + 9 * 3600e3);
  return k.getUTCHours() * 100 + k.getUTCMinutes();
};

function krSession(now = Date.now()) { // now는 검사용 주입구 — 평소엔 시계
  // ponytail: KST 시계 기준 고정 창(NXT 프리 08:00~08:50, KRX 본장 09:00~15:30, NXT 애프터 15:30~20:00).
  const kst = new Date(now + 9 * 3600e3);
  if (kst.getUTCDay() === 0 || kst.getUTCDay() === 6) return '휴장';
  if (krClosedToday === todayYmd()) return '휴장'; // 평일인데 장이 안 열렸다 = 공휴일
  const hm = kst.getUTCHours() * 100 + kst.getUTCMinutes();
  if (hm >= 800 && hm < 850) return 'NXT프리';
  if (hm >= 850 && hm < 900) return '장전'; // 프리 종료~개장. 오늘 첫 체결이 아직 없다
  if (hm >= 900 && hm < 1530) return '본장';
  if (hm >= 1530 && hm < 2000) return 'NXT애프터';
  // '휴장'은 장이 실제로 안 열리는 날(주말·공휴일)에만 쓴다 — 세션 창 밖은 장이 끝난 것이다.
  // 애프터 마감 후 밤새 '한국장 휴장'으로 보이던 문제(사용자 지적).
  return '장마감';
}
// 개장 전 구간(08:00~09:00) — 오늘 첫 체결 전이라 등락의 기준이 아직 없다
const KR_PREOPEN = ['NXT프리', '장전'];

// 미국주식 주간거래(Blue Ocean): 야후에 없음 → 토스 시세로 보완
function usDaySession() { // KST 09:00~17:00 평일 = 미국 주간거래 시간대
  const kst = new Date(Date.now() + 9 * 3600e3);
  if (kst.getUTCDay() === 0 || kst.getUTCDay() === 6) return false;
  const hm = kst.getUTCHours() * 100 + kst.getUTCMinutes();
  return hm >= 900 && hm < 1700;
}

async function tossCodeOf(symbol) {
  return cached(`tosscode:${symbol}`, 86400e3, async () => {
    const res = await fetchOrThrow('https://wts-info-api.tossinvest.com/api/v3/search-all/wts-auto-complete', {
      method: 'POST',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: symbol, sections: [{ type: 'PRODUCT' }] }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const items = d.result?.find(s => s.type === 'PRODUCT')?.data?.items || [];
    return items.find(i => i.symbol === symbol && /^US|^AMX|^NAS|^NYS/.test(i.productCode))?.productCode || null;
  });
}

async function tossPrices(codes) {
  const d = await getJson(`https://wts-info-api.tossinvest.com/api/v2/stock-prices?codes=${codes.join(',')}`);
  return Object.fromEntries(d.result.prices.map(p => [p.code, p]));
}

const num = v => parseFloat(String(v ?? '0').replace(/,/g, ''));

// ETF 자체 시장가. 시간외(NXT/단일가)가 열려 있으면 그 가격을 쓴다 —
// 구성종목을 시간외로 평가하면서 시장가만 정규장 종가로 두면 괴리율이 부풀려진다.
function marketPx(basic, sess = krSession()) {
  const om = basic.overMarketPriceInfo;
  const live = om && om.overMarketStatus === 'OPEN' && num(om.overPrice) > 0;
  const price = live ? num(om.overPrice) : num(basic.closePrice);
  // 개장 전(08:00~09:00)엔 네이버가 이미 오늘로 넘어가 등락이 0으로 굳어 있다 — 아직 체결이 없어서다.
  // '변동 0%'로 보여주면 안 움직였다는 뜻이 되므로 표시하지 않는다(사용자 지적).
  const noTrade = !live && KR_PREOPEN.includes(sess);
  const changePct = noTrade ? null : live ? num(om.fluctuationsRatio) : num(basic.fluctuationsRatio);
  const raw = live ? om.compareToPreviousClosePrice : basic.compareToPreviousClosePrice;
  return {
    price, changePct, over: !!live,
    // 등락액 — 네이버가 주는 값을 우선, 없으면 등락률에서 되구함
    change: noTrade ? null : raw != null ? num(raw) : (price && changePct != null ? price - price / (1 + changePct / 100) : null),
  };
}

// 괴리율의 기준: 본장 중엔 '현재가 vs 실시간 추정 iNAV'. 장 마감 후엔 '종가 vs 기준 NAV' —
// 둘 다 15:30 시점 값이라 같은 시점끼리의 비교가 된다(표준 공시 괴리율과 동일).
// 마감 후에도 움직이는 iNAV 대비로 재면 시점이 어긋나 밤새 값이 떠다니고 '종가 대비'와 중복된다.
function premiumOf(basic, mp, inav, inavRegular, navRef) {
  if (krSession() === '본장') {
    return {
      pct: mp.price ? (mp.price / (mp.over ? inav : inavRegular) - 1) * 100 : null,
      basis: mp.over ? 'now' : 'regular',
    };
  }
  const close = etfCloseOf(basic);
  return { pct: close && navRef ? (close / navRef - 1) * 100 : null, basis: 'close' };
}

// ETF의 최근 확정 종가 — "종가 대비" 표시 기준. 본장 중엔 오늘 종가가 아직 없으므로 전일 종가
// (naver closePrice가 본장 중엔 현재가라 등락분을 빼서 되구함), 그 외엔 최근 영업일 종가.
function etfCloseOf(basic) {
  const c = num(basic.closePrice);
  if (krSession() !== '본장') return c; // 마감 후 closePrice는 당일 종가로 고정 — 그대로 쓴다
  // 본장 중 closePrice는 현재가 — 등락률로 전일 종가를 되구한다
  const r = num(basic.fluctuationsRatio);
  return r != null ? c / (1 + r / 100) : c;
}

// 한국주식 시세. 정규장 중엔 토스 배치 1회, 정규장 외엔 네이버 개별 조회로 시간외(NXT/단일가) 가격까지.
// 토스·야후는 국내 정규장 종가만 주므로 시간외 반영에는 네이버 overMarketPriceInfo가 필요하다.
async function krQuotes(codes) {
  return cached(`kr:${codes.join(',')}`, QUOTE_TTL, () => krQuotesRaw(codes));
}
async function krQuotesRaw(codes) {
  const out = {};
  const tossBatch = async () => {
    const d = await getJson(`https://wts-info-api.tossinvest.com/api/v2/stock-prices?codes=${codes.map(c => 'A' + c).join(',')}`);
    for (const p of d.result.prices) {
      const c = p.code.slice(1);
      if (!out[c]) out[c] = { last: p.close, prevClose: p.base, regClose: p.close, session: krSession() === '본장' ? '본장' : '장마감' };
    }
  };

  if (krSession() === '본장') {
    try { await tossBatch(); return out; } catch (e) { /* 네이버로 폴백 */ }
  }

  await Promise.all(codes.map(async c => {
    try {
      const d = await getJson(`https://m.stock.naver.com/api/stock/${c}/basic`);
      const reg = num(d.closePrice);
      const prev = reg - num(d.compareToPreviousClosePrice);
      const om = d.overMarketPriceInfo;
      const live = om && om.overMarketStatus === 'OPEN' && num(om.overPrice) > 0;
      // 시간외 세션이 끝난 뒤에도 그 마감가가 최신 체결가 — 정규장 종가로 되돌리면
      // 애프터장 마감 후 다음 장까지 모든 변동이 0%로 굳는다(사용자 지적).
      const overLast = d.marketStatus !== 'OPEN' && om && num(om.overPrice) > 0 ? num(om.overPrice) : null;
      out[c] = {
        last: live ? num(om.overPrice) : (overLast ?? reg),
        prevClose: prev, regClose: reg,
        // '시간외'라고만 쓰면 KRX 시간외단일가와 헷갈린다 — 정규장 전=프리, 후=애프터로 구분
        session: d.marketStatus === 'OPEN' ? '본장'
          : live ? (om.tradingSessionType === 'PRE_MARKET' ? '프리' : '애프터') : '장마감',
      };
    } catch (e) { /* 개별 실패는 아래 토스로 보충 */ }
  }));
  if (codes.some(c => !out[c])) { try { await tossBatch(); } catch (e) {} }
  return out;
}

// ---------- 기준 NAV 시점 검증 ----------
// 네이버 nav 필드는 다음 영업일 개장 무렵에야 갱신된다. PDF는 새벽에 이미 새 날짜로 바뀌므로
// 장 마감 후~다음 개장 전에는 nav가 PDF보다 하루 늦어 iNAV가 2%대로 과대·과소평가된다(실측).
// navPerformanceReferenceDate로는 구분되지 않으므로(갱신 전후 동일), PDF 총합으로 판별한다:
//   설정단위(CU 좌수) = PDF평가총합 ÷ (기준NAV × (1 − 현금비중)) — 라운드 숫자여야 정상.
const CU_ROUND = [1e3, 2e3, 2.5e3, 5e3, 1e4, 2e4, 2.5e4, 3e4, 4e4, 5e4, 1e5, 2e5, 2.5e5, 5e5, 1e6];

// PDF가 순자산의 몇 %를 담고 있는지. CU 역산(= PDF총액 ÷ (기준NAV × share))의 분모다.
// 채권혼합형은 채권 레그에 티커가 없어 PDF에서 빠지고 주식분만 남는다(실측 1Q 코스닥150채권혼합50: 54.4%
// = 자산구성의 주식 비중과 정확히 일치). 여기에 (1 − 현금비중)=0.963을 쓰면 분모가 1.8배 커져
// CU 역산이 어긋나고, 그 뒤의 NAV 복구·검증이 전부 엉뚱한 값을 만든다.
// 비중 합이 없거나 이상하면 기존 방식으로 물러난다.
function pdfShare(pdfList, analysis) {
  const wgSum = pdfList.reduce((s, r) => s + (r.wg || 0), 0) / 100;
  if (wgSum > 0.2 && wgSum < 1.05) return wgSum;
  return 1 - (analysis.assetPortfolioList?.find(a => a.detailTypeCode === 'CASH')?.weight || 0) / 100;
}

// PDF 구성이 지난번과 달라졌는지 — 리밸런싱(편입·편출) 감지용.
// 리밸런싱 당일 아침에는 PDF가 새 구성인데 기준 NAV는 아직 전날(옛 구성)이라, 새로 편입된 종목의
// 기준 평가액과 기준 NAV의 시점이 어긋나 그 종목에서만 큰 오차가 난다.
// 실측 2026-08-06 ACE 미국빅테크TOP7 Plus(스페이스X 편입·넷플릭스 편출): 스페이스X 추적변동 -11.6%
// (다른 종목은 -1% 근처) → 기준 NAV가 08-06으로 갱신되자 +0.5%로 정상화.
// 편입가를 알 방법이 없어 보정은 못 하고, 그런 날이라는 것만 알린다.
function notePdfSet(stockCode, pdf) {
  if (pdf.partial || !Array.isArray(pdf.list) || !pdf.stdDt) return null; // 상위10 추정은 구성이 원래 다르다
  const codes = pdf.list.map(r => String(r.jm || '')).filter(Boolean).sort();
  if (codes.length < 3) return null;
  const key = `pdfset:${stockCode}`;
  const prev = cache.get(key)?.data;
  const cur = { d: String(pdf.stdDt), codes };
  if (!prev || prev.d !== cur.d) {
    cache.set(key, { ts: Date.now(), ttl: 30 * 86400e3, data: cur });
    saveCache();
  }
  if (!prev || prev.d === cur.d) return null; // 처음 보는 종목이거나 같은 날짜 PDF면 비교 대상이 없다
  const added = codes.filter(c => !prev.codes.includes(c));
  const removed = prev.codes.filter(c => !codes.includes(c));
  if (!added.length && !removed.length) return null;
  const nameOf = c => pdf.list.find(r => String(r.jm) === c)?.name || c;
  return { added: added.map(nameOf), removed, from: prev.d, to: cur.d };
}

function resolveNavRef(analysis, pdfList, extraNavs) {
  const nav = analysis.nav;
  const total = pdfList.reduce((s, r) => s + (r.valAm || 0), 0);
  if (!nav || !total) return { navRef: nav, adjusted: false };
  const d1 = analysis.navPerformanceList?.find(x => x.periodTypeCode === 'D1')?.value;
  const share = pdfShare(pdfList, analysis);

  // 후보를 CU 역산 오차로 채점: ① nav 그대로 ② 전영업일 수익률로 하루 굴린 값(지연 가설) ③ 호출측이 준 최신 후보
  const cands = [{ nav, adjusted: false }];
  if (typeof d1 === 'number') cands.push({ nav: nav * (1 + d1 / 100), adjusted: true });
  for (const n of extraNavs || []) if (n > 0) cands.push({ nav: n, adjusted: true, fresh: true });
  let best = null;
  for (const c of cands) {
    const cuEst = total / (c.nav * share);
    const cu = CU_ROUND.reduce((b, x) => Math.abs(x / cuEst - 1) < Math.abs(b / cuEst - 1) ? x : b);
    c.cu = cu; c.off = Math.abs(cu / cuEst - 1); c.cuEst = cuEst;
    if (!best || c.off < best.off) best = c;
  }
  // 조정 없는 후보가 이미 허용 오차 안이면 그걸 쓴다 — 공식 NAV를 덮어쓰는 건 위험한 쪽이라
  // '조금 더 잘 맞는다'는 이유만으로 하지 않는다. CU 검사의 분해능은 share(비중 합, 소수 2자리 반올림)
  // 오차에 묶여 ±0.4%쯤이라 1%대 차이를 가리지 못한다.
  // 실측 1Q 코스닥150채권혼합50: nav 그대로 off 1.42% / D1 굴림 off 0.36% → D1이 이겼지만
  // 공식 iNAV와 맞는 쪽은 nav 그대로였다(7,858 vs 7,998).
  if (cands[0].off <= 0.015) best = cands[0];
  // 어느 후보도 라운드 설정단위에 안 맞으면(목록에 없는 CU) 손대지 않는다 — 오탐 방지
  if (best.off > 0.015) {
    // 단, 어긋남이 작으면(6% 이내) PDF 총액에서 NAV를 되구한다 — CU가 라운드라는 사실이 근거.
    // naver nav가 아침 갱신 중 엉뚱한 값을 줄 때의 복구(실측: KODEX 200 105,157 vs 실제 ~99,977).
    // 6% 제한은 CU 격자 간격(20~25%)의 절반보다 훨씬 작아 잘못된 칸을 잡을 위험이 없다.
    if (best.off <= 0.06) {
      return { navRef: total / (best.cu * share), cuShares: best.cu, cuEst: best.cu, adjusted: true, staleNav: nav };
    }
    return { navRef: nav, adjusted: false, cuEst: best.cuEst };
  }
  return {
    navRef: best.nav, cuShares: best.cu, cuEst: best.cuEst, adjusted: best.adjusted, fresh: best.fresh,
    staleNav: best.adjusted ? nav : undefined,
  };
}

// integration API — 공식 iNAV·거래량이 여기 있다. 한 요청 안에서 여러 경로가 찾으므로 캐시 키를 공유한다.
const integrationOf = stockCode => cached(`ig:${stockCode}`, 300e3,
  () => getJson(`https://m.stock.naver.com/api/stock/${stockCode}/integration`));
const igVal = (ig, code) => ig?.totalInfos?.find(t => t.code === code)?.value ?? null;
// 거래량 — 화면 표시용. 위 캐시를 그대로 쓰므로 대부분의 경로에서 추가 호출이 없다.
const volumeOf = async stockCode =>
  igVal(await integrationOf(stockCode).catch(() => null), 'accumulatedTradingVolume');

// 어떤 방법으로도 바스켓 추적이 불가할 때: 추정을 포기하고 KRX 공식 iNAV만 표시
async function officialOnly(stockCode, analysis, basic, reason) {
  const ig = await integrationOf(stockCode);
  const official = parseFloat((ig.totalInfos.find(t => t.code === 'nav')?.value || '0').replace(/,/g, ''));
  if (!official) throw new Error(reason);
  const mp = marketPx(basic), marketPrice = mp.price;
  return {
    etfName: basic.stockName, code: stockCode,
    issuer: analysis.issuerName, baseIndex: analysis.etfBaseIndex,
    navRef: analysis.nav, navRefDate: analysis.navPerformanceReferenceDate,
    inav: official, officialINav: official, isOfficial: true,
    marketPrice, marketChangePct: mp.changePct, marketChange: mp.change, marketOver: mp.over,
    premiumPct: premiumOf(basic, mp, official, official, official).pct,
    premiumBasis: premiumOf(basic, mp, official, official, official).basis,
    inavRegular: official, sessContrib: 0,
    etfClose: etfCloseOf(basic), vsClosePct: etfCloseOf(basic) ? (official / etfCloseOf(basic) - 1) * 100 : null,
    inavChangePct: analysis.nav ? (official / analysis.nav - 1) * 100 : 0,
    domContrib: 0, frnContrib: 0, fxContrib: 0,
    up: 0, down: 0, coveragePct: 0, sumWg: 100,
    krSession: krSession(), fx: {},
    returns: analysis.returnPerformanceList, aum: analysis.totalNav, fee: analysis.totalFee,
    volume: igVal(ig, 'accumulatedTradingVolume'),
    note: `구성종목을 실시간 추적할 수 없어(${reason}) KRX 공식 iNAV를 그대로 표시합니다. 채권형·해외형은 종목코드가 공개되지 않아 자체 추정이 불가합니다.`,
    rows: [], moreCount: 0, pdfDate: '-',
    asOf: new Date().toISOString(),
  };
}

// ---------- 국내지수 선물형 레버리지·인버스 ----------
// 코스피200/코스닥150 선물 실시간 시세는 공개 소스가 없다(현물지수로 추정하면 1.9~3.2% 오차 — 실측).
// KRX 공식 iNAV는 본장 중 실시간 산출되므로 추정하지 않고 그 값을 쓴다. 현물지수 참고치는 병기.
// 네 번째 칸은 장외 세션을 굴릴 때 쓸 1배수 대표 ETF(이름으로 못 찾을 때의 폴백),
// 다섯 번째는 야간선물 심볼 — 이쪽이 있으면 선물 대 선물이라 베이시스가 상쇄돼 더 정확하다.
const DOM_INDEX = [
  [/코스피\s*200/, 'KPI200', '코스피 200', '069500', '^KS200'],   // KODEX 200
  [/코스닥\s*150/, null, '코스닥 150', '229200', '^KQ150'],        // KODEX 코스닥150 (네이버에 실시간 지수코드 없음 → 지수 참고치는 생략)
  [/코스피(?!\s*\d)/, 'KOSPI', '코스피', null, null],
  [/코스닥(?!\s*\d)/, 'KOSDAQ', '코스닥', null, null],
];

// 장외에 굴릴 기준이 될 1배수 ETF. 이름에서 배수를 떼어 찾으면 섹터까지 정확히 맞는다
// ('TIGER 200IT레버리지' → 'TIGER 200 IT'). 못 찾으면 지수 대표 ETF로 폴백하되,
// 기초지수가 그 대표 지수와 사실상 같을 때만 — '코스피 200 정보기술'에 코스피200 ETF를 붙이면 엉뚱한 값이 된다.
async function domBaseCode(nm, selfCode, idxNm, idxLabel, fallback) {
  const byName = await findBaseCode(nm, selfCode, idxNm).catch(() => null);
  if (byName) return byName;
  return fallback && domIndexSame(idxNm, idxLabel) ? fallback : null;
}

// 기초지수가 대표 지수와 사실상 같은가 — 섹터 지수('코스피 200 정보기술')에 코스피200 값을 붙이면 엉뚱해진다.
// idxKey는 영문 배수 표기만 걷어낸다(\b가 한글에 안 붙어 '레버리지지수'가 그대로 남는다) → 여기서 한 번 더 지운다.
const domIndexSame = (idxNm, idxLabel) => !idxKey(idxNm).replace(idxKey(idxLabel), '')
  .replace(/지수|선물|미결제|야간|총수익|초과|레버리지|인버스/g, '');

async function computeDomesticLev(stockCode, analysis, basic) {
  const nm = basic.stockName || '';
  const idxNm = analysis.etfBaseIndex || '';
  const hit = DOM_INDEX.find(([re]) => re.test(idxNm));
  if (!hit) return null;
  const lev = /인버스\s?-?2X/.test(nm + idxNm) ? -2 : /인버스/.test(nm) ? -1 : /레버리지/.test(nm) ? 2 : null;
  if (lev == null) return null;

  const [, idxCode, idxLabel, base1x, nightSym] = hit;
  const ig = await integrationOf(stockCode);
  const official = parseFloat((ig.totalInfos.find(t => t.code === 'nav')?.value || '0').replace(/,/g, ''));
  if (!official) return null;

  let idx = null;
  // 섹터 지수(코스피 200 정보기술 등)에는 코스피200 참고치를 붙이지 않는다 — 전혀 다른 값이다
  if (idxCode && domIndexSame(idxNm, idxLabel)) {
    try {
      const d = await naverIndex(idxCode, krSession() === '본장'); // 지수·환율 카드와 같은 캐시
      idx = { label: idxLabel, value: num(d.closePrice), changePct: num(d.fluctuationsRatio),
        live: d.marketStatus === 'OPEN' };
    } catch (e) { /* 지수 참고치 실패는 무시 */ }
  }

  const navRef = analysis.nav;
  const spotEst = idx ? navRef * (1 + lev * idx.changePct / 100) : null;
  const mp = marketPx(basic), marketPrice = mp.price;

  // KRX 공식 iNAV는 정규장 마감(15:30)으로 산출이 끝난다. 그대로 두면 1배수가 애프터에 2% 내려가 있어도
  // 레버리지는 마감값에 머물러 '종가 대비'가 4%씩 어긋난다
  // (실측 2026-08-05 18:25 TIGER 200IT레버리지 종가 대비 +0.33% — 기초 1배수 -2.23%p로 보면 실제는 -4%대).
  // 그래서 장외에는 같은 지수 1배수 ETF의 정규장 이후 변동에 배수를 적용해 굴린다.
  // 선물 베이시스의 장외 변화는 잡지 못하지만, 굴리지 않는 것보다 오차가 훨씬 작다.
  let inav = official, sessContrib = 0, rolled = null;
  if (krSession() !== '본장') {
    // ① 야간선물이 돌고 있으면 그것을 쓴다 — 이 상품 자체가 선물 기반이라 베이시스가 상쇄된다.
    //    섹터 지수에는 해당 야간선물이 없으므로 지수가 대표 지수와 같을 때만.
    const nq = nightSym && domIndexSame(idxNm, idxLabel) ? (await nightFutures())[nightSym] : null;
    if (nightUsable(nq) && Math.abs(nq.chgPct) >= 0.01) {
      sessContrib = lev * nq.chgPct;
      inav = official * (1 + sessContrib / 100);
      rolled = { name: idxLabel + ' 야간선물', pct: nq.chgPct, night: true };
    } else {
      // ② 없으면 같은 지수 1배수 ETF의 현물 바스켓으로 (선물 베이시스의 장외 변화는 못 잡는다)
      const bc = await domBaseCode(nm, stockCode, idxNm, idxLabel, base1x);
      const base = bc ? await computeINav(bc, 1).catch(() => null) : null;
      const bs = base?.sessContrib;
      // 기초가 공식값뿐이거나 추적이 얕으면 굴리지 않는다 — 오차가 배수만큼 증폭된다
      if (base && !base.isOfficial && Number.isFinite(bs) && Math.abs(bs) >= 0.01 && base.coveragePct >= 50) {
        sessContrib = lev * bs;
        inav = official * (1 + sessContrib / 100);
        rolled = { code: bc, name: base.etfName, pct: bs };
      }
    }
  }
  const etfClose = etfCloseOf(basic);
  const sgn = n => (n >= 0 ? '+' : '') + n.toFixed(2);

  return {
    etfName: basic.stockName, code: stockCode,
    issuer: analysis.issuerName, baseIndex: idxNm,
    navRef, navRefDate: analysis.navPerformanceReferenceDate,
    inav, officialINav: official, isOfficial: true, levRolled: rolled,
    marketPrice, marketChangePct: mp.changePct, marketChange: mp.change, marketOver: mp.over,
    // 장외 괴리율의 기준은 navRef가 아니라 '마감 공식 iNAV' — 기준 NAV는 전영업일 값이라
    // 종가와 하루 어긋난다(그대로 쓰면 괴리율이 +13%로 튄다, 실측)
    premiumPct: premiumOf(basic, mp, inav, official, official).pct,
    premiumBasis: premiumOf(basic, mp, inav, official, official).basis,
    inavRegular: official, sessContrib, // 공식 iNAV = 정규장 시점. 장외분은 위에서 굴린 만큼
    etfClose, vsClosePct: etfClose ? (inav / etfClose - 1) * 100 : null,
    inavChangePct: (inav / navRef - 1) * 100,
    domContrib: (inav / navRef - 1) * 100, frnContrib: 0, fxContrib: 0,
    up: 0, down: 0, coveragePct: 100, sumWg: 100,
    krSession: krSession(), fx: {},
    returns: analysis.returnPerformanceList,
    aum: analysis.totalNav, fee: analysis.totalFee,
    volume: igVal(ig, 'accumulatedTradingVolume'),
    index: idx, lev, spotEst,
    note: `국내 ${lev > 0 ? '레버리지' : '인버스'} ${lev}배 — 선물 기반이고 실시간 선물 시세는 공개 소스가 없어, 정규장 중에는 KRX 공식 iNAV를 그대로 표시합니다(본장 중 실시간 산출).`
      + (rolled ? ` 지금은 정규장이 끝나 공식 iNAV가 15:30에 멈춰 있으므로, ${rolled.night ? rolled.name : `같은 지수 1배수 ETF(${rolled.name})`}의 장외 변동 ${sgn(rolled.pct)}%를 ${lev}배로 환산해 굴린 값입니다(마감 공식값 ${official.toLocaleString('ko-KR', { maximumFractionDigits: official < 1000 ? 2 : 0 })}원 → ${sgn(sessContrib)}%).${rolled.night ? '' : ' 선물 베이시스의 장외 변화는 반영되지 않습니다.'}`
        : krSession() !== '본장' ? ' 정규장이 끝나 공식 iNAV는 15:30에 산출을 종료했고, 굴릴 기준이 될 1배수 ETF를 찾지 못해 그 시점 값에 멈춰 있습니다.' : '')
      + (idx ? ` 참고로 ${idx.label} ${idx.value.toLocaleString('ko-KR')}(${sgn(idx.changePct)}%)를 ${lev}배 단순환산하면 ${spotEst.toLocaleString('ko-KR', { maximumFractionDigits: spotEst < 1000 ? 2 : 0 })}원 — 마감 공식값과의 차이가 선물 베이시스입니다.` : '')
      + (idx && !idx.live ? ' 지수도 본장 마감으로 산출 종료.' : ''),
    rows: [], moreCount: 0, pdfDate: '-',
    asOf: new Date().toISOString(),
  };
}

// ---------- 메인 화면 지수·환율 ----------
// 국내 지수는 네이버, 나스닥 선물·달러원은 야후. '마감' 배지 기준이 둘로 갈린다 —
// 국내 지수는 정규장에만 움직이고(야간선물은 공개 시세가 없다), 선물·환율은 24시간 돌아가므로
// 주말·휴장에만 값이 멈춘다. 그래서 후자는 시각으로 정하지 않고 '시세가 멈췄는지'로 본다.
// 네이버 지수의 등락폭에는 부호가 이미 들어 있다(실측 "-187.08"). 여기에 code로 다시 부호를 씌우면
// 하락이 상승으로 뒤집힌다(실측 2026-08-06 09:30 코스피 -198 → +198). code는 값이 절댓값으로 올 때만
// 쓰는 보정으로 두고, 부호가 이미 있으면 그대로 둔다.
const navIdxChg = d => {
  const v = num(d.compareToPreviousClosePrice);
  return /^[45]$/.test(d.compareToPreviousPrice?.code || '') ? -Math.abs(v) : v;
};

// 코스피200·코스닥150 야간선물(KRX 야간시장, 대략 18:00~06:00).
// 지켜야 할 것 — ① 캐시를 줄이지 않는다 ② 실패도 캐시해서 막혔을 때 반복해 두드리지 않는다
// ③ 실패하면 조용히 지수+'마감'으로 되돌아간다(기능이 죽지 않는다) ④ 1순위가 답하면 2순위는 부르지 않는다
// 1순위는 가벼운 정적 JSON 두 개(합쳐 504B) — 세션 열림 여부와 정규장 종가를 함께 줘서
// '정규장 이후 변동'을 추정 없이 계산할 수 있다. 2순위는 형식만 다를 뿐 값은 같다.
const NIGHT_1 = 'https://moneyrecipe.blog/wp-content/uploads/data/kospi-night';
const NIGHT_2 = 'https://yasun.gg/api/prices';
const NIGHT_INS = [['latest_kospi', '^KS200'], ['latest_kosdaq', '^KQ150']];

// 야간선물만 25초를 지킨다 — 화면이 더 자주 물어도 이 캐시가 외부 호출을 25초에 한 번으로 묶는다
const NIGHT_TTL = 25e3;
// KRX 야간파생상품시장은 18:00~익일 06:00(호가 접수 17:50부터) — 그 밖의 시간에는 값이 움직이지 않으므로
// 새로 부르지 않고 캐시에 남은 마지막 값을 쓴다. 06:00~09:00에는 그 값을 '마감'으로 계속 보여주고,
// 09:00부터는 쓰지 않으므로 캐시가 비어 있어도 부르지 않는다.
const nightSessionNow = () => { const hm = kstHm(); return hm >= 1750 || hm < 600; };

async function nightFutures() {
  if (!nightSessionNow()) {
    const c = cache.get('night');
    if (c?.data) return c.data; // 만료 여부와 무관하게 마지막 값을 그대로
    if (kstHm() >= 900) return {};
  }
  return cached('night', NIGHT_TTL, async () => {
    const out = {};
    let ok1 = false;
    try {
      await Promise.all(NIGHT_INS.map(async ([file, key]) => {
        const d = await getJson(`${NIGHT_1}/${file}.json`);
        ok1 = true;
        const c = d.p?.c, r = d.p?.r; // c=현재가, r=정규장 종가(변동의 기준)
        if (!(c > 0) || !(r > 0)) return;
        out[key] = {
          value: c, chg: c - r, chgPct: (c / r - 1) * 100,
          open: !!d.m?.o, // 세션이 닫혀도 마지막 값은 남긴다 — 새벽에는 그게 가장 최신이다
          // 갱신 시각은 타임존 없는 KST 문자열 — 서버가 UTC(GCP)면 그냥 파싱하면 9시간 어긋난다
          ts: Date.parse(String(d.m.u).replace(' ', 'T') + '+09:00'),
        };
      }));
    } catch (e) { /* 아래 폴백 */ }
    if (ok1) return out; // 1순위가 답했으면 '세션 없음'이라는 판단도 그대로 받는다
    try {
      const arr = await getJson(NIGHT_2);
      for (const [, key] of NIGHT_INS) {
        const r = Array.isArray(arr) ? arr.find(x => x.symbol === key) : null;
        // 이쪽은 세션 플래그가 없다 — 체결 시각이 최근이면 열린 것으로 본다
        if (r && r.price > 0) out[key] = { value: r.price, chg: r.change, chgPct: r.changePercent,
          ts: r.timestamp, open: Date.now() - r.timestamp < 6 * 60e3 };
      }
    } catch (e) { /* 둘 다 막히면 지수+'마감'으로 돌아간다 */ }
    return out;
  });
}
// 야간선물 등락의 기준값은 '당일 정규장 선물 종가'다(실측: 1,032.10 + 9.95 = 1,042.05 = 네이버 FUT 종가).
// 그래서 chgPct를 그대로 '정규장 이후 변동률'로 쓸 수 있다.
const nightLive = q => !!q && q.open && Date.now() - q.ts < 6 * 60e3 && Number.isFinite(q.chgPct);
// 세션이 끝난 뒤에도(대략 05:00~09:00) 그 마지막 값이 정규장 종가 다음으로 최신이다 —
// 그 구간에는 값을 그대로 두고 '마감'만 붙인다. 15:30~18:00(야간 개장 전)에는 전날 밤 값이라 쓰지 않는다.
const nightUsable = q => !!q && Number.isFinite(q.chgPct)
  && (nightLive(q) || (kstHm() < 900 && Date.now() - q.ts < 24 * 3600e3));

// 카드마다 캐시를 따로 둔다 — 전체를 한 번 더 캐시하면 가장 긴 주기에 다 묶여 버린다.
// 국내 지수는 종목 시세와 같은 선(로컬 10초·서버 20초)까지 당기고, 야후는 환율과 같은 15초,
// 야간선물만 30초를 지킨다. 이 선들은 차단당하지 않는 한계로 확인된 값이라 더 줄이지 않는다.
const IDX_TTL = LOCAL ? 8e3 : 17e3;
const YF_TTL = 15e3;
// 지수는 정규장에만 움직인다 — 장외에는 새로 부르지 않고 마지막 값을 쓴다.
// 단 장중에 받아 둔 값은 종가가 아니므로(marketStatus=OPEN) 마감 후 한 번은 다시 받아 종가로 바꾼다.
const naverIndex = async (code, live) => {
  const key = `idx:${code}`;
  if (!live) {
    const c = cache.get(key);
    if (c?.data && c.data.marketStatus !== 'OPEN') return c.data;
  }
  return cached(key, IDX_TTL, () => getJson(`https://m.stock.naver.com/api/index/${code}/basic`));
};

async function marketQuotes() {
  const nf = await nightFutures();
  const inMkt = krSession() === '본장';
  const kr = async (code, name, nq, futName) => {
    // 야간선물 카드로 갈아 끼울 때는 지수를 아예 부르지 않는다(그 시간엔 값이 멈춰 있어 쓸 데가 없다)
    if (!inMkt && nightUsable(nq)) {
      return { name: futName, value: nq.value, chg: nq.chg, chgPct: nq.chgPct,
        closed: !nightLive(nq), night: true };
    }
    const d = await naverIndex(code, inMkt);
    // 등락률은 역산하지 않고 네이버가 주는 값을 그대로 쓴다(fluctuationsRatio에 부호가 들어 있다)
    const pct = num(d.fluctuationsRatio);
    return { name, value: num(d.closePrice), chg: navIdxChg(d),
      chgPct: Number.isFinite(pct) ? pct : null, closed: !inMkt };
  };
  const yf = async (sym, name) => {
    const m = (await cached(`yfq:${sym}`, YF_TTL, () =>
      getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`)))
      .chart.result[0].meta;
    const v = m.regularMarketPrice, prev = m.chartPreviousClose;
    // 야후 선물은 최대 10분 지연될 수 있어 임계를 30분으로 둔다(평일 1시간 휴장도 '마감'으로 잡힌다 — 사실이다)
    const stale = !m.regularMarketTime || Date.now() / 1000 - m.regularMarketTime > 1800;
    return { name, value: v, chg: prev ? v - prev : null, chgPct: prev ? (v / prev - 1) * 100 : null, closed: stale };
  };
  const jobs = [kr('KOSPI', '코스피', nf['^KS200'], '코스피200 야간선물'), kr('KOSDAQ', '코스닥', nf['^KQ150'], '코스닥150 야간선물')]
    .concat([['NQ=F', '나스닥 선물'], ['KRW=X', '달러/원']].map(([s, n]) => yf(s, n)));
  const names = ['코스피', '코스닥', '나스닥 선물', '달러/원'];
  const rs = await Promise.allSettled(jobs);
  // 한 곳이 막혀도 나머지 카드는 살린다 — 실패분은 값 없이 자리만 지킨다
  return rs.map((r, i) => r.status === 'fulfilled' ? r.value : { name: names[i], value: null, closed: false });
}

// ---------- 레버리지·인버스·합성: 기초 ETF 바스켓 × 배수로 추정 ----------
async function computeSynthetic(stockCode, baseCode, analysis, basic, levOverride) {
  const nm = basic.stockName;
  const lev = levOverride ?? (/인버스\s?2X/.test(nm) ? -2 : /인버스/.test(nm) ? -1 : /레버리지/.test(nm) ? 2
    : /\(합성/.test(nm) ? 1 : null); // 1배 합성형은 실물 형제 ETF 바스켓 그대로
  if (lev == null) throw new Error(`배수 판별 불가: ${nm}`);

  const base = await computeINav(baseCode, 1);
  // 기초 ETF가 제대로 추적돼야 배수를 곱할 값이 생긴다.
  //  - sumWg 0  → 0으로 나눠 NaN이 화면에 그대로 나간다(실측: KIWOOM 미국달러선물레버리지)
  //  - 반영률 0 → 변동이 0%로 나와 '기준 NAV 그대로'인 가짜 추정이 된다(실측: RISE 국채선물10년인버스)
  //  - 반영률이 낮으면 소수 종목에서 외삽한 오차가 배수만큼 증폭된다(실측: 차이나전기차 8% → 오차 1.2%p)
  const baseCov = base.coveragePct;
  if (base.isOfficial || !(base.sumWg > 0) || !Number.isFinite(base.inavChangePct) || !(baseCov >= 50)) {
    return officialOnly(stockCode, analysis, basic,
      `기초 ETF(${base.etfName})의 구성종목을 충분히 추적할 수 없음(반영률 ${(baseCov || 0).toFixed(0)}%)`);
  }
  // 기초 바스켓 수익률 분해: 현지가격 vs 환율
  // 기여도는 wgBase(정규화 기준)로 나눠야 한다 — 상위10 폴백이면 sumWg(≈50)와 어긋나 2배로 튄다
  const bw = base.wgBase || base.sumWg;
  const localRatio = 1 + (base.domContrib + base.frnContrib) / bw;
  const basketRatio = 1 + base.inavChangePct / bw; // 원화환산 누적
  // 합성형은 PDF가 스왑뿐이라 CU 역산이 불가. 기초 ETF가 최신 기준(재앵커·지연 보정)으로 옮겨졌다면
  // 자기 NAV도 같은 시점으로 맞춘다: ① integration API의 최신 기준가 ② 없으면 전영업일 수익률(D1)로 하루 굴림.
  let navRef = analysis.nav, navAdjusted = false, navRefDate = analysis.navPerformanceReferenceDate;
  if (base.navAdjusted) {
    const ig = await integrationOf(stockCode).catch(() => null);
    const igNav = parseFloat((ig?.totalInfos?.find(t => t.code === 'nav')?.value || '0').replace(/,/g, ''));
    // 본장 중 integration nav는 실시간 iNAV라 기준으로 못 쓴다 — 장외에 저장해 둔 잠정값으로 대체.
    // 잠정값은 프레임 날짜가 기초 ETF의 현재 프레임과 같을 때만(어제 값을 오늘 프레임에 붙이면 하루치 어긋남)
    const frameD = String(base.navRefDate || '').replace(/\D/g, '').slice(0, 8);
    const provRec = cache.get(`provnav:${stockCode}`);
    const navAlt = krSession() !== '본장' ? igNav
      : (provRec && Date.now() - provRec.ts < provRec.ttl && provRec.data?.d === frameD ? provRec.data.nav : null);
    if (krSession() !== '본장' && igNav && Math.abs(igNav / analysis.nav - 1) > 0.001) {
      cache.set(`provnav:${stockCode}`, { ts: Date.now(), ttl: 2 * 86400e3, data: { nav: igNav, d: frameD } });
      saveCache();
    }
    if (navAlt && Math.abs(navAlt / analysis.nav - 1) > 0.001) {
      navRef = navAlt; navAdjusted = true; navRefDate = base.navRefDate; // 기초와 같은 최신 영업일
    } else if (base.staleNav && base.navRef !== base.staleNav) {
      // 기초 NAV가 프레임 이동한 비율에 배수를 적용해 자기 NAV를 같은 프레임으로 굴린다
      // (본장 중엔 integration nav가 실시간이라 못 쓰므로 이 경로가 주력)
      navRef = analysis.nav * (1 + lev * (base.navRef / base.staleNav - 1));
      navAdjusted = true; navRefDate = base.navRefDate;
    } else {
      const d1 = analysis.navPerformanceList?.find(x => x.periodTypeCode === 'D1')?.value;
      if (typeof d1 === 'number') { navRef = navRef * (1 + d1 / 100); navAdjusted = true; }
    }
  }
  // 배수는 '원화환산' 지수 수익률에 적용(환율도 L배) — 공식 iNAV 역산으로 검증됨. (H)면 환헤지라 현지수익률만.
  const combined = /\(합성\s*H\)|\(H\)/.test(nm) ? localRatio : basketRatio; // (H)=환헤지
  // ponytail: 일간 복리 리셋 무시(기준 NAV 이후 1거래일 가정) — 주말 낀 구간은 오차 가능
  const inav = navRef * (1 + lev * (combined - 1));
  const mp = marketPx(basic), marketPrice = mp.price;
  // 기초의 정규장 이후 세션분에 배수 적용 → 시장가(정규장 종가)와 시점을 맞춘 괴리율
  const sessContrib = lev * (base.sessContrib || 0);
  const inavRegular = inav / (1 + sessContrib / 100);

  return {
    ...base,
    etfName: basic.stockName, code: stockCode,
    issuer: analysis.issuerName, baseIndex: analysis.etfBaseIndex,
    navRef, navRefDate, navAdjusted,
    inav, marketPrice,
    marketChangePct: mp.changePct, marketChange: mp.change, marketOver: mp.over,
    premiumPct: premiumOf(basic, mp, inav, inavRegular, navRef).pct,
    premiumBasis: premiumOf(basic, mp, inav, inavRegular, navRef).basis,
    inavRegular, sessContrib,
    etfClose: etfCloseOf(basic), vsClosePct: etfCloseOf(basic) ? (inav / etfCloseOf(basic) - 1) * 100 : null,
    inavChangePct: (inav / navRef - 1) * 100,
    // 형제 ETF 대체(1배)는 기초의 국내/해외 분해를 그대로 승계, 배수형은 배수 적용
    domContrib: levOverride === 1 ? base.domContrib : 0,
    frnContrib: levOverride === 1 ? base.frnContrib : lev * (localRatio - 1) * 100,
    fxContrib: levOverride === 1 ? base.fxContrib : lev * (combined - localRatio) * 100,
    returns: analysis.returnPerformanceList,
    aum: analysis.totalNav, fee: analysis.totalFee,
    volume: await volumeOf(stockCode),
    note: levOverride === 1
      ? `운용사 PDF를 받을 수 없어(사이트 차단) 같은 상품을 추종하는 ${base.etfName}(${base.code})의 구성종목으로 대체 계산했습니다. 아래 종목은 해당 ETF 구성.`
      : `합성 ETF — 기초 ETF(${base.etfName} ${base.code}) 원화환산 바스켓 × ${lev}배${combined === localRatio ? ' (환헤지)' : ''}로 추정. 아래 종목은 기초 ETF 구성.`,
    asOf: new Date().toISOString(),
  };
}

// ---------- 본체 ----------
async function computeINav(stockCode, depth = 0) {
  // etfAnalysis는 하루 단위 데이터(구성·NAV·성과)라 길게, basic은 시세라 갱신 주기에 맞춰 짧게 캐시
  const [analysis, basic] = await Promise.all([
    getAnalysis(stockCode),
    cached(`ba:${stockCode}`, QUOTE_TTL, () => getJson(`https://m.stock.naver.com/api/stock/${stockCode}/basic`)),
    loadKrDays(), // 거래일 달력 — 6시간 캐시라 실질 비용 없음. 아래 날짜 계산이 공휴일을 건너뛰려면 필요
  ]);
  noteKrStatus(basic.marketStatus); // 공휴일 판정 (ETF는 거래정지가 사실상 없어 시장 상태로 볼 수 있다)
  // 레버리지·인버스·합성형: PDF가 실물 바스켓이 아님(스왑/선물/TRS/레버리지ETF 혼합)
  // → 기초 ETF가 매칭되면 그 바스켓 × 배수로 추정
  if (depth === 0 && /레버리지|인버스|\(합성/.test(basic.stockName || '')) {
    // 국내지수 선물형을 먼저 판정 — 기초 ETF 바스켓(현물)으로 계산하면 선물 베이시스를 놓친다
    // (실측: 급락장에서 선물이 현물보다 1.8%p 더 하락 → 2배 상품은 오차 3.5%)
    const dom = await computeDomesticLev(stockCode, analysis, basic);
    if (dom) return dom;
    const baseCode = await findBaseCode(basic.stockName, stockCode, analysis.etfBaseIndex);
    if (baseCode) return computeSynthetic(stockCode, baseCode, analysis, basic);
    // 기초 ETF를 못 찾으면 여기서 멈춘다. 이런 상품의 PDF는 스왑·TRS·선물이라 실물 바스켓이 아니고
    // (비중 합이 음수이거나 200%이기도 하다) 그대로 계산하면 전혀 다른 값이 나온다.
    // 실측 — 423920: 비중 합 -47.8%, 반영률 -35.2%, 괴리율 +30.8%.
    // 전수 점검(179종목) 결과 이 경로로 내려온 것 중 쓸 만한 추정치는 하나도 없었다.
    return officialOnly(stockCode, analysis, basic, '레버리지·인버스·합성형이라 PDF가 스왑·선물로 구성됨');
  }

  const [issuerKey, adapter] = adapterOf(analysis.issuerName);
  let pdf, skipped = false;
  try {
    if (!adapter) throw new Error(`지원하지 않는 운용사: ${analysis.issuerName || '알 수 없음'}`);
    if (issuerBlocked(issuerKey)) { skipped = true; throw new Error(`${issuerKey} 오늘 차단됨 — 폴백 사용`); }
    pdf = await adapter.pdf(stockCode);
  } catch (e) {
    // 건너뛰어서 던진 것까지 다시 기록하면 차단 기한이 매번 새로 쓰여(24시간 → 10분) 계속 재시도한다
    if (!skipped) noteIssuerFail(issuerKey, e);
    // 폴백은 기초 ETF를 계산하는 중(depth 1)에도 필요하다. 예전엔 여기서 바로 throw해서
    // 레버리지 상품의 기초가 KODEX면 운용사 차단 한 번에 전체가 에러로 끝났다.
    // ① FunETF — 전 운용사 전체 PDF(실제 구성종목). 운용사 API와 같은 품질이라 최우선 대체.
    try { pdf = await funetfPdf(stockCode); pdf.altSource = 'FunETF'; }
    catch (e1) {
      // ② 같은 상품의 타 운용사 ETF 바스켓 — 재귀하므로 최상위에서만
      const sib = depth === 0 ? await findSiblingCode(basic.stockName, stockCode).catch(() => null) : null;
      if (sib) return computeSynthetic(stockCode, sib, analysis, basic, 1);
      // ③ 네이버 상위10
      try { pdf = await naverTop10Pdf(stockCode, analysis); }
      // ④ 그래도 안 되면 추정을 포기하고 KRX 공식 iNAV만 보여준다
      catch (e2) { return officialOnly(stockCode, analysis, basic, e.message); }
    }
  }
  const rebal = notePdfSet(stockCode, pdf); // 리밸런싱 감지(설명은 notePdfSet 주석에)
  // 추적 상한은 시세 조회 비용에 맞춰 국내/해외를 따로 잡는다.
  // 국내는 토스 배치 1회(정규장) → 사실상 전량 추적 가능. 해외는 야후 종목별 호출이라 상위 비중만.
  // (코스닥150 같은 국내 다종목 ETF의 반영률이 78%에 머물던 원인)
  const isKrCode = jm => /^\d{6}$/.test(jm) || /^KR7\d{9}$/.test(jm);
  const MAX_KR = krSession() === '본장' ? 400 : 100; // 정규장 외엔 네이버 개별 조회라 보수적으로
  const MAX_FRN = MAX_FRN_TRACK;
  const byWg = [...pdf.list].sort((a, b) => b.wg - a.wg);
  let nKr = 0, nFrn = 0;
  const trackable = new Set();
  for (const r of byWg) {
    if (isKrCode(r.jm || '')) { if (nKr++ < MAX_KR) trackable.add(r); }
    else if (nFrn++ < MAX_FRN) trackable.add(r);
  }
  const holdings = await Promise.all(pdf.list.map(async r => ({
    ...r, valRef: r.valAm,
    t: trackable.has(r) ? await resolveTicker(r.jm, r.name).catch(() => null) : null,
  })));

  // 시세 일괄 조회
  const fxCurs = [...new Set(holdings.filter(h => h.t && h.t.cur !== 'KRW').map(h => h.t.cur))];
  const krCodes = holdings.filter(h => h.t?.src === 'kr').map(h => h.t.sym);
  const yahooSyms = holdings.filter(h => h.t?.src === 'yahoo').map(h => h.t.sym);
  const [fxArr, krMap, ...yq] = await Promise.all([
    Promise.all(fxCurs.map(c => yahooQuote(`${c}KRW=X`))),
    krCodes.length ? krQuotes(krCodes) : {},
    ...yahooSyms.map(s => yahooQuote(s).catch(() => null)),
  ]);
  const fx = Object.fromEntries(fxCurs.map((c, i) => [c, fxArr[i]]));
  const yMap = Object.fromEntries(yahooSyms.map((s, i) => [s, yq[i]]));

  // 미국 종목: 야후가 휴장인 시간대(주간거래)엔 토스 시세로 대체
  const usHolds = holdings.filter(h => h.t?.src === 'yahoo' && h.t.cur === 'USD'
    && ['휴장', '장마감'].includes(yMap[h.t.sym]?.session)); // 장마감(당일 거래 있었음)도 주간거래 대상
  if (usHolds.length) {
    try {
      const codes = await Promise.all(usHolds.map(h => tossCodeOf(h.t.sym).catch(() => null)));
      const codeMap = {};
      usHolds.forEach((h, i) => { if (codes[i]) codeMap[h.t.sym] = codes[i]; });
      const valid = Object.values(codeMap);
      if (valid.length) {
        const tp = await tossPrices(valid);
        const day = usDaySession();
        for (const [sym, code] of Object.entries(codeMap)) {
          const p = tp[code];
          if (!p || !p.close) continue;
          const q = yMap[sym];
          yMap[sym] = { ...q, last: p.close, regClose: p.base || q.regClose, session: day ? '주간' : '휴장' };
        }
      }
    } catch (e) { /* 주간거래 시세 실패 시 야후 마지막 체결가 유지 */ }
  }

  const quoteOf = h => h.t ? (h.t.src === 'kr' ? krMap[h.t.sym] : yMap[h.t.sym]) : null;

  const dig8 = s => String(s || '').replace(/\D/g, '').slice(0, 8);
  const navD = dig8(analysis.navPerformanceReferenceDate);

  // 평가금액 미제공 운용사(PLUS): 전일종가×수량 근사는 해외장이 새 세션을 열면 한 칸 밀리고,
  // 주말엔 두 세션까지 밀린다(실측 2026-08-02: 글로벌HBM 442580 해외 -2.1%p vs 실제 +11%).
  // 기준 NAV 날짜 직전의 확정 일봉 종가 × 그 시점 환율로 기준액을 만들어 시점을 고정한다.
  const noRef = holdings.filter(h => h.t && !h.valRef && h.qty && h.t.cur !== 'KRW' && h.t.src === 'yahoo');
  if (noRef.length && navD) {
    await Promise.all(noRef.map(async h => {
      const days = await dailyCloses(h.t.sym).catch(() => null);
      const bar = days && [...days].reverse().find(x => dig8(x.d) < navD);
      if (!bar) return;
      const fxBar = await fxFixOf(h.t.cur, bar.d).catch(() => null);
      if (!fxBar) return;
      h.valRef = h.qty * bar.c * fxBar;
    }));
  }

  // PDF에 내포된 기준환율을 역산 (통화별 중앙값).
  // 야후 환율의 chartPreviousClose는 외환 일봉 경계(23:00 UTC)라 "어제 한국장 마감" 시점이 아니다
  // (실측: 4일 전 값이 오기도 함). PDF 평가금액은 운용사가 실제로 쓴 환율을 품고 있으므로 그게 정답.
  let { fxRef, fxRefDate } = await resolveFxRef(holdings, quoteOf);

  // ---------- 기준 NAV 확정 ----------
  // 네이버의 nav 날짜 라벨(navPerformanceReferenceDate)은 아침에 값보다 먼저 갱신되기도 해 믿을 수 없다
  // (실측 2026-08-03 아침: 라벨은 07-31인데 값은 목요일 NAV 그대로 → PLUS 괴리 +12%로 표시).
  // 그래서 라벨이 아니라 데이터로 판정한다: CU 라운드 검사가 실패했거나 integration nav가 2% 이상
  // 다르면 igNav를 후보에 넣어 다시 채점하고, 현재 바스켓과 라운드로 맞아떨어지는 쪽을 쓴다.
  const fmtYmd = dt => dt.getFullYear() + '.' + String(dt.getMonth() + 1).padStart(2, '0') + '.' + String(dt.getDate()).padStart(2, '0');
  const targetDt = (() => { // 기준 NAV가 존재할 가장 최근 한국 영업일
    // 09시(당일 기준가 발표)부터는 당일 — 증권사 앱이 보여주는 NAV가 바로 당일 기준가라
    // (실측: 토스 "8월 3일 기준 NAV"), 전일 기준가를 쓰면 사용자가 보는 값과 하루 어긋난다.
    // 15:30 마감 후에는 같은 날짜로 잠정(마감 iNAV) 프레임이 이어진다. 09시 전엔 전 영업일.
    const k = new Date(Date.now() + 9 * 3600e3);
    const dt = new Date(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate());
    if (k.getUTCHours() < 9) dt.setDate(dt.getDate() - 1);
    // 주말뿐 아니라 공휴일도 건너뛴다 — 안 그러면 존재하지 않는 기준가 날짜를 목표로 삼아 재앵커가 어긋난다
    while (dt.getDay() === 0 || dt.getDay() === 6 || !isKrBiz(dig8(fmtYmd(dt)))) dt.setDate(dt.getDate() - 1);
    return dt;
  })();
  const targetD = dig8(fmtYmd(targetDt));
  const nextBizYmd = b => { // basis 다음 거래일(주말·공휴일 건너뜀) — 그 basis와 짝이 되는 NAV 날짜
    const dt = new Date(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8));
    do { dt.setDate(dt.getDate() + 1); } while (dt.getDay() === 0 || dt.getDay() === 6 || !isKrBiz(dig8(fmtYmd(dt))));
    return fmtYmd(dt);
  };
  let navInfo = resolveNavRef(analysis, pdf.list);
  let navRefDateOut = analysis.navPerformanceReferenceDate;
  const ig0 = await integrationOf(stockCode).catch(() => null);
  const igNavG = parseFloat((ig0?.totalInfos?.find(t => t.code === 'nav')?.value || '0').replace(/,/g, '')) || null;
  const pdfHasValAm = pdf.list.some(r => r.valAm > 0);
  const curBasis0 = Object.entries(fxRefDate).filter(([c]) => c !== 'JPY').map(([, d]) => dig8(d)).sort().pop()
    || dig8(fxRefDate.JPY);
  const targetBasis = await (async () => { // 목표 basis = targetD 직전의 확정 해외 종가일
    if (!curBasis0) return null;
    let best = null;
    const top = holdings.filter(h => h.t?.src === 'yahoo' && quoteOf(h)?.last).sort((a, b) => b.wg - a.wg).slice(0, 3);
    for (const h of top) {
      const days = await dailyCloses(h.t.sym).catch(() => null);
      const d = days && [...days].reverse().find(x => dig8(x.d) < targetD);
      if (d && (!best || dig8(d.d) > best)) best = dig8(d.d);
    }
    return best;
  })();
  // integration nav의 의미는 시간대에 따라 다르다(실측):
  //  - 본장(09:00~15:30): 실시간 iNAV — 계속 움직이므로 기준 NAV로 쓰면 안 된다
  //    (실측 2026-08-03 장중: PLUS가 장중 iNAV를 기준 삼아 괴리 +5.8%로 오표시)
  //  - 장외: 직전 마감(15:30) 시점 값으로 얼어 있음 → '잠정 기준 NAV'로 쓴다.
  //    장마감 후엔 이 잠정 NAV 기준으로 계산하고, 다음 영업일 공식 기준가가 나오면 자동 교체된다.
  //    본장 중에 기준이 필요하면 장외 시간에 저장해 둔 값(provnav)을 쓴다.
  const inKrMarket = krSession() === '본장';
  const provRec = cache.get(`provnav:${stockCode}`);
  // 저장해 둔 잠정 NAV는 그 프레임 날짜가 지금 목표 프레임과 같을 때만 쓴다 —
  // 다음 날 아침 본장에서 어제 잠정값을 오늘 프레임에 붙이면 하루치가 통째로 어긋난다
  // (실측 2026-08-04 09:29: 레버리지 기준 NAV가 어제 값 그대로 → 괴리 +7%로 표시)
  const expFrame = curBasis0 ? dig8(nextBizYmd(curBasis0)) : targetD;
  const provNav = provRec && Date.now() - provRec.ts < provRec.ttl
    && provRec.data?.d === expFrame ? provRec.data.nav : null;
  const refNavAlt = !inKrMarket ? igNavG : provNav;
  // 바스켓이 이미 최신 basis일 때만 NAV를 단독 교체한다 — 낡은 바스켓에 최신 NAV를 붙이면 짝이 어긋난다.
  // (낡은 바스켓은 아래 재앵커가 NAV와 함께 통째로 옮긴다)
  const basketCurrent = !targetBasis || !curBasis0 || curBasis0 >= targetBasis;
  if (basketCurrent && refNavAlt && (!navInfo.cuShares || Math.abs(refNavAlt / navInfo.navRef - 1) > 0.02)) {
    if (pdfHasValAm) {
      const retry = resolveNavRef(analysis, pdf.list, [refNavAlt]);
      if (retry.fresh) {
        navInfo = { ...retry, staleNav: analysis.nav, prov: true };
        if (curBasis0) navRefDateOut = nextBizYmd(curBasis0);
      }
    } else if (Math.abs(refNavAlt / navInfo.navRef - 1) > 0.02) {
      // 평가금액 없는 PDF(PLUS)는 CU 검사가 불가 — 2% 이상 다르면 잠정 NAV를 신뢰한다.
      navInfo = { navRef: refNavAlt, adjusted: true, staleNav: navInfo.navRef, prov: true };
      if (curBasis0) navRefDateOut = nextBizYmd(curBasis0);
    }
  }

  // ---------- 기준 시점 통일(재앵커) ----------
  // 운용사마다 PDF 갱신 시차가 있어(예: 미래에셋은 주말에 다음 거래일 PDF를 미리 올리고 삼성은 안 올림)
  // 같은 지수 ETF끼리 기준 NAV 날짜가 갈리고, 환율·해외 변동이 서로 다른 구간을 재게 된다.
  // 발동 조건은 날짜 라벨이 아니라 「해외 종가 기준일(basis)이 목표보다 낡았는가」 — 데이터만 본다.
  // 결과는 CU 라운드/바스켓 정합 검사로 검증 — 실패하면 원래 짝 유지.
  // 장외에는 구성과 무관하게 '마감 잠정 프레임'으로 옮긴다(아직 안 옮겼다면).
  // 예전엔 국내 전용(!curBasis0)만 대상이었는데, 해외 ETF도 해외 종가일이 그대로여도
  // (미국장이 아직 안 열려 마지막 확정 종가가 어제와 같은 경우) 환율 기준이 15:30 스팟으로 바뀐다.
  // 안 옮기면 '어제 기준가 vs 오늘 종가'를 비교해 괴리율이 하루치만큼 튄다
  // (실측 2026-08-04 18시 ACE 미국빅테크TOP7: 우리 +3.33% vs 공식 +0.06%).
  const provFrame = !inKrMarket && igNavG && dig8(navRefDateOut) && dig8(navRefDateOut) < targetD;
  reanchor: if ((curBasis0 && targetBasis && curBasis0 < targetBasis) || provFrame) {
    // 새 프레임의 기준 NAV 후보:
    //  - 장외: 얼어 있는 마감 iNAV(잠정) — 검증 통과 시 채택
    //  - 본장: integration nav는 해외 100% ETF에선 하루 고정(전일 해외종가×당일 고시환율 = 당일 기준가,
    //    실측: 토스 표기 NAV와 일치)이라 검증 통과 시 채택. 혼합형은 국내 레그 때문에 실시간으로
    //    움직여 검증에서 걸러진다 → 검증된 전일 NAV를 바스켓 변동으로 굴린 재구성값으로 대체
    //    (기준가 = 총액/CU/(1-현금) 이므로 navNew = navOld × 총액비 — 정의상 성립).
    const igNav = igNavG;
    // 국내 종목은 valRef가 없어도 '전일종가' 기준이 암묵 기준액이므로 함께 옮긴다(혼합 ETF·PLUS)
    const trackedHs = holdings.filter(h => h.t && quoteOf(h)?.last > 0
      && (h.valRef > 0 || (h.t.cur === 'KRW' && quoteOf(h).prevClose > 0)));
    if (!trackedHs.length) break reanchor;
    const oldRefOf = h => h.valRef ?? h.qty * quoteOf(h).prevClose;
    const newRef = new Map();
    await Promise.all(trackedHs.map(async h => {
      const q = quoteOf(h);
      if (h.t.cur === 'KRW') {
        // 국내 기준 종가: 본장 중엔 전일종가(당일 기준가 프레임), 장외엔 오늘 종가(잠정 프레임)
        const px = inKrMarket ? q.prevClose : q.regClose;
        if (px > 0) newRef.set(h, h.qty * px);
        return;
      }
      if (h.t.src !== 'yahoo') return;
      const days = await dailyCloses(h.t.sym).catch(() => null);
      const bar = days && [...days].reverse().find(x => dig8(x.d) < targetD);
      if (!bar) return;
      // 환율 기준: 잠정(마감 iNAV) 프레임은 마감 15:30 시점 스팟 — 마감 이후 환율 변동이
      // 그 시점부터 측정되도록. 본장(당일 기준가) 프레임은 고시환율(다른 ETF 역산값 우선).
      // ⚠ 기준일은 미국 종가일(bar.d)이 아니라 목표 프레임의 한국 날짜(targetD)다 —
      // 한국 8/6 기준가는 '미국 8/5 종가 × 8/6 고시환율'로 만들어진다. bar.d로 부르면 하루 밀려
      // 환율 변동이 통째로 어긋난다(실측 2026-08-06: 1,433.75가 잡혀 iNAV가 공식 대비 −1.2%).
      const fix = !inKrMarket
        ? await fxCloseSpot(h.t.cur, targetD).catch(() => fxFixOf(h.t.cur, targetD)).catch(() => null)
        : await fxFixOf(h.t.cur, targetD).catch(() => null);
      if (fix) newRef.set(h, h.qty * bar.c * fix);
    }));
    // 일봉을 못 구한 종목이 소수(비중 2% 이하)면 그 종목만 빼고 진행 — 일시적 야후 실패로
    // 전체 이동이 무산되던 문제(실측: 100종목 ETF에서 1종목 실패로 프레임 갱신 불발)
    const missWg = trackedHs.filter(h => !newRef.has(h)).reduce((s, h) => s + h.wg, 0);
    if (missWg > 2) break reanchor;
    const movedHs = trackedHs.filter(h => newRef.has(h));
    const oldSum = movedHs.reduce((s, h) => s + oldRefOf(h), 0);
    const newSum = movedHs.reduce((s, h) => s + newRef.get(h), 0);
    // PDF 총액을 새 시점으로 환산해 CU 좌수 역산 (평가금액 없는 PDF는 추적분 합으로 대신)
    const totalNew = (pdf.list.reduce((s, r) => s + (r.valAm || 0), 0) || oldSum) * (newSum / oldSum);
    // PDF가 순자산의 일부만 담는 상품(채권혼합)에서 (1−현금)을 쓰면 아래 두 검증이 모두 어긋난다
    // (실측 0186S0: cuEst 29,447 vs 실제 CU 50,000 → 검증 실패 후 재구성값이 공식 대비 +2.8%)
    const share = pdfShare(pdf.list, analysis);
    const basketChg = newSum / oldSum - 1;
    let adoptNav = null, cuOk = false, cuEst = null, prov = !inKrMarket;
    if (igNav && Math.abs(igNav / navInfo.navRef - 1) <= 0.001) {
      // 이미 사실상 같은 값 — 검증할 게 없으니 공식값을 그대로 쓴다.
      // 예전엔 이 경우를 건너뛰어 아래 재구성(굴림)으로 갔는데, 그게 오히려 어긋났다
      // (실측 448330: igNav 16,913.64와 0.017% 차이인데 굴려서 16,935.80 → 괴리 −0.21%, 정답 −0.08%).
      adoptNav = { navRef: igNav };
    } else if (igNav) {
      // igNav 검증 ①: CU 좌수 라운드 ②: 두 시점 사이 바스켓 변동 ≒ NAV 변동
      cuEst = totalNew / (igNav * share);
      const cu = CU_ROUND.reduce((b, x) => Math.abs(x / cuEst - 1) < Math.abs(b / cuEst - 1) ? x : b);
      cuOk = Math.abs(cu / cuEst - 1) <= 0.015;
      const navChg = (igNav / navInfo.navRef - 1) / share;
      if (cuOk || Math.abs(basketChg - navChg) < 0.01) adoptNav = { navRef: igNav, cuShares: cuOk ? cu : undefined, cuEst: cuOk ? cuEst : undefined };
    }
    if (!adoptNav && !pdfHasValAm && igNav && inKrMarket) {
      // 평가금액 없는 PDF(PLUS)는 전일 NAV를 검증할 수 없어 굴림도 못 믿는다(실측: 네이버 nav가
      // 마감 iNAV 값으로 churn → 굴린 결과가 토스 기준가와 +4.4% 어긋남).
      // 대신 KRX 실시간 iNAV에서 국내 레그의 당일 변동분을 걷어내면 당일 기준가가 나온다
      // (KRX iNAV = 당일기준가 × (1 + 국내 당일변동 기여) — 해외 레그·환율은 하루 고정이므로).
      // 급변장에선 5분 캐시된 iNAV와 지금 시세의 시점이 어긋나므로 iNAV를 새로 받아 짝을 맞춘다.
      const igF = await getJson(`https://m.stock.naver.com/api/stock/${stockCode}/integration`).catch(() => null);
      const igNavF = parseFloat((igF?.totalInfos?.find(t => t.code === 'nav')?.value || '0').replace(/,/g, '')) || igNav;
      const domLive = movedHs.filter(h => h.t.cur === 'KRW').reduce((s, h) => {
        const q = quoteOf(h); return s + h.wg * (q.last / q.prevClose - 1);
      }, 0);
      adoptNav = { navRef: igNavF / (1 + domLive / 100) };
      prov = false;
    }
    if (!adoptNav) {
      // 검증된 전일 NAV를 바스켓 변동으로 굴린 재구성(혼합형 본장 중 등). 평가금액 있는 PDF는
      // 전일 NAV가 CU 검증됐을 때만 — 안 됐으면 어긋난 값을 증폭시킬 뿐이다.
      if (pdfHasValAm && !navInfo.cuShares) break reanchor;
      if (!pdfHasValAm && inKrMarket) break reanchor; // 위에서 못 구했으면 굴리지 않는다
      adoptNav = { navRef: navInfo.navRef * (newSum / oldSum) };
      prov = false;
    }
    for (const h of movedHs) h.valRef = newRef.get(h);
    navInfo = { ...adoptNav, adjusted: true, staleNav: navInfo.navRef, prov };
    navRefDateOut = fmtYmd(targetDt);
    ({ fxRef, fxRefDate } = await resolveFxRef(holdings, quoteOf)); // 새 기준액으로 환율 기준 재역산
  }
  // 장외에서 잠정 NAV를 채택했으면 저장 — 다음 본장 중에도 같은 기준을 유지하기 위해
  if (navInfo.prov && !inKrMarket && igNavG) {
    cache.set(`provnav:${stockCode}`, { ts: Date.now(), ttl: 2 * 86400e3, data: { nav: igNavG, d: targetD } });
    saveCache();
  }
  const navRef = navInfo.navRef;

  // ---------- 기준 정합 보정(통화 공통) ----------
  // 정의상 기준 시점의 iNAV는 공식 NAV와 같아야 하는데, PDF 평가환율(아침 최초고시)과 기준가 산정
  // 환율이 다른 날이 있다 — 실측 2026-07-31: 원화가 하루 새 0.7% 움직여 서로 다른 운용사 두 곳의
  // CU 역산이 똑같이 +0.45% 어긋남(NAV 내포 환율 ≈ 1430.4 vs PDF 1424).
  // CU 좌수가 라운드 숫자라는 사실에서 어긋남(fit)을 잴 수 있지만, 종목별로 그대로 적용하면
  // 펀드 고유 잡음(보수·미수금)까지 흡수해 종목 간 일관성이 깨진다(실측: 괴리 군집 ±0.05→±0.2).
  // 그래서 단일 통화가 지배적인 ETF의 fit만 표본으로 모아 통화·기준일별 중앙값을 만들고,
  // 그 공통값을 모든 ETF에 똑같이 적용한다 — 중심은 NAV에 맞고 상대 비교는 흐트러지지 않는다.
  // 기준 NAV의 성격(확정 기준가 s / 마감 iNAV 잠정 p)에 따라 내포 환율이 다르므로 표본을 분리한다
  // (기준가=아침 최초고시, 마감 iNAV=15:30 스팟 — 섞으면 중앙값이 오염된다)
  const navSrc = navInfo.prov ? 'p' : 's';
  // 표본 칸은 '한국 기준일'로 가른다. 미국 종가일(fxRefDate)로 가르면 어제와 오늘 표본이 같은 칸에
  // 섞여, 지난 환율이 오늘 기준을 끌어당긴다(실측 2026-08-06: 1,416.6이 1,433.95로 밀려 iNAV −1.1%).
  const navFixKey = (cur, src) => `navfix:${cur}:${dig8(navRefDateOut)}:${src}`;
  const fit = navInfo.cuShares && navInfo.cuEst ? navInfo.cuShares / navInfo.cuEst : null;
  const wgByCur = {};
  for (const h of holdings) if (h.t && h.valRef > 0) wgByCur[h.t.cur] = (wgByCur[h.t.cur] || 0) + h.wg;
  const totW = Object.values(wgByCur).reduce((s, x) => s + x, 0);
  const domCur = Object.entries(wgByCur).filter(([c]) => c !== 'KRW').sort((a, b) => b[1] - a[1])[0];
  // 보정에 쓸 표본은 '이번 계산 결과를 넣기 전'의 것이어야 한다. 넣고 나서 읽으면 표본이 자기 하나뿐일 때
  // s = fit이 되어, CU 역산 오차를 그대로 기준액에 되돌려 넣는 자기참조가 된다
  // (실측 2026-08-06 ACE 미국빅테크TOP7 Plus: 환율 기준을 고쳐도 1,433.55로 되돌아와 iNAV가 공식 대비 −1.1%).
  const priorFix = {};
  for (const cur of Object.keys(fxRefDate)) {
    const rec = cache.get(navFixKey(cur, navSrc));
    if (rec && Date.now() - rec.ts < rec.ttl && rec.data.length) priorFix[cur] = medOf(rec.data);
  }
  // 기준 NAV를 우리가 재구성한 경우(재앵커·지연 보정)에는 fit이 환율 차이가 아니라 그 재구성 오차를
  // 담는다 — 그걸 표본에 넣으면 환율 보정이 엉뚱한 값을 따라간다. 공식 기준가를 그대로 쓸 때만 모은다.
  if (fit && !navInfo.adjusted && Math.abs(fit - 1) < 0.015 && domCur && domCur[1] / totW > 0.9
      && fxRef[domCur[0]] && fxRefDate[domCur[0]]) {
    const key = navFixKey(domCur[0], navSrc);
    const samples = (cache.get(key)?.data || []).slice(-14);
    samples.push(fxRef[domCur[0]] * fit);
    cache.set(key, { ts: Date.now(), ttl: 7 * 86400e3, data: samples });
    saveCache();
  }
  let refit = false;
  for (const cur of Object.keys(fxRefDate)) {
    const navFix = priorFix[cur] ?? null;
    if (!navFix || !fxRef[cur]) continue;
    const s = navFix / fxRef[cur];
    if (Math.abs(s - 1) < 0.0005 || Math.abs(s - 1) > 0.015) continue;
    for (const h of holdings) if (h.t?.cur === cur && h.valRef > 0) { h.valRef *= s; refit = true; }
  }
  if (refit) ({ fxRef, fxRefDate } = await resolveFxRef(holdings, quoteOf)); // 보정된 기준액으로 재역산

  let sumContrib = 0, sumWg = 0, coveredWg = 0, up = 0, down = 0;
  let domContrib = 0, frnContrib = 0, fxContrib = 0, sessContrib = 0;
  let wDom = 0, wFrn = 0, fxPure = 0; // 부분별 변동률 계산용(가중치·순수 환율 변동)
  const rows = holdings.map(h => {
    sumWg += h.wg;
    const q = quoteOf(h);
    if (!q || !q.last) return { ...base(h), tracked: false };
    const fxNow = h.t.cur === 'KRW' ? 1 : fx[h.t.cur]?.last;
    if (!fxNow) return { ...base(h), tracked: false };
    coveredWg += h.wg;
    // 평가금액 미제공 운용사(PLUS): 전일종가×수량으로 기준액 근사 — 해외장 야간엔 1세션 오차 가능
    const valRef = h.valRef ?? h.qty * q.prevClose * (h.t.cur === 'KRW' ? 1 : fx[h.t.cur].prevClose);
    const ratio = h.qty * q.last * fxNow / valRef; // 기준 평가액 대비 현재 가치
    const contrib = h.wg * (ratio - 1);              // iNAV 기여(%p)
    sumContrib += contrib;
    ratio >= 1 ? up++ : down++;
    // 환율 변동은 PDF 기준환율(= 어제 한국장 마감 시점) 대비로 계산
    const fxRatio = h.t.cur === 'KRW' ? 1 : fxNow / (fxRef[h.t.cur] || fx[h.t.cur].prevClose);
    if (h.t.cur === 'KRW') { domContrib += contrib; wDom += h.wg; }
    else {
      frnContrib += h.wg * (ratio / fxRatio - 1); fxContrib += h.wg * (ratio - ratio / fxRatio);
      wFrn += h.wg; fxPure += h.wg * (fxRatio - 1);
    }
    // 등락률 분리: 정규장 마감 기준(전일종가→정규장종가) + 진행 중 세션(정규장종가→현재가)
    // 정규장 진행 중이면 분리 불필요 → 하나만
    const inReg = q.session === '본장';
    const reg = q.regClose || q.prevClose;
    // 세션이 끝났어도(예: 국내 시간외가 18:00에 닫힌 뒤) 마지막 체결가는 정규장 종가와 다르고,
    // 그 차이는 여전히 '정규장 이후 변동'이다. 세션 종료를 이유로 버리면 18:00을 넘기는 순간
    // 세션분이 0으로 접혀 괴리율 시점 보정과 레버리지 굴림이 함께 죽는다(실측 2026-08-05 19:20).
    // 시간외 체결이 없던 종목은 last === reg이므로 자동으로 0이 된다.
    const sessPct = (!inReg && reg && q.last !== reg) ? (q.last / reg - 1) * 100 : null;
    // 괴리율 시점 보정은 국내 시간외만. 미국 주간거래·프리는 한국 정규장 시간대와 겹쳐
    // ETF 종가에 이미 반영돼 있어 제거하면 오히려 어긋난다(실측 확인).
    if (sessPct != null && h.t.cur === 'KRW') sessContrib += h.wg * sessPct / 100;
    // 국내 프리장(오늘 정규장 시작 전)엔 '정규장 등락'이 어제종가÷어제종가=0%로 계산되는
    // 무의미한 값 — 데이터 없음(—)으로 표시한다. 미국 프리는 전일 정규장 등락이라 실제 데이터.
    const noRegYet = h.t.src === 'kr' && q.session === '프리';
    return {
      ...base(h), tracked: true, sym: h.t.sym, cur: h.t.cur,
      price: q.last, session: q.session,
      changePct: noRegYet ? null : (inReg ? q.last / q.prevClose : reg / q.prevClose) * 100 - 100,
      sessPct,
      trackPct: ratio * 100 - 100,
    };
  });
  function base(h) { return { name: h.name, jm: h.jm, qty: h.qty, wg: h.wg }; }


  // 한 종목도 시세를 못 구했으면 외삽할 바닥이 없다. 그대로 두면 변동 0%가 나와
  // '기준 NAV = 현재 iNAV'인 가짜 추정이 된다(실측: 인도·베트남 주식, 채권형).
  if (!(coveredWg > 0)) {
    return officialOnly(stockCode, analysis, basic,
      `구성종목 ${rows.length}개 중 실시간 시세를 구할 수 있는 종목이 없음`);
  }
  // 상위10 폴백은 바스켓의 일부만 보고 나머지를 외삽한다 — 반영률이 낮으면 오차가 그대로 커진다
  // (실측: TIGER 코스닥150을 상위10만으로 계산하면 반영률 33%에 변동 +6.1%. 실제와 무관한 숫자).
  // 기초 ETF 반영률 하한(50%)과 같은 기준을 적용하고, 못 미치면 공식 iNAV로 물러난다.
  if (pdf.partial && coveredWg < 50) {
    return officialOnly(stockCode, analysis, basic,
      `운용사 PDF를 받을 수 없고 네이버 상위 ${pdf.list.length}종목의 비중 합이 ${coveredWg.toFixed(0)}%뿐임`);
  }
  // 부분별 '변동률'(가중평균) — 기여도(%p)와 달리 해외비중에 희석되지 않아,
  // 같은 통화를 추종하면 어떤 ETF든 환율 변동률이 같은 숫자로 나온다(스케일 전 원값으로 계산).
  const domRate = wDom > 0 ? domContrib / wDom * 100 : null;
  const frnRate = wFrn > 0 ? frnContrib / wFrn * 100 : null;
  const fxRate = wFrn > 0 ? fxPure / wFrn * 100 : null;

  // 미추적 종목은 추적된 바스켓의 평균 변동으로 외삽 (커버리지 100%면 무영향)
  // 상위10 폴백(partial)은 목록 자체가 바스켓의 일부다. sumWg가 50%대인데 sumWg/coveredWg를 쓰면
  // 상위10을 전부 추적한 순간 scale=1이 되어 외삽이 아예 안 되고 변동폭이 절반으로 축소됐다
  // (커버리지도 100%로 표시돼 축소된 걸 알 방법이 없었다). 이 경우엔 순자산 100% 기준으로 되돌린다.
  const wgBase = pdf.partial ? 100 : sumWg;
  const scale = coveredWg > 0 ? wgBase / coveredWg : 0;
  sumContrib *= scale; domContrib *= scale; frnContrib *= scale; fxContrib *= scale; sessContrib *= scale;
  const inav = navRef * (1 + sumContrib / 100);
  // ETF는 시간외 시세가 없다(개별 주식만 있음). 시장가가 정규장 종가면 iNAV도 정규장 시점으로 맞춰 괴리율 계산.
  const inavRegular = inav / (1 + sessContrib / 100);
  const mp = marketPx(basic), marketPrice = mp.price;

  return {
    etfName: basic.stockName, code: stockCode,
    issuer: analysis.issuerName, baseIndex: analysis.etfBaseIndex,
    navRef, navRefDate: navRefDateOut, navProvisional: !!navInfo.prov,
    navAdjusted: navInfo.adjusted, cuShares: navInfo.cuShares, staleNav: navInfo.staleNav,
    inav, marketPrice,
    marketChangePct: mp.changePct, marketChange: mp.change, marketOver: mp.over,
    premiumPct: premiumOf(basic, mp, inav, inavRegular, navRef).pct,
    premiumBasis: premiumOf(basic, mp, inav, inavRegular, navRef).basis,
    inavRegular, sessContrib,
    etfClose: etfCloseOf(basic), vsClosePct: etfCloseOf(basic) ? (inav / etfCloseOf(basic) - 1) * 100 : null,
    inavChangePct: sumContrib,
    domContrib, frnContrib, fxContrib, domRate, frnRate, fxRate,
    // 커버리지는 '기여도를 정규화한 기준(wgBase)' 대비로 낸다 — partial일 때 100%로 보이던 문제
    up, down, coveragePct: wgBase ? coveredWg / wgBase * 100 : 0, sumWg, wgBase,
    krSession: krSession(),
    fx: Object.fromEntries(fxCurs.map(c => [c, fx[c]?.last])),
    fxRef, fxRefDate, // PDF 기준환율과 그 기준이 된 해외 종가 세션 — 환율 변동 계산 기준
    fxChangePct: Object.fromEntries(fxCurs.filter(c => fxRef[c]).map(c => [c, (fx[c].last / fxRef[c] - 1) * 100])),
    returns: analysis.returnPerformanceList,
    aum: analysis.totalNav, fee: analysis.totalFee,
    volume: igVal(ig0, 'accumulatedTradingVolume'), // ig0은 위에서 이미 받은 응답 — 추가 호출 없음
    pdfDate: pdf.stdDt,
    // 전체 PDF를 받은 경우는 출처가 어디든 결과가 같으므로 화면에 알리지 않는다(source 필드로만 남김).
    // 상위10 추정처럼 정확도가 다른 경우에만 안내한다.
    note: pdf.partial
      ? `운용사 PDF를 받을 수 없어(사이트 차단) 네이버 상위 ${pdf.list.length}종목(비중 합 ${sumWg.toFixed(1)}%)으로 추정했습니다. 나머지 ${(100 - sumWg).toFixed(1)}%는 이 종목들의 평균 변동으로 외삽하므로, 상위 종목과 나머지가 다르게 움직인 날에는 오차가 큽니다.`
      // 기준 NAV가 새 PDF보다 앞선 날짜일 때만 경고한다 — 갱신되고 나면 정상이므로 계속 띄우지 않는다
      : rebal && dig8(navRefDateOut) < dig8(pdf.stdDt)
        ? `구성종목이 바뀌었습니다(${rebal.from} → ${rebal.to}` +
          (rebal.added.length ? ` · 편입 ${rebal.added.slice(0, 3).join('·')}${rebal.added.length > 3 ? ` 외 ${rebal.added.length - 3}` : ''}` : '') +
          (rebal.removed.length ? ` · 편출 ${rebal.removed.length}종목` : '') +
          `). 기준 NAV는 아직 ${analysis.navPerformanceReferenceDate} 기준이라 새로 편입된 종목의 기준 평가액과 시점이 어긋납니다 — 그 종목의 추적변동이 하루치만큼 부풀려져 iNAV 오차가 평소보다 큽니다. 다음 기준 NAV가 나오면 해소됩니다.`
        : undefined,
    source: pdf.altSource || issuerKey,
    rows: rows.sort((a, b) => b.wg - a.wg).slice(0, 80),
    moreCount: Math.max(0, rows.length - 80),
    asOf: new Date().toISOString(),
  };
}

// ---------- HTML ----------
const HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>iNAVnow</title>
<link rel="icon" id="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>
  /* 색은 전부 변수로. 다크는 html[data-theme=dark]에서 값만 갈아끼운다(설정 → 자동/라이트/다크) */
  :root {
    color-scheme: light;
    --bg:#f0f1f5; --card:#fff; --fg:#222; --muted:#888; --muted2:#555;
    --line:#f0f0f3; --bd:#ddd; --bd2:#eceef3; --soft:#f7f8fa; --soft2:#e8e9ee; --hover:#f5f7fb;
    --up:#d63031; --down:#2e6be6; --upbg:#fdecec; --downbg:#eaf0fb;
    /* 강조색 — 런처 아이콘의 녹색(#008060 계열)에 맞춘다. 변수명은 gold를 유지(사용처가 많다). */
    --gold:#0b7a5a; --goldbg:#e8f6f1; --goldbd:#0b7a5a3a;
    --badge:#eef0f4; --badgefg:#778; --green:#1e8f45; --greenbg:#e3f3e8;
    --amber:#b07d00; --amberbg:#fdf1d7; --shadow:rgba(0,0,0,.06);
  }
  html[data-theme=dark] {
    color-scheme: dark;
    --bg:#14161a; --card:#1c1f26; --fg:#e4e6eb; --muted:#8b90a0; --muted2:#b0b4bf;
    --line:#282c34; --bd:#3a3f4a; --bd2:#2a2e37; --soft:#23272f; --soft2:#2f343d; --hover:#272c35;
    --up:#ff5f5f; --down:#6aa4ff; --upbg:#3a1e1e; --downbg:#1b2740;
    --gold:#4ec9a0; --goldbg:#122c25; --goldbd:#4ec9a03a;
    --badge:#2a2e37; --badgefg:#9aa1b0; --green:#5ec98a; --greenbg:#1d3527;
    --amber:#d9b25e; --amberbg:#332912; --shadow:rgba(0,0,0,.4);
  }
  * { box-sizing: border-box; }
  body { font-family: 'Pretendard Variable', Pretendard, -apple-system, 'Noto Sans KR', 'Malgun Gothic', sans-serif; background: var(--bg); color: var(--fg); max-width: 760px; margin: 0 auto; padding: 12px; }
  .big, .pricebig, td, .breakdown .v { font-variant-numeric: tabular-nums; }
  .card { background: var(--card); border-radius: 14px; padding: 18px 20px; margin-bottom: 14px; box-shadow: 0 1px 4px var(--shadow); }
  .row { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 6px; }
  h1 { font-size: 20px; margin: 0; }
  .muted { color: var(--muted); font-size: 13px; }
  .up { color: var(--up); } .down { color: var(--down); }
  /* 시장가와 iNAV는 같은 크기 — 한쪽만 크면 그 값이 더 중요해 보인다. 등락(.chg)은 한 단계 작게 */
  .big { font-size: 24px; font-weight: bold; margin: 6px 0; }
  .pricebig { font-size: 24px; font-weight: bold; }
  .chg { font-size: 16px; }
  .chips { margin-top: 8px; }
  .chip { display: inline-block; font-size: 12px; border: 1px solid var(--goldbd); background: var(--goldbg); color: var(--gold); border-radius: 6px; padding: 2px 8px; margin-right: 6px; margin-top: 4px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 20px; margin-top: 12px; font-size: 14px; }
  .grid div b { float: right; }
  .breakdown { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 14px; text-align: center; }
  .breakdown .bx { background: var(--soft); border-radius: 10px; padding: 10px 6px; }
  .breakdown .bx .v { font-size: 20px; font-weight: bold; margin-top: 4px; }
  .cover { display: flex; align-items: center; gap: 10px; margin-top: 14px; font-size: 14px; }
  .bar { flex: 1; height: 8px; background: var(--soft2); border-radius: 4px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--gold); }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { padding: 8px 6px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
  th { color: var(--muted); font-weight: normal; cursor: pointer; user-select: none; }
  td:first-child, th:first-child { text-align: left; max-width: 190px; overflow: hidden; text-overflow: ellipsis; }
  .badge { font-size: 11px; padding: 2px 7px; border-radius: 4px; background: var(--badge); color: var(--badgefg); }
  .badge.b본장, .badge.official { background: var(--greenbg); color: var(--green); }
  .badge.b프리, .badge.b애프터, .badge.bNXT프리, .badge.bNXT애프터, .badge.b주간, .badge.b시간외, .badge.b시간외프리 { background: var(--amberbg); color: var(--amber); }
  .badge.closed { background: var(--muted); color: var(--card); }
  /* 지수·환율 카드 — 넓으면 한 줄에 4개, 좁으면 2×2 */
  .mkt { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 12px; }
  .mkt .m { border: 1px solid var(--bd); border-radius: 14px; padding: 12px 8px; text-align: center; }
  /* '코스피200 야간선물'이 좁은 폭에서 두 줄로 감기면 같은 행 카드가 모두 커져 높이가 어긋난다 */
  .mkt .mn { font-size: 13px; color: var(--muted); display: flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; }
  @media (max-width: 360px) { .mkt .mn { font-size: 12px; } }
  .mkt .mv { font-size: 19px; font-weight: bold; margin-top: 5px; }
  .mkt .mc { font-size: 13px; margin-top: 2px; }
  @media (max-width: 620px) { .mkt { grid-template-columns: 1fr 1fr; } }
  /* 섹션 순서 변경 손잡이 — 이것만 드래그를 받는다(touch-action:none이라야 모바일에서 스크롤로 새지 않는다) */
  .grip { cursor: grab; color: var(--muted); font-size: 17px; line-height: 1; padding: 3px 6px; margin-right: 4px;
          border-radius: 7px; user-select: none; touch-action: none; }
  .grip:hover { background: var(--goldbg); color: var(--gold); }
  .sect.drag { opacity: .9; box-shadow: 0 10px 26px rgba(0,0,0,.2); position: relative; z-index: 5; }
  .sect.drag .grip { cursor: grabbing; background: var(--goldbg); color: var(--gold); }
  .sub { font-size: 11px; margin-top: 3px; padding: 1px 5px; border-radius: 4px; display: inline-block; background: var(--badge); color: var(--badgefg); }
  .sub.up { background: var(--upbg); color: var(--up); }
  .sub.down { background: var(--downbg); color: var(--down); }
  /* 칸을 절대좌표로 놓는다 — flex-wrap은 한 줄에 수십 개가 들어가면 소수점 오차로 줄바꿈이 어긋난다 */
  #tree { position: relative; width: 100%; height: 320px; margin-bottom: 8px; }
  #tree .cell { position: absolute; display: flex; flex-direction: column; justify-content: center; overflow: hidden; color: #fff; padding: 4px 7px; border: 1px solid var(--card); border-radius: 3px; font-size: 11.5px; line-height: 1.4; }
  #tree .cell b { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 작은 칸용 — 숫자만 남기면 어느 종목인지 알 수 없으니 글씨를 줄여서라도 이름을 넣는다 */
  #tree .cell.sm { font-size: 9.5px; line-height: 1.3; padding: 2px 4px; }
  #tree .cell.sm b { font-size: 10px; }
  #err { color: var(--up); white-space: pre-wrap; margin: 8px 0; }
  #note { color: var(--gold); }
  .intro { font-size: 14px; line-height: 1.75; color: var(--muted2); margin: 4px 0 0; }
  .intro b { color: var(--fg); }
  .hsec { margin-top: 18px; }
  .hsec > .muted { font-size: 12px; margin-bottom: 6px; }
  .hitem { display: flex; justify-content: space-between; align-items: center; width: 100%;
    padding: 11px 13px; margin-bottom: 6px; border: 1px solid var(--bd2); border-radius: 10px;
    background: var(--card); color: var(--fg); font-size: 14.5px; text-align: left; }
  .hitem:hover { background: var(--hover); border-color: var(--bd); }
  .hitem .c { color: var(--muted); font-size: 12.5px; }
  .recent { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; align-items: center; margin-top: 8px; }
  .recent .lbl { font-size: 11px; color: var(--muted); }
  .recent button { font-size: 12px; padding: 3px 10px; border-radius: 14px; border: 1px solid var(--bd2);
    background: var(--soft); color: var(--muted2); max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recent button:hover { background: var(--hover); border-color: var(--bd); }
  summary { cursor: pointer; user-select: none; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  .arrow { color: var(--muted); font-size: 12px; margin-left: 2px; }
  .arrow::before { content: '▼'; }
  details[open] .arrow::before { content: '▲'; }
  .legend { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 12px; }
  .legend i { flex: 1; height: 8px; border-radius: 4px;
    background: linear-gradient(to right, rgb(40,100,190), rgb(150,170,215), #9aa0ab, rgb(215,65,55), rgb(230,40,40)); }
  input, select { border: 1px solid var(--bd); border-radius: 8px; padding: 6px 10px; font-size: 14px;
    background: var(--card); color: var(--fg); font-family: inherit; }
  button { border: 1px solid var(--bd); border-radius: 8px; padding: 6px 12px; font-size: 13px; background: var(--card); color: var(--fg); cursor: pointer; font-family: inherit; }
  button.on { border-color: var(--goldbd); color: var(--gold); background: var(--goldbg); }
  /* 검색창 오른쪽 끝에 맞춰 왼쪽으로 펼친다 — left 기준이면 항목의 nowrap 폭 때문에
     화면 오른쪽(보이지 않는 영역)으로 넘어간다(실측: 폰에서 종목코드가 잘려 안 보임).
     max-width로 화면을 벗어나지 않게 묶고, 넘치는 항목명은 아래 규칙이 …으로 줄인다. */
  #sugg, #pfsugg { position: absolute; top: 36px; right: 0; min-width: min(250px, calc(100vw - 32px));
          max-width: calc(100vw - 28px); background: var(--card); border-radius: 10px;
          box-shadow: 0 4px 16px rgba(0,0,0,.15); z-index: 10; display: none; max-height: 320px; overflow-y: auto; }
  #pfsugg { min-width: 100%; max-width: 100%; }
  #sugg div, #pfsugg div { padding: 10px 14px; font-size: 14px; cursor: pointer; border-bottom: 1px solid var(--line); white-space: nowrap;
          overflow: hidden; text-overflow: ellipsis; }
  #sugg div:hover, #sugg div.sel, #pfsugg div:hover { background: var(--hover); }
  #sugg .muted, #pfsugg .muted { font-size: 12px; }
  footer { color: var(--muted); font-size: 12px; line-height: 1.7; padding: 4px 8px 20px; }
  .home { display: inline-block; font-size: 12.5px; color: var(--muted); text-decoration: none; margin-bottom: 5px; }
  .home:hover { color: var(--fg); }
  /* 폰 화면 — 글자를 한 단계 줄이고, 구성 종목 표는 가로 스크롤 대신 한 종목당 2줄로 접는다 */
  @media (max-width: 640px) {
    body { padding: 10px; }
    .card { padding: 14px 15px; margin-bottom: 11px; }
    h1 { font-size: 17px; }
    .big { font-size: 20px; }
    .pricebig { font-size: 20px; }
    .chg { font-size: 14px; }
    .muted { font-size: 12.5px; }
    .grid { grid-template-columns: 1fr; gap: 5px; font-size: 13px; } /* 2열은 375px에서 값이 줄바꿈된다 */
    .breakdown { gap: 7px; }
    .breakdown .bx .v { font-size: 17px; }
    .chip { font-size: 11.5px; }
    /* 폰은 폭이 좁아 같은 높이면 칸이 몇 개 안 남는다 — 세로로 늘려 면적을 확보한다 */
    #tree { height: 400px; }
    .intro { font-size: 13.5px; }
    .hitem { font-size: 13.5px; padding: 10px 12px; }
    footer { font-size: 11.5px; }
    #q { width: 150px; }
    #holdcard table { font-size: 12.5px; }
    #holdcard thead { display: none; } /* 접은 배치라 열 머리글이 맞지 않는다(정렬은 기본값 비중순) */
    #holdcard tbody tr { display: grid; grid-template-columns: 1fr auto auto auto;
      grid-template-areas: 'nm nm nm wg' 'pr ss ch tk'; gap: 3px 8px; padding: 9px 2px;
      border-bottom: 1px solid var(--line); }
    #holdcard td { border: 0; padding: 0; text-align: right; }
    #holdcard td:nth-child(1) { grid-area: nm; text-align: left; max-width: none; font-weight: 600; }
    #holdcard td:nth-child(2) { grid-area: ss; text-align: left; }
    #holdcard td:nth-child(3) { grid-area: pr; text-align: left; }
    #holdcard td:nth-child(4) { grid-area: ch; }
    #holdcard td:nth-child(5) { grid-area: tk; }
    #holdcard td:nth-child(6) { grid-area: wg; }
    /* 열 머리글이 없으니 숫자만 봐선 헷갈리는 두 칸에 꼬리표를 붙인다 */
    #holdcard td:nth-child(5)::before { content: '추적 '; color: var(--muted); font-weight: normal; }
    #holdcard td:nth-child(6)::before { content: '비중 '; color: var(--muted); }
    #holdcard td[colspan] { grid-column: 1 / -1; text-align: center; white-space: normal; }
    #holdcard .sub { margin: 0 0 0 4px; }
  }
  dialog { border: 0; border-radius: 14px; padding: 0; width: 360px; max-width: 92vw;
    background: var(--card); box-shadow: 0 10px 44px rgba(0,0,0,.28); color: var(--fg); font-family: inherit; }
  dialog::backdrop { background: rgba(0,0,0,.35); }
  .dlg { padding: 20px 22px 22px; }
  .dlg h2 { font-size: 17px; margin: 0; }
  .dlg .x { border: 0; background: none; font-size: 16px; color: var(--muted); padding: 2px 6px; }
  .dlg .sec { margin-top: 18px; }
  .dlg .sec > .muted { font-size: 12px; margin-bottom: 7px; }
  .dlg label { display: flex; align-items: center; gap: 8px; font-size: 14px; padding: 5px 0; cursor: pointer; }
  .dlg label .muted { font-size: 12px; }
  .dlg .hint { font-size: 12px; color: var(--muted); line-height: 1.5; margin: 4px 0 0 24px; }
  .dlg .btns { display: flex; gap: 8px; }
  .dlg .btns button { flex: 1; }
  .dlg #theme { width: 100%; }
  .dlg #otitle { width: calc(100% - 24px); margin: 4px 0 0 24px; }
  .dlg input[type=number], .dlg #pfq { width: 100%; }
  .dlg .err { color: var(--up); font-size: 12px; margin-top: 8px; min-height: 16px; }
  .dlg button.primary { background: var(--gold); border-color: var(--gold); color: #fff; font-weight: 600; }
  html[data-theme=dark] .dlg button.primary { color: #1c1f26; }

  /* ---------- 포트폴리오 ---------- */
  #pfhead { gap: 10px; }
  #pfhead .ttl { display: flex; align-items: center; gap: 8px; }
  /* 새로고침 버튼 — 계산 중에는 회전만 한다(게이지와 같이 쓰면 어느 쪽을 봐야 할지 애매하다).
     완전한 원이라 테두리는 돌아도 그대로 보이고 ↻ 글리프만 회전한다. */
  #pfrf { width: 26px; height: 26px; padding: 0; border-radius: 50%; display: inline-flex;
    align-items: center; justify-content: center; font-size: 14px; line-height: 1; color: var(--muted2); }
  #pfrf[disabled] { cursor: default; color: var(--gold); animation: pfspin .9s linear infinite; }
  @keyframes pfspin { to { transform: rotate(360deg); } }
  #pfsum { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 14px 0 4px; text-align: center; }
  #pfsum .bx { background: var(--soft); border-radius: 10px; padding: 11px 8px; }
  #pfsum .bx > .muted { font-size: 12px; }
  #pfsum .v { font-size: 17px; font-weight: bold; margin-top: 3px; font-variant-numeric: tabular-nums; }
  #pfsum .v .pct { font-size: 12px; margin-left: 4px; font-weight: normal; }
  /* 현재가 / iNAV 전환 — 정규장 중엔 현재가, 그 밖에는 iNAV가 기본 */
  #pfbasis { display: inline-flex; border: 1px solid var(--bd); border-radius: 8px; overflow: hidden; }
  #pfbasis button { border: 0; border-radius: 0; padding: 6px 11px; font-size: 12.5px; background: none; color: var(--muted2); }
  #pfbasis button + button { border-left: 1px solid var(--bd); }
  #pfbasis button.on { background: var(--gold); color: #fff; font-weight: 600; }
  html[data-theme=dark] #pfbasis button.on { color: #1c1f26; }
  .pfrow { padding: 13px 0 0; border-top: 1px solid var(--line); margin-top: 13px; }
  .pfrow:first-child { border-top: 0; margin-top: 4px; }
  .pfrow .nm { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 600; }
  .pfrow .nm a { color: inherit; text-decoration: none; }
  .pfrow .nm a:hover { text-decoration: underline; }
  .pfrow .act { margin-left: auto; display: flex; gap: 4px; }
  .pfrow .act button { padding: 4px 6px; border-color: transparent; background: none; color: var(--muted); line-height: 0; }
  .pfrow .act button:hover { background: var(--hover); color: var(--fg); }
  .pfrow .act svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7;
    stroke-linecap: round; stroke-linejoin: round; }
  .pfbar { position: relative; height: 20px; border-radius: 6px; background: var(--soft2); overflow: hidden; margin: 8px 0 7px; }
  .pfbar i { position: absolute; inset: 0 auto 0 0; background: var(--gold); opacity: .82; border-radius: 6px; }
  .pfbar span { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    gap: 4px; font-size: 11.5px; font-weight: 600; color: var(--fg); }
  /* 평가금액은 비중보다 한 단계 작게 — 비중이 주 정보다 */
  .pfbar span b { font-size: 10px; font-weight: 500; opacity: .78; }
  .pfrow .dt { display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
    font-size: 13px; font-variant-numeric: tabular-nums; }
  .pfrow .dt .muted { font-size: 12.5px; }
  #pfempty { font-size: 13px; color: var(--muted); line-height: 1.7; margin: 12px 0 2px; }
  @media (max-width: 640px) {
    #pfsum { grid-template-columns: 1fr; gap: 6px; text-align: left; }
    #pfsum .bx { display: flex; justify-content: space-between; align-items: baseline; padding: 9px 12px; }
    #pfsum .v { font-size: 15px; margin: 0; }
    .pfrow .dt { flex-wrap: wrap; }
    #pfhead { gap: 8px; }
  }
</style>
<script>
  // 첫 페인트 전에 테마를 확정한다(스크립트가 body 끝에 있으면 밝은 화면이 한 번 번쩍인다)
  try {
    var c0 = JSON.parse(localStorage.getItem('cfg') || '{}'), t0 = c0.theme || 'auto';
    document.documentElement.dataset.theme =
      t0 === 'auto' ? (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light') : t0;
  } catch (e) {}
</script>
</head><body>
<div class="card">
  <a class="home" id="homelink" href="/">‹ Home</a>
  <div class="row">
    <h1 id="name">불러오는 중…</h1>
    <span style="display:flex;gap:8px;align-items:center">
      <button id="cfgbtn" title="설정" onclick="openCfg()">⚙</button>
      <span style="position:relative">
        <input id="q" placeholder="종목명·코드 검색" autocomplete="off" style="width:190px">
        <div id="sugg"></div>
      </span>
      <button id="fav" onclick="toggleFav()">☆ 관심</button>
    </span>
  </div>
  <div class="muted" id="meta"></div>
  <div class="recent" id="recent"></div>
  <div class="row" style="margin-top:10px" id="pricerow">
    <span class="pricebig" id="mkt"></span>
    <span class="muted" id="idx"></span>
  </div>
  <div class="grid" id="stats"></div>
  <div class="chips" id="rets"></div>
</div>
<div class="card" id="introcard" style="display:none">
  <p class="intro"><b>iNAVnow</b>는 한국에 상장된 ETF의 <b>지금 이 순간 iNAV(순자산가치)</b>를 보여줍니다.
  구성종목의 실시간 시세와 환율로 직접 계산하기 때문에, 하루 한 번만 갱신되는 공식 NAV나 장중에만 나오는
  공식 iNAV와 달리 <b>미국 프리·정규장·애프터·주간거래</b>와 <b>국내 시간외</b>까지 반영합니다.
  장이 열리기 전에 적정가를 미리 가늠하거나, 지금 시장가가 얼마나 비싸고 싼지(괴리율) 확인할 때 쓰세요.</p>
</div>
<!-- 홈의 세 섹션 — 순서를 바꿀 수 있어야 해서 한 컨테이너에 담는다(정렬은 이 안에서만 일어난다) -->
<div id="hsecs">
<div class="card sect" id="home" data-sec="lists" style="display:none">
  <div class="row"><span class="ttl">
    <span class="grip" onpointerdown="gripDown(event)" title="끌어서 순서 변경">≡</span><b>관심 · 최근 조회</b>
  </span></div>
  <div id="homeLists"></div>
</div>
<div class="card sect" id="mktcard" data-sec="mkt" style="display:none">
  <div class="row">
    <span class="ttl">
      <span class="grip" onpointerdown="gripDown(event)" title="끌어서 순서 변경">≡</span><b>지수 · 환율</b>
    </span>
    <span class="muted" id="mktclock"></span>
  </div>
  <div class="mkt" id="mktbody"></div>
</div>
<div class="card sect" id="pfcard" data-sec="pf" style="display:none">
  <div class="row" id="pfhead">
    <span class="ttl">
      <span class="grip" onpointerdown="gripDown(event)" title="끌어서 순서 변경">≡</span><b>내 포트폴리오</b>
      <span class="muted" id="pfclock">—</span>
      <button id="pfrf" title="지금 다시 계산" onclick="pfCalc()">↻</button>
    </span>
    <span class="ttl">
      <span id="pfbasis">
        <button type="button" data-b="price" onclick="pfBasis('price')" title="시장 체결가로 평가">현재가</button>
        <button type="button" data-b="inav" onclick="pfBasis('inav')" title="구성종목 실시간 시세로 계산한 추정 순자산으로 평가">iNAV</button>
      </span>
      <button id="pfaddbtn" onclick="pfOpen(-1)">+ 추가</button>
    </span>
  </div>
  <div id="pfsum"></div>
  <div id="pfbody"></div>
</div>
</div>
<div class="card" id="trackcard">
  <div class="row"><b>실시간 iNAV</b><span class="muted" id="clock"></span></div>
  <div class="big" id="inav">—</div>
  <div class="muted" id="inavsub"></div>
  <div class="muted" id="note" style="margin-top:6px"></div>
  <div class="breakdown" id="bd">
    <div class="bx"><div class="muted">국내 변동</div><div class="v" id="dom"></div></div>
    <div class="bx"><div class="muted">해외 변동(현지)</div><div class="v" id="frn"></div></div>
    <div class="bx"><div class="muted">환율 변동</div><div class="v" id="fxc"></div></div>
  </div>
  <div class="muted" id="bdnote" style="margin-top:7px;font-size:12px"></div>
  <div class="cover" id="cov"><span id="updown"></span><span class="muted">반영률</span><div class="bar"><i id="coverbar"></i></div><span id="coverpct"></span></div>
</div>
<details class="card" id="holdcard">
  <summary class="row">
    <b>구성 종목</b>
    <span class="arrow"></span>
  </summary>
  <div id="err"></div>
  <div style="overflow-x:auto;margin-top:12px"><table>
    <thead><tr><th onclick="sortBy('wg')">종목 ▾</th><th>세션</th><th onclick="sortBy('price')">현재가</th><th onclick="sortBy('changePct')" title="위: 정규장 마감 등락률 · 아래: 진행 중 세션 변동">등락</th><th onclick="sortBy('trackPct')">추적변동</th><th>비중</th></tr></thead>
    <tbody id="rows"></tbody>
  </table></div>
</details>
<details class="card" id="treecard">
  <summary class="row">
    <b>트리맵</b>
    <span><span class="muted">칸 크기 = 비중 · 색 = 추적변동</span> <span class="arrow"></span></span>
  </summary>
  <div id="tree" style="margin-top:12px"></div>
  <div class="legend">
    <span class="muted">-5%</span><i></i><span class="muted">+5%</span>
  </div>
</details>
<footer id="foot"></footer>
<dialog id="cfgdlg"><div class="dlg">
  <div class="row"><h2>설정</h2><button class="x" onclick="cfgdlg.close()">✕</button></div>
  <div class="sec">
    <div class="muted">테마</div>
    <select id="theme">
      <option value="auto">자동 (시스템 설정)</option>
      <option value="light">라이트</option>
      <option value="dark">다크</option>
    </select>
  </div>
  <div class="sec">
    <div class="muted">목록 초기화</div>
    <div class="btns">
      <button onclick="clearFavs()">관심 목록</button>
      <button onclick="clearRecents()">최근 조회</button>
    </div>
  </div>
  <div class="sec" id="secTitle">
    <div class="muted">페이지 타이틀</div>
    <label><input type="radio" name="tm" value="default"> 기본 <span class="muted">종목명 · iNAVnow</span></label>
    <label><input type="radio" name="tm" value="noname"> 종목명 미표시 <span class="muted">iNAVnow 고정</span></label>
    <label><input type="radio" name="tm" value="office"> 오피스 모드</label>
    <input id="otitle" placeholder="표시할 타이틀" maxlength="60" autocomplete="off">
    <div class="hint" id="otHint">파비콘을 스프레드시트 아이콘으로, 제목을 입력한 이름으로 바꿉니다.</div>
  </div>
  <div class="sec" id="secInav">
    <label><input type="checkbox" id="showinav"> 타이틀에 현재 iNAV 표시</label>
    <div class="hint">갱신될 때마다 제목 뒤에 <b>_숫자</b>로 붙습니다(종목명 미표시 모드 제외).</div>
  </div>
  <div class="sec">
    <div class="muted">구성종목 자료(PDF)</div>
    <div class="row" style="gap:10px">
      <span class="hint" id="pdfinfo" style="margin:0">확인 중…</span>
      <button type="button" id="pdfrf" onclick="pdfReload()">지금 다시 받기</button>
    </div>
    <div class="hint">운용사가 하루 한 번 올리는 자료라 오래 들고 있습니다. 리밸런싱이 늦게 반영됐을 때만 눌러 주세요.</div>
  </div>
</div></dialog>
<dialog id="pfdlg"><form class="dlg" method="dialog" onsubmit="return pfSave()">
  <div class="row"><h2 id="pfdlgh">포트폴리오 추가</h2><button type="button" class="x" onclick="pfdlg.close()">✕</button></div>
  <div class="sec">
    <div class="muted">종목</div>
    <span style="position:relative;display:block">
      <input id="pfq" placeholder="종목명·코드 검색" autocomplete="off">
      <div id="pfsugg"></div>
    </span>
  </div>
  <div class="sec">
    <div class="muted">평균단가 (원)</div>
    <input id="pfavg" type="number" step="any" min="0" inputmode="decimal" placeholder="예: 30423">
  </div>
  <div class="sec">
    <div class="muted">보유수량 (주)</div>
    <input id="pfqty" type="number" step="any" min="0" inputmode="decimal" placeholder="예: 150">
  </div>
  <div class="err" id="pferr"></div>
  <div class="sec btns">
    <button type="submit" class="primary" id="pfok">추가</button>
    <button type="button" onclick="pfdlg.close()">취소</button>
  </div>
</form></dialog>
<script>
const fmt = (n, d=2) => n==null||isNaN(n) ? '—' : n.toLocaleString('ko-KR',{minimumFractionDigits:d,maximumFractionDigits:d});
const sign = (n, d=2) => n==null ? '—' : (n>=0?'+':'')+fmt(n,d);
const cls = n => n>=0 ? 'up' : 'down';
const dp = v => Math.abs(v||0) < 1000 ? 2 : 0; // 저가 ETF(인버스2X 등)는 소수점 표시
// 세션 표시 이름 — 내부 값은 계산 분기 여러 곳이 비교하므로 그대로 두고 보일 때만 바꾼다.
// '한국장'이 앞에 붙으니 뒤에 '장'을 또 쓰지 않는다(한국장 장마감 → 한국장 마감).
const SESS_LABEL = {'NXT프리':'프리마켓','장전':'개장 전','본장':'정규장','NXT애프터':'애프터마켓','장마감':'마감'};
const sessLabel = s => SESS_LABEL[s] || s || '';
const CODE = new URLSearchParams(location.search).get('code') || '';
const HOME = !CODE; // ?code= 없이 들어오면 메인 화면
const SAMPLES = [
  {code:'069500', name:'KODEX 200'},
  {code:'360750', name:'TIGER 미국S&P500'},
  {code:'465580', name:'ACE 미국빅테크TOP7 Plus'},
  {code:'229200', name:'KODEX 코스닥150'},
];
let D = null, sortKey = 'wg', sortAsc = false;
function sortBy(k){ if(sortKey===k) sortAsc=!sortAsc; else {sortKey=k; sortAsc=false;} render(); }

// ---------- 검색·관심 ----------
let ETFS = [], selIdx = -1;
fetch('/api/etfs').then(r=>r.json()).then(d=>{ if(Array.isArray(d)) ETFS = d; });
const $q = document.getElementById('q'), $sugg = document.getElementById('sugg');
const favs = () => JSON.parse(localStorage.getItem('favs')||'[]');
const esc = s => String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; });

// 최근 조회 (localStorage, 현재 종목 제외하고 5개 표시 → 6개까지 보관)
let recentSaved = false;
const recents = () => JSON.parse(localStorage.getItem('recents')||'[]');
function pushRecent(code, name){
  const r = recents().filter(function(x){ return x.code !== code; });
  r.unshift({code: code, name: name});
  localStorage.setItem('recents', JSON.stringify(r.slice(0, 6)));
}
function renderRecent(){
  const list = recents().filter(function(x){ return x.code !== CODE; }).slice(0, 5);
  const el = document.getElementById('recent');
  if(!list.length){ el.innerHTML = ''; return; }
  el.innerHTML = '<span class="lbl">최근</span>' + list.map(function(x){
    const nm = x.name.length > 14 ? x.name.slice(0,14)+'…' : x.name;
    return '<button data-code="'+esc(x.code)+'" title="'+esc(x.name)+' ('+esc(x.code)+')">'+esc(nm)+'</button>';
  }).join('');
  Array.prototype.forEach.call(el.querySelectorAll('button'), function(b){
    b.onclick = function(){ go(b.dataset.code); };
  });
}
function go(code){ location.search = '?code=' + code; }
function norm(s){ return s.toLowerCase().replace(/\\s+/g,''); }
function showSugg(items, title){
  selIdx = -1;
  if(!items.length){ $sugg.style.display='none'; return; }
  $sugg.innerHTML = (title?'<div class="muted">'+title+'</div>':'') +
    items.map(x=>'<div data-code="'+x.code+'">'+x.name+' <span class="muted">('+x.code+')</span></div>').join('');
  // 드롭다운은 검색창 오른쪽 끝에 맞춰 왼쪽으로 펼쳐진다. CSS의 100vw로는 검색창이 화면 어디에
  // 있는지 알 수 없어 왼쪽으로 넘칠 수 있다(실측 320px 화면에서 −19px) → 좌표를 재서 폭을 묶는다.
  $sugg.style.maxWidth = Math.max(160, Math.round($q.getBoundingClientRect().right) - 10) + 'px';
  $sugg.style.display = 'block';
  [...$sugg.querySelectorAll('div[data-code]')].forEach(el=>el.onmousedown=e=>{e.preventDefault(); go(el.dataset.code);});
}
function search(){
  const q = norm($q.value);
  if(!q){ showSugg(favs(), favs().length?'★ 관심':''); return; }
  showSugg(ETFS.filter(x=>norm(x.name).includes(q) || x.code.startsWith($q.value.trim())).slice(0,10));
}
$q.addEventListener('input', search);
$q.addEventListener('focus', search);
$q.addEventListener('blur', ()=>setTimeout(()=>$sugg.style.display='none',150));
$q.addEventListener('keydown', e=>{
  const opts = [...$sugg.querySelectorAll('div[data-code]')];
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){
    e.preventDefault();
    selIdx = (selIdx + (e.key==='ArrowDown'?1:-1) + opts.length) % (opts.length||1);
    opts.forEach((o,i)=>o.classList.toggle('sel', i===selIdx));
  } else if(e.key==='Enter'){
    const pick = opts[selIdx>=0?selIdx:0];
    if(pick) go(pick.dataset.code);
    else if(/^[0-9A-Z]{6}$/.test($q.value.trim())) go($q.value.trim());
  } else if(e.key==='Escape'){ $sugg.style.display='none'; }
});
function updateFavBtn(){
  const on = favs().some(f=>f.code===CODE);
  const b = document.getElementById('fav');
  b.textContent = (on?'★':'☆')+' 관심';
  b.classList.toggle('on', on);
}
function toggleFav(){
  let f = favs();
  if(f.some(x=>x.code===CODE)) f = f.filter(x=>x.code!==CODE);
  else if(D) f.push({code: CODE, name: D.etfName});
  localStorage.setItem('favs', JSON.stringify(f));
  updateFavBtn();
}
updateFavBtn();

// ---------- 설정 ----------
const OFFICE_ICON = 'https://ssl.gstatic.com/docs/spreadsheets/spreadsheets-2026-v2.ico';
const CFG = Object.assign({theme:'auto', titleMode:'default', officeTitle:'', showInav:false},
  JSON.parse(localStorage.getItem('cfg')||'{}'));
const darkMq = matchMedia('(prefers-color-scheme:dark)');
function applyTheme(){
  document.documentElement.dataset.theme =
    CFG.theme==='auto' ? (darkMq.matches?'dark':'light') : CFG.theme;
}
darkMq.addEventListener('change', function(){ if(CFG.theme==='auto') applyTheme(); });
let curIcon = '';
function setIcon(href, type){
  if(curIcon === href) return; // 매 갱신마다 <link>를 갈아끼우지 않게
  curIcon = href;
  const l = document.createElement('link');
  l.id = 'icon'; l.rel = 'icon'; l.type = type; l.href = href;
  document.getElementById('icon').replaceWith(l);
}
// 타이틀 위장은 회사 PC용 기능 — 폰에선 쓸 일이 없으니 설정째로 감추고 iNAVnow로 고정한다.
// (fine pointer인 좁은 데스크톱 창은 모바일로 보지 않는다)
const MOBILE = matchMedia('(pointer:coarse) and (max-width:820px)').matches;
function applyTitle(){
  if(MOBILE){ setIcon('/favicon.svg', 'image/svg+xml'); document.title = 'iNAVnow'; return; }
  const m = CFG.titleMode;
  setIcon(m==='office' ? OFFICE_ICON : '/favicon.svg', m==='office' ? 'image/x-icon' : 'image/svg+xml');
  const iv = (CFG.showInav && m!=='noname' && D && D.inav!=null) ? '_'+fmt(D.inav, dp(D.inav)) : '';
  if(m==='office') document.title = (CFG.officeTitle || '제목 없는 스프레드시트') + iv;
  else if(m==='noname' || HOME || !D) document.title = 'iNAVnow';
  else document.title = D.etfName + iv + ' · iNAVnow'; // 탭 여러 개 열었을 때 구분되게
}
function saveCfg(){ localStorage.setItem('cfg', JSON.stringify(CFG)); applyTheme(); applyTitle(); syncCfgUI(); }
function syncCfgUI(){
  const office = CFG.titleMode === 'office';
  document.getElementById('theme').value = CFG.theme;
  document.getElementById('secTitle').style.display = MOBILE ? 'none' : '';
  document.getElementById('secInav').style.display = MOBILE ? 'none' : '';
  [...document.querySelectorAll('input[name=tm]')].forEach(r=>{ r.checked = r.value===CFG.titleMode; });
  const ot = document.getElementById('otitle');
  ot.value = CFG.officeTitle;
  ot.style.display = office ? '' : 'none';
  document.getElementById('otHint').style.display = office ? '' : 'none';
  const si = document.getElementById('showinav');
  si.checked = CFG.showInav && CFG.titleMode!=='noname';
  si.disabled = CFG.titleMode === 'noname';
}
function openCfg(){ syncCfgUI(); document.getElementById('cfgdlg').showModal(); pdfInfo(); }
// 하루 한 번만 받는 자료(구성종목 PDF)의 상태. 리밸런싱이 늦게 올라온 날 손으로 새로 받을 수 있게 한다.
async function pdfInfo(){
  const el = document.getElementById('pdfinfo');
  el.textContent = '확인 중…';
  try {
    const d = await (await fetch('/api/pdfinfo')).json();
    if(!d.count){ el.textContent = '아직 받은 자료가 없습니다.'; return; }
    const mins = Math.round((Date.now() - d.newest) / 60000);
    const ago = mins < 1 ? '방금' : mins < 60 ? mins+'분 전' : Math.floor(mins/60)+'시간 '+(mins%60)+'분 전';
    el.textContent = d.count+'종목 · 마지막 수신 '+ago
      + (d.dates.length ? ' · 기준일 '+d.dates.join(', ') : '')
      + (d.blocked.length ? ' · 오늘 차단: '+d.blocked.join(',') : '');
  } catch(e){ el.textContent = '상태를 읽지 못했습니다.'; }
}
async function pdfReload(){
  const btn = document.getElementById('pdfrf'), el = document.getElementById('pdfinfo');
  btn.disabled = true; el.textContent = '지우는 중…';
  try {
    await fetch('/api/pdfinfo?clear=1');
    el.textContent = '지웠습니다. 다음 조회 때 새로 받습니다.';
    // 화면에 보이는 값도 새로 받게 한다(홈이면 포트폴리오, 종목 화면이면 그 종목)
    if(HOME){ PFCAT = null; if(typeof pfCalc === 'function') pfCalc(); } else { refresh(); }
  } catch(e){ el.textContent = '초기화에 실패했습니다.'; }
  btn.disabled = false;
}
document.getElementById('theme').onchange = function(){ CFG.theme = this.value; saveCfg(); };
[...document.querySelectorAll('input[name=tm]')].forEach(r=>{
  r.onchange = function(){ CFG.titleMode = r.value; saveCfg(); if(r.value==='office') document.getElementById('otitle').focus(); };
});
document.getElementById('otitle').oninput = function(){
  CFG.officeTitle = this.value;
  localStorage.setItem('cfg', JSON.stringify(CFG)); applyTitle(); // syncCfgUI는 생략(입력 중 커서 유지)
};
document.getElementById('showinav').onchange = function(){ CFG.showInav = this.checked; saveCfg(); };
function clearFavs(){
  if(!confirm('관심 목록을 모두 지울까요?')) return;
  localStorage.removeItem('favs');
  updateFavBtn(); if(HOME) showHome();
}
function clearRecents(){
  if(!confirm('최근 조회 목록을 모두 지울까요?')) return;
  localStorage.removeItem('recents');
  recentSaved = true; // 지운 직후 현재 종목이 다시 쌓이지 않게
  if(HOME) showHome(); else renderRecent();
}
applyTheme(); applyTitle();

function heat(p){ // -5%~+5% → 파랑~빨강
  if(p==null) return '#9aa0ab';
  const t = Math.max(-1, Math.min(1, p/5));
  return t>=0 ? 'rgb('+(190+40*t)+','+(90-50*t)+','+(70-30*t)+')' : 'rgb('+(70+30*t)+','+(120+20*t)+','+(210-20*t)+')';
}
// 구성 종목 접기/펼치기 — 주된 내용이라 기본은 펼침('0'이 저장돼 있을 때만 접는다)
const $hold = document.getElementById('holdcard');
$hold.open = localStorage.getItem('holdOpen') !== '0';
$hold.addEventListener('toggle', function(){ localStorage.setItem('holdOpen', this.open ? '1' : '0'); });

// 트리맵 접기/펼치기 — 네이티브 <details>(키보드·스크린리더 기본 지원). 기본 접힘, 선택은 유지.
const $tree = document.getElementById('treecard');
$tree.open = localStorage.getItem('treeOpen') === '1';
$tree.addEventListener('toggle', function(){
  localStorage.setItem('treeOpen', this.open ? '1' : '0');
  if(this.open && D) treemap(D.rows); // 접힌 상태에선 폭이 0이라 열릴 때 그린다
});

// 정사각화(squarified) 트리맵 — 남은 사각형의 짧은 변에 칸을 쌓고, 종횡비가 나빠지기 직전에 줄을 끊는다
// (Bruls et al. 1999). 비중 내림차순 입력을 가정한다.
function squarify(items, x, y, w, h, out){
  if(!items.length) return out;
  if(items.length === 1){ out.push({r: items[0], x, y, w, h}); return out; }
  const total = items.reduce((s,v)=>s+v.wg,0);
  const vert = w >= h;         // 가로가 길면 왼쪽에 세로 열을 세운다(그래야 칸이 정사각에 가까워진다)
  const side = vert ? h : w;   // 줄이 뻗는 방향의 길이
  const across = vert ? w : h; // 줄 두께 방향
  let sum = 0, best = Infinity, n = 1;
  for(let i=0;i<items.length;i++){
    const s2 = sum + items[i].wg;
    const thick = across * s2/total;
    let worst = 0; // 이 줄에 i까지 넣었을 때 가장 나쁜 종횡비
    for(let k=0;k<=i;k++){
      const len = side * items[k].wg/s2;
      worst = Math.max(worst, len > 0 ? Math.max(thick/len, len/thick) : Infinity);
    }
    if(worst > best) break;    // 더 넣으면 나빠진다 → 직전까지로 끊는다
    best = worst; sum = s2; n = i+1;
  }
  const thick = across * sum/total;
  let off = 0;
  for(let k=0;k<n;k++){
    const it = items[k], len = side * it.wg/sum;
    out.push(vert ? {r: it, x, y: y+off, w: thick, h: len}
                  : {r: it, x: x+off, y, w: len, h: thick});
    off += len;
  }
  return vert ? squarify(items.slice(n), x+thick, y, w-thick, h, out)
              : squarify(items.slice(n), x, y+thick, w, h-thick, out);
}

function treemap(rows){
  const el = document.getElementById('tree');
  el.innerHTML = '';
  const W = el.clientWidth, H = el.clientHeight || 320;
  if(!W) return; // 접혀 있으면 폭이 0
  const all = rows.filter(r=>r.wg>0).sort((a,b)=>b.wg-a.wg);
  const total = all.reduce((s,r)=>s+r.wg,0);
  if(!total) return;
  // 라벨이 들어갈 최소 면적보다 작아질 칸은 '기타'로 묶는다 — 안 묶으면 폭 몇 px짜리 조각이
  // 수십 개 생겨 트리맵이 읽히지 않는다(비중 0.1%대 종목이 100개 넘는 ETF가 흔하다).
  // 1700px² = 축약 라벨(40x26)이 종횡비 여유를 두고 들어가는 크기.
  // 기준을 화면 면적에서 뽑으므로 폰에서는 자동으로 더 많이 묶인다.
  const minWg = total * 1700 / (W * H);
  const big = all.filter(r=>r.wg>=minWg), small = all.filter(r=>r.wg<minWg);
  let items = all;
  if(small.length > 1){
    const wg = small.reduce((s,r)=>s+r.wg,0);
    const tr = small.filter(r=>r.tracked), trWg = tr.reduce((s,r)=>s+r.wg,0);
    const avg = trWg ? tr.reduce((s,r)=>s+r.wg*r.trackPct,0)/trWg : null; // 묶음 색은 비중 가중평균
    items = big.concat([{name:'기타 '+small.length+'종목', wg, trackPct: avg, tracked: avg!=null, more: small}])
      .sort((a,b)=>b.wg-a.wg);
  }
  for(const c of squarify(items, 0, 0, W, H, [])){
    const r = c.r, d = document.createElement('div');
    d.className = 'cell';
    d.style.cssText = 'left:'+c.x+'px;top:'+c.y+'px;width:'+c.w+'px;height:'+c.h+'px';
    d.style.background = heat(r.tracked ? r.trackPct : null);
    const chg = r.tracked ? sign(r.trackPct)+'%' : '—';
    // 칸 크기에 맞춰 표기를 줄인다(가로만 보면 납작한 칸에서 글자가 잘린다)
    // 해외 종목은 회사명 첫 단어보다 티커가 알아보기 쉽다(Micron→MU, Applied→AMAT). 국내는 종목명.
    const nm = r.more ? r.name
             : (r.cur && r.cur !== 'KRW' && r.sym) ? r.sym.split('.')[0]
             : r.name.split(' ')[0];
    // 이름이 안 들어가는 칸은 아예 비운다 — 숫자만 있으면 어느 종목인지 알 수 없어 읽을 수 없다(툴팁으로 대체)
    if (c.w>=68 && c.h>=46) d.innerHTML = '<b>'+nm+'</b>'+chg+'<br>'+fmt(r.wg,1)+'%';
    else if (c.w>=40 && c.h>=30) { d.className = 'cell sm'; d.innerHTML = '<b>'+nm+'</b>'+chg; }
    // \\n — 이 스크립트는 서버 쪽 템플릿 리터럴 안이라 \\n을 써야 클라이언트에 개행 이스케이프로 전달된다
    d.title = r.more
      ? r.name+' 합계 '+fmt(r.wg,1)+'% (가중평균 '+chg+')\\n'
        + r.more.slice(0,10).map(x=>'· '+x.name+' '+fmt(x.wg,2)+'%').join('\\n')
        + (r.more.length>10 ? '\\n… 외 '+(r.more.length-10)+'종목' : '')
      : r.name+' '+chg+' · '+fmt(r.wg,1)+'%';
    el.appendChild(d);
  }
}
function render(){
  if(!D) return;
  const d = D;
  document.getElementById('name').textContent = d.etfName;
  applyTitle();
  if(!recentSaved && d.etfName){ pushRecent(d.code, d.etfName); recentSaved = true; renderRecent(); }
  document.getElementById('meta').textContent = d.code+' · '+(d.issuer||'')+(d.pdfDate && d.pdfDate!=='-' ? ' · PDF '+d.pdfDate : '');
  document.getElementById('bd').style.display = d.isOfficial ? 'none' : '';
  document.getElementById('bdnote').style.display = d.isOfficial ? 'none' : '';
  // 세 칸은 '기준 NAV 이후 누적'이라 기준 시점이 다르면(운용사 PDF 갱신 시차) 같은 지수라도 값이 다르다.
  // 같은 지수 ETF끼리 환율 변동이 왜 다르냐는 혼동이 실제로 있어 구간을 명시한다.
  const bdDates = Object.values(d.fxRefDate||{});
  document.getElementById('bdnote').textContent = '기준 NAV('+(d.navRefDate||'')+') 이후 각 부분의 변동률'
    + (bdDates.length ? ' · 해외는 '+bdDates.sort()[0].slice(5)+' 종가부터' : '')
    + ' · 작은 값은 iNAV 기여분(비중·배수 반영)';
  document.getElementById('cov').style.display = d.isOfficial ? 'none' : '';
  document.getElementById('foot').style.display = d.isOfficial ? 'none' : '';
  // 등락액 표기 (▲250 / ▼735) — %만 있으면 실제로 얼마가 움직였는지 알 수 없다
  const amt = function(v,dd){ return v==null ? '' : (v>0?'▲':v<0?'▼':'')+fmt(Math.abs(v),dd); };
  // 개장 전엔 등락 자체가 없다(서버가 null로 준다) — '+0.00%'가 아니라 —로 둔다
  document.getElementById('mkt').innerHTML = fmt(d.marketPrice,dp(d.marketPrice))+'원 '
    + (d.marketChangePct==null ? '<span class="chg" style="color:var(--muted)">—</span>'
       : '<span class="chg '+cls(d.marketChangePct)+'">'
         + (d.marketChange!=null ? amt(d.marketChange,dp(d.marketPrice))+' ' : '')+sign(d.marketChangePct)+'%</span>')
    + (d.marketOver ? ' <span class="badge b시간외">'+(d.krSession==='NXT프리'?'프리':d.krSession==='NXT애프터'?'애프터':'시간외')+'</span>' : '');
  document.getElementById('idx').textContent = d.baseIndex||'';
  // 첫 칸은 등락의 기준이 된 종가 — 등락액은 바로 위 가격줄에 이미 있고, iNAV는 아래 카드에 있어 중복이었다.
  // 시간외 시세일 땐 등락 기준이 당일 정규장 종가라 라벨을 구분한다.
  // 개장 전엔 등락액이 없어도 전일 종가는 안다(etfClose = 최근 확정 종가)
  const refClose = d.marketChange!=null ? d.marketPrice - d.marketChange : d.etfClose || null;
  document.getElementById('stats').innerHTML =
    '<div>'+(d.marketOver?'당일 종가':'전일 종가')+' <b>'+(refClose!=null?fmt(refClose,dp(d.marketPrice))+'원':'—')+'</b></div>'+
    // 공식 iNAV를 쓰는 상품은 기준 NAV가 전영업일 값이라 괴리율 기준이 '마감 공식 iNAV'다 — 라벨도 그렇게
    '<div>괴리율'+(d.premiumBasis==='regular'?'(정규장 기준)':d.premiumBasis==='close'?(d.isOfficial?'(종가↔공식iNAV)':'(종가↔기준NAV)'):'(시장가)')+' <b class="'+cls(d.premiumPct)+'">'+sign(d.premiumPct)+'%</b></div>'+
    '<div>기준 NAV('+(d.navRefDate||'')+') <b>'+fmt(d.navRef)+'</b></div>'+
    '<div>순자산 <b>'+(d.aum||'—')+'</b></div>'+
    '<div>거래량 <b>'+(d.volume||'—')+'</b></div>'+
    '<div>운용보수 <b>'+(d.fee!=null?d.fee+'%':'—')+'</b></div>';
  document.getElementById('rets').innerHTML = (d.returns||[]).map(r=>'<span class="chip">'+r.periodTypeCode+' '+sign(r.value,1)+'%</span>').join('');
  document.getElementById('clock').textContent = new Date(d.asOf).toLocaleTimeString('ko-KR')+' KST · 한국장 '+sessLabel(d.krSession);
  // 종가 대비: 최근 확정 종가에서 iNAV가 얼마나 움직였나 — "내일 시초가가 얼마나 뜰지"의 가늠자
  document.getElementById('inav').innerHTML = fmt(d.inav,dp(d.inav))+'원 <span class="chg '+cls(d.inavChangePct)+'">'
    + (d.navRef ? amt(d.inav-d.navRef,dp(d.inav))+' ' : '')+sign(d.inavChangePct)+'%</span>'
    + (d.vsClosePct!=null && d.krSession!=='본장' ? ' <span class="sub '+cls(d.vsClosePct)+'" style="font-size:13px;vertical-align:middle;padding:3px 8px" title="최근 영업일 종가 '+fmt(d.etfClose,dp(d.etfClose))+'원 대비">종가 대비 '+sign(d.vsClosePct)+'%</span>' : '')
    // 장외에 1배수로 굴린 값은 순수 공식값이 아니다 — 배지로 구분한다(설명은 아래 note에)
    + (d.isOfficial ? ' <span class="badge official" style="font-size:12px;vertical-align:middle">'
        + (d.levRolled ? 'KRX 공식 + 장외 추정' : 'KRX 공식')+'</span>' : '');
  const hasRows = !!(d.rows && d.rows.length);
  document.getElementById('holdcard').style.display = hasRows ? '' : 'none';
  document.getElementById('treecard').style.display = hasRows ? '' : 'none';
  const fxTxt = Object.entries(d.fx||{}).map(function(e){
    const c=e[0], v=e[1], chg=(d.fxChangePct||{})[c];
    return c+' '+fmt(v,1)+(chg!=null ? '('+sign(chg)+'%)' : '');
  }).join(' · ');
  // 환율 변동의 기준 시점 — 잠정(마감 iNAV) 프레임이면 장마감 15:30 스팟, 그 외엔 해외 종가일의 고시가
  const fxDates = Object.values(d.fxRefDate||{});
  const fxBasis = !fxDates.length ? '' : d.navProvisional ? ' [장마감 15:30 기준]'
    : ' [기준 '+fxDates.sort()[0].slice(5)+' 종가]';
  document.getElementById('inavsub').textContent = '기준 NAV '+fmt(d.navRef)+'원('+(d.navRefDate||'')
    +(d.navProvisional?', 장마감 잠정':d.navAdjusted?', PDF로 재계산':'')+') 대비'+(fxTxt?' · 환율 '+fxTxt+fxBasis:'')
    + (d.sessContrib ? ' · 이 중 정규장 이후 세션분 '+sign(d.sessContrib)+'%p (정규장 시점 iNAV '+fmt(d.inavRegular,dp(d.inavRegular))+'원)' : '');
  document.getElementById('note').textContent = d.note || '';
  // 주 숫자 = 그 부분의 변동률(같은 통화면 어떤 ETF든 동일) · 작은 값 = iNAV 기여(해외비중·배수 반영)
  const rateHtml = function(rate, contrib){
    if(rate==null && !contrib) return '<span class="muted">—</span>';
    if(rate==null) return '<span class="'+cls(contrib)+'">'+sign(contrib)+'%p</span>';
    // 변동률과 기여가 사실상 같으면(단일 구성) 기여 줄은 생략 — 같은 숫자 반복일 뿐
    const same = Math.abs(rate - contrib) < 0.005;
    return '<span class="'+cls(rate)+'">'+sign(rate)+'%</span>'
      + (same ? '' : '<div class="muted" style="font-size:11px;margin-top:2px;font-weight:normal">기여 '+sign(contrib)+'%p</div>');
  };
  document.getElementById('dom').innerHTML = rateHtml(d.domRate, d.domContrib);
  document.getElementById('frn').innerHTML = rateHtml(d.frnRate, d.frnContrib);
  document.getElementById('fxc').innerHTML = rateHtml(d.fxRate, d.fxContrib);
  document.getElementById('updown').innerHTML = '<span class="up">▲'+d.up+'</span> <span class="down">▼'+d.down+'</span>';
  document.getElementById('coverbar').style.width = d.coveragePct+'%';
  document.getElementById('coverpct').textContent = fmt(d.coveragePct,1)+'%';
  const rows = [...d.rows].sort((a,b)=>{const va=a[sortKey]??-1e9, vb=b[sortKey]??-1e9; return sortAsc?va-vb:vb-va;});
  document.getElementById('rows').innerHTML = rows.map(r=>{
    const curFmt = r.cur==='KRW'?'원':(' '+(r.cur||''));
    return '<tr><td title="'+r.name+'">'+r.name+(r.sym?' <span class="muted">'+r.sym+'</span>':'')+'</td>'+
    '<td>'+(r.tracked?'<span class="badge b'+r.session+'">'+r.session+'</span>':'<span class="badge">미추적</span>')+'</td>'+
    '<td>'+(r.tracked?fmt(r.price, r.cur==='JPY'||r.cur==='KRW'?0:2)+curFmt:'—')+'</td>'+
    '<td class="'+cls(r.changePct)+'">'+(r.tracked?(r.changePct==null?'<span class="muted" title="오늘 정규장이 아직 시작 전입니다">—</span>':sign(r.changePct)+'%'):'—')
      + (r.sessPct!=null ? '<div class="sub '+cls(r.sessPct)+'" title="현재 진행 중인 세션 변동(정규장 종가 대비)">'+sign(r.sessPct)+'%</div>' : '')+'</td>'+
    '<td class="'+cls(r.trackPct)+'">'+(r.tracked?sign(r.trackPct)+'%':'—')+'</td>'+
    '<td>'+fmt(r.wg,2)+'%</td></tr>';
  }).join('') + (d.moreCount ? '<tr><td colspan="6" class="muted" style="text-align:center">…외 '+d.moreCount+'종목 (비중 하위, 미추적분은 추적 바스켓 평균으로 외삽)</td></tr>' : '');
  if ($tree.open) treemap(d.rows); // 접혀 있으면 폭이 0 → 펼칠 때 그린다
  document.getElementById('foot').textContent = 'iNAV = 기준NAV × (1 + Σ 비중×(주수×현재가×환율÷PDF평가액 − 1)) · PDF: 운용사 공식 · 시세: Yahoo(미/일/홍콩/중, 프리·애프터), 토스(미국 주간거래), 네이버(국내 시간외) · 15초 갱신 · 등락 위=정규장 마감, 아래 작은값=진행 중 세션 · 추적변동 = PDF 평가시점 대비 누적(환율 포함)';
}
// 종목 페이지도 매 방문이 '새 문서'라 아무것도 남기지 않으면 들어갈 때마다 처음부터 다시 받는다.
// 마지막 응답을 종목별로 남겨 두고, 들어오면 그걸 먼저 그린다(빈 화면 없음).
// 갱신 주기 안이면 조회를 아예 건너뛰고, 지났으면 화면을 보여준 뒤 뒤에서 새로 받는다.
const DSTORE = 'inavLast', DKEEP = 10; // 종목 10개까지 보관(용량 방어)
function dLoad(code){
  try {
    const all = JSON.parse(localStorage.getItem(DSTORE) || '{}');
    return all[code] || null; // {at, d}
  } catch(e){ return null; }
}
function dSave(code, d){
  try {
    const all = JSON.parse(localStorage.getItem(DSTORE) || '{}');
    all[code] = { at: Date.now(), d: d };
    // 오래된 것부터 버린다
    const keys = Object.keys(all).sort(function(a,b){ return all[b].at - all[a].at; });
    const keep = {};
    keys.slice(0, DKEEP).forEach(function(k){ keep[k] = all[k]; });
    localStorage.setItem(DSTORE, JSON.stringify(keep));
  } catch(e){
    // 용량 초과 — 이번 종목만 남기고 다시 시도(실패해도 화면 동작에는 지장 없음)
    try { localStorage.setItem(DSTORE, JSON.stringify({ [code]: { at: Date.now(), d: d } })); } catch(e2){}
  }
}

async function refresh(){
  if(HOME) return; // 메인 화면에선 종목 데이터를 불러오지 않는다(탭 복귀 시 기본종목이 덮어쓰던 문제)
  try{
    const r = await fetch('/api/inav?code='+CODE);
    const d = await r.json();
    if(d.error) throw new Error(d.error);
    D = d; document.getElementById('err').textContent = '';
    dSave(CODE, d);
    render();
  }catch(e){
    document.getElementById('err').textContent = '오류: '+e.message;
    if(!D){ // 첫 로드 실패 — 헤더가 '불러오는 중'에 멈추지 않게
      document.getElementById('name').textContent = CODE+' 조회 실패';
      document.getElementById('inav').textContent = '—';
      document.getElementById('meta').textContent = e.message;
      // 오류 메시지(#err)는 접힌 부분 안에 있으므로 강제로 펼친다
      document.getElementById('holdcard').style.display = '';
      document.getElementById('holdcard').open = true;
      document.getElementById('treecard').style.display = 'none';
    }
  }
}
// 보이지 않는 탭은 갱신하지 않는다 — 켜둔 채 잊어버린 탭이 외부 API를 계속 긁는 걸 막는다.
// 다시 보이면 즉시 1회 갱신해 최신 상태로 맞춘다.
// 단, 로컬 서버는 예외 — 탭을 뒤로 넘겨두고 제목의 iNAV만 보는 용도라 계속 돌린다.
// (브라우저가 숨은 탭 타이머를 1분 단위로 묶으므로 실제 갱신은 약 1분 간격)
const BG_OK = ${LOCAL};
let timer = null;
function startLoop(){ if(!timer) timer = setInterval(refresh, ${REFRESH_MS}); }
function stopLoop(){ if(timer){ clearInterval(timer); timer = null; } }
// 마지막 응답이 갱신 주기 안이면 다시 받지 않는다(있으면 그걸 그린다).
// 재진입·탭 복귀마다 무조건 refresh()를 부르면 12초 전에 받아 둔 값이 있어도 전체를 다시 훑는다.
// 재사용 창은 갱신 주기보다 넉넉하게 둔다 — 포트폴리오 계산은 종목당 몇 초씩 걸려서, 주기(10초)로
// 자르면 계산이 끝날 즈음 첫 종목은 이미 만료다. 그러면 방금 받은 값을 두고 또 받게 된다.
// 창 안이면 그 값으로 그리고 조회를 건너뛴다 — 어차피 정기 타이머가 한 주기 안에 갱신한다.
const REUSE_MS = 60000;
function refreshIfStale(){
  const last = dLoad(CODE);
  if(last && last.d && Date.now() - last.at < REUSE_MS){
    if(!D){ D = last.d; render(); }
    return;
  }
  refresh();
}
document.addEventListener('visibilitychange', function(){
  if(HOME || BG_OK) return;
  if(document.hidden) stopLoop(); else { refreshIfStale(); startLoop(); }
});
// ---------- 메인 화면 ----------
function itemHtml(x){
  return '<button class="hitem" data-code="'+esc(x.code)+'"><span>'+esc(x.name)+'</span><span class="c">'+esc(x.code)+'</span></button>';
}
function showHome(){
  document.getElementById('name').textContent = 'iNAVnow';
  document.getElementById('meta').textContent = '한국 상장 ETF의 실시간 iNAV · 종목명이나 코드로 검색해 보세요';
  ['homelink','pricerow','stats','rets','recent','fav','trackcard','holdcard','treecard'].forEach(function(id){
    const el = document.getElementById(id); if(el) el.style.display = 'none';
  });
  document.getElementById('foot').style.display = 'none';
  ['introcard','home','mktcard'].forEach(function(id){ document.getElementById(id).style.display = ''; });
  applySecOrder();
  mktStart();

  const f = favs();
  const r = recents().filter(function(x){ return !f.some(function(y){ return y.code === x.code; }); });
  let html = '';
  if(f.length) html += '<div class="hsec"><div class="muted">★ 관심</div>' + f.map(itemHtml).join('') + '</div>';
  if(r.length) html += '<div class="hsec"><div class="muted">최근 조회</div>' + r.slice(0,8).map(itemHtml).join('') + '</div>';
  if(!f.length && !r.length) html += '<div class="hsec"><div class="muted">이런 종목으로 시작해 보세요</div>' + SAMPLES.map(itemHtml).join('') + '</div>';
  const box = document.getElementById('homeLists');
  box.innerHTML = html;
  Array.prototype.forEach.call(box.querySelectorAll('button'), function(b){
    b.onclick = function(){ go(b.dataset.code); };
  });
}

// ---------- 지수 · 환율 ----------
// 국내 지수는 정규장에만 움직여 그 밖에는 '마감'이 붙고, 나스닥 선물·달러원은 24시간 돌아
// 주말·휴장에만 붙는다(판단은 서버에서). 값은 localStorage에 남겨 홈 재진입 때 빈 칸이 없게 한다.
// 지수·환율은 종목 화면과 같은 주기로 그린다. 실제 외부 호출 간격은 서버 캐시가 정한다 —
// 국내 지수는 이 주기 그대로, 야후(선물·환율)는 15초, 야간선물은 25초로 각각 묶인다.
const MKT_MS = ${REFRESH_MS};
let MKT = null, MKTAT = 0, mktTimer = null;
function mktStart(){
  if(!MKT){
    try { const c = JSON.parse(localStorage.getItem('mktLast')||'null');
      if(c && Array.isArray(c.d)){ MKT = c.d; MKTAT = c.at || 0; mktRender(); } } catch(e){}
  }
  mktLoad();
  if(!mktTimer) mktTimer = setInterval(function(){ if(!document.hidden || BG_OK) mktLoad(); }, MKT_MS);
}
async function mktLoad(){
  // 갱신 주기 안이면 그냥 둔다 — 앱은 홈에 올 때마다 새 문서라 이게 없으면 매번 다시 받는다
  if(Date.now() - MKTAT < MKT_MS - 1500){ mktRender(); return; }
  try {
    const d = await (await fetch('/api/market')).json();
    if(Array.isArray(d)){
      MKT = d; MKTAT = Date.now();
      try { localStorage.setItem('mktLast', JSON.stringify({at: MKTAT, d: d})); } catch(e){}
    }
  } catch(e){ /* 실패하면 직전 값을 그대로 둔다 */ }
  mktRender();
}
function mktRender(){
  if(!MKT) return;
  document.getElementById('mktbody').innerHTML = MKT.map(function(m){
    const amt = m.chg == null ? '—' : (m.chg>0?'▲':m.chg<0?'▼':'')+fmt(Math.abs(m.chg),2);
    return '<div class="m"><div class="mn">'+esc(m.name)+(m.closed?'<span class="badge closed">마감</span>':'')+'</div>'
      + '<div class="mv">'+(m.value==null?'—':fmt(m.value,2))+'</div>'
      + '<div class="mc '+(m.chg?cls(m.chg):'muted')+'">'+amt+(m.chgPct==null?'':' '+sign(m.chgPct)+'%')+'</div></div>';
  }).join('');
  document.getElementById('mktclock').textContent = MKTAT ? new Date(MKTAT).toLocaleTimeString('ko-KR')+' 기준' : '';
}

// ---------- 홈 섹션 순서 ----------
// HTML5 drag&drop은 모바일 WebView에서 동작하지 않아 pointer 이벤트로 직접 옮긴다.
// 드래그 중 카드를 실제로 DOM에서 이동시키므로 미리보기가 곧 결과다.
const SEC_DEF = ['lists','mkt','pf'];
function secOrder(){
  try {
    const a = JSON.parse(localStorage.getItem('secOrder'));
    if(Array.isArray(a) && a.length === SEC_DEF.length && SEC_DEF.every(function(k){ return a.indexOf(k) >= 0; })) return a;
  } catch(e){}
  return SEC_DEF.slice();
}
function applySecOrder(){
  const box = document.getElementById('hsecs');
  secOrder().forEach(function(k){
    const el = box.querySelector('[data-sec="'+k+'"]');
    if(el) box.appendChild(el); // 순서대로 뒤에 붙이면 그 순서가 된다
  });
}
function gripDown(e){
  const card = e.target.closest('.sect');
  if(!card) return;
  e.preventDefault(); // 손잡이에서 시작한 터치는 스크롤로 넘기지 않는다
  const box = document.getElementById('hsecs');
  card.classList.add('drag');
  function move(ev){
    const y = ev.clientY;
    const sibs = Array.prototype.filter.call(box.querySelectorAll('.sect'), function(s){
      return s !== card && s.offsetParent; // 숨어 있는 섹션은 건너뛴다
    });
    for(let i = 0; i < sibs.length; i++){
      const r = sibs[i].getBoundingClientRect();
      if(y > r.top && y < r.bottom){
        box.insertBefore(card, y < r.top + r.height/2 ? sibs[i] : sibs[i].nextSibling);
        break;
      }
    }
  }
  function up(){
    card.classList.remove('drag');
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    const ks = Array.prototype.map.call(box.querySelectorAll('.sect'), function(s){ return s.dataset.sec; });
    try { localStorage.setItem('secOrder', JSON.stringify(ks)); } catch(e){}
  }
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// ---------- 내 포트폴리오 ----------
// 보유 종목의 실시간 iNAV로 지금 평가금액을 낸다. 수량·단가는 localStorage에만 두고 서버로 보내지 않는다.
const ICON_EDIT = '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.6 3.4a2 2 0 0 1 2.9 2.9L7.5 18.3 3.5 19.4l1.1-4Z"/></svg>';
const ICON_DEL  = '<svg viewBox="0 0 24 24"><path d="M3.5 6.5h17"/><path d="M18.5 6.5 17.4 20a1 1 0 0 1-1 .9H7.6a1 1 0 0 1-1-.9L5.5 6.5"/><path d="M9.8 10.5v6M14.2 10.5v6"/><path d="M9 6.5V4.4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2.1"/></svg>';
const PFSTORE = 'pf';
// 공개 서버(auth.js로 띄운 경우)는 서버 파일에 저장한다 — 집·폰에서 같은 포트폴리오를 본다.
// 로컬판은 이 브라우저에만 저장한다(서버로 아무것도 보내지 않는다).
const PF_REMOTE = ${!LOCAL && !ANDROID};
const pfLocal = () => { try { return JSON.parse(localStorage.getItem(PFSTORE)||'[]'); } catch(e){ return []; } };
let PF = PF_REMOTE ? [] : pfLocal();
let PF_OK = !PF_REMOTE; // 서버 저장을 실제로 쓸 수 있는지
let PF_DOWN = '';    // 서버 모드에서 목록을 못 불러온 상태 — 편집을 막는다(빈 목록으로 덮어쓰면 원본이 날아간다)
let PFV = {};        // code → 최근 계산한 {inav, price}
let PFAT = null;     // 화면에 보이는 기준 시각(현재가만 갱신해도 움직인다)
let PFCAT = null;    // iNAV 전체 계산 시각 — 재계산 판단은 이걸로 한다
                     // (현재가 갱신이 PFAT를 밀면 5분 조건이 매번 리셋돼 iNAV가 영영 안 바뀐다)
let PFERR = '';      // 저장 실패 안내
let PFBUSY = false, pfEditIdx = -1, pfPick = null;
const PF_TTL = 60e3; // iNAV 전체 재계산 간격. 더 줄여도 외부 호출은 시세 캐시(30초)에 묶여 늘지 않지만,
                     // 장외에는 3종목 계산에 4.7초가 들어 30초로 하면 거의 쉬지 않고 돈다
// 종목 상세 ↔ 홈 이동은 매번 '새 문서'라 PFV·PFAT가 메모리에서 사라진다(앱은 file:// 이동이라 특히).
// 남겨 두지 않으면 5분이 안 지났는데도 홈에 올 때마다 전 종목을 다시 조회한다.
const PFCSTORE = 'pfCalc';
(function pfLoadCalc(){
  try {
    const d = JSON.parse(localStorage.getItem(PFCSTORE) || 'null');
    if(d && d.at && d.v){ PFV = d.v; PFAT = new Date(d.at); PFCAT = new Date(d.cat || d.at); }
  } catch(e){}
})();
function pfSaveCalc(){
  try {
    const v = {}; // 지운 종목의 값은 남기지 않는다
    PF.forEach(function(h){ if(PFV[h.code]) v[h.code] = PFV[h.code]; });
    localStorage.setItem(PFCSTORE, JSON.stringify({at: PFAT ? +PFAT : Date.now(), cat: PFCAT ? +PFCAT : null, v: v}));
  } catch(e){}
}
// 평가 기준: 정규장 중엔 '현재가'(실제로 팔릴 값), 그 밖에는 'iNAV'(체결가가 멈춰 있어 유일한 단서)가 기본.
// 첫 렌더는 시계로 추정하고, 첫 조회 응답의 krSession으로 교정한다(공휴일은 시계로 알 수 없다).
// 직접 누르면 그 선택을 지키고, 새로 열면 다시 기본값으로 돌아간다.
function pfDefBasis(sess){
  if(sess) return sess === '본장' ? 'price' : 'inav';
  const k = new Date(Date.now() + 9 * 3600e3);
  const hm = k.getUTCHours() * 100 + k.getUTCMinutes(), wd = k.getUTCDay();
  return (wd >= 1 && wd <= 5 && hm >= 900 && hm < 1530) ? 'price' : 'inav';
}
let PFB = pfDefBasis(null), pfBPinned = false;
function pfBasis(b){ PFB = b; pfBPinned = true; pfRender(); }
async function pfLoad(){
  if(!PF_REMOTE) return;
  let r;
  try { r = await fetch('/api/pf'); }
  catch(e){ PF_DOWN = '서버에 연결할 수 없어 포트폴리오를 불러오지 못했습니다.'; PF_OK = false; PF = []; return; }
  if(r.status === 404){ // 래퍼 없이 ETF_SERVER=1로 띄운 구성 — 저장 API 자체가 없다 → 브라우저 저장
    PF_OK = false; PF = pfLocal(); return;
  }
  if(!r.ok){
    // 파일 손상·권한 오류 등. 여기서 브라우저 저장으로 조용히 넘어가면, 이후 수정한 내용이
    // 서버가 살아난 뒤 사라진다. 그래서 오류를 그대로 보여주고 편집을 막는다.
    let msg = '';
    try { msg = (await r.json()).error || ''; } catch(e){}
    PF_DOWN = msg || ('포트폴리오를 불러오지 못했습니다 (HTTP '+r.status+')');
    PF_OK = false; PF = [];
    return;
  }
  try {
    const d = await r.json();
    if(!Array.isArray(d.items)) throw new Error('형식이 올바르지 않습니다');
    PF = d.items; PF_OK = true; PF_DOWN = '';
  } catch(e){ PF_DOWN = '서버 응답을 해석할 수 없습니다.'; PF_OK = false; PF = []; }
}
// 저장 요청을 한 줄로 세운다 — 빠르게 연달아 고치면 PUT 순서가 뒤바뀌어 옛 목록이 최종본이 될 수 있다
let pfQueue = Promise.resolve();
function pfSet(l){
  PF = l;
  if(!(PF_REMOTE && PF_OK)){ localStorage.setItem(PFSTORE, JSON.stringify(l)); return; }
  const body = JSON.stringify(l);
  pfQueue = pfQueue.then(function(){
    return fetch('/api/pf', {method:'PUT', headers:{'Content-Type':'application/json'}, body: body})
      .then(function(r){
        if(!r.ok) throw new Error(r.status);
        if(PFERR){ PFERR = ''; pfRender(); }
      });
  }).catch(function(){ // 체인이 끊기지 않게 여기서 흡수하고 안내만 띄운다
    PFERR = '서버에 저장하지 못했습니다 — 새로고침하면 되돌아갑니다.'; pfRender();
  });
}
const amtHtml = (v, c) => (v>0?'▲':v<0?'▼':'')+fmt(Math.abs(v),0)+(c||'원');

function pfRender(){
  const sum = document.getElementById('pfsum'), box = document.getElementById('pfbody');
  const ck = document.getElementById('pfclock'), bad = PF_DOWN || PFERR;
  ck.textContent = bad ? bad
    : PFAT ? PFAT.toLocaleTimeString('ko-KR')+' KST 기준' : PF.length ? '계산 중…' : '';
  ck.className = bad ? 'up' : 'muted';
  // 불러오기에 실패했으면 추가·수정을 막는다 — 빈 목록 상태로 저장하면 서버의 원본이 날아간다
  document.getElementById('pfaddbtn').disabled = !!PF_DOWN;
  document.getElementById('pfrf').disabled = !!PF_DOWN;
  Array.prototype.forEach.call(document.querySelectorAll('#pfbasis button'), function(b){
    b.classList.toggle('on', b.dataset.b === PFB);
  });
  sum.style.display = PF.length && !PF_DOWN ? '' : 'none';
  if(PF_DOWN){
    sum.innerHTML = '';
    box.innerHTML = '<div id="pfempty">지우거나 덮어쓰지 않도록 편집을 잠갔습니다. 서버의 <b>portfolio.json</b>을 확인한 뒤 새로고침해 주세요.</div>';
    return;
  }
  if(!PF.length){
    sum.innerHTML = '';
    box.innerHTML = '<div id="pfempty">보유한 ETF를 추가하면 구성종목의 실시간 시세로 계산한 <b>지금 이 순간의 평가금액</b>을 보여줍니다.<br>'
      + (PF_REMOTE && PF_OK
          ? '수량·평균단가는 이 서버에 저장되어 어느 기기로 접속해도 같은 목록을 봅니다.'
          : '수량·평균단가는 이 브라우저에만 저장되며 서버로 전송되지 않습니다.')
      + '</div>';
    return;
  }
  const bLbl = PFB === 'price' ? '현재가' : 'iNAV';
  let cost = 0, val = 0, allKnown = true;
  const rows = PF.map(function(h){
    const c = h.avg * h.qty, q = PFV[h.code] || null;
    const u = q ? (PFB === 'price' ? q.price : q.inav) : null; // 선택한 기준의 단가
    cost += c;
    if(u == null) allKnown = false; else val += u * h.qty;
    return { h: h, cost: c, unit: u, val: u != null ? u * h.qty : null };
  });
  const total = allKnown ? val : null;
  const diff = total != null ? total - cost : null;
  const pct = (diff != null && cost > 0) ? diff / cost * 100 : null;
  sum.innerHTML =
    '<div class="bx"><div class="muted">원금</div><div class="v">'+fmt(cost,0)+'원</div></div>'+
    '<div class="bx"><div class="muted">현재가치 <span style="font-size:10.5px">'+bLbl+' 기준</span></div>'+
      '<div class="v">'+(total!=null ? fmt(total,0)+'원' : '—')+'</div></div>'+
    '<div class="bx"><div class="muted">변동</div><div class="v '+(diff!=null?cls(diff):'')+'">'+
      (diff!=null ? amtHtml(diff)+'<span class="pct">'+sign(pct)+'%</span>' : '—')+'</div></div>';
  // 비중은 선택한 기준의 평가금액 — 값이 움직이면 막대도 따라 움직인다. 아직 못 구했으면 원금 기준.
  const base = (total != null && total > 0) ? total : cost;
  box.innerHTML = rows.map(function(r, i){
    const mine = r.val != null ? r.val : r.cost;
    const w = base > 0 ? Math.min(100, mine / base * 100) : 0;
    const d = r.val != null ? r.val - r.cost : null;
    const p = (d != null && r.cost > 0) ? d / r.cost * 100 : null;
    return '<div class="pfrow">'+
      '<div class="nm"><a href="?code='+esc(r.h.code)+'" title="'+esc(r.h.name)+' 상세 보기">'+esc(r.h.name)+'</a>'+
        '<span class="act">'+
          '<button type="button" title="수정" onclick="pfOpen('+i+')">'+ICON_EDIT+'</button>'+
          '<button type="button" title="삭제" onclick="pfDel('+i+')">'+ICON_DEL+'</button>'+
        '</span></div>'+
      '<div class="pfbar" title="'+(r.val!=null?bLbl:'원금')+' 기준 비중 '+fmt(w,1)+'%">'+
        '<i style="width:'+w.toFixed(1)+'%"></i><span>'+fmt(w,1)+'%'+
        (mine!=null ? '<b>('+fmt(mine,0)+')</b>' : '')+'</span></div>'+
      '<div class="dt"><span class="muted">'+fmt(r.h.qty,0)+'주 · 평균 '+fmt(r.h.avg,dp(r.h.avg))+'원'+
        (r.unit!=null ? ' → '+bLbl+' '+fmt(r.unit,dp(r.unit))+'원' : '')+'</span>'+
        '<span class="'+(d!=null?cls(d):'muted')+'">'+
          (d!=null ? amtHtml(d)+' <span style="font-size:12px">'+sign(p)+'%</span>' : '계산 중…')+'</span>'+
      '</div></div>';
  }).join('');
}

// 현재가만 갱신 — /api/px는 ETF 시세 배치 한 번이라 종목 화면과 같은 주기로 돌려도 부담이 없다.
// iNAV는 그대로 두고 price만 바꾸므로, 현재가 기준으로 보고 있으면 값이 즉시 따라 움직인다.
async function pfPxTick(){
  if(!PF.length || PF_DOWN || PFBUSY) return;
  try {
    const d = await (await fetch('/api/px?codes='+encodeURIComponent(PF.map(function(h){ return h.code; }).join(',')))).json();
    let any = false;
    PF.forEach(function(h){
      const v = d && d[h.code];
      if(v && v.price > 0){ PFV[h.code] = Object.assign({}, PFV[h.code], { price: v.price }); any = true; }
    });
    if(any){ PFAT = new Date(); pfSaveCalc(); pfRender(); }
  } catch(e){ /* 실패하면 다음 주기에 다시 */ }
}

async function pfCalc(){
  if(PFBUSY || PF_DOWN || !PF.length) return;
  PFBUSY = true;
  const btn = document.getElementById('pfrf');
  btn.disabled = true; // disabled인 동안만 CSS가 회전시킨다
  // 순차 조회 — 한꺼번에 던지면 ETF 하나가 구성종목 수백 개를 훑으므로 외부 API 부담이 크다.
  // 앞 종목이 채운 시세 캐시를 뒤 종목이 재사용하는 이점도 있다.
  // 순차로 둔다. 병렬로 바꿔 봤지만 종목마다 구성종목 시세를 각자 100건씩 동시에 던져
  // 커넥션 풀에서 밀려 오히려 3배 느렸다(실측 3종목: 순차 4.7초·100회 → 병렬 13.4초·263회).
  // in-flight 병합은 같은 키만 합치므로 서로 다른 종목의 조회는 합쳐지지 않는다.
  for(const h of PF){
    await (async function(h){
    try {
      // 종목 페이지가 갱신 주기 안에 받아 둔 게 있으면 그대로 쓴다 — 같은 응답을 두 번 받지 않는다
      const cached = dLoad(h.code);
      const fresh = cached && cached.d && Date.now() - cached.at < REUSE_MS;
      const d = fresh ? cached.d : await (await fetch('/api/inav?code='+encodeURIComponent(h.code))).json();
      if(d && d.inav != null) PFV[h.code] = { inav: d.inav, price: d.marketPrice };
      // 반대로 여기서 받은 응답도 남긴다 — 이 종목을 눌러 들어가면 다시 받지 않는다
      if(!fresh && d && d.inav != null) dSave(h.code, d);
      if(!pfBPinned && d && d.krSession) PFB = pfDefBasis(d.krSession); // 공휴일 교정
      if(d && d.etfName && d.etfName !== h.name){ h.name = d.etfName; pfSet(PF); } // 운용사 개명 반영
    } catch(e){ /* 한 종목 실패가 나머지 계산을 막지 않는다 */ }
    pfRender(); // 끝난 종목부터 화면에 채운다
    })(h);
  }
  PFAT = PFCAT = new Date();
  pfSaveCalc(); // 다음 페이지 로드가 5분 안이면 이 값을 그대로 쓴다
  PFBUSY = false; btn.disabled = false;
  pfRender();
}

function pfOpen(i){
  if(PF_DOWN) return; // 불러오기 실패 상태에서는 편집을 막는다
  pfEditIdx = i;
  const h = i >= 0 ? PF[i] : null;
  pfPick = h ? {code: h.code, name: h.name} : null;
  document.getElementById('pfdlgh').textContent = h ? '보유 종목 수정' : '포트폴리오 추가';
  document.getElementById('pfok').textContent = h ? '저장' : '추가';
  document.getElementById('pfq').value = h ? h.name : '';
  document.getElementById('pfavg').value = h ? h.avg : '';
  document.getElementById('pfqty').value = h ? h.qty : '';
  document.getElementById('pferr').textContent = '';
  document.getElementById('pfsugg').style.display = 'none';
  pfdlg.showModal();
  (h ? document.getElementById('pfavg') : document.getElementById('pfq')).focus();
}
function pfSave(){
  const err = document.getElementById('pferr');
  const avg = parseFloat(document.getElementById('pfavg').value);
  const qty = parseFloat(document.getElementById('pfqty').value);
  if(!pfPick){ err.textContent = '종목을 검색해 목록에서 선택해 주세요.'; return false; }
  if(!(avg > 0)){ err.textContent = '평균단가를 0보다 큰 값으로 입력해 주세요.'; return false; }
  if(!(qty > 0)){ err.textContent = '보유수량을 0보다 큰 값으로 입력해 주세요.'; return false; }
  const dup = PF.findIndex(function(x){ return x.code === pfPick.code; });
  if(dup >= 0 && dup !== pfEditIdx){ err.textContent = '이미 담긴 종목입니다. 그 종목의 수정 버튼을 눌러 주세요.'; return false; }
  const rec = {code: pfPick.code, name: pfPick.name, avg: avg, qty: qty};
  const l = PF.slice();
  if(pfEditIdx >= 0) l[pfEditIdx] = rec; else l.push(rec);
  pfSet(l);
  pfdlg.close();
  pfRender();
  pfCalc();
  return false; // 닫기는 위에서 했다 — form의 기본 동작은 막는다
}
function pfDel(i){
  const h = PF[i];
  if(!h || !confirm(h.name+'을(를) 포트폴리오에서 삭제할까요?')) return;
  const l = PF.slice(); l.splice(i, 1); pfSet(l);
  pfRender();
}
function pfSearch(){
  const el = document.getElementById('pfsugg'), raw = document.getElementById('pfq').value.trim(), q = norm(raw);
  if(!q){ el.style.display = 'none'; return; }
  if(!ETFS.length){
    el.innerHTML = '<div class="muted" style="cursor:default">종목 목록을 불러오는 중…</div>';
    el.style.display = 'block'; return;
  }
  const list = ETFS.filter(function(x){ return norm(x.name).includes(q) || x.code.startsWith(raw); }).slice(0, 8);
  if(!list.length){
    el.innerHTML = '<div class="muted" style="cursor:default">검색 결과가 없습니다</div>';
    el.style.display = 'block'; return;
  }
  el.innerHTML = list.map(function(x){
    return '<div data-code="'+esc(x.code)+'" data-name="'+esc(x.name)+'">'+esc(x.name)+' <span class="muted">('+esc(x.code)+')</span></div>';
  }).join('');
  el.style.display = 'block';
  Array.prototype.forEach.call(el.querySelectorAll('div[data-code]'), function(d){
    d.onmousedown = function(e){ e.preventDefault(); pfChoose(d.dataset.code, d.dataset.name); };
  });
}
function pfChoose(code, name){
  pfPick = {code: code, name: name};
  document.getElementById('pfq').value = name;
  document.getElementById('pfsugg').style.display = 'none';
  document.getElementById('pferr').textContent = '';
  document.getElementById('pfavg').focus();
}
(function(){
  const $pfq = document.getElementById('pfq');
  $pfq.addEventListener('input', function(){ pfPick = null; pfSearch(); });
  $pfq.addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ // 엔터로 폼이 먼저 submit되지 않게 첫 후보를 고른다
      const first = document.querySelector('#pfsugg div[data-code]');
      if(first){ e.preventDefault(); pfChoose(first.dataset.code, first.dataset.name); }
    } else if(e.key === 'Escape'){ document.getElementById('pfsugg').style.display = 'none'; e.stopPropagation(); }
  });
})();

if(HOME){
  showHome();
  document.getElementById('pfcard').style.display = '';
  pfRender();
  // 남겨 둔 계산이 5분보다 오래됐을 때만 다시 조회한다. 3분 전에 계산했다면 그 값을 그대로 보여주고
  // 2분 뒤에 갱신한다 — 홈에 올 때마다 전 종목을 다시 훑던 문제(앱에서 특히 두드러짐).
  // 별도 타이머를 관리하지 않고 30초마다 나이만 재는 방식이라 이중 발화가 없다.
  function pfTick(){
    if(!(BG_OK || !document.hidden)) return; // 안 보이는 탭에서는 건너뛴다
    if(!PFCAT || Date.now() - +PFCAT >= PF_TTL) pfCalc();
  }
  pfLoad().then(function(){ pfRender(); pfTick(); pfPxTick(); }); // 서버 저장이면 목록을 받아온 뒤 판단
  setInterval(pfTick, 30e3);
  // 현재가는 ETF 자체 시세만 있으면 되므로(구성종목을 훑지 않는다) 종목 화면과 같은 주기로 돌린다.
  // iNAV 전체 재계산은 위 pfTick이 5분마다 맡는다.
  setInterval(function(){ if(BG_OK || !document.hidden) pfPxTick(); }, MKT_MS);
}
else {
  renderRecent();
  // 남겨 둔 응답이 있으면 먼저 그려서 빈 화면을 없앤다(주기가 지났으면 그 뒤에 새로 받는다)
  const last = dLoad(CODE);
  if(last && last.d){ D = last.d; render(); }
  refreshIfStale();
  if(BG_OK || !document.hidden) startLoop();
}
</script></body></html>`;

const handler = async (req, res) => {
  const u = new URL(req.url, 'http://x');

  if (u.pathname === '/favicon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    return res.end(FAVICON);
  }

  if (u.pathname === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(stats, null, 1));
  }
  if (u.pathname === '/api/etfs') {
    try {
      const list = await etfList();
      send(req, res, JSON.stringify(list), JSON_T);
    } catch (e) {
      console.error('/api/etfs 실패:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (u.pathname === '/api/market') {
    try {
      send(req, res, JSON.stringify(await marketQuotes()), JSON_T);
    } catch (e) {
      console.error('/api/market 실패:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (u.pathname === '/api/pdfinfo') {
    // 하루 한 번만 받아도 되는 자료(구성종목 PDF·차단 기록)의 상태와 수동 초기화
    if (u.searchParams.get('clear') === '1') {
      let n = 0;
      for (const k of [...cache.keys()]) if (/^(pdf:|blk:)/.test(k)) { cache.delete(k); n++; }
      saveCache();
      send(req, res, JSON.stringify({ cleared: n }), JSON_T);
      return;
    }
    const items = [];
    for (const [k, v] of cache) if (k.startsWith('pdf:')) items.push({ src: k.split(':')[1], at: v.ts, stdDt: v.data?.stdDt || null });
    const blocked = [...cache.keys()].filter(k => k.startsWith('blk:') && issuerBlocked(k.slice(4))).map(k => k.slice(4));
    send(req, res, JSON.stringify({
      count: items.length,
      oldest: items.length ? Math.min(...items.map(x => x.at)) : null,
      newest: items.length ? Math.max(...items.map(x => x.at)) : null,
      dates: [...new Set(items.map(x => x.stdDt).filter(Boolean))].sort(),
      ttlMs: PDF_TTL, blocked,
    }), JSON_T);
    return;
  }
  if (u.pathname === '/api/px') {
    // ETF 자체 시세만 — 구성종목을 훑지 않으므로 포트폴리오 현재가를 종목 화면과 같은 주기로 갱신할 수 있다
    try {
      const codes = (u.searchParams.get('codes') || '').split(',')
        .filter(c => /^[0-9A-Z]{6}$/.test(c)).slice(0, 30);
      const q = codes.length ? await krQuotes(codes) : {};
      send(req, res, JSON.stringify(Object.fromEntries(codes.map(c =>
        [c, q[c] ? { price: q[c].last, prev: q[c].prevClose, session: q[c].session } : null]))), JSON_T);
    } catch (e) {
      console.error('/api/px 실패:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (u.pathname === '/api/inav') {
    try {
      const before = stats.calls;
      const data = await computeINav(u.searchParams.get('code') || DEFAULT_CODE);
      const body = JSON.stringify(data);
      stats.reqs++; stats.bytesOut += body.length;
      stats.lastReqCalls = stats.calls - before; // 이번 요청이 유발한 외부 호출 수
      send(req, res, body, JSON_T);
    } catch (e) {
      // 세션 0(숨김 실행)에선 이 로그가 문제를 알 수 있는 유일한 창구다
      console.error('/api/inav 실패:', u.searchParams.get('code') || DEFAULT_CODE, '-', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  send(req, res, HTML, HTML_T);
};

// 안드로이드에서는 HTTP 서버가 없다 — 페이지가 이 함수들을 직접 부른다(에셋 index.html의 fetch shim).
if (!NODE) {
  globalThis.ENGINE = { computeINav, etfList, marketQuotes, krQuotes, stats, cache, saveCache,
    issuerBlocked, PDF_TTL, krSession, todayYmd, DEFAULT_CODE };
} else {

// async 핸들러가 던지면 unhandled rejection으로 프로세스가 죽는다 — 요청 하나로 서비스가 내려간다.
// 라우트별 try/catch와 별개로 마지막 그물을 둔다(잘못된 request-target, 소켓 조기 종료 등).
const server = http.createServer((req, res) => {
  handler(req, res).catch(e => {
    console.error('요청 처리 실패:', req.method, req.url, e.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    if (!res.writableEnded) res.end('서버 오류');
  });
});

// test.js·auth.js가 require해서 쓸 수 있게 직접 실행일 때만 포트를 연다
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`http://localhost:${PORT}`);
    // manage.ps1이 '우리 서버'만 골라 죽일 수 있게 PID를 남긴다 (포트 점유자를 무작정 죽이지 않기 위해)
    try { fs.writeFileSync(__dirname + '/server.pid', String(process.pid)); } catch (e) {}
  });
}
module.exports = { server, handler, PORT, HTML, cached, cache, krSession, marketPx, navIdxChg, notePdfSet, noteKrStatus, todayYmd, parseKrDays, loadKrDays, isKrBiz, calClosedToday, SECTIGO_OV_CA };

}
