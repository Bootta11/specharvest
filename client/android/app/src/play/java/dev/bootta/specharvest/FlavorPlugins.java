package dev.bootta.specharvest;

import com.getcapacitor.Plugin;
import java.util.List;

/** The Play build has no extra native plugins: Google Play updates the app, so there's no AppInstaller. */
final class FlavorPlugins {

    static final List<Class<? extends Plugin>> PLUGINS = List.of();

    private FlavorPlugins() {}
}
