package com.hmdm.plugins.phoenix.rest;

import java.util.List;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonInclude;

import com.hmdm.rest.json.SyncApplicationInt;
import com.hmdm.rest.json.SyncApplicationSettingInt;
import com.hmdm.rest.json.SyncConfigurationFileInt;
import com.hmdm.rest.json.SyncResponseInt;

/**
 * The sync response the tablet downloads, plus the five fields the free server has no column for.
 *
 * 🔴 WHY A WRAPPER AND NOT AN EDIT TO HEADWIND'S OWN CLASS. Editing `SyncResponse` would mean forking
 * the server, and every upgrade would then be a merge. `SyncResponseHook` exists precisely so a
 * plugin can hand back a DIFFERENT object — *"the hooks may extend the response with additional
 * properties"* — so this delegates every one of the interface's getters to the original and adds five
 * keys beside them.
 *
 * 🔴 ALL 66 GETTERS ARE WRITTEN OUT, AND THE ALTERNATIVE WAS A SILENTLY TRUNCATED CONFIGURATION.
 * The first draft implemented `SyncResponseInt` with a single method — `getDeviceId()`, which the
 * interface does not even declare — and relied on Jackson's `@JsonUnwrapped` to emit the rest. Two
 * things were wrong with that. It could not compile, which was the cheap half. The expensive half is
 * what it was reaching for: if the delegation is incomplete, the tablet downloads a configuration
 * MISSING whatever was left out — its applications, its kiosk settings, its permitted volume — and a
 * tablet that quietly reconfigures itself from a partial answer is far worse than one that refuses.
 * So the list below is the interface's own, in its own order, taken from the compiled
 * `SyncResponseInt` in `common-0.1.0.jar`, and the compiler now enforces that it stays complete.
 *
 * Measured at the same time, and the reason this is safe: Headwind's concrete `SyncResponse` exposes
 * exactly 66 public getters and NOT ONE that the interface does not declare. So delegating the
 * interface loses nothing that was being serialised before.
 *
 * 🔴 THE FIVE NAMES ARE READ OFF THE AGENT AND ARE NOT FREE TO CHOOSE. `hmdm-android`'s
 * `ServerConfig` deserialises exactly `lock`, `lockMessage`, `factoryReset`, `passwordReset` and
 * `reboot`. A tidier name here is a field the agent ignores — and an ignored field looks exactly like
 * a tablet that did not obey, which is the most expensive kind of wrong in this system.
 *
 * 🔴 `NON_NULL` IS LOAD-BEARING, AND IT IS ALSO WHAT THE ORIGINAL CARRIES. A null `factoryReset` must
 * be ABSENT from the JSON, not present as `null`: the agent reads these as tri-state, and a key that
 * is always there is a key that is always being decided about.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class PhoenixSyncResponseDecorator implements SyncResponseInt {

    /** 🔴 `@JsonIgnore`, or the whole original would be serialised a second time under "delegate". */
    @JsonIgnore
    private final SyncResponseInt delegate;

    private Boolean lock;
    private String lockMessage;
    private Boolean factoryReset;
    private String passwordReset;
    private Boolean reboot;

    public PhoenixSyncResponseDecorator(SyncResponseInt delegate) {
        this.delegate = delegate;
    }

    // ── The five fields this add-on exists to add ────────────────────────────────────────────────

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

    // ── Everything Headwind already sends, unchanged ─────────────────────────────────────────────

    @Override public String getBackgroundColor() { return delegate.getBackgroundColor(); }
    @Override public String getTextColor() { return delegate.getTextColor(); }
    @Override public String getBackgroundImageUrl() { return delegate.getBackgroundImageUrl(); }
    @Override public List<SyncApplicationInt> getApplications() { return delegate.getApplications(); }
    @Override public String getPassword() { return delegate.getPassword(); }
    @Override public String getImei() { return delegate.getImei(); }
    @Override public String getPhone() { return delegate.getPhone(); }
    @Override public String getIconSize() { return delegate.getIconSize(); }
    @Override public String getTitle() { return delegate.getTitle(); }
    @Override public Boolean getGps() { return delegate.getGps(); }
    @Override public Boolean getBluetooth() { return delegate.getBluetooth(); }
    @Override public Boolean getWifi() { return delegate.getWifi(); }
    @Override public Boolean getMobileData() { return delegate.getMobileData(); }
    @Override public boolean isKioskMode() { return delegate.isKioskMode(); }
    @Override public Boolean getKioskHome() { return delegate.getKioskHome(); }
    @Override public Boolean getKioskRecents() { return delegate.getKioskRecents(); }
    @Override public Boolean getKioskNotifications() { return delegate.getKioskNotifications(); }
    @Override public Boolean getKioskSystemInfo() { return delegate.getKioskSystemInfo(); }
    @Override public Boolean getKioskKeyguard() { return delegate.getKioskKeyguard(); }
    @Override public Boolean getKioskLockButtons() { return delegate.getKioskLockButtons(); }
    @Override public Boolean getKioskScreenOn() { return delegate.getKioskScreenOn(); }
    @Override public String getMainApp() { return delegate.getMainApp(); }
    @Override public boolean isLockStatusBar() { return delegate.isLockStatusBar(); }
    @Override public int getSystemUpdateType() { return delegate.getSystemUpdateType(); }
    @Override public String getSystemUpdateFrom() { return delegate.getSystemUpdateFrom(); }
    @Override public String getSystemUpdateTo() { return delegate.getSystemUpdateTo(); }
    @Override public Boolean getScheduleAppUpdate() { return delegate.getScheduleAppUpdate(); }
    @Override public String getAppUpdateFrom() { return delegate.getAppUpdateFrom(); }
    @Override public String getAppUpdateTo() { return delegate.getAppUpdateTo(); }
    @Override public String getDownloadUpdates() { return delegate.getDownloadUpdates(); }
    @Override public List<SyncApplicationSettingInt> getApplicationSettings() { return delegate.getApplicationSettings(); }
    @Override public Boolean getUsbStorage() { return delegate.getUsbStorage(); }
    @Override public String getRequestUpdates() { return delegate.getRequestUpdates(); }
    @Override public Boolean getDisableLocation() { return delegate.getDisableLocation(); }
    @Override public String getAppPermissions() { return delegate.getAppPermissions(); }
    @Override public String getPushOptions() { return delegate.getPushOptions(); }
    @Override public Integer getKeepaliveTime() { return delegate.getKeepaliveTime(); }
    @Override public Boolean getAutoBrightness() { return delegate.getAutoBrightness(); }
    @Override public Integer getBrightness() { return delegate.getBrightness(); }
    @Override public Boolean getManageTimeout() { return delegate.getManageTimeout(); }
    @Override public Integer getTimeout() { return delegate.getTimeout(); }
    @Override public Boolean getLockVolume() { return delegate.getLockVolume(); }
    @Override public Boolean getManageVolume() { return delegate.getManageVolume(); }
    @Override public Integer getVolume() { return delegate.getVolume(); }
    @Override public String getPasswordMode() { return delegate.getPasswordMode(); }
    @Override public Integer getOrientation() { return delegate.getOrientation(); }
    @Override public Boolean getDisplayStatus() { return delegate.getDisplayStatus(); }
    @Override public Boolean getRunDefaultLauncher() { return delegate.getRunDefaultLauncher(); }
    @Override public Boolean getDisableScreenshots() { return delegate.getDisableScreenshots(); }
    @Override public Boolean getAutostartForeground() { return delegate.getAutostartForeground(); }
    @Override public String getTimeZone() { return delegate.getTimeZone(); }
    @Override public String getAllowedClasses() { return delegate.getAllowedClasses(); }
    @Override public String getNewServerUrl() { return delegate.getNewServerUrl(); }
    @Override public Boolean getLockSafeSettings() { return delegate.getLockSafeSettings(); }
    @Override public Boolean getPermissive() { return delegate.getPermissive(); }
    @Override public Boolean getKioskExit() { return delegate.getKioskExit(); }
    @Override public Boolean getShowWifi() { return delegate.getShowWifi(); }
    @Override public List<SyncConfigurationFileInt> getFiles() { return delegate.getFiles(); }
    @Override public String getNewNumber() { return delegate.getNewNumber(); }
    @Override public String getRestrictions() { return delegate.getRestrictions(); }
    @Override public String getCustom1() { return delegate.getCustom1(); }
    @Override public String getCustom2() { return delegate.getCustom2(); }
    @Override public String getCustom3() { return delegate.getCustom3(); }
    @Override public String getAppName() { return delegate.getAppName(); }
    @Override public String getVendor() { return delegate.getVendor(); }
    @Override public String getDescription() { return delegate.getDescription(); }
}
