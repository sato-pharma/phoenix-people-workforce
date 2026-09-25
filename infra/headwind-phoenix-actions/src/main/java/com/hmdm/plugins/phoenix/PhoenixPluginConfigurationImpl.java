package com.hmdm.plugins.phoenix;

import java.util.ArrayList;
import java.util.List;

import javax.servlet.ServletContext;

import com.google.inject.Module;

import com.hmdm.plugin.PluginConfiguration;
import com.hmdm.plugins.phoenix.guice.module.PhoenixActionsModule;
import com.hmdm.plugins.phoenix.guice.module.PhoenixRestModule;

/**
 * The one class that makes this add-on exist. Without it, nothing else in this directory ever runs.
 *
 * 🔴 THIS FILE IS THE FIX FOR THE MOST EXPENSIVE DEFECT IN THE ADD-ON, AND THE DEFECT WAS SILENCE.
 * The first draft shipped a Guice `AbstractModule` and nothing that would ever instantiate it. It
 * would have compiled, built, deployed, started and answered 404 on every endpoint, and the only
 * symptom would have been four buttons in Phoenix that never did anything.
 *
 * 🔴 HOW HEADWIND ACTUALLY FINDS A PLUGIN — read out of `com.hmdm.plugin.PluginList`, not from docs:
 *
 *     new ClassGraph().enableAllInfo().whitelistPackages("com.hmdm").scan()
 *         .getClassesImplementing(PluginConfiguration.class.getName())
 *
 * Two things follow, and both are load-bearing:
 *
 *   1. Discovery is a CLASSPATH SCAN for implementations of `PluginConfiguration`. There is no list
 *      to add to and no descriptor file to write — but there is also nothing that will pick up a
 *      bare Guice module. This class is the hook.
 *   2. 🔴 THE SCAN IS WHITELISTED TO THE PACKAGE `com.hmdm`, WHICH IS WHY THIS ADD-ON LIVES THERE.
 *      The first draft used `com.satopharma.phoenix.headwind`, which ClassGraph would never have
 *      looked at. That is not namespace squatting: every Headwind plugin in the shipped WAR lives
 *      under `com.hmdm.plugins.*` (audit, deviceinfo, devicelog, messaging, push, xtra), and
 *      `getRootPackage()` below exists precisely so a plugin declares its own subtree. Moving out of
 *      `com.hmdm` would disable the add-on, silently.
 *
 * `getTaskModules` is a default method on the interface and is not overridden — this add-on has no
 * background task. Confirmed against `MessagingPluginConfigurationImpl`, which does the same.
 */
public class PhoenixPluginConfigurationImpl implements PluginConfiguration {

    /**
     * 🔴 THIS STRING IS PART OF THE WIRE CONTRACT, NOT A LABEL. It is the `<id>` in
     * `/rest/plugins/<id>/private/...`, which is the URL Phoenix calls and the URL the filters in
     * `PhoenixRestModule` are registered against. Changing it here without changing both of those
     * gives a 404 that looks exactly like an add-on that failed to load.
     */
    private static final String PLUGIN_ID = "phoenix-actions";

    @Override
    public String getPluginId() {
        return PLUGIN_ID;
    }

    @Override
    public String getRootPackage() {
        return "com.hmdm.plugins.phoenix";
    }

    @Override
    public List<Module> getPluginModules(ServletContext context) {
        List<Module> modules = new ArrayList<>();
        modules.add(new PhoenixActionsModule());
        modules.add(new PhoenixRestModule());
        return modules;
    }
}
