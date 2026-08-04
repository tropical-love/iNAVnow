// 런처 아이콘 생성 — 원본 PNG 하나에서 안드로이드 밉맵 세트를 만든다. 의존성 없이 순수 JS.
//   node tools/build-icon.js "<원본.png>"
//
// 왜 손으로 안 하나: 안드로이드는 adaptive icon(전경/배경 108dp)과 구형 밉맵(48~192px)을
// 밀도별로 요구하고, 런처가 전경을 원형·스퀘어클로 잘라낸다.
//
// 하는 일
//   ① 원본에서 '내용'의 경계를 재서(여백 무시) 정사각으로 맞춘다 — 테두리가 있는 그림이든
//      없는 그림이든 같은 크기로 보이게. 비율을 고정하면 원본을 바꿀 때마다 어긋난다.
//   ② adaptive 전경: 내용을 FG_FRAC 비율로 넣고, 원형 마스크로 얼마나 잘리는지 계산해 보고한다.
//   ③ 구형 밉맵: 원본 배경색에 합성해 채운다(투명하면 legacy 슬롯에서 깨져 보인다).
//   ④ 배경색을 values/colors.xml에 기록 — 전경의 사각형 경계가 배경과 같은 색이라 안 보이게.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) { console.error('원본 PNG 경로를 주세요'); process.exit(1); }
const RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

