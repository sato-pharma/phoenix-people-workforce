package com.hmdm.plugins.phoenix;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

import javax.sql.DataSource;

/**
 * The add-on's second table: the positions a tablet uploads itself, and every statement that touches it.
 *
 * 🔴 WHY THIS TABLE EXISTS (26 Nov 2026). The Phoenix launcher (6.41 onwards) stores every fix it takes
 * in its own `locations` table and PUTs the pending rows to `/rest/plugins/devicelocations/public/update/
 * {number}`, deleting them only on a 2xx. That endpoint belongs to a premium Headwind plugin the free
 * server does not have, so every upload answered 404 — measured on PHX-TAB-0008 at 02:13 and 02:14 Cairo
 * on 26 Nov — and the tablet threw each fix away after a day (its `deleteOldItems` keeps 24 hours). The
 * `deviceinfo` history plugin, the other source Phoenix reads, has never received a single row from
 * any tablet. This table is where those uploads now land.
 *
 * 🔴 THE TIME IS STORED AS THE TABLET'S OWN EPOCH MILLISECONDS, NOT AS A `timestamp`. Headwind's
 * Postgres columns are `timestamp without time zone`, and converting the tablet's `ts` into one would
 * apply the session's zone silently — a two-hour shift on a trail is a rep placed somewhere he was not.
 * A number has no zone to get wrong; Phoenix turns it into an instant (`asMoment`, `locations.ts`).
 *
 * 🔴 THE UNIQUE INDEX IS THE RETRY GUARD. The launcher re-sends rows it has not seen a 2xx for, so the
 * same fix can arrive twice; `on conflict do nothing` keeps one.
 *
 * Plain parameterised JDBC on Headwind's own DataSource, for the reasons `PhoenixActionStore` gives:
 * the device number arrives on an unauthenticated public path, so it is attacker-controlled input.
 */
public final class PhoenixLocationStore {

    /** How long an uploaded position is kept on the tablet server. */
    public static final int KEEP_DAYS = 90;

    /** The most rows one read hands back. */
    public static final int MAX_READ = 1000;

    private final DataSource dataSource;

    public PhoenixLocationStore(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    /** One position, exactly as the tablet reported it. */
    public static final class Fix {
        public final long recordedAtMs;
        public final double lat;
        public final double lon;

        public Fix(long recordedAtMs, double lat, double lon) {
            this.recordedAtMs = recordedAtMs;
            this.lat = lat;
            this.lon = lon;
        }
    }

    /** Create the table and its two indexes if they are not there. Idempotent, run at start-up. */
    public void ensureSchema() throws SQLException {
        try (Connection connection = dataSource.getConnection();
             Statement statement = connection.createStatement()) {
            statement.execute(
                "create table if not exists phoenix_device_locations ("
                    + "id bigserial primary key,"
                    + "device_number varchar(128) not null,"
                    + "recorded_at_ms bigint not null,"
                    + "lat double precision not null,"
                    + "lon double precision not null,"
                    + "received_at timestamp not null default now())");
            statement.execute(
                "create unique index if not exists phoenix_device_locations_fix_uq"
                    + " on phoenix_device_locations (device_number, recorded_at_ms, lat, lon)");
            statement.execute(
                "create index if not exists phoenix_device_locations_recent_idx"
                    + " on phoenix_device_locations (device_number, recorded_at_ms desc)");
        }
    }

    /**
     * Is this a tablet the server enrolled?
     *
     * 🔴 AN UPLOAD FOR A NUMBER THE SERVER DOES NOT KNOW IS DROPPED. The path is public, so without this
     * a stranger could fill the table with rows for any made-up number.
     */
    public boolean isKnownDevice(String deviceNumber) throws SQLException {
        try (Connection connection = dataSource.getConnection();
             PreparedStatement statement = connection.prepareStatement("select 1 from devices where number = ?")) {
            statement.setString(1, deviceNumber);
            try (ResultSet rows = statement.executeQuery()) {
                return rows.next();
            }
        }
    }

    /**
     * Keep the positions one upload carried, then drop that tablet's rows older than `KEEP_DAYS`.
     * Returns how many rows were new.
     */
    public int save(String deviceNumber, List<Fix> fixes) throws SQLException {
        if (fixes.isEmpty()) return 0;
        String insert = "insert into phoenix_device_locations (device_number, recorded_at_ms, lat, lon)"
            + " values (?, ?, ?, ?) on conflict do nothing";
        int added = 0;
        try (Connection connection = dataSource.getConnection()) {
            try (PreparedStatement statement = connection.prepareStatement(insert)) {
                for (Fix fix : fixes) {
                    statement.setString(1, deviceNumber);
                    statement.setLong(2, fix.recordedAtMs);
                    statement.setDouble(3, fix.lat);
                    statement.setDouble(4, fix.lon);
                    statement.addBatch();
                }
                for (int count : statement.executeBatch()) {
                    if (count > 0) added += count;
                }
            }
            try (PreparedStatement statement = connection.prepareStatement(
                "delete from phoenix_device_locations where device_number = ? and recorded_at_ms < ?")) {
                statement.setString(1, deviceNumber);
                statement.setLong(2, System.currentTimeMillis() - KEEP_DAYS * 24L * 60L * 60L * 1000L);
                statement.executeUpdate();
            }
        }
        return added;
    }

    /** One tablet's positions, newest first. */
    public List<Fix> recent(String deviceNumber, int limit) throws SQLException {
        int bounded = Math.max(1, Math.min(limit, MAX_READ));
        String sql = "select recorded_at_ms, lat, lon from phoenix_device_locations"
            + " where device_number = ? order by recorded_at_ms desc limit ?";
        List<Fix> fixes = new ArrayList<>();
        try (Connection connection = dataSource.getConnection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, deviceNumber);
            statement.setInt(2, bounded);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    fixes.add(new Fix(rows.getLong("recorded_at_ms"), rows.getDouble("lat"), rows.getDouble("lon")));
                }
            }
        }
        return fixes;
    }

    /** How many positions the server holds for one tablet, so a read of the newest page can say "of N". */
    public long count(String deviceNumber) throws SQLException {
        try (Connection connection = dataSource.getConnection();
             PreparedStatement statement = connection.prepareStatement(
                 "select count(*) from phoenix_device_locations where device_number = ?")) {
            statement.setString(1, deviceNumber);
            try (ResultSet rows = statement.executeQuery()) {
                return rows.next() ? rows.getLong(1) : 0L;
            }
        }
    }
}
