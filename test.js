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

  // ---------- 3c-2b. 지수 종가는 확정된 뒤에만 고정한다 ----------
  // 네이버는 15:30 직후 이미 marketStatus=CLOSE를 주는데 그 값은 확정 종가가 아니다
  // (실측 2026-08-11: 직후 코스피 6,358.35 → 확정 6,345.53, 12.8p 차이). 상태만 보고 굳히면
  // 켜 둔 화면이 종일 그 값을 들고 있는다 — 앱을 새로 켠 사람과 값이 다르게 보였다.
  {
    const KST3 = (d, h, mi) => Date.UTC(2026, 7, d, h - 9, mi); // 2026-08-11(화) 기준
    assert.strictEqual(S.idxSettled(KST3(11, 15, 31)), false, '마감 직후 값을 확정 종가로 굳힌다');
    assert.strictEqual(S.idxSettled(KST3(11, 15, 45)), false, '종가가 확정되기 전에 굳힌다');
    assert.strictEqual(S.idxSettled(KST3(11, 16, 0)), true, '확정 시각이 지났는데도 계속 다시 받는다');
    assert.strictEqual(S.idxSettled(KST3(11, 23, 0)), true, '밤에도 지수를 다시 받는다');
    assert.strictEqual(S.idxSettled(KST3(12, 8, 30)), true, '개장 전에는 전일 종가가 최종이다');
    assert.strictEqual(S.idxSettled(KST3(11, 13, 0)), false, '장중에는 굳혀선 안 된다');
    assert.strictEqual(S.idxSettled(KST3(15, 13, 0)), true, '주말은 다시 받을 이유가 없다'); // 8/15 토
    ok('지수 종가는 확정 시각(16:00) 이후에만 고정하고, 마감 직후에는 다시 받는다');
  }

  // ---------- 3c-2c. 레버리지 장외 굴림은 프리마켓에 현물을 먼저 본다 ----------
  // 야간선물은 06:00에 끝나 그 값에 멈춘다. 프리마켓(08:00~)에는 현물이 다시 거래되는데
  // 선물을 먼저 보면 그 값이 이겨서 프리장 변동이 하나도 반영되지 않는다
  // (실측 2026-08-12 08:24: 코스닥150레버리지가 06:00 선물값에 멈춰 있었다).
  {
    assert.strictEqual(S.spotFirst('NXT프리'), true, '프리마켓인데 멈춘 선물을 먼저 본다');
    assert.strictEqual(S.spotFirst('장전'), true, '프리장 종료~개장 사이에도 현물이 최신이다');
    assert.strictEqual(S.spotFirst('NXT애프터'), false, '애프터에는 선물이 돌고 있어 선물이 먼저다');
    assert.strictEqual(S.spotFirst('장마감'), false, '저녁·새벽에는 선물이 먼저다');
    assert.strictEqual(S.spotFirst('휴장'), false);
    assert.deepStrictEqual(S.KR_PREOPEN, ['NXT프리', '장전'], '프리마켓 세션 목록이 바뀌었다');
    ok('레버리지 장외 굴림이 프리마켓에는 현물 바스켓을 먼저 본다');
  }

  // ---------- 3c-2d. '어제 대비'의 기준과 라벨 ----------
  // 기준은 언제나 가장 최근 확정 종가다. 같은 값에 '어제보다'를 붙이면 시점마다 말이 어긋난다 —
  // 오늘 마감 뒤에는 그 값이 '오늘 종가 대비 장외 변동'이고, 토·일·월에는 금요일이 기준이다.
  {
    // 직전 거래일 탐색은 달력(isKrBiz)을 쓴다 — 앞의 3b가 가짜 달력을 남겨 두므로 여기서 다시 세운다.
    // 2026-08: 11(화)·12(수)·13(목)·14(금)·17(월)을 거래일로, 15~16(주말)은 비운다.
    const days = [];
    for (let i = 0; i < 45; i++) days.push(String(20200101 + i)); // isKrBiz 활성화 요건(>40개)
    days.push('20260811', '20260812', '20260813', '20260814', '20260817', S.todayYmd());
    S.cache.set('krbiz', { ts: Date.now(), ttl: 6 * 3600e3, data: days });
    await S.loadKrDays();
    const K = (d, h, mi) => Date.UTC(2026, 7, d, h - 9, mi); // 2026-08-12는 수요일
    const at = (d, h, mi) => S.dayRef(K(d, h, mi));
    // 라벨
    assert.strictEqual(at(12, 13, 0).label, '어제보다', '장중 기준은 직전 거래일 종가다');
    assert.strictEqual(at(12, 15, 45).label, '어제보다', '15:45에는 종가가 아직 확정 전이다');
    assert.strictEqual(at(12, 16, 30).label, '오늘 종가보다', '마감 뒤인데 어제를 기준으로 본다');
    assert.strictEqual(at(12, 23, 59).label, '오늘 종가보다', '자정 전까지는 오늘 종가가 기준이다');
    assert.strictEqual(at(13, 0, 4).label, '어제보다', '자정을 넘기면 어제가 된다');
    assert.strictEqual(at(13, 8, 31).label, '어제보다', '프리장에도 기준은 직전 거래일이다');
    assert.strictEqual(at(15, 12, 0).label, '금요일보다', '토요일 기준은 금요일이다');   // 8/15 토
    assert.strictEqual(at(16, 12, 0).label, '금요일보다', '일요일도 금요일이 기준이다'); // 8/16 일
    assert.strictEqual(at(17, 3, 0).label, '금요일보다', '월요일 새벽도 금요일이 기준이다');
    assert.strictEqual(at(17, 10, 0).label, '금요일보다', '월요일 장중도 금요일이 기준이다');
    assert.strictEqual(at(17, 17, 0).label, '오늘 종가보다', '월요일 마감 뒤에는 그날 종가가 기준이다');

    // 어느 값을 기준으로 쓰는가 — 여기가 자정에 하루 어긋나던 자리다.
    // 네이버의 '전일 종가'는 자정이 지나도 한동안 그 전날을 가리킨다(실측 2026-08-13 00:04:
    // ACE…레버리지 전일 종가가 46,880원(8/11)으로 나왔고 08:31에는 45,335원(8/12)이었다).
    // 장이 닫혀 있는 동안에는 정규장 종가(reg)가 곧 가장 최근 확정 종가라, 그걸 쓰면 어긋나지 않는다.
    assert.strictEqual(at(13, 0, 4).useReg, true, '자정 직후에 전일 종가를 쓰면 기준이 하루 밀린다');
    assert.strictEqual(at(13, 8, 31).useReg, true, '프리장에도 정규장 종가가 직전 거래일 종가다');
    assert.strictEqual(at(13, 10, 0).useReg, false, '장중에는 진행 중인 오늘 값을 기준으로 쓰면 안 된다');
    assert.strictEqual(at(13, 15, 45).useReg, false, '종가 확정 전에는 전일 종가가 기준이다');
    assert.strictEqual(at(13, 16, 30).useReg, true, '마감 뒤에는 오늘 종가를 기준으로 써야 한다');
    assert.strictEqual(at(15, 12, 0).useReg, true, '주말에는 정규장 종가가 곧 금요일 종가다');
    assert.strictEqual(at(17, 3, 0).useReg, true, '월요일 새벽도 마찬가지다');
    S.cache.delete('krbiz'); // 뒤 검사가 쓰는 상태로 되돌린다
    ok("'어제 대비'가 오늘 종가·어제·금요일을 시점에 맞게 가른다");
  }

  // ---------- 3c-2e. 환율 '마감' 딱지는 시계로 판정한다 ----------
  // 원/달러는 주말만 빼면 거의 24시간 돌아간다. 야후 갱신은 몇십 분 밀리는 일이 흔해서
  // '30분 이상 안 움직였으면 마감'으로 보면 평일 아침에도 마감이 붙는다
  // (실측 2026-08-19 09:13: 마지막 갱신 08:24 = 49분 전인데 서울 외환시장은 09:00에 열렸다).
  {
    const K = (d, h, mi) => Date.UTC(2026, 7, d, h - 9, mi); // 2026-08-19는 수요일
    assert.strictEqual(S.fxMarketOpen(K(19, 9, 13)), true, '평일 아침에 환율이 마감으로 나온다');
    assert.strictEqual(S.fxMarketOpen(K(19, 3, 0)), true, '평일 새벽에도 외환시장은 돌아간다');
    assert.strictEqual(S.fxMarketOpen(K(22, 5, 0)), true, '토요일 이른 아침까지는 열려 있다');   // 8/22 토
    assert.strictEqual(S.fxMarketOpen(K(22, 7, 30)), false, '주말인데 열려 있다고 본다');
    assert.strictEqual(S.fxMarketOpen(K(23, 12, 0)), false, '일요일은 닫혀 있다');              // 8/23 일
    assert.strictEqual(S.fxMarketOpen(K(24, 5, 0)), false, '월요일 개장 전인데 열렸다고 본다');   // 8/24 월
    assert.strictEqual(S.fxMarketOpen(K(24, 6, 30)), true, '월요일 06:00 이후에는 열린다');
    ok("환율 '마감'은 주말에만 붙고, 평일 갱신 지연으로는 붙지 않는다");
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
    await new Promise(r => S.server.close(r)); // 다 닫힌 뒤에 다음 블록이 다시 연다
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

  // ---------- 3f-2. 계산이 안 되는 자료는 버려서 다음 조회가 새로 받게 한다 ----------
  // 아침에 아직 다 올라오지 않은 PDF를 한 번 받으면 그게 캐시에 남아 다음 정기 갱신(15:40)까지
  // 종일 같은 실패를 반복한다(실측 2026-08-13: 비중 합 88%짜리 PDF로 iNAV가 null이었고,
  // 캐시가 빈 새 프로세스에서는 100%로 정상 계산됐다).
  {
    ['pdfkey:999999', 'pdfdrop:999999', 'pdf:zzz:bad'].forEach(k => S.cache.delete(k));
    S.cache.set('pdf:zzz:bad', { ts: Date.now(), ttl: 60e3, data: { stdDt: '20260813' } });
    S.notePdfKey('999999', 'pdf:zzz:bad');
    assert.strictEqual(S.dropBadPdf('999999'), true, '쓸 수 없는 자료를 버리지 않았다');
    assert.strictEqual(S.cache.has('pdf:zzz:bad'), false, '자료가 그대로 남아 있다');
    // 곧바로 또 버리지는 않는다 — 실패할 때마다 운용사를 두드리면 차단당한다
    S.cache.set('pdf:zzz:bad', { ts: Date.now(), ttl: 60e3, data: { stdDt: '20260813' } });
    assert.strictEqual(S.dropBadPdf('999999'), false, '쿨다운 없이 계속 다시 받는다');
    assert.strictEqual(S.cache.has('pdf:zzz:bad'), true, '쿨다운 중인데 또 버렸다');
    // 한 번도 받은 적 없는 종목은 버릴 것도 없다
    assert.strictEqual(S.dropBadPdf('888888'), false);
    ['pdfkey:999999', 'pdfdrop:999999', 'pdf:zzz:bad'].forEach(k => S.cache.delete(k));
    ok('계산이 안 되는 구성종목 자료는 버리고, 30분 안에 되풀이하지는 않는다');
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
    await new Promise(r => S.server.close(r));
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
      // 검사는 전부 '주석을 걷어낸' 소스로 한다 — 주석에 함수 이름을 적어 두면 통과해 버린다
      // (실측: 순서 검사가 주석 속 getOutputStream을 실제 호출로 봤다).
      // 주석만 지우고 문자열은 남긴다 — 정규식으로 //를 지우면 코드 안의 "://"(originOf가 출처를
      // 만들 때 쓴다)까지 주석으로 보고 그 줄의 뒷부분을 먹는다
      const strip = t => {
        let out = '', i = 0;
        while (i < t.length) {
          const c = t[i];
          if (c === '"' || c === "'") {                       // 문자열 리터럴은 그대로
            let j = i + 1;
            while (j < t.length && t[j] !== c) j += t[j] === '\\' ? 2 : 1;
            out += t.slice(i, j + 1); i = j + 1;
          } else if (c === '/' && t[i + 1] === '/') {          // 한 줄 주석
            while (i < t.length && t[i] !== '\n') i++;
          } else if (c === '/' && t[i + 1] === '*') {          // 여러 줄 주석
            const e = t.indexOf('*/', i + 2); i = e < 0 ? t.length : e + 2;
          } else { out += c; i++; }
        }
        return out;
      };
      // strip 자체를 먼저 확인한다 — 이 아래 검사 전부가 여기에 얹혀 있다
      assert.strictEqual(strip('a("://"); // b\nc /* d */ e'), 'a("://"); \nc  e', 'strip이 문자열이나 주석을 잘못 다룬다');
      const nj = strip(fs.readFileSync(netJava, 'utf8'));
      assert.ok(nj.includes('"://"'), 'strip이 코드 안의 "://"를 지웠다');
      assert.ok(/setInstanceFollowRedirects\(false\)/.test(nj), '자동 리다이렉트가 켜져 있다 — 허용 목록을 우회한다');
      assert.ok(!/setInstanceFollowRedirects\(true\)/.test(nj), 'setInstanceFollowRedirects(true)가 남아 있다');
      // 이동할 때마다 검사하려면 allowed()가 루프 안에 있어야 한다(요청 생성보다 앞에)
      const loop = /for \(int hop[\s\S]*?openConnection\(\)/.exec(nj);
      assert.ok(loop && /allowed\(target\)/.test(loop[0]), 'allowed() 검사가 이동 루프 안에 없다');
      assert.ok(/MAX_HOPS/.test(nj), '리다이렉트 횟수 제한이 없다');
      // 헤더(Cookie·Referer)를 매 홉에 다시 싣기 때문에, 출처가 바뀌면 A의 쿠키가 B로 건네진다.
      // 호스트 이름만 비교하면 같은 이름의 다른 포트(8443 등)를 남의 출처로 보지 못한다
      assert.ok(/originOf\(target\)\.equals\(origin\)/.test(nj),
        '출처가 바뀌는 리다이렉트를 막지 않는다 — 쿠키가 다른 곳으로 넘어간다');
      assert.ok(/getDefaultPort/.test(nj), '출처 비교가 포트를 보지 않는다');
      assert.ok(/getPort\(\) != 443/.test(nj), '허용 목록이 포트를 보지 않는다 — 허용 호스트의 다른 포트로 나갈 수 있다');
      // 홉마다 타임아웃을 새로 세면 3번 이동에 8초×4까지 늘어난다. connect·read·본문 읽기가
      // 각각 남은 시간을 새로 쓰는 것도 막아야 실제 상한이 생긴다
      assert.ok(/deadline/.test(nj) && !/setReadTimeout\(timeout\)/.test(nj),
        '타임아웃이 요청 단위가 아니라 홉 단위다');
      assert.ok(/clock\.schedule\([^)]*disconnect/.test(nj), '시한이 지나도 연결을 끊지 않는다');
      assert.ok(/readAll\(in, deadline\)/.test(nj), '본문 읽기가 시한을 보지 않는다');
      // 감시가 본문 전송보다 늦게 걸리면 POST가 그 자리에서 막힐 때 시한이 소용없다
      const gi = nj.indexOf('clock.schedule'), oi = nj.indexOf('getOutputStream');
      assert.ok(gi > 0 && oi > gi, '시한 감시가 본문 전송(getOutputStream)보다 늦게 걸린다');
      // 중괄호 균형으로 블록을 떼어 낸다(정규식으로 끝을 짚으면 엉뚱한 줄을 문다).
      // 못 찾으면 null — 표식을 놓쳤을 때 파일 첫 중괄호(=클래스 전체)를 집어 조용히 통과하면 안 된다.
      // 리터럴 안의 중괄호는 세지 않는다(문자열은 strip이 남겨 두므로 여기서 걸러야 한다).
      const blockAt = (t, from) => {
        if (from < 0) return null;
        const j = t.indexOf('{', from);
        if (j < 0) return null;
        let d = 0;
        for (let k = j; k < t.length; k++) {
          const ch = t[k];
          if (ch === '"' || ch === "'") {
            k++;
            while (k < t.length && t[k] !== ch) k += t[k] === '\\' ? 2 : 1;
            continue;
          }
          if (ch === '{') d++;
          else if (ch === '}' && --d === 0) return t.slice(j, k + 1);
        }
        return null; // 균형이 맞지 않는다
      };
      assert.strictEqual(blockAt('x { a "}" b } y', 0), '{ a "}" b }', 'blockAt이 문자열 안의 중괄호를 센다');
      assert.strictEqual(blockAt('아무것도', -1), null, 'blockAt이 표식을 놓쳤는데 무언가를 돌려준다');
      assert.strictEqual(blockAt('x { 안 닫힘', 0), null, 'blockAt이 균형이 안 맞는데 돌려준다');
      // 정상·예외·리다이렉트 어느 길로 나가도 감시 해제·목록 제거·연결 닫기 셋이 다 일어나야 한다.
      // (셋 중 하나가 빠져도 통과하지 않도록 finally 블록 안에서 함께 본다 — active.remove는
      //  예약 실패 처리에도 있어서 파일 전체 검색으로는 구분되지 않는다)
      const fin = blockAt(nj, nj.indexOf('} finally {', nj.indexOf('int status')));
      assert.ok(fin, '요청 처리의 finally 블록을 찾지 못했다 — 구조가 바뀌었으면 이 검사도 고칠 것');
      assert.ok(/guard\.cancel\(false\)/.test(fin), 'finally가 시한 감시를 해제하지 않는다');
      assert.ok(/active\.remove\(c\)/.test(fin), 'finally가 진행 중 목록에서 빼지 않는다 — close()가 이미 끝난 연결을 만진다');
      assert.ok(/c\.disconnect\(\)/.test(fin), 'finally가 연결을 닫지 않는다');
      assert.ok(/active\.add\(c\)/.test(nj), '진행 중인 연결을 등록하지 않는다');
      // close(): 연결을 먼저 끊고 스레드를 내려야 한다. clock을 먼저 내리면 네트워크에서 막힌
      // 요청을 나중에 끊어 줄 감시가 사라져, 화면이 사라진 뒤에도 그 요청이 남는다
      const closeBody = blockAt(nj, nj.indexOf('void close()'));
      assert.ok(closeBody, 'close()를 찾지 못했다');
      const ci = closeBody.indexOf('disconnect'), si = closeBody.indexOf('shutdownNow');
      assert.ok(ci >= 0 && si > ci, 'close()가 연결을 끊기 전에 스레드를 내린다 — 막힌 요청이 남는다');
      assert.ok((closeBody.match(/shutdownNow/g) || []).length === 2, 'close()가 두 스레드를 다 내리지 않는다');
      // 닫힌 뒤에는 콜백을 돌려보내지 않는다
      assert.ok(/if \(!closed\) act\.resolveNet/.test(nj), '닫힌 뒤에도 응답을 화면으로 보낸다');
      // 등록·감시 예약과 close()가 같은 자물쇠 안이어야 서로를 지나치지 않는다. 나뉘어 있으면
      // close()가 목록을 훑은 뒤 끼어든 연결이 감시 없이 네트워크로 나간다
      const locks = [];
      for (let i = nj.indexOf('synchronized (lifecycle)'); i >= 0; i = nj.indexOf('synchronized (lifecycle)', i + 1)) {
        const bl = blockAt(nj, i);
        if (bl) locks.push(bl);
      }
      assert.ok(locks.some(bl => /active\.add\(c\)/.test(bl) && /clock\.schedule/.test(bl)),
        '연결 등록과 시한 감시 예약이 같은 자물쇠 안에 없다');
      assert.ok(locks.some(bl => /closed = true/.test(bl) && /shutdownNow/.test(bl)),
        'close()가 자물쇠 밖에서 종료를 진행한다');
      assert.ok(locks.some(bl => /if \(closed\) return;/.test(bl) && /pool\.execute/.test(bl)),
        '종료 중에도 새 작업을 큐에 넣는다 — 거부 예외가 브리지 밖으로 나갈 수 있다');
      // 위 셋이 서로 다른 블록이어야 한다(표식이 통째로 사라진 경우를 잡는 안전망)
      assert.ok(locks.length >= 3, `자물쇠 블록이 ${locks.length}개다 — 요청 시작·연결 등록·종료 세 곳에 있어야 한다`);

      const mj = strip(fs.readFileSync(path.join(__dirname, 'android/app/src/main/java/com/inavnow/MainActivity.java'), 'utf8'));
      const onDestroy = /protected void onDestroy\(\)\s*\{([\s\S]*?)\n    \}/.exec(mj);
      assert.ok(onDestroy, 'onDestroy를 찾지 못했다');
      assert.ok(/net\.close\(\)/.test(onDestroy[1]),
        'onDestroy가 Net을 정리하지 않는다 — 화면이 재생성될 때마다 스레드가 쌓인다');
      assert.ok(/destroyed = true/.test(onDestroy[1]), 'onDestroy가 파괴 표시를 남기지 않는다');
      // 파괴된 WebView를 만지면 죽는다 — UI 스레드에 올라간 뒤에도 한 번 더 봐야 한다
      assert.ok(/if \(destroyed\) return/.test(mj) && /if \(!destroyed\) web\.evaluateJavascript/.test(mj),
        '파괴 후 콜백이 WebView로 들어갈 수 있다');
      ok('앱 브리지가 리다이렉트를 직접 따라가며 이동마다 다시 검사한다(교차 호스트 거부·공용 시한·정리)');
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
    // 검사가 스스로 listen하면 안 된다 — require일 때는 auth.js의 바인딩 코드(require.main 블록)가
    // 실행되지 않아, 거기가 0.0.0.0으로 되돌아가도 통과해 버린다. 정말 프로세스로 띄워서 확인한다.
    assert.strictEqual(A.HOST, '127.0.0.1', `listen에 쓰는 값이 ${A.HOST}다`);
    const os = require('os');
    // PORT=0으로 띄우고 실제 포트를 자식이 찍어 준 것에서 읽는다 — 포트를 고르면 다른 프로세스와
    // 부딪히고, 하필 그 자리에 남의 HTTP 서버가 있으면 엉뚱한 응답을 보고 통과할 수 있다
    const child = require('child_process').spawn(process.execPath, ['auth.js'],
      { cwd: __dirname, env: { ...process.env, ETF_PASS: 'testpass', PORT: '0' } });
    try {
      const aport = await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('auth.js가 10초 안에 포트를 알려주지 않았다')), 10000);
        let buf = '';
        child.stdout.on('data', d => {
          buf += d;
          const m = /localhost:(\d+)/.exec(buf);
          if (m) { clearTimeout(t); res(+m[1]); }
        });
        child.on('exit', c => { clearTimeout(t); rej(new Error(`auth.js가 바로 끝났다(코드 ${c})`)); });
      });
      const hit = host => new Promise(res => {
        const rq = http.get({ host, port: aport, path: '/', timeout: 1500 }, r => { r.resume(); res(true); });
        rq.on('error', () => res(false));
        rq.on('timeout', () => { rq.destroy(); res(false); });
      });
      assert.ok(await hit('127.0.0.1'), `auth.js가 127.0.0.1:${aport}에서 응답하지 않는다`);
      const lan = Object.values(os.networkInterfaces()).flat()
        .find(i => i && i.family === 'IPv4' && !i.internal);
      if (lan) {
        assert.strictEqual(await hit(lan.address), false,
          `${lan.address}:${aport}으로 접속됐다 — 같은 망의 누구나 평문으로 로그인 화면에 닿는다`);
      }
      ok('node auth.js가 루프백만 듣는다' + (lan ? ` (${lan.address}로는 닿지 않는다)` : ' (LAN 주소 없음)'));
    } finally {
      // 이미 끝났으면 기다리지 않는다 — 종료된 뒤에 exit를 기다리면 영원히 걸린다
      if (child.exitCode === null && child.signalCode === null) {
        const done = new Promise(r => child.once('exit', r));
        child.kill();
        await done;
      }
    }
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
