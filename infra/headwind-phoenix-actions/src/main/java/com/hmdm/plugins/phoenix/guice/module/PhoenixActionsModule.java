package com.hmdm.plugins.phoenix.guice.module;

import java.util.logging.Level;
import java.util.logging.Logger;

import javax.sql.DataSource;

import com.google.inject.AbstractModule;
import com.google.inject.Provides;
import com.google.inject.Singleton;
import com.google.inject.multibindings.Multibinder;

import com.hmdm.plugins.phoenix.PhoenixActionStore;
import com.hmdm.plugins.phoenix.PhoenixSyncResponseHook;
import com.hmdm.rest.json.SyncResponseHook;

/**
 * Wiring: the store, and the hook that puts the five fields into every sync response.
 *
 * 🔴 THE HOOK IS A MULTIBINDING, AND A PLAIN `bind()` HERE IS A SILENT NO-OP. `SyncResource` — the
 * class that serves `/rest/public/sync/configuration/{number}` — injects
 *
 *     &#64;Inject private Set&lt;SyncResponseHook&gt; syncResponseHooks;
 *
 * and iterates it. Guice fills a `Set&lt;T&gt;` only from a `Multibinder`; a `bind(SyncResponseHook.class)
 * .to(...)` binds the single key `SyncResponseHook`, which nothing injects, so the set stays EMPTY
 * and the hook is never called. The first draft did exactly that. It would have started cleanly,
 * logged nothing, served every endpoint, and simply never locked a tablet.
 *
 * The `DataSource` is Headwind's own, injected rather than built: `AbstractPersistenceModule` extends
 * mybatis-guice's `MyBatisModule` and calls `bindDataSourceProviderType(PooledDataSourceProvider)`,
 * which binds `javax.sql.DataSource` in the main injector. So the add-on opens no second pool and
 * needs no credentials of its own — a second pool on a small box is a second thing to size wrong, and
 * a second credential is a second thing to leak.
 */
public class PhoenixActionsModule extends AbstractModule {

    private static final Logger LOGGER = Logger.getLogger(PhoenixActionsModule.class.getName());

    @Override
    protected void configure() {
        Multibinder.newSetBinder(binder(), SyncResponseHook.class)
            .addBinding()
            .to(PhoenixSyncResponseHook.class);
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
