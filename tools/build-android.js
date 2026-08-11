// 안드로이드 WebView용 에셋 생성 — server.js 하나를 그대로 재사용한다. `node tools/build-android.js`
//
// 안드로이드에는 로컬 HTTP 서버가 없다. 대신
//   ① engine.js  = server.js 그대로 (브라우저에서는 NODE=false로 갈라져 서버 부분을 건너뛴다)
//   ② index.html = server.js가 만든 페이지 + engine.js 로드 + /api/* 를 함수 호출로 바꾸는 fetch shim
// 을 만들어 assets/에 넣는다. 외부 통신은 네이티브가 넣어 준 window.__net이 담당한다(CORS 우회).
//
// engine.js를 인라인 <script>로 넣으면 안 된다 — 안에 </script> 문자열이 있어 HTML 파서가 태그를
// 먼저 닫아 버린다. 외부 파일로 싣는 이유가 그것이다.
process.env.ETF_TARGET = 'android';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets');
const { HTML } = require(path.join(ROOT, 'server.js'));

// 네이티브 브리지 — Net.java와 짝이다. AndroidNet.request(id, spec)로 던지고 __netDone(id, json)으로 받는다.
// WebView의 JavascriptInterface는 동기 반환이 위험(메인 스레드 블록)해서 콜백 id로 맞춘다.
const BRIDGE = `<script>
(function(){
  let seq = 0; const waiting = new Map();
  window.__netDone = function(id, json){
    const w = waiting.get(id); if(!w) return;
    waiting.delete(id);
    let d; try { d = JSON.parse(json); } catch(e){ return w.rej(new Error('브리지 응답 파싱 실패')); }
    if(d.error || !d.status) return w.rej(new Error(d.error || '네트워크 실패'));
    const bin = Uint8Array.from(atob(d.bodyB64), c => c.charCodeAt(0));
    const h = new Headers(); let sc = null;
    for(const k in d.headers){
      const v = d.headers[k];
      // Set-Cookie는 Response 생성자가 버린다(실측) → 따로 붙여 engine.js가 __setCookie로 읽게 한다
      if(k.toLowerCase() === 'set-cookie'){ sc = Array.isArray(v) ? v : [v]; continue; }
      if(Array.isArray(v)) v.forEach(x => h.append(k, x)); else h.append(k, v);
    }
    const resp = new Response(bin, {status: d.status, headers: h});
    if(sc) Object.defineProperty(resp, '__setCookie', {value: sc});
    w.res(resp);
  };
  window.__net = function(url, opts){
    opts = opts || {};
    const id = 'n' + (++seq), to = opts.timeout || 8000;
    return new Promise(function(res, rej){
      waiting.set(id, {res: res, rej: rej});
      // 네이티브도 타임아웃을 걸지만, 브리지가 응답을 잃어버리면 영원히 매달리므로 한 겹 더 둔다
      setTimeout(function(){ if(waiting.has(id)){ waiting.delete(id); rej(new Error('브리지 타임아웃 ' + url)); } }, to + 4000);
      try {
        AndroidNet.request(id, JSON.stringify({url: url, method: opts.method || 'GET',
          headers: opts.headers || {}, body: opts.body || null,
          extraCa: opts.extraCa || null, timeout: to}));
      } catch(e){ waiting.delete(id); rej(new Error('브리지 없음: ' + e.message)); }
    });
  };
})();
</script>
`;