// ---------- 최소 PNG 리더 (RGBA8 / 팔레트 아님 / 인터레이스 아님) ----------
function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG가 아닙니다');
  let p = 8, w = 0, h = 0, bit = 0, ct = 0, idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bit = data[8]; ct = data[9];
      if (data[12] !== 0) throw new Error('인터레이스 PNG는 지원하지 않습니다');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bit !== 8 || (ct !== 6 && ct !== 2)) throw new Error(`지원하지 않는 형식(bit=${bit}, colorType=${ct})`);
  const ch = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0, q = 0; y < h; y++) {
    const ft = raw[q++];
    const line = Buffer.from(raw.subarray(q, q + stride)); q += stride;
    // PNG 필터 되돌리기
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      if (ft === 1) line[i] = (line[i] + a) & 255;
      else if (ft === 2) line[i] = (line[i] + b) & 255;
      else if (ft === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch, d = (y * w + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
      out[d + 3] = ch === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { w, h, px: out };
}

// ---------- 최소 PNG 라이터 ----------
function writePng(w, h, px) {
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // 필터 없음
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const b = Buffer.alloc(8 + data.length + 4);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, 'ascii');
    data.copy(b, 8);
    b.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
let T = null;
function crc(b) {
  if (!T) {
    T = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- 그림 내용의 경계 찾기 ----------
// 원본마다 여백이 달라서(테두리가 있는 그림 / 없는 그림) 축소 비율을 고정하면 로고가 작아 보이거나
// 잘린다. 실제 내용 범위를 재서 맞춘다. '내용'은 ① 반투명 이상이고 ② 흰색에 가깝지 않은 픽셀.
// (투명 배경 원본은 ①이, 흰 배경 원본은 ②가 걸러 준다)
function bbox(src) {
  let x0 = src.w, y0 = src.h, x1 = -1, y1 = -1;
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    const s = (y * src.w + x) * 4;
    if (src.px[s + 3] < 24) continue;
    const far = 255 - Math.min(src.px[s], src.px[s + 1], src.px[s + 2]);
    if (far < 18) continue; // 흰색·연회색 배경
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return { x: 0, y: 0, w: src.w, h: src.h }; // 못 찾으면 전체
  // 정사각으로 맞춘다(가로세로 비율을 유지해 로고가 늘어나지 않게)
  const side = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  return {
    x: Math.round((x0 + x1) / 2 - side / 2), y: Math.round((y0 + y1) / 2 - side / 2),
    w: side, h: side,
  };
}

// ---------- 박스 필터 축소 (안티에일리어싱) ----------
// box: 원본에서 잘라낼 영역 · frac: 결과 canvas에서 그 내용이 차지할 비율 · bg: 배경색(null이면 투명)
function place(src, size, box, frac, bg) {
  const out = Buffer.alloc(size * size * 4);
  if (bg) for (let i = 0; i < size * size; i++) { out[i*4] = bg[0]; out[i*4+1] = bg[1]; out[i*4+2] = bg[2]; out[i*4+3] = 255; }
  const inner = Math.max(1, Math.round(size * frac)), off = Math.round((size - inner) / 2);
  const sx = box.w / inner, sy = box.h / inner;
  for (let y = 0; y < inner; y++) {
    const y0 = Math.floor(box.y + y * sy), y1 = Math.min(src.h, Math.ceil(box.y + (y + 1) * sy));
    for (let x = 0; x < inner; x++) {
      const x0 = Math.floor(box.x + x * sx), x1 = Math.min(src.w, Math.ceil(box.x + (x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let j = Math.max(0, y0); j < y1; j++) for (let i = Math.max(0, x0); i < x1; i++) {
        const s = (j * src.w + i) * 4, al = src.px[s + 3] / 255;
        // 알파 가중 평균 — 투명 픽셀의 검정이 섞여 테두리가 어두워지는 것을 막는다
        r += src.px[s] * al; g += src.px[s + 1] * al; b += src.px[s + 2] * al; a += src.px[s + 3]; n++;
      }
      if (!n) continue;
      const aa = a / n, w = a / 255 || 1;
      const d = ((y + off) * size + (x + off)) * 4;
      const sr = Math.round(r / w), sg = Math.round(g / w), sb = Math.round(b / w);
      if (bg) { // 배경 위에 알파 합성
        const al = aa / 255;
        out[d] = Math.round(sr * al + bg[0] * (1 - al));
        out[d + 1] = Math.round(sg * al + bg[1] * (1 - al));
        out[d + 2] = Math.round(sb * al + bg[2] * (1 - al));
        out[d + 3] = 255;
      } else { out[d] = sr; out[d + 1] = sg; out[d + 2] = sb; out[d + 3] = Math.round(aa); }
    }
  }
  return out;
}

const src = readPng(fs.readFileSync(SRC));
const box = bbox(src);

// 전경에서 내용이 차지할 비율 — 추측하지 않고 계산한다.
//
// adaptive icon은 108dp 중 가운데 72dp(66.7%)만 보장되고, 마스크는 런처마다 다르다(원형·스퀘어클·
// 둥근 사각형). 어디서도 잘리지 않으려면 가장 좁은 마스크인 **내접원**(지름 66.7%) 안에 내용이
// 전부 들어가야 한다. 정사각 로고를 그 원에 넣으면 비율이 0.667/√2 ≈ 0.47까지 내려가는데,
// 실제 로고는 네 귀가 비어 있는 경우가 많아 그만큼 줄일 필요가 없다.
// 그래서 내용의 '외접원 반지름'을 재서 딱 맞는 비율을 구한다(안전 여유 2%).
// (실측: 눈대중 0.56은 갤럭시 스퀘어클에서 잘려 보였다 — 원 기준 2.3% 초과였음)
const SAFE_D = 0.667; // 보장되는 내접원의 지름 비율
const FG_FRAC = (() => {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  let r2 = 0;
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    const s = (y * src.w + x) * 4;
    if (src.px[s + 3] < 24) continue;
    if (255 - Math.min(src.px[s], src.px[s + 1], src.px[s + 2]) < 18) continue;
    const d2 = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
    if (d2 > r2) r2 = d2;
  }
  const rSrc = Math.sqrt(r2);              // 내용의 외접원 반지름(원본 픽셀)
  const frac = SAFE_D / 2 / (rSrc / box.w); // 그 반지름이 내접원 반지름에 딱 닿는 비율
  return Math.min(0.9, frac * 0.98);        // 안티에일리어싱 여유 2%
})();
// 원본 배경색을 그대로 배경 레이어에 쓴다 — 전경의 불투명 사각형 경계가 안 보이게 하려면
// 두 색이 같아야 한다(원본이 순백이 아니라 살짝 회색빛일 수 있다).
const corner = (() => {
  const p = (y, x) => { const s = (y * src.w + x) * 4; return [src.px[s], src.px[s+1], src.px[s+2], src.px[s+3]]; };
  const c = p(2, 2);
  return c[3] < 24 ? [255, 255, 255] : [c[0], c[1], c[2]]; // 투명 원본이면 흰색
})();
console.log(`전경 비율 자동계산 → ${(FG_FRAC*100).toFixed(1)}%`);
console.log(`원본 ${src.w}x${src.h} · 내용 경계 ${box.w}x${box.h} @(${box.x},${box.y})`
  + ` = 캔버스의 ${(box.w / src.w * 100).toFixed(0)}%`);

// 구형 밉맵 — minSdk 26이라 adaptive가 항상 이기지만, 알림·스토어 등 legacy 슬롯을 위해 남긴다.
// 투명 배경으로 두면 legacy 슬롯에서 깨져 보이므로 흰 배경에 합성한다.
const LEGACY = { 'mipmap-mdpi': 48, 'mipmap-hdpi': 72, 'mipmap-xhdpi': 96, 'mipmap-xxhdpi': 144, 'mipmap-xxxhdpi': 192 };
for (const [dir, size] of Object.entries(LEGACY)) {
  const d = path.join(RES, dir);
  fs.mkdirSync(d, { recursive: true });
  const png = writePng(size, size, place(src, size, box, 0.86, corner));
  fs.writeFileSync(path.join(d, 'ic_launcher.png'), png);
  fs.writeFileSync(path.join(d, 'ic_launcher_round.png'), png);
}
console.log('구형 밉맵 5종 (48~192px, 원본 배경색 · 내용 86%)');

const FG = { 'drawable-mdpi': 108, 'drawable-hdpi': 162, 'drawable-xhdpi': 216, 'drawable-xxhdpi': 324, 'drawable-xxxhdpi': 432 };
let check = null;
for (const [dir, size] of Object.entries(FG)) {
  const d = path.join(RES, dir);
  fs.mkdirSync(d, { recursive: true });
  const px = place(src, size, box, FG_FRAC, null);
  fs.writeFileSync(path.join(d, 'ic_fg.png'), writePng(size, size, px));
  if (size === 432) check = px;
}
// 배경색을 리소스에 기록. 전경은 원본 배경색이 칠해진 사각형이라, 배경 레이어가 같은 색이어야
// 사각형 경계가 보이지 않는다(원본이 순백이 아니라 살짝 회색빛인 경우가 있다).
const hex = '#' + corner.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
fs.writeFileSync(path.join(RES, 'values', 'colors.xml'), [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<resources>',
  '    <!-- adaptive icon 배경 — 원본 PNG의 배경색. tools/build-icon.js가 갱신한다 -->',
  `    <color name="ic_bg">${hex}</color>`,
  '</resources>',
  '',
].join('\n'));
console.log('배경색 ' + hex + ' → values/colors.xml');
console.log(`adaptive 전경 5종 (108~432px, 내용 ${(FG_FRAC * 100).toFixed(0)}%)`);

// 원형 마스크 검사 — 지름 66.7%의 내접원 밖으로 나가는 내용 픽셀이 얼마나 되는지
if (check) {
  const size = 432, r = size * 0.667 / 2, c = size / 2;
  let total = 0, out = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const s = (y * size + x) * 4;
    if (check[s + 3] < 24) continue;
    if (255 - Math.min(check[s], check[s + 1], check[s + 2]) < 18) continue;
    total++;
    if (Math.hypot(x - c + 0.5, y - c + 0.5) > r) out++;
  }
  const pct = total ? out / total * 100 : 0;
  console.log(`원형 마스크(지름 66.7%) 잘림: 내용 픽셀의 ${pct.toFixed(1)}%`
    + (pct > 3 ? '  ⚠ FG_FRAC을 낮추는 편이 좋습니다' : '  (허용 범위)'));
}
