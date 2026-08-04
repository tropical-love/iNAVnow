# iNAVnow 안드로이드 앱

메인 페이지와 같은 `server.js`를 그대로 쓰는 WebView 앱입니다. PC도 서버도 필요 없이 **폰 안에서 직접** 계산하고,
포트폴리오·관심 목록·캐시도 기기 안에만 저장합니다. 외부로 나가는 통신은 시세 조회뿐입니다.

## 설치

[릴리스](../../releases/latest)의 **`inavnow.apk`** 를 폰에서 받아 실행하세요. Android 8.0(API 26) 이상.

스토어를 거치지 않는 설치라 **"출처를 알 수 없는 앱"** 허용을 한 번 물어봅니다(설치를 실행한
브라우저·파일 관리자마다 최초 1회). 이 경고는 서명과 무관하며, 없애는 방법은 Play Store 배포뿐입니다.

## 직접 빌드하려면

필요한 것: JDK 17+, Android SDK(platform 34 · build-tools 34.0.0), Gradle 8.9.
SDK 경로는 PC마다 다르므로 `android/local.properties`를 직접 만드세요:

```
sdk.dir=C\:\\Users\\<이름>\\AppData\\Local\\Android\\Sdk
```

```bash
node tools/build-android.js
cd android && gradle assembleRelease
```

1단계가 `server.js` → `assets/`를 만듭니다. **`server.js`를 고치면 반드시 1단계를 다시 돌려야 합니다.**
산출물은 `app/build/outputs/apk/release/inavnow.apk`입니다.

`android/keystore.properties`가 없으면 디버그 키로 서명되므로, 배포용으로 쓰실 거면 키를 직접 만드세요
(`keytool -genkeypair -keystore android/inavnow.jks -alias inavnow -keyalg RSA -keysize 2048 -validity 10000`).
