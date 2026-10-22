package com.hmdm.plugins.phoenix.guice.module;

import java.util.Arrays;
import java.util.List;

import com.google.inject.servlet.ServletModule;

import com.hmdm.plugins.phoenix.rest.DeviceResetConfirmResource;
import com.hmdm.plugins.phoenix.rest.PhoenixActionsResource;
import com.hmdm.plugins.phoenix.security.AccessGateFilter;
import com.hmdm.rest.filter.AuthFilter;
import com.hmdm.rest.filter.PrivateIPFilter;
import com.hmdm.rest.filter.PublicIPFilter;
import com.hmdm.security.jwt.JWTFilter;

/**
 * Which URLs exist, and who is allowed to reach them.
 *
 * The shape is copied from Headwind's own `MessagingRestModule`, read out of the shipped jar rather
 * than from documentation: a `ServletModule` that filters the private paths and binds the resources.
 *
 * 🔴 ONE FILTER OF HEADWIND'S FIVE IS DELIBERATELY NOT USED, AND THAT IS A DECISION, NOT AN OMISSION.
 * The stock chain is JWT → Auth → `PluginAccessFilter` → PrivateIP. `PluginAccessFilter` refuses a
 * user who lacks the per-customer permission row for the plugin — a row created by a plugin's own
 * Liquibase changelog, registering it in Headwind's `plugins` table. This add-on deliberately does
 * not write rows into Headwind's own tables (it owns exactly one table of its own, and creating it is
 * the only schema change it makes), so that filter would refuse EVERY caller including the only
 * account that exists. The remaining three still apply: a caller needs a valid JWT, an authenticated
 * console session, and a private-network source address, and the console itself sits behind
 * Cloudflare Access. The honest cost, written here rather than discovered later: any authenticated
 * Headwind user could call these, rather than only one holding a plugin permission. On a box with one
 * account that is a distinction without a difference — if a second console login is ever created,
 * this is the line to revisit.
 *
 * 🔴 THE PUBLIC PATH IS THE AGENT'S, NOT OURS. `/rest/plugins/devicereset/public/*` is where the stock
 * tablet agent POSTs after it wipes, reboots or clears a screen lock. The open-source server does not
 * serve it, so it 404s today. Serving it is what turns "sent" into "witnessed". It carries only
 * `PublicIPFilter`, because the agent posts these without a token — that is the agent's design, and
 * the worst an anonymous caller can do is close a row early for a device number it already knows.
 */
public class PhoenixRestModule extends ServletModule {

    /**
     * 🔴 THE PLUGIN ID IS REPEATED HERE AS A LITERAL BECAUSE A SERVLET PATH CANNOT BE COMPUTED FROM A
     * CONSTANT AT MODULE-CONFIGURATION TIME WITHOUT HIDING IT. It must stay identical to
     * `PhoenixPluginConfigurationImpl.PLUGIN_ID` and to the `@Path` on `PhoenixActionsResource`. All
     * three are pinned together by the repository's own test, so a drift is caught before it ships.
     */
    private static final List<String> PROTECTED_RESOURCES =
        Arrays.asList("/rest/plugins/phoenix-actions/private/*");

    private static final List<String> PUBLIC_RESOURCES =
        Arrays.asList("/rest/plugins/devicereset/public/*");

    @Override
    protected void configureServlets() {
        // 🔴 FIRST, AND ON EVERY PATH: the console hostname needs a Cloudflare Access pass once
        // PHX_ACCESS_TEAM_DOMAIN and PHX_ACCESS_AUD are set (AccessGateFilter says why the server checks
        // what Cloudflare already did). Every other hostname passes straight through, so the tablets
        // never meet it. Headwind maps GuiceFilter to /*, so this sees the console pages and the API alike.
        filter("/*").through(AccessGateFilter.class);

        filter(PROTECTED_RESOURCES).through(JWTFilter.class);
        filter(PROTECTED_RESOURCES).through(AuthFilter.class);
        filter(PROTECTED_RESOURCES).through(PrivateIPFilter.class);

        filter(PUBLIC_RESOURCES).through(PublicIPFilter.class);

        bind(PhoenixActionsResource.class);
        bind(DeviceResetConfirmResource.class);
    }
}
