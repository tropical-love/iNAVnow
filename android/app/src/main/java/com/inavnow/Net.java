package com.inavnow;

import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;

/**
 * 엔진(engine.js)의 외부 통신을 대신 받아 준다.
 *
 * WebView에서 fetch로 네이버·야후·운용사를 직접 부르면 CORS로 전부 막히므로, 여기서 대신 요청한다.
 * 규약은 개발용 브리지(tools 쪽 검증 스크립트)와 같다:
 *   요청  {url, method, headers, body, extraCa}
 *   응답  {status, headers, bodyB64}
 * 본문을 base64로 넘기는 이유 — 네이버 ETF 목록이 EUC-KR이라 바이트가 온전해야 JS에서
 * TextDecoder('euc-kr')로 풀 수 있다. 문자열로 넘기면 깨진다.
 *
 * 의존성을 두지 않으려고 HttpURLConnection을 쓴다(gzip·리다이렉트는 플랫폼이 처리).
 * 쿠키는 자동 처리하지 않는다 — funetf 흐름이 Set-Cookie를 읽어 직접 되돌려주기 때문이다.
 */
public class Net {
    private final MainActivity act;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private SSLSocketFactory sectigoFactory; // 지연 생성

    Net(MainActivity act) { this.act = act; }

    /** engine.js의 window.__net이 부른다. 응답은 콜백 id로 되돌려 준다(WebView는 동기 반환이 위험). */
    @JavascriptInterface
    public void request(final String id, final String spec) {
        pool.execute(() -> {
            JSONObject out = new JSONObject();
            try {
                JSONObject s = new JSONObject(spec);
                out = doRequest(s);
            } catch (Throwable t) {
                try {
                    out.put("status", 0);
                    out.put("error", t.getClass().getSimpleName() + ": " + t.getMessage());
                } catch (Exception ignore) {}
            }
            act.resolveNet(id, out.toString());
        });
    }

    private JSONObject doRequest(JSONObject s) throws Exception {
        String url = s.getString("url");
        String method = s.optString("method", "GET");
        String body = s.isNull("body") ? null : s.optString("body", null);
        String extraCa = s.isNull("extraCa") ? null : s.optString("extraCa", null);
        int timeout = s.optInt("timeout", 8000);

        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        // kiwoometf.com은 중간 인증서를 빼먹고 보낸다 — 그 인증서를 보태 정상 검증을 켠다.
        // 검증을 끄는 게 아니라 신뢰 앵커를 보태는 것이라 MITM 방어가 유지된다.
        if ("sectigo-ov".equals(extraCa) && c instanceof HttpsURLConnection) {
            ((HttpsURLConnection) c).setSSLSocketFactory(sectigoFactory());
        }
        c.setRequestMethod(method);
        c.setConnectTimeout(timeout);
        c.setReadTimeout(timeout);
        c.setInstanceFollowRedirects(true);

        JSONObject hs = s.optJSONObject("headers");
        if (hs != null) {
            for (java.util.Iterator<String> it = hs.keys(); it.hasNext(); ) {
                String k = it.next();
                c.setRequestProperty(k, hs.getString(k));
            }
        }
        if (body != null) {
            c.setDoOutput(true);
            byte[] b = body.getBytes("UTF-8");
            c.setFixedLengthStreamingMode(b.length);
            try (OutputStream os = c.getOutputStream()) { os.write(b); }
        }

        int status = c.getResponseCode();
        // 4xx·5xx는 getInputStream이 던지므로 errorStream으로 받는다(엔진이 상태코드로 분기한다)
        InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
        byte[] bytes = readAll(in);

        JSONObject rh = new JSONObject();
        for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
            if (e.getKey() == null) continue; // 상태 라인
            List<String> v = e.getValue();
            // Set-Cookie는 여러 개가 올 수 있다 — 배열로 넘겨 JS가 각각 읽게 한다(funetf 로그인 흐름)
            if (v.size() > 1) rh.put(e.getKey(), new org.json.JSONArray(v));
            else rh.put(e.getKey(), v.get(0));
        }
        c.disconnect();

        JSONObject out = new JSONObject();
        out.put("status", status);
        out.put("headers", rh);
        out.put("bodyB64", Base64.encodeToString(bytes, Base64.NO_WRAP));
        return out;
    }

    private static byte[] readAll(InputStream in) throws Exception {
        if (in == null) return new byte[0];
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        in.close();
        return bo.toByteArray();
    }

    /** 기본 신뢰 저장소 + 에셋의 Sectigo 중간 인증서 */
    private synchronized SSLSocketFactory sectigoFactory() throws Exception {
        if (sectigoFactory != null) return sectigoFactory;
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        X509Certificate extra;
        try (InputStream is = act.getAssets().open("sectigo-ov.pem")) {
            extra = (X509Certificate) cf.generateCertificate(is);
        }
        // 시스템 기본 앵커를 그대로 가져오고 거기에 중간 인증서를 더한다
        KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
        ks.load(null, null);
        KeyStore sys = KeyStore.getInstance("AndroidCAStore");
        sys.load(null, null);
        for (java.util.Enumeration<String> a = sys.aliases(); a.hasMoreElements(); ) {
            String al = a.nextElement();
            java.security.cert.Certificate cert = sys.getCertificate(al);
            if (cert != null) ks.setCertificateEntry(al, cert);
        }
        ks.setCertificateEntry("sectigo-ov", extra);
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(ks);
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, tmf.getTrustManagers(), null);
        sectigoFactory = ctx.getSocketFactory();
        return sectigoFactory;
    }
}
