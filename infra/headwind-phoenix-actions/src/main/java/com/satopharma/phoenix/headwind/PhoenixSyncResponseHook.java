package com.satopharma.phoenix.headwind;

import java.util.List;
import java.util.logging.Level;
import java.util.logging.Logger;

import javax.inject.Inject;
import javax.inject.Singleton;

import com.hmdm.rest.json.SyncResponseHook;
import com.hmdm.rest.json.SyncResponseInt;

/**
 * Puts the five fields the free agent already obeys into the response it downloads.
 *
 * 🔴 THIS IS THE WHOLE TRICK, AND IT IS SMALL BECAUSE THE HARD PART WAS ALREADY DONE BY THE AGENT.
 * `hmdm-android`'s `ServerConfig` reads `lock`, `lockMessage`, `factoryReset`, `passwordReset` and
 * `reboot`, and `ConfigUpdater` acts on each with a real `DevicePolicyManager` call. The open-source
 * server never sets them. Headwind's own `SyncResponseHook` is the published way to extend that
 * response — so this adds the missing half without touching a tablet, an agent or Headwind's core.
 *
 * 🔴 THE HOOK RUNS ON EVERY CHECK-IN OF EVERY TABLET. It must be fast, and it must never throw: an
 * exception here is an exception on the fleet's hottest path, and a tablet that cannot sync is a
 * tablet that cannot be reached to fix it. Every failure below is logged and swallowed, which means
 * the worst outcome is an action that does not arrive — never a fleet that goes dark.
 *
 * 🔴 A LOCK IS RE-SENT AT EVERY CHECK-IN, ON PURPOSE. A lock is a STANDING state, not an event: the
 * agent reads the field each time, so a response that omitted it would silently unlock the tablet.
 * That is why only the one-shot actions are closed on confirmation, and the standing ones are closed
 * by an explicit unlock.
 */
@Singleton
public class PhoenixSyncResponseHook implements SyncResponseHook {

    private static final Logger LOGGER = Logger.getLogger(PhoenixSyncResponseHook.class.getName());

    private final PhoenixActionStore store;

    @Inject
    public PhoenixSyncResponseHook(PhoenixActionStore store) {
        this.store = store;
    }

    @Override
    public SyncResponseInt handle(int deviceId, SyncResponseInt response) {
        if (response == null) return null;
        try {
            String deviceNumber = response.getDeviceId();
            if (deviceNumber == null || deviceNumber.isEmpty()) return response;

            List<PhoenixActionStore.PendingAction> pending = store.openFor(deviceNumber);
            if (pending.isEmpty()) return response;

            PhoenixSyncResponseDecorator decorated = new PhoenixSyncResponseDecorator(response);

            // Oldest first, last word wins — so "lock" then "unlock" ends unlocked, which is what a
            // person who pressed two buttons in that order means.
            for (PhoenixActionStore.PendingAction action : pending) {
                switch (action.action) {
                    case PhoenixActionStore.LOCK:
                        decorated.setLock(true);
                        decorated.setLockMessage(null);
                        break;
                    case PhoenixActionStore.LOST_MODE_ON:
                        decorated.setLock(true);
                        decorated.setLockMessage(action.message);
                        break;
                    case PhoenixActionStore.UNLOCK:
                    case PhoenixActionStore.LOST_MODE_OFF:
                        decorated.setLock(false);
                        decorated.setLockMessage(null);
                        break;
                    case PhoenixActionStore.FACTORY_RESET:
                        decorated.setFactoryReset(true);
                        break;
                    case PhoenixActionStore.PASSWORD_RESET:
                        decorated.setPasswordReset(action.password);
                        break;
                    case PhoenixActionStore.REBOOT:
                        decorated.setReboot(true);
                        break;
                    default:
                        // An action this build does not know. Left open rather than silently closed,
                        // so a newer Phoenix talking to an older box does not lose the instruction.
                        continue;
                }
                store.markConsumed(action.id);
            }

            // An unlock takes effect the moment it is folded in; nothing needs to come back from the
            // tablet to prove a lock was lifted, because the absence of the field IS the lift.
            if (Boolean.FALSE.equals(decorated.getLock())) {
                store.clearStanding(response.getDeviceId());
            }

            return decorated;
        } catch (Exception exception) {
            // 🔴 NEVER RETHROW. See the class comment: this runs on every check-in of every tablet.
            LOGGER.log(Level.WARNING, "Phoenix actions hook could not run for device " + deviceId, exception);
            return response;
        }
    }
}
