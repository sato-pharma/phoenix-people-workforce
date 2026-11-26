package com.hmdm.plugins.phoenix.rest;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;

import javax.inject.Inject;
import javax.inject.Singleton;
import javax.ws.rs.Consumes;
import javax.ws.rs.PUT;
import javax.ws.rs.Path;
import javax.ws.rs.PathParam;
import javax.ws.rs.Produces;
import javax.ws.rs.core.MediaType;
import javax.ws.rs.core.Response;

import com.hmdm.plugins.phoenix.PhoenixLocationStore;
import com.hmdm.plugins.phoenix.security.MiniJson;

/**
 * Where the tablet uploads the positions it took — the path the launcher already PUTs to, which the
 * free server answered with 404 until 26 Nov 2026.
 *
 * 🔴 THE PATH AND THE BODY ARE THE LAUNCHER'S, NOT OURS. `ServerService.sendLocations` declares
 * `PUT {project}/rest/plugins/devicelocations/public/update/{number}` with a JSON array of
 * `LocationTable.Location`, which Retrofit's Jackson converter writes from its getters as
 * `{"id": …, "ts": <epoch ms>, "lat": …, "lon": …}` (`SendLocationsTask` in our launcher build fills
 * it; the source of both classes is the public h-mdm/hmdm-android, and the strings `SendLocationsTask`
 * and `devicelocations/public/update/{number}` were read from the 6.51 APK's classes.dex). The task
 * deletes the rows it sent only on a 2xx, so an answer here that is not 2xx keeps them on the tablet
 * for the 24 hours its `deleteOldItems` allows.
 *
 * 🔴 UNAUTHENTICATED, BECAUSE THE LAUNCHER SENDS NO TOKEN — exactly like `DeviceResetConfirmResource`.
 * So what reaches the table is bounded instead: the device number must be one the server enrolled
 * (`isKnownDevice`), a body over `MAX_BODY_BYTES` or `MAX_FIXES` is cut, and a position that cannot be
 * real — off the globe, 0/0, dated more than a day ahead or older than `MAX_AGE_DAYS` — is dropped. A
 * stranger who knows a printed device number can still add made-up positions for it. Phoenix labels
 * these rows as the tablet's own upload, never as a verified place.
 *
 * 🔴 THE ANSWER IS `{"status":"OK"}` WHENEVER THE BODY COULD BE READ, EVEN WHEN NOTHING WAS KEPT — a
 * refusal would make a real tablet re-send the same rows for a day, and a forged call learns nothing
 * from either answer. Only an unreadable body (400) or a database failure (500) is not OK; the second
 * keeps the rows on the tablet, which is the point.
 */
@Singleton
@Path("/plugins/devicelocations")
public class DeviceLocationsResource {

    private static final Logger LOGGER = Logger.getLogger(DeviceLocationsResource.class.getName());

    /** The largest body read. A day of fixes every 15 minutes is under 10 KB. */
    static final int MAX_BODY_BYTES = 512 * 1024;

    /** The most positions kept from one upload. */
    static final int MAX_FIXES = 2000;

    /** A position older than this is not kept. The launcher itself keeps one day. */
    static final int MAX_AGE_DAYS = 30;

    private final PhoenixLocationStore store;

    @Inject
    public DeviceLocationsResource(PhoenixLocationStore store) {
        this.store = store;
    }

    @PUT
    @Path("/public/update/{number}")
    @Consumes({MediaType.APPLICATION_JSON, MediaType.WILDCARD})
    @Produces(MediaType.APPLICATION_JSON)
    public Response update(@PathParam("number") String number, InputStream body) {
        if (number == null || number.trim().isEmpty() || number.length() > 128) {
            return Response.status(400).build();
        }
        String deviceNumber = number.trim();

        Object parsed;
        try {
            parsed = MiniJson.parse(readCapped(body));
        } catch (IllegalArgumentException | IOException | StackOverflowError unreadable) {
            LOGGER.log(Level.WARNING, "Phoenix location upload for " + deviceNumber + " was not readable JSON: "
                + unreadable.getClass().getSimpleName());
            return Response.status(400).build();
        }

        List<PhoenixLocationStore.Fix> fixes = fixesFrom(parsed, System.currentTimeMillis());
        try {
            if (!fixes.isEmpty()) {
                if (!store.isKnownDevice(deviceNumber)) {
                    LOGGER.log(Level.WARNING, "Phoenix location upload for " + deviceNumber
                        + " dropped: no enrolled tablet has that number.");
                } else {
                    int added = store.save(deviceNumber, fixes);
                    LOGGER.info("Phoenix location upload: " + deviceNumber + " sent " + fixes.size()
                        + " position(s), " + added + " new.");
                }
            }
        } catch (Exception exception) {
            LOGGER.log(Level.WARNING, "Phoenix location upload for " + deviceNumber + " could not be stored", exception);
            return Response.serverError().build();
        }

        Map<String, Object> answer = new HashMap<>();
        answer.put("status", "OK");
        return Response.ok(answer).build();
    }

    /**
     * The real positions in an upload. Accepts the launcher's array, or a single object of the same shape.
     * Package-private so the shape rules are readable beside the endpoint.
     */
    static List<PhoenixLocationStore.Fix> fixesFrom(Object parsed, long nowMs) {
        List<Object> items = new ArrayList<>();
        if (parsed instanceof List) {
            items.addAll((List<?>) parsed);
        } else if (parsed instanceof Map) {
            items.add(parsed);
        }
        long newest = nowMs + 24L * 60L * 60L * 1000L;
        long oldest = nowMs - MAX_AGE_DAYS * 24L * 60L * 60L * 1000L;
        List<PhoenixLocationStore.Fix> fixes = new ArrayList<>();
        for (Object item : items) {
            if (fixes.size() >= MAX_FIXES) break;
            if (!(item instanceof Map)) continue;
            Map<?, ?> row = (Map<?, ?>) item;
            Double lat = number(row.get("lat"), row.get("latitude"));
            Double lon = number(row.get("lon"), row.get("longitude"));
            Double ts = number(row.get("ts"), row.get("time"));
            if (lat == null || lon == null || ts == null) continue;
            if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
            // 🔴 A ZERO PAIR IS NULL ISLAND, NOT A PLACE — the same rule as Phoenix's own `asCoordinate`.
            if (lat == 0 && lon == 0) continue;
            // A number below 10^12 is seconds, not milliseconds — the same rule as `asMoment`.
            long recordedAtMs = ts < 1_000_000_000_000d ? (long) (ts * 1000d) : ts.longValue();
            if (recordedAtMs < oldest || recordedAtMs > newest) continue;
            fixes.add(new PhoenixLocationStore.Fix(recordedAtMs, lat, lon));
        }
        return fixes;
    }

    private static Double number(Object first, Object second) {
        Object value = first != null ? first : second;
        if (!(value instanceof Double)) return null;
        Double number = (Double) value;
        return number.isNaN() || number.isInfinite() ? null : number;
    }

    /** The body as text, refused past `MAX_BODY_BYTES` — so an endless upload cannot fill the heap. */
    private static String readCapped(InputStream body) throws IOException {
        if (body == null) throw new IOException("no body");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = body.read(buffer)) != -1) {
            if (out.size() + read > MAX_BODY_BYTES) throw new IOException("body over " + MAX_BODY_BYTES + " bytes");
            out.write(buffer, 0, read);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
}
