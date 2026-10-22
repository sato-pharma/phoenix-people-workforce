import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.RSAPublicKey;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import com.hmdm.plugins.phoenix.security.AccessTokenVerifier;

/**
 * Build-time proof that AccessTokenVerifier accepts a genuine Cloudflare Access pass and refuses every
 * forgery that matters — run in the Dockerfile's build stage against the compiled classes, so a verifier
 * that lets a forged pass through fails the IMAGE, never the console.
 *
 * It signs its own passes with keys it generates, publishes them the way Cloudflare does (a JWKS list,
 * read back through AccessTokenVerifier.parseKeys), and checks each case. There is no network here.
 */
public class AccessVerifierCheck {

  static final String TEAM = "curly-violet-4187.cloudflareaccess.com";
  static final String AUD = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();

  static String b64(String text) {
    return B64.encodeToString(text.getBytes(StandardCharsets.UTF_8));
  }

  static String b64(BigInteger value) {
    byte[] bytes = value.toByteArray();
    if (bytes.length > 1 && bytes[0] == 0) {
      byte[] trimmed = new byte[bytes.length - 1];
      System.arraycopy(bytes, 1, trimmed, 0, trimmed.length);
      bytes = trimmed;
    }
    return B64.encodeToString(bytes);
  }

  static String token(String header, String claims, PrivateKey key) throws Exception {
    String signed = b64(header) + "." + b64(claims);
    Signature rsa = Signature.getInstance("SHA256withRSA");
    rsa.initSign(key);
    rsa.update(signed.getBytes(StandardCharsets.US_ASCII));
    return signed + "." + B64.encodeToString(rsa.sign());
  }

  static String claims(String iss, String aud, long exp, Long nbf) {
    return "{\"iss\":\"" + iss + "\",\"aud\":" + aud + ",\"exp\":" + exp + (nbf == null ? "" : ",\"nbf\":" + nbf)
        + ",\"email\":\"owner@satopharma.com\",\"type\":\"app\"}";
  }

  public static void main(String[] args) throws Exception {
    KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
    generator.initialize(2048);
    KeyPair real = generator.generateKeyPair();
    KeyPair stranger = generator.generateKeyPair();

    RSAPublicKey pub = (RSAPublicKey) real.getPublic();
    String jwks = "{\"keys\":[{\"kid\":\"k1\",\"kty\":\"RSA\",\"alg\":\"RS256\",\"use\":\"sig\",\"e\":\""
        + b64(pub.getPublicExponent()) + "\",\"n\":\"" + b64(pub.getModulus()) + "\"}],"
        + "\"public_cert\":{\"kid\":\"k1\",\"cert\":\"ignored\"}}";
    final Map<String, PublicKey> published = AccessTokenVerifier.parseKeys(jwks);
    if (published.size() != 1 || !published.containsKey("k1")) {
      throw new IllegalStateException("parseKeys did not read Cloudflare's key list shape: " + published.keySet());
    }

    final int[] fetches = {0};
    AccessTokenVerifier verifier = new AccessTokenVerifier(TEAM, AUD, () -> {
      fetches[0]++;
      return published;
    });

    long now = System.currentTimeMillis();
    long nowS = now / 1000;
    String iss = "https://" + TEAM;
    String rs = "{\"alg\":\"RS256\",\"kid\":\"k1\",\"typ\":\"JWT\"}";
    PrivateKey key = real.getPrivate();

    List<String> wrong = new ArrayList<>();
    expect(wrong, verifier, now, true, "a genuine pass", token(rs, claims(iss, "[\"" + AUD + "\"]", nowS + 600, nowS - 5), key));
    expect(wrong, verifier, now, true, "a genuine pass with aud as a plain string", token(rs, claims(iss, "\"" + AUD + "\"", nowS + 600, null), key));
    expect(wrong, verifier, now, true, "a pass inside the one-minute clock slack", token(rs, claims(iss, "[\"" + AUD + "\"]", nowS - 30, null), key));
    expect(wrong, verifier, now, false, "a pass for ANOTHER Access app on the same team", token(rs, claims(iss, "[\"another-app-aud\"]", nowS + 600, null), key));
    expect(wrong, verifier, now, false, "an expired pass", token(rs, claims(iss, "[\"" + AUD + "\"]", nowS - 600, null), key));
    expect(wrong, verifier, now, false, "a pass not valid yet", token(rs, claims(iss, "[\"" + AUD + "\"]", nowS + 600, nowS + 600), key));
    expect(wrong, verifier, now, false, "a pass from another team", token(rs, claims("https://evil.cloudflareaccess.com", "[\"" + AUD + "\"]", nowS + 600, null), key));
    expect(wrong, verifier, now, false, "a pass signed by a stranger's key under the real key id", token(rs, claims(iss, "[\"" + AUD + "\"]", nowS + 600, null), stranger.getPrivate()));
    expect(wrong, verifier, now, false, "a pass naming a key Cloudflare never published", token("{\"alg\":\"RS256\",\"kid\":\"k9\"}", claims(iss, "[\"" + AUD + "\"]", nowS + 600, null), key));
    expect(wrong, verifier, now, false, "alg none", b64("{\"alg\":\"none\",\"kid\":\"k1\"}") + "." + b64(claims(iss, "[\"" + AUD + "\"]", nowS + 600, null)) + ".");
    expect(wrong, verifier, now, false, "alg HS256", token("{\"alg\":\"HS256\",\"kid\":\"k1\"}", claims(iss, "[\"" + AUD + "\"]", nowS + 600, null), key));
    String genuine = token(rs, claims(iss, "[\"" + AUD + "\"]", nowS + 600, null), key);
    String[] parts = genuine.split("\\.");
    expect(wrong, verifier, now, false, "a genuine signature over altered claims", parts[0] + "." + b64(claims(iss, "[\"" + AUD + "\"]", nowS + 99999, null)) + "." + parts[2]);
    expect(wrong, verifier, now, false, "no pass at all", null);
    expect(wrong, verifier, now, false, "garbage", "not-a-token");
    expect(wrong, verifier, now, false, "two parts", parts[0] + "." + parts[1]);

    if (fetches[0] > 2) {
      wrong.add("an unknown key id refetched the key list " + fetches[0] + " times inside one minute — the refetch floor is gone");
    }
    if (AccessTokenVerifier.isTeamDomain("curly-violet-4187.cloudflareaccess.com.evil.example")
        || AccessTokenVerifier.isTeamDomain("evil.example")
        || !AccessTokenVerifier.isTeamDomain(TEAM)) {
      wrong.add("isTeamDomain accepts a name that is not <team>.cloudflareaccess.com, or refuses the real one");
    }
    if (!wrong.isEmpty()) {
      throw new IllegalStateException("AccessTokenVerifier is wrong:\n  " + String.join("\n  ", wrong));
    }
    System.out.println("AccessVerifierCheck: the Access pass verifier accepts the genuine passes and refuses all 12 forgeries");
  }

  static void expect(List<String> wrong, AccessTokenVerifier verifier, long now, boolean valid, String what, String token) {
    if (verifier.isValid(token, now) != valid) {
      wrong.add((valid ? "REFUSED " : "ACCEPTED ") + what);
    }
  }
}