// /api/* 를 엔진 함수 직접 호출로 돌리는 shim. 페이지의 클라이언트 코드는 손대지 않는다.
const SHIM = BRIDGE + `<script src="engine.js"></script>
<script>
// 페이지는 원래 로컬 서버에 /api/* 로 물었다. 안드로이드에는 서버가 없으니 같은 응답을 만들어 준다.
// 순차 처리라 여러 종목을 부를 때도 외부 API를 한꺼번에 때리지 않는다(원래 서버 동작과 동일).
(function(){
  const J = o => new Response(JSON.stringify(o), {status: 200, headers: {'Content-Type': 'application/json'}});
  const E = (m, c) => new Response(JSON.stringify({error: m}), {status: c || 500, headers: {'Content-Type': 'application/json'}});
  const real = window.fetch.bind(window);
  window.fetch = async function(u, o){
    const s = typeof u === 'string' ? u : (u && u.url) || '';
    if(!s.startsWith('/api/')) return real(u, o);
    const q = new URLSearchParams(s.split('?')[1] || '');
    try {
      if(s.startsWith('/api/inav'))  return J(await ENGINE.computeINav(q.get('code') || ENGINE.DEFAULT_CODE));
      if(s.startsWith('/api/etfs'))  return J(await ENGINE.etfList());
      if(s.startsWith('/api/market'))return J(await ENGINE.marketQuotes());
      if(s.startsWith('/api/pdfinfo')){ // 하루치 자료 상태 / 수동 초기화
        const C = ENGINE.cache;
        if(q.get('clear') === '1'){
          // 차단 기록은 남기고, codes를 주면 그 종목이 쓴 키만 지운다(서버 라우트와 같은 규칙)
          const only = (q.get('codes')||'').split(',').filter(function(c){ return /^[0-9A-Z]{6}$/.test(c); });
          let n = 0, miss = 0;
          if(only.length){
            only.forEach(function(c){
              const keys = ENGINE.pdfKeysOf(c);
              if(!keys.length){ miss++; return; }
              keys.forEach(function(k){ if(C.delete(k)) n++; }); // 거쳐 온 출처를 모두 비운다
              // pdfset(전일 구성 기록)은 남긴다 — 리밸런싱 비교 기준이다
            });
          } else {
            for(const k of [...C.keys()]) if(k.startsWith('pdf:')){ C.delete(k); n++; }
          }
          ENGINE.saveCache();
          return J({cleared: n, miss: miss, scope: only.length ? 'codes' : 'all'});
        }
        const items = [];
        const live = [];
        for(const [k, v] of C) if(k.startsWith('pdf:')){
          items.push(v.ts);
          if(Date.now() - v.ts < ENGINE.pdfTtlFor(v.data, v.ts)) live.push(v.ts);
        }
        const sets = [...C.entries()].filter(function(e){ return e[0].startsWith('pdfset:'); })
          .map(function(e){ return ENGINE.fxKeyD(e[1].data && e[1].data.d); }).filter(function(x){ return x.length === 8; });
        const dates = [...new Set(sets)].sort();
        const blocked = [...C.keys()].filter(function(k){ return k.startsWith('blk:') && ENGINE.issuerBlocked(k.slice(4)); }).map(function(k){ return k.slice(4); });
        return J({
          count: live.length, total: items.length,
          oldest: live.length ? Math.min.apply(null, live) : null,
          newest: live.length ? Math.max.apply(null, live) : null,
          dates: dates, retrying: ENGINE.pdfRetryTime(), stale: sets.filter(function(d){ return d < ENGINE.todayYmd(); }).length, // 종목별로 센다
          ttlMs: ENGINE.pdfTtl(), marks: ENGINE.PDF_MARKS, blocked: blocked,
        });
      }
      if(s.startsWith('/api/px')){ // ETF 자체 시세만 (포트폴리오 현재가 빠른 갱신)
        const cs = (q.get('codes')||'').split(',').filter(function(c){ return /^[0-9A-Z]{6}$/.test(c); }).slice(0,30);
        const m = cs.length ? await ENGINE.krQuotes(cs) : {};
        return J(Object.fromEntries(cs.map(function(c){
          return [c, m[c] ? {price:m[c].last, prev:m[c].prevClose, session:m[c].session} : null];
        })));
      }
      if(s.startsWith('/api/stats')) return J(ENGINE.stats);
      if(s.startsWith('/api/pf'))    return E('이 앱은 포트폴리오를 기기에 저장합니다', 404); // 로컬 저장으로 유도
    } catch(e){ return E(e.message); }
    return E('알 수 없는 경로: ' + s, 404);
  };
})();
</script>
`;

