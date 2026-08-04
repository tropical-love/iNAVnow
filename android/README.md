# iNAVnow 안드로이드 앱

`server.js` 하나를 그대로 재사용하는 WebView 앱입니다. 로컬 HTTP 서버가 없고, 외부 통신만 네이티브가 대신 받습니다.

## 왜 이 구조인가

WebView에서 네이버·야후·운용사를 fetch로 직접 부르면 **CORS로 전부 막힙니다**. 그래서
`server.js`의 유일한 외부 통신 통로(`fetchOrThrow`)를 네이티브(`Net.java`)로 우회시켰습니다.
계산 로직 2,000줄은 손대지 않았고, 갈라지는 곳은 셋뿐입니다.

| | 로컬 Node | GCP (auth.js) | 안드로이드 |
|---|---|---|---|
| 외부 통신 | `fetch` | `fetch` | `window.__net` → `Net.java` |
| 캐시 | `cache.json` | `cache.json` | `localStorage` |
| HTTP 표면 | `http.createServer` | 래퍼 경유 | 없음 (fetch shim이 함수 직접 호출) |
| 포트폴리오 | `localStorage` | 서버 파일 | `localStorage` (기기 내부) |
| 갱신 주기 | 촘촘(10s/30s) | 보수(20s/60s) | 보수 |

## 빌드

```bash
node tools/build-android.js
cd android && gradle assembleRelease
```

1단계가 `server.js` → `assets/`(index.html · engine.js · sectigo-ov.pem)를 만듭니다.
**server.js를 고치면 반드시 1단계를 다시 돌려야 합니다.**

산출물: `app/build/outputs/apk/release/inavnow.apk` (약 290KB).
디버그 빌드는 `gradle assembleDebug` → `apk/debug/app-debug.apk`(약 400KB, `debuggable=true`).
배포에는 릴리스를 씁니다.

`local.properties`는 이 PC의 SDK 경로라 저장소에 없습니다. 처음 빌드할 때 만드세요:

```
sdk.dir=C\:\\Users\\<이름>\\AppData\\Local\\Android\\Sdk
```

### 릴리스 서명

`android/keystore.properties`가 있으면 그 키로, 없으면 **디버그 키로** 서명합니다(설치는 되지만
`debuggable`이 켜져 있고, 서명 주체가 이 PC의 `~/.android/debug.keystore`입니다).

키를 한 번 만들어 두세요 — 비밀번호는 직접 정합니다:

```bash
keytool -genkeypair -v -keystore android/inavnow.jks -alias inavnow \
  -keyalg RSA -keysize 2048 -validity 10000
```

그리고 `android/keystore.properties`(git에 올라가지 않습니다):

```
storeFile=inavnow.jks
storePassword=<위에서 정한 비밀번호>
keyAlias=inavnow
keyPassword=<같은 비밀번호>
```

> **`.jks`와 비밀번호는 반드시 백업하세요.** 서명이 바뀌면 이미 설치된 앱 위에 업데이트가 되지
> 않아, 쓰던 사람 전원이 삭제하고 다시 설치해야 합니다.

서명 확인:

```bash
%LOCALAPPDATA%\Android\Sdk\build-tools\34.0.0\apksigner.bat verify -v --print-certs app/build/outputs/apk/release/inavnow.apk
```

### '출처를 알 수 없는 앱' 경고에 대해

이 경고는 **서명과 무관합니다.** 스토어를 거치지 않은 설치에 안드로이드가 붙이는 것이라
릴리스 키로 서명해도 그대로 나옵니다. 없애는 방법은 Play Store 배포뿐입니다.
설치를 실행한 앱(브라우저·파일 관리자)별로 최초 1회만 묻습니다.

### 런처 아이콘

원본은 `icon-src/icon.png`(1254×1254, 투명 배경). 바꿀 때는 그 파일을 갈아끼우고:

```bash
node tools/build-icon.js android/icon-src/icon.png
```

밉맵 5종(48~192px)과 adaptive 전경 5종(108~432px), 그리고 `values/colors.xml`의 배경색을 만듭니다.
의존성 없이 PNG를 직접 읽고 쓰는 스크립트라 ImageMagick 같은 게 필요 없습니다.

동작:

1. 원본에서 **내용의 경계를 재서** 정사각으로 맞춥니다 — 테두리가 있는 그림이든 없는 그림이든
   같은 크기로 보입니다. 비율을 고정하면 원본을 바꿀 때마다 어긋납니다.
