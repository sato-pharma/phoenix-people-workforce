package com.satopharma.phoenix.headwind;

import java.util.logging.Level;
import java.util.logging.Logger;

import javax.sql.DataSource;

import com.google.inject.AbstractModule;
import com.google.inject.Provides;
import com.google.inject.Singleton;

import com.hmdm.rest.json.SyncResponseHook;

/**
 * Wiring. Registers the store, the hook and the two REST resources with Headwind's own Guice
 * injector.
 *
 * 🔴 THIS FILE IS THE MOST LIKELY THING IN THE ADD-ON TO NEED A CORRECTION ON THE FIRST BUILD, AND
 * ITS FAILURE MODE IS SILENT. Headwind discovers plugin modules through its own registration — if
 * this module is not picked up, nothing throws: the sync response simply goes out without the five
 * fields, and every tablet does nothing. **When an action does not arrive, check here before you
 * check the tablet.** The single fastest test is
 * `GET /rest/plugins/phoenix-actions/private/status` — if that answers 404, the module never loaded,
 * and no amount of looking at the tablet will show why.
 *
 * The `DataSource` is Headwind's own — the add-on opens no second connection pool and needs no
 * credentials of its own. That is deliberate: a second pool on a small box is a second thing to size
 * wrong, and a second credential is a second thing to leak.
 */
public class PhoenixActionsModule extends AbstractModule {

    private static final Logger LOGGER = Logger.getLogger(PhoenixActionsModule.class.getName());

    @Override
    protected void configure() {
        bind(PhoenixActionsResource.class);
        bind(DeviceResetConfirmResource.class);
        bind(SyncResponseHook.class).to(PhoenixSyncResponseHook.class);
    }

    @Provides
    @Singleton
    public PhoenixActionStore phoenixActionStore(DataSource dataSource) {
        PhoenixActionStore store = new PhoenixActionStore(dataSource);
        try {
            store.ensureSchema();
            LOGGER.info("Phoenix actions add-on: table ready.");
        } catch (Exception exception) {
            // 🔴 LOGGED LOUDLY AND NOT RETHROWN. A failed table creation must not stop the whole MDM
            // server from starting: a hundred tablets losing their management because an add-on could
            // not create a table is a far worse outcome than four buttons refusing.
            LOGGER.log(Level.SEVERE,
                "Phoenix actions add-on could NOT create its table — lock, lost mode, factory reset and "
                    + "password reset will not work. The rest of the server is unaffected.",
                exception);
        }
        return store;
    }
}
