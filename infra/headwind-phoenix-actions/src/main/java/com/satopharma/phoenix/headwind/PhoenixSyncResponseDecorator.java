package com.satopharma.phoenix.headwind;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonUnwrapped;

import com.hmdm.rest.json.SyncResponseInt;

/**
 * The sync response the tablet downloads, plus the five fields the free server has no column for.
 *
 * 🔴 WHY A WRAPPER AND NOT AN EDIT TO HEADWIND'S OWN CLASS. Editing `SyncResponse` would mean forking
 * the server, and every upgrade would then be a merge. `SyncResponseHook` exists precisely so a
 * plugin can hand back a DIFFERENT object — *"the hooks may extend the response with additional
 * properties"* — so this delegates everything to the original through `@JsonUnwrapped` and adds five
 * keys beside it. An upgrade to Headwind changes the original's fields and this file keeps working.
 *
 * 🔴 THE FIVE NAMES ARE READ OFF THE AGENT AND ARE NOT FREE TO CHOOSE. `hmdm-android`'s
 * `ServerConfig` deserialises exactly `lock`, `lockMessage`, `factoryReset`, `passwordReset` and
 * `reboot`. A tidier name here is a field the agent ignores — and an ignored field looks exactly like
 * a tablet that did not obey, which is the most expensive kind of wrong in this system.
 *
 * 🔴 `NON_NULL` IS LOAD-BEARING. A null `factoryReset` must be ABSENT from the JSON, not present as
 * `null`: the agent reads these as tri-state, and a key that is always there is a key that is always
 * being decided about.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class PhoenixSyncResponseDecorator implements SyncResponseInt {

    @JsonUnwrapped
    private final SyncResponseInt delegate;

    private Boolean lock;
    private String lockMessage;
    private Boolean factoryReset;
    private String passwordReset;
    private Boolean reboot;

    public PhoenixSyncResponseDecorator(SyncResponseInt delegate) {
        this.delegate = delegate;
    }

    public SyncResponseInt getDelegate() {
        return delegate;
    }

    @Override
    public String getDeviceId() {
        return delegate.getDeviceId();
    }

    public Boolean getLock() {
        return lock;
    }

    public void setLock(Boolean lock) {
        this.lock = lock;
    }

    public String getLockMessage() {
        return lockMessage;
    }

    public void setLockMessage(String lockMessage) {
        this.lockMessage = lockMessage;
    }

    public Boolean getFactoryReset() {
        return factoryReset;
    }

    public void setFactoryReset(Boolean factoryReset) {
        this.factoryReset = factoryReset;
    }

    public String getPasswordReset() {
        return passwordReset;
    }

    public void setPasswordReset(String passwordReset) {
        this.passwordReset = passwordReset;
    }

    public Boolean getReboot() {
        return reboot;
    }

    public void setReboot(Boolean reboot) {
        this.reboot = reboot;
    }
}
