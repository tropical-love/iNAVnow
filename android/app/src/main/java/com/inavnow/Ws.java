package com.inavnow;

import android.util.Base64;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * 엔진(engine.js)의 window.__ws — 트레이딩뷰 시세 웹소켓 하나를 대신 연다(나스닥 선물 실시간 대용, Vantage NAS100FT).
 *
 * WebView의 WebSocket은 Origin을 페이지 출처(file://)로 보내는데, 트레이딩뷰는 그 연결을 끊는다
 * (실측: file://·null·빈 값·남의 도메인 거부, tradingview.com만 받는다). 그래서 네이티브로 열고 Origin을 직접 넣는다.
 * 의존성을 두지 않는 방침(build.gradle)이라 RFC 6455 클라이언트를 직접 짰다 — 이 앱이 쓰는 범위
 * (텍스트 프레임·조각 이어 붙이기, 핑·퐁, 닫기)만.
 *
 * 열 수 있는 주소는 URL 하나뿐이다 — 브리지처럼 페이지가 임의의 곳으로 나가는 통로가 되지 않게.
 * 한 번에 하나만 연다 — 새로 열면 앞의 것을 닫는다(페이지를 옮기면 옛 페이지가 연 연결이 남으므로).
 */
class Ws {
    static final String HOST = "data.tradingview.com";
    static final String PATH = "/socket.io/websocket?type=chart";
    static final String URL = "wss://" + HOST + PATH;
    static final String ORIGIN = "https://www.tradingview.com";
    /** 하트비트가 10~20초마다 온다 — 이만큼 아무것도 안 오면 끊긴 것으로 본다 */
    private static final int READ_TIMEOUT_MS = 60000;
    private static final int CONNECT_TIMEOUT_MS = 10000;
    /** 메시지 하나의 상한 — 시세 묶음은 수 KB다. 이상한 길이로 메모리를 다 먹지 않게 */
    private static final int MAX_MSG = 4 << 20;

    private final MainActivity act;
    private Conn cur;
    private boolean shut = false;

    Ws(MainActivity act) { this.act = act; }

    synchronized void open(String id, String url) {
        if (shut) return;
        if (cur != null) cur.close();
        cur = null;
        if (!URL.equals(url)) { act.resolveWs(id, "close", null); return; }
        cur = new Conn(id);
        Thread t = new Thread(cur, "ws-" + id);
        t.setDaemon(true);
        t.start();
    }

    synchronized void send(String id, String text) {
        if (cur != null && cur.id.equals(id)) cur.send(text);
    }

    synchronized void close(String id) {
        if (cur != null && cur.id.equals(id)) { cur.close(); cur = null; }
    }

    /** Activity가 사라질 때 — 이 뒤로는 열지 않는다 */
    synchronized void closeAll() {
        shut = true;
        if (cur != null) cur.close();
        cur = null;
    }

    private class Conn implements Runnable {
        final String id;
        private volatile boolean closed = false;
        private volatile Socket raw;
        private volatile OutputStream out;
        /** 보내기는 한 줄로 — 프레임이 섞이면 안 된다. JS 인터페이스 스레드에서 네트워크를 만지지 않게도 */
        private final ExecutorService writer = Executors.newSingleThreadExecutor();
        private final SecureRandom rnd = new SecureRandom();

        Conn(String id) { this.id = id; }

        @Override public void run() {
            String why = null; // 끊긴 이유 — 엔진이 설정 창에 보여 준다
            try {
                Socket plain = new Socket();
                raw = plain;
                if (closed) return;
                plain.connect(new InetSocketAddress(HOST, 443), CONNECT_TIMEOUT_MS);
                // 호스트 이름을 넘겨 감싸야 SNI가 실린다
                SSLSocket s = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault())
                        .createSocket(plain, HOST, 443, true);
                raw = s;
                s.setSoTimeout(CONNECT_TIMEOUT_MS);
                s.startHandshake();
                // SSLSocket은 인증서의 호스트 이름을 스스로 확인하지 않는다 — HttpsURLConnection과 같은 검증기를 쓴다
                if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(HOST, s.getSession())) {
                    throw new SSLException("인증서의 호스트 이름이 맞지 않는다: " + HOST);
                }

                byte[] k = new byte[16];
                rnd.nextBytes(k);
                String key = Base64.encodeToString(k, Base64.NO_WRAP);
                OutputStream o = new BufferedOutputStream(s.getOutputStream());
                String req = "GET " + PATH + " HTTP/1.1\r\n"
                        + "Host: " + HOST + "\r\n"
                        + "Upgrade: websocket\r\n"
                        + "Connection: Upgrade\r\n"
                        + "Sec-WebSocket-Key: " + key + "\r\n"
                        + "Sec-WebSocket-Version: 13\r\n"
                        + "Origin: " + ORIGIN + "\r\n"
                        + "User-Agent: Mozilla/5.0\r\n\r\n";
                o.write(req.getBytes(StandardCharsets.US_ASCII));
                o.flush();

                InputStream in = new BufferedInputStream(s.getInputStream());
                String[] head = readHead(in).split("\r\n");
                if (!head[0].matches("HTTP/1\\.1 101( .*)?")) throw new IOException("업그레이드 거부: " + head[0]);
                String accept = Base64.encodeToString(MessageDigest.getInstance("SHA-1").digest(
                        (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)), Base64.NO_WRAP);
                boolean okAccept = false;
                for (String h : head) {
                    int c = h.indexOf(':');
                    if (c > 0 && h.substring(0, c).trim().equalsIgnoreCase("Sec-WebSocket-Accept")
                            && h.substring(c + 1).trim().equals(accept)) okAccept = true;
                }
                if (!okAccept) throw new IOException("Sec-WebSocket-Accept가 맞지 않는다");

                s.setSoTimeout(READ_TIMEOUT_MS);
                out = o;
                if (closed) return;
                act.resolveWs(id, "open", null);

                ByteArrayOutputStream msg = new ByteArrayOutputStream();
                while (!closed) {
                    int b0 = in.read(), b1 = in.read();
                    if (b0 < 0 || b1 < 0) break;
                    boolean fin = (b0 & 0x80) != 0;
                    int op = b0 & 0x0F;
                    long len = b1 & 0x7F;
                    if (len == 126) len = (readByte(in) << 8) | readByte(in);
                    else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | readByte(in); }
                    if (len < 0 || len > MAX_MSG) throw new IOException("프레임이 너무 크다: " + len);
                    byte[] mask = (b1 & 0x80) != 0 ? readFully(in, 4) : null; // 서버 프레임은 보통 가리지 않는다
                    byte[] data = readFully(in, (int) len);
                    if (mask != null) for (int i = 0; i < data.length; i++) data[i] ^= mask[i & 3];

                    if (op == 8) break;                                  // 닫기
                    if (op == 9) { sendFrame(10, data); continue; }      // 핑 → 퐁
                    if (op == 10) continue;                              // 퐁
                    if (op == 0 || op == 1 || op == 2) {                 // 이어지는 조각·텍스트·바이너리
                        if (msg.size() + data.length > MAX_MSG) throw new IOException("메시지가 너무 크다");
                        msg.write(data);
                        if (fin) {
                            String text = new String(msg.toByteArray(), StandardCharsets.UTF_8);
                            msg.reset();
                            if (!closed) act.resolveWs(id, "message", text);
                        }
                    }
                }
            } catch (Throwable t) {
                if (!closed) android.util.Log.d("iNAVnow", "ws " + id + " 끊김: " + t);
                why = t.getClass().getSimpleName() + (t.getMessage() != null ? " " + t.getMessage() : "");
            } finally {
                close();
                act.resolveWs(id, "close", why);
            }
        }

        void send(String text) {
            if (closed) return;
            final byte[] b = text.getBytes(StandardCharsets.UTF_8);
            try {
                writer.execute(() -> {
                    try { sendFrame(1, b); } catch (Throwable t) { close(); }
                });
            } catch (Throwable ignore) {} // 닫히는 중이면 버린다
        }

        /** 클라이언트 프레임은 반드시 가린다(RFC 6455 5.3) */
        private synchronized void sendFrame(int op, byte[] data) throws IOException {
            OutputStream o = out;
            if (o == null || closed) return;
            ByteArrayOutputStream f = new ByteArrayOutputStream(data.length + 14);
            f.write(0x80 | op);
            if (data.length < 126) f.write(0x80 | data.length);
            else if (data.length < 65536) { f.write(0x80 | 126); f.write(data.length >>> 8); f.write(data.length & 0xFF); }
            else { f.write(0x80 | 127); for (int i = 7; i >= 0; i--) f.write((int) (((long) data.length >>> (8 * i)) & 0xFF)); }
            byte[] m = new byte[4];
            rnd.nextBytes(m);
            f.write(m);
            for (int i = 0; i < data.length; i++) f.write(data[i] ^ m[i & 3]);
            o.write(f.toByteArray());
            o.flush();
        }

        void close() {
            closed = true;
            writer.shutdownNow();
            Socket s = raw;
            if (s != null) try { s.close(); } catch (Throwable ignore) {} // 읽기에서 막힌 스레드를 깨운다
        }
    }

    /** 응답 머리(빈 줄까지). 너무 길면 이상한 상대다 */
    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int state = 0;
        while (state < 4) {
            int c = in.read();
            if (c < 0) throw new EOFException("응답 머리가 끝나기 전에 끊겼다");
            b.write(c);
            if (b.size() > 16384) throw new IOException("응답 머리가 너무 길다");
            state = (c == '\r' && (state == 0 || state == 2)) || (c == '\n' && (state == 1 || state == 3)) ? state + 1
                    : (c == '\r' ? 1 : 0);
        }
        return new String(b.toByteArray(), StandardCharsets.ISO_8859_1).trim();
    }

    private static int readByte(InputStream in) throws IOException {
        int c = in.read();
        if (c < 0) throw new EOFException();
        return c;
    }

    private static byte[] readFully(InputStream in, int n) throws IOException {
        byte[] b = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(b, off, n - off);
            if (r < 0) throw new EOFException();
            off += r;
        }
        return b;
    }
}
