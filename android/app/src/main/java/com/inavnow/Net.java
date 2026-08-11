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
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

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
    /** 요청 하나의 시한을 재는 시계 — 지나면 연결을 끊는다 */
    private final ScheduledExecutorService clock = Executors.newSingleThreadScheduledExecutor();
    /** 지금 열려 있는 연결들 — 앱이 닫힐 때 직접 끊어야 한다(아래 close 설명) */
    private final Set<HttpURLConnection> active = Collections.newSetFromMap(new ConcurrentHashMap<>());
    private volatile boolean closed = false;
    /** 요청 시작과 종료가 서로를 지나치지 않게 잡는 자물쇠 */
    private final Object lifecycle = new Object();
    private SSLSocketFactory sectigoFactory; // 지연 생성

    Net(MainActivity act) { this.act = act; }

    /** engine.js의 window.__net이 부른다. 응답은 콜백 id로 되돌려 준다(WebView는 동기 반환이 위험). */
    @JavascriptInterface
    public void request(final String id, final String spec) {
        synchronized (lifecycle) {
            if (closed) return; // 돌려줄 화면이 이미 없다
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
                if (!closed) act.resolveNet(id, out.toString()); // 닫힌 뒤엔 돌려줄 화면이 없다
            });
        }
    }

    /**
     * 엔진이 실제로 쓰는 호스트만 허용한다(알파벳순).
     *
     * 이 브리지는 CORS 밖에서 임의 요청을 보낼 수 있어, 페이지에 스크립트가 한 번이라도 주입되면
     * 일반 웹페이지보다 할 수 있는 일이 많다. 목록을 좁혀 두면 그때도 낯선 서버로는 못 나간다.
     * 호스트를 늘릴 때는 engine.js에서 실제로 부르는 것만 넣는다.
     */
    private static final String[] HOSTS = {
            "finance.naver.com",
            "investments.miraeasset.com",
            "m.stock.naver.com",
            "moneyrecipe.blog",
            "papi.aceetf.co.kr",
            "query1.finance.yahoo.com",
            "wts-info-api.tossinvest.com",
            "www.1qetf.com",
            "www.aceetf.co.kr",
            "www.funetf.co.kr",
            "www.kiwoometf.com",
            "www.plusetf.co.kr",
            "www.riseetf.co.kr",
            "www.samsungfund.com",
            "www.soletf.com",
            "yasun.gg",
    };

    private static boolean allowed(URL u) {
        if (!"https".equals(u.getProtocol())) return false; // 평문 http로는 나가지 않는다
        // 포트도 본다 — 이름만 맞추면 허용된 호스트의 8443 같은 다른 포트로도 나갈 수 있다
        if (u.getPort() != -1 && u.getPort() != 443) return false;
        String h = u.getHost().toLowerCase();
        for (String ok : HOSTS) if (h.equals(ok)) return true;
        return false;
    }

    /** 같은 출처인지 — 리다이렉트는 스킴·호스트·포트가 모두 같을 때만 따라간다 */
    private static String originOf(URL u) {
        int port = u.getPort() == -1 ? u.getDefaultPort() : u.getPort();
        return u.getProtocol().toLowerCase() + "://" + u.getHost().toLowerCase() + ":" + port;
    }

    /** 리다이렉트를 따라가는 최대 횟수 — 지금 쓰는 API 중 리다이렉트하는 곳은 없다 */
    private static final int MAX_HOPS = 3;

    private JSONObject doRequest(JSONObject s) throws Exception {
        String method = s.optString("method", "GET");
        String body = s.isNull("body") ? null : s.optString("body", null);
        String extraCa = s.isNull("extraCa") ? null : s.optString("extraCa", null);
        int timeout = s.optInt("timeout", 8000);
        JSONObject hs = s.optJSONObject("headers");

        // 타임아웃은 요청 하나에 한 번만 준다 — 홉마다 새로 8초를 세면 리다이렉트 3번에 32초까지
        // 늘어나 브리지를 기다리는 쪽이 먼저 포기한다
        final long deadline = System.currentTimeMillis() + timeout;

        URL target = new URL(s.getString("url"));
        final String origin = originOf(target);
        for (int hop = 0; ; hop++) {
            // 이동할 때마다 다시 검사한다 — 플랫폼의 자동 추적에 맡기면 허용된 사이트가 30x로
            // 다른 호스트를 가리키는 순간 목록 밖으로 나가 버린다(첫 URL만 검사되므로)
            if (!allowed(target)) {
                throw new SecurityException("허용하지 않는 주소: " + target.getProtocol() + "://" + target.getAuthority());
            }
            // 출처가 바뀌는 리다이렉트는 따라가지 않는다. 헤더(Cookie·Referer)를 그대로 다시 실어
            // 보내므로, 허용된 A가 허용된 B로 넘기면 A의 쿠키가 B에 건네진다(같은 호스트의 다른
            // 포트도 남의 출처다). 지금 어댑터 중 이런 리다이렉트에 의존하는 곳은 없다.
            if (hop > 0 && !originOf(target).equals(origin)) {
                throw new SecurityException("다른 출처로 넘기는 리다이렉트는 따르지 않는다: " + origin + " → " + originOf(target));
            }
            int left = (int) (deadline - System.currentTimeMillis());
            if (left <= 0) throw new java.net.SocketTimeoutException("리다이렉트를 따라가다 시간이 다 됐다");

            HttpURLConnection c = (HttpURLConnection) target.openConnection();
            // kiwoometf.com은 중간 인증서를 빼먹고 보낸다 — 그 인증서를 보태 정상 검증을 켠다.
            // 검증을 끄는 게 아니라 신뢰 앵커를 보태는 것이라 MITM 방어가 유지된다.
            if ("sectigo-ov".equals(extraCa) && c instanceof HttpsURLConnection) {
                ((HttpsURLConnection) c).setSSLSocketFactory(sectigoFactory());
            }
            c.setRequestMethod(method);
            c.setConnectTimeout(left);
            c.setReadTimeout(left);
            c.setInstanceFollowRedirects(false); // 직접 따라간다(위 재검사를 거치게)

            if (hs != null) {
                for (java.util.Iterator<String> it = hs.keys(); it.hasNext(); ) {
                    String k = it.next();
                    c.setRequestProperty(k, hs.getString(k));
                }
            }
            // connect·read 타임아웃을 남은 시간으로 줘도 둘이 이어 붙으면 시한을 넘고, 본문이 조금씩
            // 계속 오면 읽기가 더 길어진다. 시한이 지나면 연결을 끊어 실제 상한을 만든다.
            // 감시는 첫 네트워크 작업(POST 본문 전송 = getOutputStream) '전에' 걸어야 한다 —
            // 여기까지의 설정 호출은 통신을 하지 않지만, 본문 전송은 그 자리에서 막힐 수 있다.
            final HttpURLConnection conn = c;
            // 등록과 감시 예약을 close()와 같은 자물쇠로 묶는다. 나누어 두면 close()가 목록을 다
            // 훑은 뒤에 이 연결이 끼어들 수 있고(동시 추가를 반드시 본다는 보장이 없다), 그러면
            // 감시는 clock이 내려가 사라졌는데 요청은 그대로 네트워크로 나간다.
            final ScheduledFuture<?> guard;
            synchronized (lifecycle) {
                if (closed) { c.disconnect(); throw new IllegalStateException("앱이 닫혀 요청을 시작하지 않는다"); }
                active.add(c);
                try {
                    guard = clock.schedule(conn::disconnect,
                            Math.max(1, deadline - System.currentTimeMillis()), TimeUnit.MILLISECONDS);
                } catch (RuntimeException e) { // 예약이 거부되면(종료 중) 연 것을 되돌린다
                    active.remove(c);
                    c.disconnect();
                    throw e;
                }
            }
            try {
                if (body != null) {
                    c.setDoOutput(true);
                    byte[] b = body.getBytes("UTF-8");
                    c.setFixedLengthStreamingMode(b.length);
                    try (OutputStream os = c.getOutputStream()) { os.write(b); }
                }

                int status = c.getResponseCode();
                String loc = c.getHeaderField("Location");
                if (isRedirect(status) && loc != null && hop < MAX_HOPS) {
                    URL next = new URL(target, loc); // 상대 경로 Location도 받는다
                    // 303, 그리고 관행상 301·302는 GET으로 바꿔 따라간다. 307·308은 메서드와 본문을 지킨다.
                    if (status == 303 || status == 301 || status == 302) { method = "GET"; body = null; }
                    target = next;
                    continue; // 연결은 아래 finally가 닫는다
                }

                // 4xx·5xx는 getInputStream이 던지므로 errorStream으로 받는다(엔진이 상태코드로 분기한다)
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                byte[] bytes = readAll(in, deadline);

                JSONObject rh = new JSONObject();
                for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
                    if (e.getKey() == null) continue; // 상태 라인
                    List<String> v = e.getValue();
                    // Set-Cookie는 여러 개가 올 수 있다 — 배열로 넘겨 JS가 각각 읽게 한다(funetf 로그인 흐름)
                    if (v.size() > 1) rh.put(e.getKey(), new org.json.JSONArray(v));
                    else rh.put(e.getKey(), v.get(0));
                }

                JSONObject out = new JSONObject();
                out.put("status", status);
                out.put("headers", rh);
                out.put("bodyB64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                return out;
            } finally {
                // 예외로 빠져나갈 때도 정리한다 — 취소만 하고 연결을 두면 소켓이 남는다
                guard.cancel(false);
                active.remove(c);
                c.disconnect();
            }
        }
    }

    /**
     * Activity가 사라질 때 정리한다 — 재생성될 때마다 스레드가 쌓이면 안 된다.
     *
     * 순서가 중요하다. shutdownNow()는 네트워크에서 막혀 있는 요청을 실제로 깨우지 못하고,
     * clock을 먼저 내리면 그 요청을 나중에 끊어 줄 감시까지 사라져 영원히 남는다
     * (특히 본문 전송에서 막힌 경우). 그래서 열려 있는 연결을 직접 끊고 나서 스레드를 내린다.
     */
    void close() {
        synchronized (lifecycle) {
            closed = true;
            for (HttpURLConnection c : active) {
                try { c.disconnect(); } catch (Throwable ignore) {}
            }
            pool.shutdownNow();
            clock.shutdownNow();
        }
    }

    private static boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }

    private static byte[] readAll(InputStream in, long deadline) throws Exception {
        if (in == null) return new byte[0];
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            bo.write(buf, 0, n);
            // 조금씩 계속 보내는 상대에게 끝없이 붙잡히지 않는다(읽기 타임아웃은 매 조각마다 갱신된다)
            if (System.currentTimeMillis() > deadline) throw new java.net.SocketTimeoutException("본문을 다 읽기 전에 시한이 지났다");
        }
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
