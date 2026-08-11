package com.inavnow;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.webkit.ConsoleMessage;
import android.net.Uri;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * 에셋의 index.html을 WebView로 띄운다. 계산은 전부 engine.js(=server.js와 같은 파일)가 하고,
 * 외부 통신만 Net이 네이티브로 대신 받는다. 로컬 HTTP 서버는 없다.
 *
 * 포트폴리오·설정·캐시는 WebView의 localStorage에 남는다 = 기기 내부 저장. 밖으로 나가지 않는다.
 */
public class MainActivity extends Activity {
    /** 메인 화면에서 두 번 눌러 종료할 때의 유효 시간 — 토스트(LENGTH_SHORT ≈ 2초)와 맞춘다 */
    private static final long EXIT_WINDOW_MS = 2000;

    /** 에셋으로 실려 나간 페이지인지 — 앱이 열어도 되는 유일한 출처다 */
    private static boolean isAsset(Uri u) {
        return u != null && "file".equals(u.getScheme())
                && u.getPath() != null && u.getPath().startsWith("/android_asset/");
    }

    private WebView web;
    private Net net;
    private long lastBack;
    private Toast exitToast;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle st) {
        super.onCreate(st);
        web = new WebView(this);
        setContentView(web);

        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true); // localStorage — 포트폴리오·캐시가 여기 있다
        web.getSettings().setDatabaseEnabled(true);
        // 에셋 밖으로는 나가지 않는다. 브리지(AndroidNet)가 이 WebView의 모든 페이지에 붙어 있어,
        // 외부 페이지가 한 번이라도 열리면 그 페이지에서 임의 네트워크 요청을 할 수 있게 된다.
        // 이 앱에는 외부로 나가는 링크가 없으므로 전부 막는다.
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !isAsset(r.getUrl());
            }
        });
        // JS 오류를 logcat으로 — 기기에서 엔진이 죽으면 이것 말고는 볼 방법이 없다
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                android.util.Log.d("iNAVnow", m.messageLevel() + " " + m.message()
                        + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
            // WebView 기본 다이얼로그는 제목에 출처를 박는다 — 에셋을 file://로 여니
            // "'file://' 페이지 내용:"이 그대로 보인다. 제목 없는 다이얼로그로 직접 띄운다.
            @Override public boolean onJsAlert(WebView v, String url, String msg, android.webkit.JsResult r) {
                new android.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(msg)
                        .setPositiveButton(android.R.string.ok, (d, w) -> r.confirm())
                        .setOnCancelListener(d -> r.cancel())
                        .show();
                return true;
            }
            @Override public boolean onJsConfirm(WebView v, String url, String msg, android.webkit.JsResult r) {
                new android.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(msg)
                        .setPositiveButton(android.R.string.ok, (d, w) -> r.confirm())
                        .setNegativeButton(android.R.string.cancel, (d, w) -> r.cancel())
                        .setOnCancelListener(d -> r.cancel()) // 뒤로가기·바깥 탭도 '취소'로 확실히 닫는다
                        .show();
                return true;
            }
        });

        // index.html에 주입된 브리지 스크립트가 AndroidNet.request(id, spec)를 부르고,
        // 응답은 resolveNet → window.__netDone(id, json)으로 돌아간다.
        net = new Net(this);
        web.addJavascriptInterface(net, "AndroidNet");
        web.loadUrl("file:///android_asset/index.html");
    }

    /** Net이 백그라운드 스레드에서 부른다 → JS는 메인 스레드에서만 만질 수 있다 */
    void resolveNet(String id, String json) {
        final String js = "window.__netDone(" + JSONObject.quote(id) + "," + JSONObject.quote(json) + ")";
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    /**
     * 종목 상세에서는 뒤로가기가 히스토리를 따라가고, 메인 화면에서는 두 번 눌러야 끝난다.
     *
     * 메인에서 히스토리를 따라가면 조금 전에 보던 종목 페이지로 되돌아가 버려서 앱을 닫기가 어렵다
     * (홈↔종목을 오갈수록 히스토리가 쌓인다). 그래서 메인에서는 히스토리를 무시하고 종료로 간다.
     */
    @Override public void onBackPressed() {
        String url = web.getUrl();
        boolean detail = url != null && url.contains("?code=");
        if (detail && web.canGoBack()) { web.goBack(); return; }

        long now = System.currentTimeMillis();
        if (now - lastBack < EXIT_WINDOW_MS) { super.onBackPressed(); return; }
        lastBack = now;
        if (exitToast != null) exitToast.cancel();
        exitToast = Toast.makeText(this, "한 번 더 뒤로가기 버튼을 누르면 앱이 종료됩니다.", Toast.LENGTH_SHORT);
        exitToast.show();
    }

    @Override protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
