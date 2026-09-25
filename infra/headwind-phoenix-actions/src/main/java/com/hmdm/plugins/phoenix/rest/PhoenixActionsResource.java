package com.hmdm.plugins.phoenix.rest;

import java.util.HashMap;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;

import javax.inject.Inject;
import javax.inject.Singleton;
import javax.ws.rs.Consumes;
import javax.ws.rs.GET;
import javax.ws.rs.POST;
import javax.ws.rs.Path;
import javax.ws.rs.Produces;
import javax.ws.rs.core.MediaType;
import javax.ws.rs.core.Response;

import com.hmdm.plugins.phoenix.PhoenixActionStore;

/**
 * What Phoenix calls to queue an instruction.
 *
 * 🔴 THE PATH IS PART OF A THREE-WAY CONTRACT. `/plugins/phoenix-actions` here must match the plugin
 * id in `PhoenixPluginConfigurationImpl` and the filter path in `PhoenixRestModule`. Change one and
 * the other two answer 404 — which looks exactly like an add-on that never loaded, and sends the
 * next reader to the wrong place entirely.
 *
 * Reachable only through the JWT, Auth and private-IP filters registered in `PhoenixRestModule`, with
 * the console itself behind Cloudflare Access. The tablet's own confirmations are a separate,
 * deliberately unauthenticated resource — see `DeviceResetConfirmResource`.
 */
@Singleton
@Path("/plugins/phoenix-actions")
public class PhoenixActionsResource {

    private static final Logger LOGGER = Logger.getLogger(PhoenixActionsResource.class.getName());

    private final PhoenixActionStore store;

    @Inject
    public PhoenixActionsResource(PhoenixActionStore store) {
        this.store = store;
    }

    /**
     * Is the add-on here?
     *
     * 🔴 PHOENIX ASKS THIS BEFORE DRAWING FOUR BUTTONS. A box rebuilt without the add-on answers 404,
     * and Phoenix then refuses those actions in words rather than offering a control that cannot work.
     */
    @GET
    @Path("/private/status")
    @Produces(MediaType.APPLICATION_JSON)
    public Response status() {
        Map<String, Object> body = new HashMap<>();
        body.put("ready", true);
        body.put("actions", new String[] {
            PhoenixActionStore.LOCK,
            PhoenixActionStore.UNLOCK,
            PhoenixActionStore.LOST_MODE_ON,
            PhoenixActionStore.LOST_MODE_OFF,
            PhoenixActionStore.FACTORY_RESET,
            PhoenixActionStore.PASSWORD_RESET,
            PhoenixActionStore.REBOOT,
        });
        return Response.ok(body).build();
    }

    /** Queue one instruction for one tablet. */
    @POST
    @Path("/private/action")
    @Consumes(MediaType.APPLICATION_JSON)
    @Produces(MediaType.APPLICATION_JSON)
    public Response queue(Map<String, Object> request) {
        try {
            String deviceNumber = text(request.get("deviceNumber"));
            if (deviceNumber == null) {
                return refuse("A tablet has to be named.");
            }

            String action = resolveAction(request);
            if (action == null) {
                return refuse("Nothing in that request names an action this add-on carries.");
            }

            long id = store.queue(
                deviceNumber,
                action,
                text(request.get("lockMessage")),
                text(request.get("password")),
                text(request.get("requestedBy")));

            Map<String, Object> body = new HashMap<>();
            body.put("status", "OK");
            body.put("id", id);
            body.put("action", action);
            // 🔴 SAID PLAINLY IN THE RESPONSE, NOT ONLY IN A COMMENT. The instruction is queued; the
            // tablet acts at its next check-in and confirms after that.
            body.put("queued", true);
            body.put("confirmed", false);
            return Response.ok(body).build();
        } catch (Exception exception) {
            LOGGER.log(Level.SEVERE, "Phoenix action could not be queued", exception);
            return Response.serverError().build();
        }
    }

    /**
     * Phoenix sends the five agent field names rather than an action word, so one shape serves both
     * sides. `lock: true` with a message is lost mode; without one it is a plain lock.
     */
    private String resolveAction(Map<String, Object> request) {
        if (Boolean.TRUE.equals(request.get("factoryReset"))) return PhoenixActionStore.FACTORY_RESET;
        if (Boolean.TRUE.equals(request.get("passwordReset"))) return PhoenixActionStore.PASSWORD_RESET;
        if (Boolean.TRUE.equals(request.get("reboot"))) return PhoenixActionStore.REBOOT;
        Object lock = request.get("lock");
        if (Boolean.TRUE.equals(lock)) {
            return text(request.get("lockMessage")) != null
                ? PhoenixActionStore.LOST_MODE_ON
                : PhoenixActionStore.LOCK;
        }
        if (Boolean.FALSE.equals(lock)) return PhoenixActionStore.UNLOCK;
        return null;
    }

    private Response refuse(String message) {
        Map<String, Object> body = new HashMap<>();
        body.put("status", "ERROR");
        body.put("message", message);
        // Headwind's own convention: a refusal is HTTP 200 with an ERROR envelope, not a 4xx.
        return Response.ok(body).build();
    }

    private static String text(Object value) {
        if (!(value instanceof String)) return null;
        String trimmed = ((String) value).trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