// 클라이언트 스크립트보다 먼저 실려야 한다(ETFS 로딩이 첫 fetch를 곧바로 부른다).
// 페이지의 클라이언트 코드는 </head> 뒤 <body> 끝에 있으므로 </body> 직전에 끼우면 늦다 → </head> 앞에 넣는다.
if (!HTML.includes('</head>')) throw new Error('페이지에서 </head>를 찾지 못했습니다 — 템플릿 구조가 바뀐 듯합니다');
let page = HTML.replace('</head>', SHIM + '</head>');

// 외부 CDN(폰트)은 앱에서 못 받거나 느리다 — 시스템 폰트로 떨어지게 링크를 뺀다.
const cdn = /<link rel="stylesheet" href="https:\/\/cdn\.jsdelivr\.net[^>]*>/g;
const nCdn = (page.match(cdn) || []).length;
page = page.replace(cdn, '<!-- 폰트 CDN 제거(오프라인) -->');

// /favicon.svg 는 서버가 주던 경로다. 앱에는 서버가 없으니 SVG를 data URI로 박아 넣는다.
// ⚠ <link id="icon">을 지우면 안 된다 — setIcon()이 이 엘리먼트를 replaceWith 하므로
//   없으면 applyTitle() 첫 호출에서 터지고 클라이언트 스크립트가 그 자리에서 끊긴다(실측).
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const FAVICON = /const FAVICON = `([\s\S]*?)`;/.exec(SRC);
if (!FAVICON) throw new Error('server.js에서 FAVICON을 찾지 못했습니다');
const SECTIGO = (/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(SRC) || [])[0];
if (!SECTIGO) throw new Error('server.js에서 Sectigo 중간 인증서를 찾지 못했습니다');
const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(FAVICON[1]).toString('base64');
const iconRe = /(<link rel="icon" id="icon" type="image\/svg\+xml" href=")[^"]*(">)/;
if (!iconRe.test(page)) throw new Error('페이지에서 파비콘 link를 찾지 못했습니다');
page = page.replace(iconRe, '$1' + dataUri + '$2');
// 클라이언트 코드 안의 '/favicon.svg' 참조(setIcon 인자)도 같은 data URI로 바꾼다
page = page.split("'/favicon.svg'").join(JSON.stringify(dataUri));

// 절대경로 링크는 file:// 에서 file:/// 로 해석돼 ERR_ACCESS_DENIED가 난다(실측: ‹ Home).
// 에셋 안에서만 도는 상대경로로 바꾼다. 남은 절대경로가 있으면 빌드를 멈춘다.
page = page.split('href="/"').join('href="index.html"');
const left = page.match(/(?:href|src)="\/[^"]*"/g);
if (left) throw new Error('file://에서 깨질 절대경로가 남았습니다: ' + [...new Set(left)].join(', '));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), page);
fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(OUT, 'engine.js'));
// kiwoometf가 빼먹는 중간 인증서 — Net.java가 이 파일을 읽어 신뢰 앵커에 보탠다
fs.writeFileSync(path.join(OUT, 'sectigo-ov.pem'), SECTIGO + '\n');

const kb = p => (fs.statSync(p).size / 1024).toFixed(0) + 'KB';
console.log('에셋 생성 완료 →', path.relative(ROOT, OUT));
console.log('  index.html     ', kb(path.join(OUT, 'index.html')), '(폰트 CDN ' + nCdn + '개 제거, 브리지 주입)');
console.log('  engine.js      ', kb(path.join(OUT, 'engine.js')));
console.log('  sectigo-ov.pem ', kb(path.join(OUT, 'sectigo-ov.pem')));
