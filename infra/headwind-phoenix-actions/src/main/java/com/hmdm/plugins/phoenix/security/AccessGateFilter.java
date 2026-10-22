package com.hmdm.plugins.phoenix.security;

import java.io.IOException;
import java.util.logging.Level;
import java.util.logging.Logger;

import javax.inject.Singleton;
import javax.servlet.Filter;
import javax.servlet.FilterChain;
import javax.servlet.FilterConfig;
import javax.servlet.ServletException;
import javax.servlet.ServletRequest;
import javax.servlet.ServletResponse;
import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * Every request to the console's hostname must carry a genuine Cloudflare Access pass — once Access is
 * configured here. Every other hostname passes straight through.
 *
 * 🔴 THE HOST TEST IS `request.getServerName()`, THE SAME VALUE `rewrite.config` TESTS AS %{HTTP_HOST}
 * (Tomcat's ResolverImpl resolves that variable to getServerName()). The two must agree on which
 * requests are the console's: the rewrite lets the console and private API through only on
 * mdm-console.satopharma.com, and this filter demands the Access pass on exactly those. A request that
 * fakes the Host header to reach the console therefore meets this check; a request on any other name
 * meets the rewrite's tablet-only allowlist. There is no third way in.
 *
 * 🔴 THREE STATES, READ ONCE AT START FROM TWO SERVICE VARIABLES on `phoenix-headwind`:
 *   PHX_ACCESS_TEAM_DOMAIN   the Zero Trust team, e.g. curly-violet-4187.cloudflareaccess.com
 *   PHX_ACCESS_AUD           the console Access application's "Application Audience (AUD) Tag"
 *   - neither set: Access is not configured yet, and the console behaves exactly as it did before this
 *     filter existed. Logged at WARNING on every start, so the gap is never silent.
 *   - one set: a half-done setup. Every console request is REFUSED until the other is set, because
 *     guessing either way is worse — open would look protected, and the error names the missing half.
 *   - both set: the pass is checked on every console request (AccessTokenVerifier says how).
 *
 * The tablets never touch this hostname, so nothing here can reach the fleet. Phoenix's own calls carry
 * an Access service token (`HEADWIND_MDM_ACCESS_CLIENT_ID`/`_SECRET`), for which Cloudflare issues the
 * same signed pass.
 */
@Singleton
public class AccessGateFilter implements Filter {

    private static final Logger LOGGER = Logger.getLogger(AccessGateFilter.class.getName());

    /** Must stay identical to the hostname in rewrite.config's RewriteCond. Pinned together by the repository's test. */
    static final String CONSOLE_HOST = "mdm-console.satopharma.com";

    static final String PASS_HEADER = "Cf-Access-Jwt-Assertion";
    static final String PASS_COOKIE = "CF_Authorization";

    private enum Mode { NOT_CONFIGURED, MISCONFIGURED, ENFORCING }

    private Mode mode = Mode.NOT_CONFIGURED;
    private AccessTokenVerifier verifier;

    @Override
    public void init(FilterConfig filterConfig) {
        String team = trimmed(System.getenv("PHX_ACCESS_TEAM_DOMAIN"));
        String aud = trimmed(System.getenv("PHX_ACCESS_AUD"));
        if (team == null && aud == null) {
            mode = Mode.NOT_CONFIGURED;
            LOGGER.warning("Access gate OFF: PHX_ACCESS_TEAM_DOMAIN and PHX_ACCESS_AUD are not set, so " + CONSOLE_HOST
                + " is NOT checked for a Cloudflare Access pass and anyone who reaches it directly meets only the console password.");
            return;
        }
        if (team == null || aud == null || !AccessTokenVerifier.isTeamDomain(team)) {
            mode = Mode.MISCONFIGURED;
            LOGGER.severe("Access gate REFUSING every " + CONSOLE_HOST + " request: "
                + (team == null ? "PHX_ACCESS_TEAM_DOMAIN is not set"
                    : aud == null ? "PHX_ACCESS_AUD is not set"
                    : "PHX_ACCESS_TEAM_DOMAIN is not a <team>.cloudflareaccess.com name"));
            return;
        }
        verifier = new AccessTokenVerifier(team, aud, AccessTokenVerifier.cloudflare(team));
        mode = Mode.ENFORCING;
        LOGGER.info("Access gate ON: every " + CONSOLE_HOST + " request needs a Cloudflare Access pass for team " + team);
    }

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain) throws IOException, ServletException {
        if (!(request instanceof HttpServletRequest) || !isConsoleHost(request.getServerName()) || mode == Mode.NOT_CONFIGURED) {
            chain.doFilter(request, response);
            return;
        }
        HttpServletRequest http = (HttpServletRequest) request;
        if (mode == Mode.ENFORCING && verifier.isValid(passOf(http), System.currentTimeMillis())) {
            chain.doFilter(request, response);
            return;
        }
        LOGGER.log(Level.WARNING, "Access gate refused {0} {1}: {2}", new Object[] {
            http.getMethod(), http.getRequestURI(), mode == Mode.ENFORCING ? "no valid Access pass" : "the gate is half-configured",
        });
        HttpServletResponse out = (HttpServletResponse) response;
        out.setStatus(HttpServletResponse.SC_FORBIDDEN);
        out.setContentType("text/plain; charset=utf-8");
        out.getWriter().write("This address needs a Cloudflare Access sign-in.");
    }

    @Override
    public void destroy() {
    }

    static boolean isConsoleHost(String serverName) {
        return serverName != null && CONSOLE_HOST.equalsIgnoreCase(serverName);
    }

    private static String passOf(HttpServletRequest request) {
        String header = request.getHeader(PASS_HEADER);
        if (header != null && !header.isEmpty()) return header;
        Cookie[] cookies = request.getCookies();
        if (cookies == null) return null;
        for (Cookie cookie : cookies) {
            if (PASS_COOKIE.equals(cookie.getName())) return cookie.getValue();
        }
        return null;
    }

    private static String trimmed(String value) {
        if (value == null) return null;
        String out = value.trim();
        return out.isEmpty() ? null : out;
    }
}
