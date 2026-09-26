package com.hmdm.plugins.phoenix.rest;

import java.util.HashMap;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;

import javax.inject.Inject;
import javax.inject.Singleton;
import javax.servlet.http.HttpServletRequest;
import javax.ws.rs.POST;
import javax.ws.rs.Path;
import javax.ws.rs.PathParam;
import javax.ws.rs.Produces;
import javax.ws.rs.core.Context;
import javax.ws.rs.core.MediaType;
import javax.ws.rs.core.Response;

import com.hmdm.plugins.phoenix.PhoenixActionStore;

/**
 * The paths the stock Headwind agent already POSTs to after it acts — and which the open-source
 * server does not serve, so they return 404 today.
 *
 * 🔴 THIS IS WHAT TURNS "SENT" INTO "WITNESSED", AND IT IS THE REASON THE ADD-ON IS WORTH BUILDING
 * RATHER THAN FAKING. Without it a console can only ever say an instruction was sent. With it, a row
 * closes when the TABLET says it acted. On a console whose buttons erase a hundred tablets, those are
 * not the same sentence, and the difference is not cosmetic: "the wipe went through" and "the wipe was
 * requested" lead to different decisions about a tablet somebody still has.
 *
 * 🔴 UNAUTHENTICATED, BECAUSE THE AGENT POSTS THESE WITHOUT A TOKEN. That is the agent's design, not a
 * hole opened here, and it cannot be closed from this side: authenticating these paths would mean
 * shipping a modified agent, and running the free agent exactly as published is the whole reason this
 * add-on exists. An anonymous caller still cannot queue an action, read one, learn a device number, or
 * reach any tablet.
 *
 * 🔴 SO THE ONE THING IT COULD DO IS CONFIRM SOMETHING THAT NEVER HAPPENED — AND THAT IS GATED ON
 * DELIVERY, WHICH IS THE POINT OF `consumed_at is not null` IN `PhoenixActionStore.confirm`. Before
 * that clause, a confirmation could close a row the tablet had never been handed: queue a wipe, and a
 * forged confirmation a second later would report it done while the tablet was still sitting in
 * somebody's bag. Now a confirmation can only close a row the sync hook has already written into a
 * real response for that device — so the worst a stranger can do is call an action done a few seconds
 * before the tablet does it. What is left is small, bounded and honest.
 *
 * 🔴 A CONFIRMATION THAT CLOSES NOTHING IS LOGGED AT WARNING, and that log line is the detection.
 * Zero rows means there was no delivered, open row of that kind — a stale retry from a tablet that
 * already reported, or a forged call. Either way the answer to the agent is still `200 OK`: refusing
 * would make a real agent retry forever, and the agent is not the party to argue with.
 *
 * 🔴 ALL THREE PATHS SIT UNDER `/plugins/devicereset/public/`, WHICH IS THE AGENT'S SPELLING AND NOT
 * THIS ADD-ON'S. It is the one place in the add-on where the URL is not ours to choose — the tablet
 * decides it, and the server either answers there or the confirmation is lost. `PhoenixRestModule`
 * registers the public filter on that same prefix for exactly this reason.
 */
@Singleton
@Path("/plugins/devicereset")
public class DeviceResetConfirmResource {

    private static final Logger LOGGER = Logger.getLogger(DeviceResetConfirmResource.class.getName());

    private final PhoenixActionStore store;

    @Inject
    public DeviceResetConfirmResource(PhoenixActionStore store) {
        this.store = store;
    }

    /** The agent says it wiped itself. In practice this rarely arrives — a wiped tablet is gone. */
    @POST
    @Path("/public/{number}")
    @Produces(MediaType.APPLICATION_JSON)
    public Response confirmReset(@PathParam("number") String number, @Context HttpServletRequest request) {
        return confirm(number, request, PhoenixActionStore.FACTORY_RESET);
    }

    /** The agent says it rebooted. */
    @POST
    @Path("/public/reboot/{number}")
    @Produces(MediaType.APPLICATION_JSON)
    public Response confirmReboot(@PathParam("number") String number, @Context HttpServletRequest request) {
        return confirm(number, request, PhoenixActionStore.REBOOT);
    }

    /** The agent says it cleared the screen lock. The stored password is dropped in the same write. */
    @POST
    @Path("/public/password/{number}")
    @Produces(MediaType.APPLICATION_JSON)
    public Response confirmPassword(@PathParam("number") String number, @Context HttpServletRequest request) {
        return confirm(number, request, PhoenixActionStore.PASSWORD_RESET);
    }

    private Response confirm(String number, HttpServletRequest request, String action) {
        try {
            if (number == null || number.isEmpty()) return Response.status(400).build();
            String source = sourceOf(request);
            int closed = store.confirm(number, source, action);
            if (closed == 0) {
                // The detection, such as it is. A real agent reaches here only on a stale retry.
                LOGGER.log(
                    Level.WARNING,
                    "Phoenix action confirmation closed nothing: " + action + " for device " + number
                        + " from " + (source == null ? "an unknown source" : source)
                        + " — no delivered, open row of that kind. A stale retry, or a forged call.");
            }
            Map<String, Object> body = new HashMap<>();
            // 🔴 ALWAYS OK, EVEN WHEN NOTHING CLOSED. The agent is not the party to argue with: a
            // refusal makes a real tablet retry forever, and a forged call learns nothing from either
            // answer. The row, or the absence of one, is the record.
            body.put("status", "OK");
            return Response.ok(body).build();
        } catch (Exception exception) {
            LOGGER.log(Level.WARNING, "Phoenix action confirmation failed for " + number, exception);
            return Response.serverError().build();
        }
    }

    /**
     * Where the confirmation came from, trimmed to the column's width.
     *
     * 🔴 `getRemoteAddr()` AND NOT `X-Forwarded-For`. A forwarded header is set by whoever is calling,
     * so trusting it here would let a forged confirmation choose what gets written next to it — which
     * is worse than recording nothing. Behind Railway's edge the real address is the edge's, so this
     * distinguishes little on the public path and a good deal on the private one. It is a note beside
     * the row, never an identity.
     */
    private static String sourceOf(HttpServletRequest request) {
        if (request == null) return null;
        String address = request.getRemoteAddr();
        if (address == null || address.isEmpty()) return null;
        return address.length() > 64 ? address.substring(0, 64) : address;
    }
}