2. adaptive 전경의 크기(`FG_FRAC`)를 **계산해서** 정합니다 — 내용의 외접원 반지름을 재서
   보장 영역(지름 66.7%)의 내접원에 딱 맞춥니다(안전 여유 2%). 눈대중으로 0.56을 쓰던 때는
   갤럭시 스퀘어클에서 로고 네 귀가 잘렸습니다. 현재 원본에서는 자동으로 **48.8%**가 나오고
   원형 마스크 잘림 **0.0%**입니다. 원본을 바꾸면 이 값도 자동으로 다시 계산됩니다.
3. 구형 밉맵은 원본 배경색에 합성합니다(투명하면 legacy 슬롯에서 깨져 보입니다).
4. 원본 배경색을 `ic_bg`로 기록합니다 — 전경의 사각형 경계가 배경과 같은 색이라 보이지 않습니다.

> 런처는 전경의 가운데 72dp(66.7%)만 보장하고, 마스크 모양은 런처마다 다릅니다(원형·스퀘어클·
> 둥근 사각형). 어디서도 잘리지 않으려면 가장 좁은 **내접원** 안에 내용이 전부 들어가야 합니다.
> 축소는 알파 가중 박스 필터라 반투명 가장자리가 어두워지지 않습니다.

마스크별 실제 모습이 궁금하면 미리보기를 만들 수 있습니다(원형·갤럭시 스퀘어클·정사각 나란히).
검증용 스크립트라 저장소에는 없고, 필요할 때 다시 만들면 됩니다.

### 이 PC의 도구 위치

Android Studio 없이 커맨드라인 SDK만 씁니다.

- SDK: `%LOCALAPPDATA%\Android\Sdk` (platform android-34, build-tools 34.0.0)
- Gradle: `%LOCALAPPDATA%\gradle-dist\gradle-8.9\bin\gradle.bat`
- `local.properties`의 `sdk.dir`가 SDK를 가리킵니다(git에 올리지 않음)

## 설치

디버그 서명이라 스토어를 거치지 않습니다. APK를 폰으로 옮기고 **출처를 알 수 없는 앱**을 허용해 설치하세요.
`adb`를 깔면 `adb install -r app-debug.apk`로도 됩니다.

## 되돌리면 안 되는 함정

빌드 스크립트와 코드에 주석으로 박아 뒀지만 요약하면:

1. **engine.js는 반드시 외부 `<script src>`로** 싣습니다. 인라인으로 넣으면 안에 있는 `</script>` 문자열이
   HTML 파서에 태그 종료로 읽혀 페이지가 통째로 깨집니다.
2. **`<link id="icon">`을 지우지 마세요.** `setIcon()`이 이 엘리먼트를 `replaceWith` 하므로 없으면
   `applyTitle()` 첫 호출에서 터지고 클라이언트 스크립트가 그 자리에서 멈춥니다(실측).
   그래서 지우는 대신 SVG를 data URI로 박아 넣습니다.
3. **본문은 base64로 넘깁니다.** 네이버 ETF 목록이 EUC-KR이라 바이트가 온전해야
   `TextDecoder('euc-kr')`로 풀립니다. 문자열로 넘기면 깨집니다.
4. **`Set-Cookie`는 `res.__setCookie`로 따로 넘깁니다.** `new Response(..., {headers})`는 Set-Cookie를
   통째로 버립니다(실측: 헤더 목록에 안 남고 `getSetCookie()`도 빈 배열). 이걸 안 하면 funetf 폴백이
   csrf 토큰을 못 찾아 조용히 다음 폴백으로 밀립니다.
5. **kiwoometf는 검증을 끄지 않습니다.** 중간 인증서(`sectigo-ov.pem`)를 신뢰 앵커에 *보태서*
   정상 체인 검증을 켠 채 호출합니다 — MITM 방어가 유지됩니다.
6. `server.js`에서 최상위 `process.env` 접근은 `NODE ? … : null`로 감싸야 합니다. 안 그러면
   브라우저에서 엔진이 로드되는 순간 통째로 죽습니다(실측: `PORT`).
7. **절대경로 링크(`href="/"`)를 남기면 안 됩니다.** `file://`에서 `file:///`로 풀려
   `net::ERR_ACCESS_DENIED`가 납니다(실측: `‹ Home`). 빌드 스크립트가 `index.html`로 바꾸고,
   남은 절대경로가 있으면 빌드를 멈춥니다.
