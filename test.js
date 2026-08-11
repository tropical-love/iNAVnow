// 회귀 검사 — 네트워크 없이 도는 것만. `node test.js`
// 프레임워크를 두지 않는다. 여기 있는 건 전부 실제로 서비스를 깬 적이 있는 항목이다.
// 인증(auth.js)은 공개 서버 전용이라 GitHub 배포판에는 없다 — 파일이 있을 때만 검사한다.
const assert = require('assert');
const http = require('http');

process.env.ETF_PASS = 'testpass';
const S = require('./server.js');
let A = null;
try { A = require('./auth.js'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

let n = 0;
const ok = m => { n++; console.log('  ok', m); };

// ---------- 1. 로그인 비번 파싱: 깨진 퍼센트 인코딩으로 프로세스가 죽던 자리 ----------
if (A) {
  assert.strictEqual(A.passOf('pass=testpass'), 'testpass');
  assert.strictEqual(A.passOf('pass=a+b'), 'a b');
  assert.strictEqual(A.passOf('pass=%ED%95%9C'), '한');
  assert.strictEqual(A.passOf('pass=%'), '%');        // ← URIError를 던지던 입력
  assert.strictEqual(A.passOf('pass=%E0%A4%A'), '%E0%A4%A');
  assert.strictEqual(A.passOf(''), '');
  ok('passOf가 깨진 인코딩에도 던지지 않는다');
}

// ---------- 2. 페이지 인라인 스크립트가 파싱되는지 ----------
// 클라이언트 스크립트는 server.js의 템플릿 리터럴 안에 있어서 \n·${ 같은 것이 조용히 치환된다.
// (실측: title 문자열에 \n을 쓰자 서버가 실제 개행으로 바꿔 스크립트 전체가 파싱 실패 → 페이지 백지.
//  node --check server.js는 통과하므로 이 검사가 없으면 브라우저를 열어야만 알 수 있다)
{
  const vm = require('vm');
  const blocks = [...S.HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(blocks.length >= 2, `인라인 script 블록이 ${blocks.length}개뿐 — 추출 정규식을 확인할 것`);
  blocks.forEach((src, i) => new vm.Script(src, { filename: `inline-script-${i}.js` })); // 파싱만, 실행 안 함
  ok(`페이지 인라인 스크립트 ${blocks.length}개가 문법 오류 없이 파싱된다`);
}

// ---------- 3. cached(): 진행 중 호출 합치기 ----------
(async () => {
  let calls = 0;
  const slow = () => new Promise(r => setTimeout(() => { calls++; r('v'); }, 30));
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => S.cached('t:dedup', 1000, slow)));
  assert.deepStrictEqual(rs, ['v', 'v', 'v', 'v', 'v']);
  assert.strictEqual(calls, 1, `동시 5요청이 ${calls}회 호출 — 합쳐지지 않았다`);
  ok('cached()가 동시 요청을 1회 호출로 합친다');

  // 실패는 캐시하지 않는다(다음 요청이 다시 시도해야 한다)
  let fails = 0;
  const bad = () => { fails++; return Promise.reject(new Error('x')); };
  await S.cached('t:fail', 1000, bad).catch(() => {});
  await S.cached('t:fail', 1000, bad).catch(() => {});
  assert.strictEqual(fails, 2);
  assert.strictEqual(S.cache.get('t:fail'), undefined);
  ok('실패한 호출은 캐시에 남지 않는다');

  // ---------- 3. 공휴일 = 휴장 (라벨 + 날짜 계산 양쪽) ----------
  const today = S.todayYmd();
  const kst = new Date(Date.now() + 9 * 3600e3);
  const hm = kst.getUTCHours() * 100 + kst.getUTCMinutes();
  const weekday = kst.getUTCDay() !== 0 && kst.getUTCDay() !== 6;
  if (weekday && hm >= 910 && hm < 1520) { // 본장 시간대에서만 검사 가능
    S.noteKrStatus('CLOSE');
    assert.strictEqual(S.krSession(), '휴장', '평일 본장 시간대 CLOSE인데 휴장이 아니다');
    // 라벨만이 아니라 날짜 계산도: 오늘이 공휴일이면 isKrBiz(오늘)도 거짓이어야
    // targetDt·nextBizYmd가 존재하지 않는 오늘 기준가를 목표로 삼지 않는다
    assert.strictEqual(S.isKrBiz(today), false, '공휴일 판정 후에도 isKrBiz(오늘)이 참이다');
    S.noteKrStatus('OPEN');
    assert.strictEqual(S.krSession(), '본장');
    assert.strictEqual(S.isKrBiz(today), true);
    ok('본장 시간대 marketStatus=CLOSE면 라벨·날짜 계산 모두 휴장으로 본다');
  } else {
    S.noteKrStatus('CLOSE'); // 시간대 밖에서는 기록하지 않아야 한다
    assert.strictEqual(S.isKrBiz(today), true, '시간대 밖 CLOSE가 오늘을 휴장으로 바꿨다');
    ok('본장 시간대 밖의 CLOSE는 공휴일로 오판하지 않는다 (' + S.krSession() + ')');
  }

  // ---------- 3a. 달력 기반 공휴일 판정 — 시각 고정 주입 (marketStatus 창 밖에서도 잡는다) ----------
  // 2026-06-03(수)은 실제 휴장일(지방선거), 06-04(목)은 거래일이라고 가정한 가짜 달력
  const calSet = new Set(['20260602', '20260604']);
  const KST = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 9, mi); // KST → UTC ms
  const at0905 = KST(2026, 6, 3, 9, 5), at1800 = KST(2026, 6, 3, 18, 0);
  assert.strictEqual(S.calClosedToday(calSet, at0905, at0905), null, '개장 전 달력으로 판정해버렸다');
  assert.strictEqual(S.calClosedToday(calSet, at1800, at1800), '20260603', '공휴일 저녁인데 휴장으로 못 잡았다');
  assert.strictEqual(S.calClosedToday(calSet, KST(2026, 6, 3, 9, 15), KST(2026, 6, 3, 15, 30)), '20260603',
    '15:20 이후(marketStatus 창 밖)인데 휴장으로 못 잡았다');
  const thu = KST(2026, 6, 4, 15, 30);
  assert.strictEqual(S.calClosedToday(calSet, thu, thu), 'open', '거래일(봉 있음)을 휴장으로 오판했다');
  const sat = KST(2026, 6, 6, 12, 0);
  assert.strictEqual(S.calClosedToday(calSet, sat, sat), null, '주말은 판정 대상이 아니어야 한다');
  ok('calClosedToday가 공휴일 09:05·15:30·18:00을 고정 시각으로 정확히 가른다');

  // ---------- 3b. 거래일 달력이 캐시 TTL을 따라 갱신된다 (첫 로드 후 영원히 고정 금지) ----------
  const mkDays = last => { // isKrBiz 활성화 요건(>40개)을 채우는 가짜 달력
    const a = [];
    for (let i = 0; i < 45; i++) a.push(String(20200101 + i));
    a.push(last, today); // 오늘을 포함시킨다 — 빼면 calClosedToday가 오늘을 휴장으로 기록해 뒤 검사를 오염시킨다
    return a;
  };
  S.cache.set('krbiz', { ts: Date.now(), ttl: 6 * 3600e3, data: mkDays('20250102') });
  await S.loadKrDays();
  assert.strictEqual(S.isKrBiz('20250102'), true);
  assert.strictEqual(S.isKrBiz('20250103'), false);
  S.cache.set('krbiz', { ts: Date.now(), ttl: 6 * 3600e3, data: mkDays('20250103') }); // 캐시 교체 = TTL 후 재조회 상황
  await S.loadKrDays();
  assert.strictEqual(S.isKrBiz('20250103'), true, 'loadKrDays가 첫 로드 결과에 영원히 고정돼 있다');
  S.cache.delete('krbiz');
  ok('loadKrDays가 매번 캐시를 거쳐 갱신을 반영한다');

  // ---------- 3c. 세션 라벨 + 개장 전 등락 공백 (고정 시각 주입) ----------
  // '휴장'은 주말·공휴일에만 — 애프터 마감 후 밤새 '휴장'으로 보이던 자리.
  {
    const KST2 = (d, h, mi) => Date.UTC(2026, 7, d, h - 9, mi); // 2026-08-xx KST → UTC ms
    const lab = (d, h, mi) => S.krSession(KST2(d, h, mi));
    assert.strictEqual(lab(4, 23, 16), '장마감', '평일 밤인데 휴장으로 나온다');  // 화 23:16 (실측 스크린샷)
    assert.strictEqual(lab(5, 3, 0), '장마감');                                   // 수 새벽
    assert.strictEqual(lab(5, 8, 8), 'NXT프리');                                  // 프리
    assert.strictEqual(lab(5, 8, 55), '장전');                                    // 프리 종료~개장
    assert.strictEqual(lab(5, 10, 0), '본장');
    assert.strictEqual(lab(5, 16, 0), 'NXT애프터');
    assert.strictEqual(lab(8, 12, 0), '휴장', '토요일은 휴장이어야 한다');
    assert.strictEqual(lab(9, 12, 0), '휴장', '일요일은 휴장이어야 한다');
    ok('세션 라벨: 휴장은 주말·공휴일만, 세션 창 밖은 장마감');

    // 개장 전엔 네이버가 오늘로 넘어가 등락이 0으로 굳는다 → 0%가 아니라 표시 없음(null)
    const basic = { closePrice: '45,225', fluctuationsRatio: '0', compareToPreviousClosePrice: '0' };
    assert.strictEqual(S.marketPx(basic, 'NXT프리').changePct, null, '개장 전인데 0%로 표시된다');
    assert.strictEqual(S.marketPx(basic, '장전').change, null);
    assert.strictEqual(S.marketPx(basic, '장마감').changePct, 0, '장마감의 실제 0%까지 지웠다');
    // 프리장에 체결이 있으면 그 등락을 쓴다
    const preLive = { ...basic, overMarketPriceInfo: { overMarketStatus: 'OPEN', overPrice: '45,500',
      fluctuationsRatio: '0.61', compareToPreviousClosePrice: '275' } };
    assert.strictEqual(S.marketPx(preLive, 'NXT프리').changePct, 0.61);
    ok('개장 전 등락은 비우고, 프리장 체결이 있으면 그 값을 쓴다');
  }

  // ---------- 3c-2. 지수 등락 부호 (하락을 상승으로 뒤집던 자리) ----------
  // 네이버 지수 응답의 등락폭에는 부호가 이미 들어 있다. code로 한 번 더 부호를 씌우면 뒤집힌다
  // (실측 2026-08-06 09:30 코스피 -198.43 → +198.43으로 표시됨).
  {
    const mk = (v, code) => ({ compareToPreviousClosePrice: v, compareToPreviousPrice: { code } });
    assert.strictEqual(S.navIdxChg(mk('-187.08', '5')), -187.08, '하락(부호 포함)을 뒤집었다');
    assert.strictEqual(S.navIdxChg(mk('239.31', '2')), 239.31, '상승을 잘못 바꿨다');
    assert.strictEqual(S.navIdxChg(mk('187.08', '5')), -187.08, '절댓값으로 올 때 code 보정이 안 된다');
    assert.strictEqual(S.navIdxChg(mk('0', '3')), 0);
    assert.strictEqual(S.navIdxChg(mk('-1,234.56', '5')), -1234.56, '천단위 콤마를 못 읽는다');
    ok('지수 등락 부호가 상승·하락 양쪽에서 맞는다');
  }

  // ---------- 3c-3. PDF 갱신 경계 (하루 세 번만 새로 받는다) ----------
  {
    const KST = (h, mi) => Date.UTC(2026, 7, 10, h - 9, mi);
    const mins = (h, mi) => Math.round(S.pdfTtl(KST(h, mi)) / 60000);
    assert.deepStrictEqual(S.PDF_MARKS, [800, 1540, 1900], '갱신 시점이 바뀌었다 — 아래 기대값도 함께 고칠 것');
    assert.strictEqual(mins(7, 30), 30, '07:30 → 08:00');
    assert.strictEqual(mins(8, 1), 459, '08:01 → 15:40');
    assert.strictEqual(mins(15, 29), 11, '15:29 → 15:40');
    assert.strictEqual(mins(15, 45), 195, '15:45 → 19:00');
    assert.strictEqual(mins(19, 5), 775, '19:05 → 다음날 08:00');
    assert.strictEqual(mins(2, 0), 360, '02:00 → 08:00');
    // 경계 직전에도 최소 1분은 살아 있어야 한다(0으로 떨어지면 매 조회가 새로 받는다)
    assert.ok(S.pdfTtl(KST(7, 59)) >= 60e3 && S.pdfTtl(KST(15, 39)) >= 60e3);
    ok('PDF 갱신 경계가 장 시작 전·마감 직후·저녁 세 번으로 계산된다');
  }

  // ---------- 3c-4. PDF 기준일이 낡으면 짧게 쥔다 (늦게 올리는 운용사 대응) ----------
  {
    const KST = (h, mi) => Date.UTC(2026, 7, 11, h - 9, mi); // 2026-08-11(화)
    // 날짜·시각을 모두 고정한다 — pdfTtlFor 내부의 '오늘'도 now에서 뽑으므로 실행일과 무관하다
    const yst = '20260810', today = '20260811';
    // 어댑터마다 다른 필드에서 기준일을 꺼낸다
    assert.strictEqual(S.pdfStdDt({ std_DT: '2026-08-11' }), '20260811', 'ACE 필드');
    assert.strictEqual(S.pdfStdDt({ pdf: { gijunYMD: '20260811' } }), '20260811', 'KODEX 필드');
    assert.strictEqual(S.pdfStdDt({ pdfList: [{ businessDate: '2026.08.11' }] }), '20260811', 'KIWOOM 필드');
    assert.strictEqual(S.pdfStdDt({ content: [{ wkdate: '20260810' }] }), '20260810', 'PLUS 필드');
    assert.strictEqual(S.pdfStdDt({ nothing: 1 }), '', '못 찾으면 빈 문자열');
    // 낡은 기준일 → 30분, 오늘·다음 영업일자 → 경계까지
    assert.strictEqual(S.pdfTtlFor({ stdDt: yst }, KST(8, 5), KST(8, 5)), 30 * 60e3, '낡은 자료를 하루 쥐고 있다');
    assert.strictEqual(S.pdfTtlFor({ stdDt: today }, KST(8, 5), KST(8, 5)), S.pdfTtl(KST(8, 5)), '오늘자인데 짧게 쥔다');
    assert.strictEqual(S.pdfTtlFor({}, KST(8, 5), KST(8, 5)), S.pdfTtl(KST(8, 5)), '기준일을 못 찾으면 경계 TTL');
    // 주말·공휴일에 직전 영업일자는 정상이다 — 낡았다고 보면 30분마다 다시 받는다(하루 48회)
    const SAT = (h, mi) => Date.UTC(2026, 7, 15, h - 9, mi); // 2026-08-15 토
    const SUN = (h, mi) => Date.UTC(2026, 7, 16, h - 9, mi);
    assert.notStrictEqual(S.pdfTtlFor({ stdDt: yst }, SAT(9, 0), SAT(9, 0)), 30 * 60e3, '토요일에 30분마다 다시 받는다');
    assert.notStrictEqual(S.pdfTtlFor({ stdDt: yst }, SUN(9, 0), SUN(9, 0)), 30 * 60e3, '일요일에 30분마다 다시 받는다');
    // 첫 갱신 시각(08:00) 전에는 전일자가 정상
    assert.notStrictEqual(S.pdfTtlFor({ stdDt: yst }, KST(7, 0), KST(7, 0)), 30 * 60e3, '08:00 전인데 벌써 낡았다고 본다');
    // 받은 시각과 지금을 나눠 쓰는지 — 하나로 쓰면 자정 이후 첫 계산에서 캐시가 만료된다
    const D10 = (h, mi) => Date.UTC(2026, 7, 10, h - 9, mi);
    const D11 = (h, mi) => Date.UTC(2026, 7, 11, h - 9, mi);
    const night = S.pdfTtlFor({ stdDt: yst }, D10(19, 5), D11(2, 0));
    assert.ok(night > 415 * 60e3, '19:05에 받은 자료가 02:00에 만료된다(now와 수신 시각을 섞어 쓴 것)');
    assert.strictEqual(S.pdfTtlFor({ stdDt: yst }, D10(19, 5), D11(9, 0)), 30 * 60e3, '아침에는 재확인해야 한다');
    // 재확인 가능 시각 판정
    assert.strictEqual(S.pdfRetryTime(Date.UTC(2026, 7, 15, 0, 0)), false, '토요일 09:00에 재확인 대상');
    assert.strictEqual(S.pdfRetryTime(D11(7, 0)), false, '08:00 전인데 재확인 대상');
    assert.strictEqual(S.pdfRetryTime(D11(9, 0)), true, '평일 09:00인데 재확인을 안 한다');
    ok('낡은 PDF 재확인은 거래일 08:00 이후에만 — 주말·개장 전에는 하지 않는다(공휴일은 09:10 확정 전까지 예외)');
  }

  // ---------- 3d. 리밸런싱 감지 (편입 종목의 기준 평가액이 기준 NAV와 어긋나는 날을 알린다) ----------
  {
    const pdf = (d, jms) => ({ stdDt: d, list: jms.map(j => ({ jm: j, name: '종목' + j })) });
    S.cache.delete('pdfset:TEST');
    assert.strictEqual(S.notePdfSet('TEST', pdf('20260805', ['A', 'B', 'C'])), null, '처음 보는 종목은 비교 대상이 없다');
    assert.strictEqual(S.notePdfSet('TEST', pdf('20260805', ['A', 'B', 'C'])), null, '같은 날짜 PDF는 비교하지 않는다');
    const r = S.notePdfSet('TEST', pdf('20260806', ['A', 'C', 'D']));
    assert.deepStrictEqual(r && r.added, ['종목D'], '편입 종목을 못 잡았다');
    assert.deepStrictEqual(r && r.removed, ['B'], '편출 종목을 못 잡았다');
    assert.strictEqual(r.from, '20260805'); assert.strictEqual(r.to, '20260806');
    // 구성이 그대로면 날짜만 바뀌어도 리밸런싱이 아니다
    assert.strictEqual(S.notePdfSet('TEST', pdf('20260807', ['A', 'C', 'D'])), null);
    // 상위10 추정(partial)은 구성이 원래 다르므로 비교하지 않는다
    assert.strictEqual(S.notePdfSet('TEST', { ...pdf('20260810', ['A']), partial: true }), null);
    S.cache.delete('pdfset:TEST');
    ok('notePdfSet이 PDF 편입·편출을 잡고, 같은 구성·상위10 추정은 넘긴다');
  }

  // ---------- 3e. 수동 갱신(clear=1)이 차단 기록을 지우지 않는다 ----------
  // 지우면 429로 막힌 운용사를 버튼 누를 때마다 다시 두드려 차단이 길어진다.
  {
    await new Promise(r => S.server.listen(0, '127.0.0.1', r));
    const port = S.server.address().port;
    S.cache.set('pdf:test:zzz', { ts: Date.now(), ttl: 60e3, data: { stdDt: '20260811' } });
    S.cache.set('blk:testissuer', { ts: Date.now(), ttl: 24 * 3600e3, data: '429 ...' });
      // GET으로는 지워지지 않아야 한다 — 다른 사이트가 <img src>로 캐시를 비우는 길을 막는다
    const bad = await fetch('http://127.0.0.1:' + port + '/api/pdfinfo?clear=1');
    assert.strictEqual(bad.status, 405, 'GET으로도 캐시가 지워진다');
    assert.strictEqual(S.cache.has('pdf:test:zzz'), true, 'GET 요청이 캐시를 지웠다');
    // 다른 출처에서 온 POST도 거부한다
    const xo = await fetch('http://127.0.0.1:' + port + '/api/pdfinfo?clear=1', {
      method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.strictEqual(xo.status, 403, '다른 출처의 POST를 받아들였다');
    assert.strictEqual(S.cache.has('pdf:test:zzz'), true, '다른 출처의 요청이 캐시를 지웠다');
  const res = await fetch('http://127.0.0.1:' + port + '/api/pdfinfo?clear=1', { method: 'POST' });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.ok(body.cleared >= 1, 'PDF를 지우지 않았다');
    assert.strictEqual(S.cache.has('pdf:test:zzz'), false, 'PDF가 남아 있다');
    assert.strictEqual(S.cache.has('blk:testissuer'), true, '차단 기록까지 지웠다 — 429를 다시 유발한다');

    // codes를 주면 그 종목이 쓴 키만 지운다 — 화면과 무관한 종목 자료는 남아야 한다.
    // 111111은 옛 형식(문자열 하나)으로 저장된 종목 — 갱신 뒤에도 읽혀야 한다
    S.cache.set('pdfkey:111111', { ts: Date.now(), ttl: 60e3, data: 'pdf:aaa:mine' });
    S.cache.set('pdf:aaa:mine', { ts: Date.now(), ttl: 60e3, data: { stdDt: '20260811' } });
    S.cache.set('pdf:bbb:other', { ts: Date.now(), ttl: 60e3, data: { stdDt: '20260811' } });
    S.cache.set('pdfset:111111', { ts: Date.now(), ttl: 60e3, data: { d: '20260811', codes: ['x'] } });
    // 555555는 운용사 원본 → FunETF 폴백을 오간 종목. 둘 다 지워야 차단이 풀렸을 때
    // 남은 원본 캐시를 재사용해 '새로 받은 척'하지 않는다
    S.cache.delete('pdfkey:555555');
    S.notePdfKey('555555', 'pdf:aaa:orig');
    S.notePdfKey('555555', 'pdf:funetf:KR7555555001');
    S.cache.set('pdf:aaa:orig', { ts: Date.now(), ttl: 60e3, data: { stdDt: '20260811' } });
    S.cache.set('pdf:funetf:KR7555555001', { ts: Date.now(), ttl: 60e3, data: { stdDt: '20260811' } });
    const r2 = await (await fetch('http://127.0.0.1:' + port + '/api/pdfinfo?clear=1&codes=111111,222222,555555', { method: 'POST' })).json();
    assert.strictEqual(r2.scope, 'codes');
    assert.strictEqual(r2.cleared, 3, '거쳐 온 출처를 모두 지워야 한다(111111 1건 + 555555 2건)');
    assert.strictEqual(r2.miss, 1, '한 번도 계산하지 않은 종목은 miss로 세어야 한다');
    assert.strictEqual(S.cache.has('pdf:aaa:orig'), false, '이전 출처(운용사 원본) 자료가 남아 있다');
    assert.strictEqual(S.cache.has('pdf:funetf:KR7555555001'), false, '마지막 출처(폴백) 자료가 남아 있다');
    assert.strictEqual(S.cache.has('pdf:aaa:mine'), false, '지정 종목 자료가 남아 있다');
    assert.strictEqual(S.cache.has('pdf:bbb:other'), true, '무관한 종목 자료까지 지웠다');
    // pdfset은 응답 캐시가 아니라 리밸런싱 비교 이력이다 — 지우면 다음 PDF가 '처음 보는 구성'이 되어
    // 편입·편출을 못 잡는다. 하필 이 버튼은 리밸런싱이 늦을 때 누르라고 안내한다
    assert.strictEqual(S.cache.has('pdfset:111111'), true, '리밸런싱 비교 이력을 지웠다 — 편입·편출을 놓친다');
    ['pdf:bbb:other', 'pdfkey:111111', 'pdfkey:555555', 'pdfset:111111', 'blk:testissuer'].forEach(k => S.cache.delete(k));
    S.server.close();
    ok('수동 갱신은 지정 종목 자료만 비우고, 차단 기록·리밸런싱 이력·무관한 종목은 남긴다');
  }

  // ---------- 3f. PDF 키는 받아 온 뒤에만 남긴다 ----------
  // 실패한 키가 남으면 삭제 API가 'miss 0 / cleared 0'을 돌려줘 지운 것처럼 보인다.
  {
    S.cache.delete('pdfkey:333333');
    await S.pdfCached('333333', 'pdf:zzz:fail', () => Promise.reject(new Error('사이트 차단'))).catch(() => {});
    assert.strictEqual(S.cache.has('pdfkey:333333'), false, '실패한 PDF의 키가 남았다');
    await S.pdfCached('333333', 'pdf:zzz:ok', () => Promise.resolve({ stdDt: '20260811' }));
    await S.pdfCached('333333', 'pdf:funetf:zzz', () => Promise.resolve({ stdDt: '20260811' })); // 폴백으로 갈아탄 경우
    assert.deepStrictEqual(S.pdfKeysOf('333333'), ['pdf:zzz:ok', 'pdf:funetf:zzz'], '거쳐 온 출처를 모두 기억하지 않았다');
    // 합성·레버리지는 기초 ETF 키 목록 전체를 자기 코드에도 연결한다(computeSynthetic과 같은 형태)
    for (const k of S.pdfKeysOf('333333')) S.notePdfKey('444444', k);
    assert.deepStrictEqual(S.pdfKeysOf('444444'), ['pdf:zzz:ok', 'pdf:funetf:zzz'], '기초 ETF 키 목록이 연결되지 않았다');
    ['pdfkey:333333', 'pdfkey:444444', 'pdf:zzz:ok', 'pdf:funetf:zzz'].forEach(k => S.cache.delete(k));
    ok('PDF 키는 성공한 뒤에만 남고, 합성 ETF에는 기초 ETF 키가 연결된다');
  }

  // ---------- 3g. PDF 상태는 지금 보고 있는 종목만 센다 ----------
  // 과거에 조회한 종목까지 합치면 화면에 없는 종목 때문에 '지난 기준일 N종목'이 뜬다.
  {
    const srv = S.server.listen(0);
    const port = srv.address().port;
    const day = S.todayYmd(), old = '20200102';
    S.cache.set('pdf:mine:a', { ts: Date.now(), ttl: 60e3, data: { stdDt: day } });
    S.cache.set('pdf:other:b', { ts: Date.now(), ttl: 60e3, data: { stdDt: old } });
    S.notePdfKey('777777', 'pdf:mine:a');
    S.notePdfKey('888888', 'pdf:other:b');
    S.cache.set('pdfset:777777', { ts: Date.now(), ttl: 60e3, data: { d: day, codes: ['x'] } });
    S.cache.set('pdfset:888888', { ts: Date.now(), ttl: 60e3, data: { d: old, codes: ['y'] } }); // 화면에 없는 종목
    const mine = await (await fetch('http://127.0.0.1:' + port + '/api/pdfinfo?codes=777777')).json();
    assert.strictEqual(mine.scope, 'codes');
    assert.strictEqual(mine.total, 1, '내 종목만 세지 않았다');
    assert.strictEqual(mine.stale, 0, '화면에 없는 종목 때문에 지난 기준일로 셌다');
    const all = await (await fetch('http://127.0.0.1:' + port + '/api/pdfinfo')).json();
    assert.strictEqual(all.scope, 'all');
    assert.ok(all.stale >= 1, 'codes 없이 조회하면 전체를 세야 한다');
    ['pdf:mine:a', 'pdf:other:b', 'pdfkey:777777', 'pdfkey:888888', 'pdfset:777777', 'pdfset:888888']
      .forEach(k => S.cache.delete(k));
    S.server.close();
    ok('PDF 상태 집계가 codes로 준 종목 범위만 센다');
  }

  // ---------- 3g-2. 포트폴리오 부분 실패를 성공으로 확정하지 않는다 ----------
  // 실패 종목의 이전 값이 '방금 계산한 값'으로 저장되면 다음 주기까지 새 값처럼 쓰인다.
  // 브라우저 함수지만 순수 로직이라 페이지에서 떼어 내 실제로 돌려 본다.
  {
    const vm = require('vm');
    const src = /\nfunction pfMarkCalc\(staleNames\)\{[\s\S]*?\n\}/.exec(S.HTML);
    assert.ok(src, 'pfMarkCalc를 페이지에서 찾지 못했다(이름이 바뀌었으면 이 검사도 고칠 것)');
    let saved = 0; // vm 안에서 부르는 것도 세도록 클로저로 둔다
    const ctx = { PF_TTL: 60e3, PF_RETRY: 20e3, PFSTALE: [], PFAT: null, PFCAT: null,
      pfSaveCalc: () => { saved++; } };
    vm.runInNewContext(src[0] + '\n;this.run = pfMarkCalc;', ctx);

    ctx.run([]); // 전 종목 성공
    assert.deepStrictEqual(ctx.PFSTALE, []);
    assert.strictEqual(+ctx.PFCAT, +ctx.PFAT, '전부 성공했는데 계산 시각이 화면 시각과 다르다');
    assert.ok(Date.now() - +ctx.PFCAT < 1000, '계산 시각이 지금이 아니다');
    assert.strictEqual(saved, 1, '저장을 부르지 않았다 — 페이지를 옮기면 사라진다');

    ctx.run(['KODEX 200', 'TIGER 미국S&P500']); // 일부 실패
    assert.deepStrictEqual(ctx.PFSTALE, ['KODEX 200', 'TIGER 미국S&P500'], '못 받은 종목을 남기지 않았다');
    assert.ok(+ctx.PFAT > +ctx.PFCAT, '실패가 있는데 계산 시각을 지금으로 밀었다');
    // 재계산 판단은 PFCAT으로 한다 → 남은 대기시간이 PF_RETRY 이하여야 다음 검사에서 다시 시도한다
    const wait = ctx.PF_TTL - (Date.now() - +ctx.PFCAT);
    assert.ok(wait > 0 && wait <= ctx.PF_RETRY, `다음 재시도까지 ${wait}ms — PF_RETRY 안에 들어오지 않는다`);

    ctx.run([]); // 재시도 성공
    assert.deepStrictEqual(ctx.PFSTALE, [], '다시 받았는데도 낡은 종목 표시가 남았다');
    assert.strictEqual(+ctx.PFCAT, +ctx.PFAT);
    ok('포트폴리오 부분 실패는 계산 시각을 밀지 않고, 다시 받으면 표시가 사라진다');
  }

  // ---------- 3h. 앱 브리지 허용 목록이 엔진이 쓰는 호스트를 다 담고 있다 ----------
  // 브리지는 허용 목록 밖으로 나가지 않는다 → 새 호스트를 엔진에 추가하고 목록에 안 넣으면
  // 로컬·서버에서는 되고 앱에서만 그 어댑터가 조용히 폴백으로 밀린다.
  {
    const fs = require('fs'), path = require('path');
    const netJava = path.join(__dirname, 'android/app/src/main/java/com/inavnow/Net.java');
    if (fs.existsSync(netJava)) { // PC 배포판에는 android 폴더가 없다
      const src = fs.readFileSync(__filename.replace(/test\.js$/, 'server.js'), 'utf8');
      // 데이터를 받는 곳이 아닌 것들: 폰트·아이콘 CDN(빌드가 제거), SVG 네임스페이스, PEM 안에 적힌 발급자 URL
      const skip = new Set(['cdn.jsdelivr.net', 'ssl.gstatic.com', 'www.w3.org', 'crt.sectigo.com']);
      const used = [...new Set([...src.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/g)].map(m => m[1]))]
        .filter(h => !skip.has(h));
      const block = /HOSTS\s*=\s*\{([\s\S]*?)\}/.exec(fs.readFileSync(netJava, 'utf8')); // HOSTS 배열만
      assert.ok(block, 'Net.java에서 HOSTS 목록을 찾지 못했다');
      const allow = new Set([...block[1].matchAll(/"([^"]+)"/g)].map(m => m[1]));
      const missing = used.filter(h => !allow.has(h));
      assert.deepStrictEqual(missing, [], '앱 허용 목록에 없는 호스트: ' + missing.join(', '));
      // 반대로 쓰지 않는 호스트를 열어 두지도 않는다
      const extra = [...allow].filter(h => !used.includes(h));
      assert.deepStrictEqual(extra, [], '엔진이 쓰지 않는 호스트가 열려 있다: ' + extra.join(', '));
      ok(`앱 브리지 허용 목록이 엔진이 쓰는 호스트 ${used.length}개와 정확히 일치한다`);

      // 자동 리다이렉트를 켜면 첫 URL만 검사되고, 허용된 사이트가 30x로 가리키는 낯선 호스트로
      // 그대로 나간다 = 허용 목록이 무력해진다. 자바 코드는 여기서 돌릴 수 없어 구조만 고정한다.
      const nj = fs.readFileSync(netJava, 'utf8');
      assert.ok(/setInstanceFollowRedirects\(false\)/.test(nj), '자동 리다이렉트가 켜져 있다 — 허용 목록을 우회한다');
      assert.ok(!/setInstanceFollowRedirects\(true\)/.test(nj), 'setInstanceFollowRedirects(true)가 남아 있다');
      // 이동할 때마다 검사하려면 allowed()가 루프 안에 있어야 한다(요청 생성보다 앞에)
      const loop = /for \(int hop[\s\S]*?openConnection\(\)/.exec(nj);
      assert.ok(loop && /allowed\(target\)/.test(loop[0]), 'allowed() 검사가 이동 루프 안에 없다');
      assert.ok(/MAX_HOPS/.test(nj), '리다이렉트 횟수 제한이 없다');
      ok('앱 브리지가 리다이렉트를 직접 따라가며 이동마다 다시 검사한다');
    }
  }

  // ---------- 4. 거래일 달력: close=null인 실거래일을 휴장으로 오판하지 않는다 ----------
  const ts = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 1000 - 32400; // 09:00 KST
  const fixture = { // 2026-08-03(월)은 야후가 close를 비워 보낸 실거래일, 07-17(금)은 제헌절
    chart: { result: [{ meta: { gmtoffset: 32400 },
      timestamp: ['2026-07-16', '2026-07-20', '2026-07-31', '2026-08-03', '2026-08-04'].map(ts),
      indicators: { quote: [{ close: [1, 2, 3, null, 4] }] } }] },
  };
  assert.deepStrictEqual(S.parseKrDays(fixture),
    ['20260716', '20260720', '20260731', '20260803', '20260804']);
  ok('parseKrDays가 close=null인 실거래일도 거래일로 센다');

  // ---------- 5. 내장 Sectigo 중간 인증서가 진짜 그 인증서인지 ----------
  // (체인 검증 자체는 Node TLS가 하므로, 여기서는 내장 PEM이 손상·교체되지 않았는지만 잠근다)
  const { X509Certificate } = require('crypto');
  const ca = new X509Certificate(S.SECTIGO_OV_CA);
  assert.match(ca.subject, /CN=Sectigo RSA Organization Validation Secure Server CA/);
  assert.match(ca.issuer, /CN=USERTrust RSA Certification Authority/);
  assert.strictEqual(ca.fingerprint256,
    '72:A3:4A:C2:B4:24:AE:D3:F6:B0:B0:47:55:B8:8C:C0:27:DC:CC:80:6F:DD:B2:2B:4C:D7:C4:77:73:97:3E:C0');
  assert.ok(new Date(ca.validTo) > new Date(Date.now() + 90 * 86400e3),
    '중간 인증서 만료 90일 전 — 잎 인증서 AIA의 crt.sectigo.com에서 새로 받아 교체할 것');
  ok('내장 Sectigo 중간 인증서의 지문·주체·발급자가 맞다');

  // ---------- 5a. 공개 서버는 루프백만 듣는다 (auth.js가 있을 때만) ----------
  // 전체 인터페이스에 붙으면 공인IP:8778로 평문 HTTP 접속이 열려 비밀번호와 세션 쿠키가 그대로 흐른다.
  // nginx는 127.0.0.1로 프록시하므로 HTTPS 경로는 이것으로 충분하다.
  if (A) {
    const { execFileSync } = require('child_process');
    const os = require('os');
    const probe = 'const a=require("./auth.js");a.server.listen(0,process.env.AUTH_HOST||"127.0.0.1",()=>{'
      + 'console.log(a.server.address().address);process.exit(0);});';
    const addr = execFileSync(process.execPath, ['-e', probe],
      { cwd: __dirname, env: { ...process.env, ETF_PASS: 'testpass' }, encoding: 'utf8' }).trim();
    assert.strictEqual(addr, '127.0.0.1', `기본 바인딩이 ${addr} — 외부에서 평문으로 접속할 수 있다`);
    const lan = Object.values(os.networkInterfaces()).flat()
      .find(i => i && i.family === 'IPv4' && !i.internal);
    assert.ok(!/0\.0\.0\.0/.test(addr), '전체 인터페이스에 붙었다');
    ok('auth.js는 기본으로 루프백만 듣는다' + (lan ? ` (이 PC의 ${lan.address}로는 열리지 않는다)` : ''));
  }

  // ---------- 6. 인증 전 요청으로 서버가 죽지 않는다 (실제 소켓, auth.js가 있을 때만) ----------
  if (A) {
    await new Promise(r => A.server.listen(0, '127.0.0.1', r));
    const port = A.server.address().port;
    const post = body => new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port, path: '/login', method: 'POST',
        headers: { 'Content-Length': Buffer.byteLength(body) } }, rs => {
        rs.resume(); rs.on('end', () => resolve(rs.statusCode));
      });
      rq.on('error', reject); rq.end(body);
    });
    assert.strictEqual(await post('pass=%'), 401);          // 죽지 않고 401
    assert.strictEqual(await post('pass=testpass'), 302);   // 살아서 정상 로그인도 된다
    ok('pass=% 요청 뒤에도 서버가 살아 있다');
    A.server.close();
  }

  console.log(`\n${n}개 검사 통과`);
  process.exit(0);
})().catch(e => { console.error('\n실패:', e.message); process.exit(1); });
