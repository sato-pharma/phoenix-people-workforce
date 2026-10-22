package com.hmdm.plugins.phoenix.security;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.RSAPublicKeySpec;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Decides whether a Cloudflare Access pass (the `Cf-Access-Jwt-Assertion` token) is genuine.
 *
 * 🔴 WHY THE SERVER CHECKS IT AT ALL, WHEN CLOUDFLARE ALREADY DID. Access stands in front of a
 * hostname only for traffic that comes THROUGH Cloudflare. This server is published by Railway, whose
 * edge answers anyone who connects to it directly with the console's name — the same connection
 * `.github/workflows/origin-certificate-check.yml` makes every day — and that path never meets
 * Cloudflare. A console "behind Access" with no check here is a console with a side door. Cloudflare's
 * own guidance is to validate this token at the origin; this is that check (owner, 2026-10-22: shut the
 * back door at the server).
 *
 * What makes a pass genuine — every one of these, or it is refused:
 *   - three parts, header `alg` RS256 (nothing else, so `none` and HMAC tricks are dead on arrival);
 *   - signed by a key Cloudflare publishes for THIS team, at https://<team>/cdn-cgi/access/certs;
 *   - `iss` is exactly https://<team>;
 *   - `aud` names THIS Access application's audience tag — a pass for another app on the same team
 *     (the MeshCentral one, say) does not open this console;
 *   - `exp` in the future and `nbf` (when present) in the past, with one minute of clock slack.
 *
 * Pure logic, no servlet types, so `AccessVerifierCheck.java` exercises it at image build with keys it
 * generates itself.
 */
public final class AccessTokenVerifier {

    /** Where the signing keys come from. Production fetches Cloudflare's list; the build check hands its own. */
    public interface KeySource {
        Map<String, PublicKey> fetch() throws Exception;
    }

    static final long CLOCK_SLACK_SECONDS = 60;
    static final long REFETCH_FLOOR_MILLIS = 60_000;
    static final long KEY_LIFETIME_MILLIS = 6L * 60 * 60 * 1000;

    private static final Pattern TEAM_DOMAIN = Pattern.compile("^[a-z0-9-]+\\.cloudflareaccess\\.com$");

    private final String issuer;
    private final String audience;
    private final KeySource keySource;
    private volatile Map<String, PublicKey> keys = Collections.emptyMap();
    private volatile long fetchedAt;

    public AccessTokenVerifier(String teamDomain, String audience, KeySource keySource) {
        if (!isTeamDomain(teamDomain)) throw new IllegalArgumentException("not a Cloudflare Access team domain: " + teamDomain);
        if (audience == null || audience.trim().isEmpty()) throw new IllegalArgumentException("no Access audience tag");
        this.issuer = "https://" + teamDomain;
        this.audience = audience.trim();
        this.keySource = keySource;
    }

    public static boolean isTeamDomain(String teamDomain) {
        return teamDomain != null && TEAM_DOMAIN.matcher(teamDomain).matches();
    }