8. XML 리소스 **주석 안에 하이픈 두 개를 쓰면 빌드가 깨집니다**(CSS 변수명을 그대로 적다가 겪음).

## 페이지 이동이 곧 새 문서라는 점

앱에서 홈↔종목 이동은 `file://` URL 이동이라 **매번 새 문서**입니다. 메모리에 있던 것이 다 사라지므로
두 가지를 localStorage에 남깁니다. 이걸 빼면 홈에 올 때마다 전 종목을 다시 조회합니다(실측 152회 → 1회).

- **포트폴리오 계산 결과**(`pfCalc` 키: 기준시각 + 종목별 iNAV·현재가) — 5분이 안 지났으면 그 값을
  즉시 보여주고 재계산하지 않습니다. 30초마다 나이만 재는 방식이라 타이머가 겹치지 않습니다.
- **시세 캐시 전체**(`engineCache` 키) — Node는 장기 캐시만 `cache.json`에 쓰지만, 앱은 `ba:`·`an:`·
  `kr:`·`yq:`·`yd:`·`pdf:`까지 담습니다(실측 35개 449KB). 만료분은 읽을 때 걸러 무한정 자라지 않고,
  용량 초과 시 장기 캐시만 남기고 재시도합니다.
- **종목 상세의 마지막 응답**(`inavLast` 키, 종목 10개까지) — 들어가면 그 값을 먼저 그려서 빈 화면이
  없고, 갱신 주기(앱 20초) 안이면 조회를 아예 건너뜁니다. 판단은 `refreshIfStale()` 한 곳에 모아
  시작 경로와 탭 복귀(`visibilitychange`) 양쪽이 같은 규칙을 씁니다 — 복귀 때 무조건 `refresh()`를
  부르던 탓에 캐시가 있어도 전체를 다시 훑었습니다(실측으로 잡음).

## 앱 껍데기 설정

- **액션바 없음** — `Theme.iNAVnow`(NoActionBar). 웹 페이지가 자기 헤더를 그리므로 상단에 `iNAVnow`
  바가 겹쳐 나오던 것을 없앴습니다. `windowBackground`·`statusBarColor`를 페이지 배경과 같은 값으로
  맞춰 로딩 순간 번쩍임이 없고, `values-night/`로 시스템 다크모드도 따라갑니다.
- **세로 고정** — `android:screenOrientation="portrait"`.
- **뒤로가기** — 종목 상세에서는 WebView 히스토리를 따라가고, 메인 화면에서는 히스토리를 무시하고
  두 번 눌러야 종료합니다(첫 번째는 토스트 안내, 2초 안에 다시 누르면 종료).
  메인에서 히스토리를 따라가면 조금 전 보던 종목으로 되돌아가 앱을 닫기 어렵습니다 — 홈↔종목을
  오갈수록 히스토리가 쌓이기 때문입니다. 현재 페이지 판별은 URL의 `?code=` 유무로 합니다.

## 검증 현황

브라우저에서 네이티브 브리지를 흉내낸 개발용 프록시로 앱과 **동일한 경로**를 실측했습니다.

| 항목 | 결과 |
|---|---|
| 엔진 로드 + 브리지 | ✓ |
| 네이버 EUC-KR 종목목록 | 1,155개 |
| KODEX 200 | iNAV 100,771.60 · 괴리 −0.123% · 반영 97.1% (Node 서버와 동일) |
| 2회차 호출 | 1ms (localStorage 캐시 219KB) |
| kiwoom 중간 인증서 경로 | `출처 kiwoom` · 반영 97% |
| funetf `Set-Cookie` | 7개 전달 · csrf 토큰 추출 ✓ |
| 해외 ETF(환율·야후) | ACE 미국빅테크TOP7 Plus · 반영 100% · USD 1,432.66 |
| 포트폴리오 | localStorage 저장 + 계산 ✓ |
| APK | 105KB, 에셋 3종 포함, 권한 INTERNET·ACCESS_NETWORK_STATE만 |

**아직 실기에서 돌려보지 않았습니다.** `adb`가 없어 설치·logcat 확인을 못 했습니다.
폰에 넣어 보시고 문제가 있으면 `platform-tools`를 깔아 logcat으로 잡겠습니다
(`MainActivity`가 JS 콘솔을 `iNAVnow` 태그로 흘려 둡니다).
