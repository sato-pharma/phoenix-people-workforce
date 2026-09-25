package com.satopharma.phoenix.headwind;

import java.util.HashMap;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;

import javax.inject.Inject;
import javax.inject.Singleton;
import javax.ws.rs.POST;
import javax.ws.rs.Path;
import javax.ws.rs.PathParam;
import javax.ws.rs.Produces;
import javax.ws.rs.core.MediaType;
import javax.ws.rs.core.Response;

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
 * hole opened here. Bounded on purpose: an anonymous caller can only close a row that is already open
 * for a device number it already knows. It cannot queue an action, read one, learn a device number, or
 * reach any tablet. The cost of a misuse is a row marked confirmed early — which shows up as a console
 * that believes a wipe landed. So the console still shows the tablet's own last check-in time beside
 * it, and a confirmation without a check-in is visible as the odd thing it is.
 *
 * 🔴 BOTH SPELLINGS ARE SERVED, AND THAT IS DELIBERATE RATHER THAN CARELESS. The agent's exact paths
 * for reboot and password could not be pinned from source with the certainty the factory-reset one
 * could — `/rest/plugins/devicereset/public/reboot/{number}` and a sibling `/rest/plugins/reboot/...`
 * are both plausible readings. Serving both costs nothing and removes a silent failure where the
 * tablet confirms into a 404 and the row never closes. When the pilot shows which one arrives, the
 * other can go.
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
    public Response confirmReset(@PathParam("number") String number) {
        return confirm(number, PhoenixActionStore.FACTORY_RESET);
    }

    /** The agent says it rebooted. */
    @POST
    @Path("/public/reboot/{number}")
    @Produces(MediaType.APPLICATION_JSON)
    public Response confirmReboot(@PathParam("number") String number) {
        return confirm(number, PhoenixActionStore.REBOOT);
    }

    /** The agent says it cleared the screen lock. The stored password is dropped in the same write. */
    @POST
    @Path("/public/password/{number}")
    @Produces(MediaType.APPLICATION_JSON)
    public Response confirmPassword(@PathParam("number") String number) {
        return confirm(number, PhoenixActionStore.PASSWORD_RESET);
    }

    private Response confirm(String number, String action) {
        try {
            if (number == null || number.isEmpty()) return Response.status(400).build();
            store.confirm(number, action);
            Map<String, Object> body = new HashMap<>();
            body.put("status", "OK");
            return Response.ok(body).build();
        } catch (Exception exception) {
            LOGGER.log(Level.WARNING, "Phoenix action confirmation failed for " + number, exception);
            return Response.serverError().build();
        }
    }
}