    /** True only for a genuine, current pass to THIS application. Never throws. */
    public boolean isValid(String token, long nowMillis) {
        try {
            if (token == null) return false;
            String[] parts = token.split("\\.", -1);
            if (parts.length != 3) return false;
            Map<String, Object> header = MiniJson.object(decodeText(parts[0]));
            Map<String, Object> claims = MiniJson.object(decodeText(parts[1]));
            if (!"RS256".equals(header.get("alg"))) return false;
            Object kid = header.get("kid");
            if (!(kid instanceof String)) return false;

            PublicKey key = keyFor((String) kid, nowMillis);
            if (key == null) return false;
            Signature rsa = Signature.getInstance("SHA256withRSA");
            rsa.initVerify(key);
            rsa.update((parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
            if (!rsa.verify(Base64.getUrlDecoder().decode(parts[2]))) return false;

            if (!issuer.equals(claims.get("iss"))) return false;
            if (!hasAudience(claims.get("aud"))) return false;
            long now = nowMillis / 1000;
            Object exp = claims.get("exp");
            if (!(exp instanceof Double) || ((Double) exp).longValue() + CLOCK_SLACK_SECONDS < now) return false;
            Object nbf = claims.get("nbf");
            if (nbf != null && (!(nbf instanceof Double) || ((Double) nbf).longValue() - CLOCK_SLACK_SECONDS > now)) return false;
            return true;
        } catch (Exception refused) {
            return false;
        }
    }

    private boolean hasAudience(Object aud) {
        if (aud instanceof String) return audience.equals(aud);
        if (aud instanceof List) {
            for (Object one : (List<?>) aud) {
                if (audience.equals(one)) return true;
            }
        }
        return false;
    }

    /**
     * A known key, or one fetch to learn a new one. Cloudflare rotates its keys, so an unknown `kid`
     * triggers a refetch — but at most once a minute, so a stream of forged tokens with made-up ids
     * cannot turn this server into a load generator against Cloudflare.
     */
    private PublicKey keyFor(String kid, long nowMillis) {
        PublicKey key = keys.get(kid);
        boolean stale = nowMillis - fetchedAt > KEY_LIFETIME_MILLIS;
        if (key != null && !stale) return key;
        synchronized (this) {
            key = keys.get(kid);
            stale = nowMillis - fetchedAt > KEY_LIFETIME_MILLIS;
            if ((key == null || stale) && nowMillis - fetchedAt > REFETCH_FLOOR_MILLIS) {
                fetchedAt = nowMillis;
                try {
                    keys = Collections.unmodifiableMap(new HashMap<>(keySource.fetch()));
                } catch (Exception unreachable) {
                    // Keep the keys already held: Cloudflare briefly unreachable must not lock out a pass
                    // signed by a key this server has already seen.
                }
                key = keys.get(kid);
            }
        }
        return key;
    }

    private static String decodeText(String part) {
        return new String(Base64.getUrlDecoder().decode(part), StandardCharsets.UTF_8);
    }

    /** Cloudflare's published key list for a team, as kid → RSA key. */
    public static KeySource cloudflare(final String teamDomain) {
        return new KeySource() {
            @Override
            public Map<String, PublicKey> fetch() throws Exception {
                HttpURLConnection http = (HttpURLConnection) new URL("https://" + teamDomain + "/cdn-cgi/access/certs").openConnection();
                http.setConnectTimeout(5000);
                http.setReadTimeout(5000);
                http.setInstanceFollowRedirects(false);
                if (http.getResponseCode() != 200) throw new IllegalStateException("certs answered " + http.getResponseCode());
                String body;
                try (InputStream in = http.getInputStream()) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buffer = new byte[8192];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                        if (out.size() > 256 * 1024) throw new IllegalStateException("certs reply too large");
                    }
                    body = new String(out.toByteArray(), StandardCharsets.UTF_8);
                }
                return parseKeys(body);
            }
        };
    }

    /** Reads `{"keys":[{"kid","kty":"RSA","n","e"},…]}` into kid → key; anything else in the reply is ignored. */
    public static Map<String, PublicKey> parseKeys(String json) throws Exception {
        Map<String, PublicKey> out = new HashMap<>();
        Object list = MiniJson.object(json).get("keys");
        if (!(list instanceof List)) return out;
        KeyFactory rsa = KeyFactory.getInstance("RSA");
        for (Object entry : (List<?>) list) {
            if (!(entry instanceof Map)) continue;
            Map<?, ?> jwk = (Map<?, ?>) entry;
            Object kid = jwk.get("kid");
            Object n = jwk.get("n");
            Object e = jwk.get("e");
            if (!"RSA".equals(jwk.get("kty")) || !(kid instanceof String) || !(n instanceof String) || !(e instanceof String)) continue;
            BigInteger modulus = new BigInteger(1, Base64.getUrlDecoder().decode((String) n));
            BigInteger exponent = new BigInteger(1, Base64.getUrlDecoder().decode((String) e));
            out.put((String) kid, rsa.generatePublic(new RSAPublicKeySpec(modulus, exponent)));
        }
        return out;
    }
}
