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
 * The one table this add-on owns, and every statement that touches it.
 *
 * 🔴 PLAIN JDBC ON HEADWIND'S OWN DATASOURCE, DELIBERATELY. Headwind uses MyBatis with mappers
 * registered through its Guice modules; adding a mapper means joining that wiring, which is the part
 * of this add-on most likely to need a correction on the first build. Fewer things to wire is fewer
 * things that fail silently — and this is five statements, not an ORM's worth of work.
 *
 * 🔴 EVERY STATEMENT IS PARAMETERISED. A device number arrives from the tablet's own sync request,
 * which is an UNAUTHENTICATED public endpoint — it is attacker-controlled input by definition, and
 * concatenating it into SQL on the server that can wipe a hundred tablets is not a thing to get
 * almost right.
 *
 * 🔴 THE TABLE KEYS ON THE DEVICE NUMBER, BUT THE HOOK ONLY KNOWS THE NUMERIC ID, SO THE READ JOINS.
 * Phoenix speaks device NUMBERS — that is what Headwind's REST API exposes and what a person reads on
 * a tablet's label. `SyncResponseHook.handle` is handed `int deviceId`, the primary key of Headwind's
 * own `devices` row, and — measured, not assumed — `SyncResponseInt` has NO `getDeviceId()` to
 * recover the number from. So the two reads below join `devices` on its primary key, which is exactly
 * one row, so the join can never multiply the result. Columns confirmed from Headwind's own
 * `DeviceMapper.xml`: `devices.id` and `devices.number`.
 */
public final class PhoenixActionStore {

    public static final String LOCK = "lock";
    public static final String UNLOCK = "unlock";
    public static final String LOST_MODE_ON = "lost_mode_on";
    public static final String LOST_MODE_OFF = "lost_mode_off";
    public static final String FACTORY_RESET = "factory_reset";
    public static final String PASSWORD_RESET = "password_reset";
    public static final String REBOOT = "reboot";

    private final DataSource dataSource;

    public PhoenixActionStore(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    /** One waiting instruction. */
    public static final class PendingAction {
        public final long id;
        public final String action;
        public final String message;
        public final String password;

        PendingAction(long id, String action, String message, String password) {
            this.id = id;
            this.action = action;
            this.message = message;
            this.password = password;
        }
    }

    /**
     * Create the table if it is not there.
     *
     * Idempotent, and run at start-up rather than by a migration tool, because this add-on ships
     * inside the Headwind image and has no migration runner of its own.
     */
    public void ensureSchema() throws SQLException {
        try (Connection connection = dataSource.getConnection();
             Statement statement = connection.createStatement()) {
            statement.execute(
                "create table if not exists phoenix_pending_actions ("
                    + "id bigserial primary key,"
                    + "device_number varchar(128) not null,"
                    + "action varchar(32) not null,"
                    + "message text,"
                    + "password text,"
                    + "requested_by varchar(128),"
                    + "created_at timestamp not null default now(),"
                    + "consumed_at timestamp,"
                    + "confirmed_at timestamp)");
            statement.execute(
                "create index if not exists phoenix_pending_actions_open_idx"
                    + " on phoenix_pending_actions (device_number) where confirmed_at is null");
        }
    }

    /** Queue an instruction for a tablet. */
    public long queue(String deviceNumber, String action, String message, String password, String requestedBy)
            throws SQLException {
        String sql = "insert into phoenix_pending_actions"
            + " (device_number, action, message, password, requested_by)"
            + " values (?, ?, ?, ?, ?) returning id";
        try (Connection connection = dataSource.getConnection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, deviceNumber);
            statement.setString(2, action);
            statement.setString(3, message);
            statement.setString(4, password);
            statement.setString(5, requestedBy);
            try (ResultSet rows = statement.executeQuery()) {
                return rows.next() ? rows.getLong(1) : -1L;
            }
        }
    }

    /**
     * What a tablet should be told at this check-in, found by Headwind's own numeric device id.
     *
     * 🔴 ORDERED OLDEST FIRST, AND EVERY OPEN ROW IS RETURNED, NOT JUST THE LATEST. "Lock it" then
     * "wipe it" must not become "wipe it" alone, and "lock" then "unlock" must resolve in the order a
     * person pressed them. The hook folds them in that order; the last word wins, which is what a
     * person pressing two buttons expects.
     */
    public List<PendingAction> openFor(int deviceId) throws SQLException {
        String sql = "select a.id, a.action, a.message, a.password"
            + " from phoenix_pending_actions a"
            + " join devices d on d.number = a.device_number"
            + " where d.id = ? and a.confirmed_at is null"
            + " order by a.id asc";
        List<PendingAction> pending = new ArrayList<>();
        try (Connection connection = dataSource.getConnection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setInt(1, deviceId);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    pending.add(new PendingAction(
                        rows.getLong("id"),
                        rows.getString("action"),
                        rows.getString("message"),
                        rows.getString("password")));
                }
            }
        }
        return pending;
    }

    /** The tablet was told. Not the same as the tablet having done it. */
    public void markConsumed(long id) throws SQLException {
        String sql = "update phoenix_pending_actions set consumed_at = now()"
            + " where id = ? and consumed_at is null";
        try (Connection connection = dataSource.getConnection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setLong(1, id);
            statement.executeUpdate();
        }
    }

    /**
     * The tablet came back and said it acted.
     *
     * 🔴 THE PASSWORD IS CLEARED IN THE SAME STATEMENT. A temporary screen-lock password that
     * outlives the reset it was for is a credential sitting in a table for no reason.
     *
     * A lock or a lost-mode message is NOT closed here: those are standing states the tablet must
     * keep being told about at every check-in, or the next sync response would drop the field and the
     * tablet would quietly unlock itself. Only the one-shot actions close.
     */
    public void confirm(String deviceNumber, String... actions) throws SQLException {
        if (actions.length == 0) return;
        StringBuilder sql = new StringBuilder(
            "update phoenix_pending_actions set confirmed_at = now(), password = null"
                + " where device_number = ? and confirmed_at is null and action in (");
        for (int index = 0; index < actions.length; index++) {
            sql.append(index == 0 ? "?" : ", ?");
        }
        sql.append(")");
        try (Connection connection = dataSource.getConnection();
             PreparedStatement statement = connection.prepareStatement(sql.toString())) {
            statement.setString(1, deviceNumber);
            for (int index = 0; index < actions.length; index++) {
                statement.setString(index + 2, actions[index]);
            }
            statement.executeUpdate();
        }
    }

    /** Clear the standing states — what "unlock" and "lost mode off" actually do. */
    public void clearStanding(int deviceId) throws SQLException {
        String sql = "update phoenix_pending_actions set confirmed_at = now()"
            + " where confirmed_at is null and action in (?, ?)"
            + " and device_number in (select d.number from devices d where d.id = ?)";
        try (Connection connection = dataSource.getConnection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, LOCK);
            statement.setString(2, LOST_MODE_ON);
            statement.setInt(3, deviceId);
            statement.executeUpdate();
        }
    }
}
