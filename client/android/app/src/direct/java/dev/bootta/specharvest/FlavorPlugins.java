package dev.bootta.specharvest;

import com.getcapacitor.Plugin;
import java.util.List;

/** Native plugins only the direct build (the APK on Zealot) has: it updates itself (docs/app-updates.md). */
final class FlavorPlugins {

    static final List<Class<? extends Plugin>> PLUGINS = List.of(AppInstallerPlugin.class);

    private FlavorPlugins() {}
}
