package dev.bootta.specharvest;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Installs a new APK of this app (direct build only, see lib/apk-update.ts and docs/app-updates.md): downloads it,
 * reporting "progress" events, and hands it to Android's PackageInstaller. Android checks that it's signed with the
 * same key as the installed app. On Android 12+ the update installs without a confirm screen when this app installed
 * the current version; otherwise InstallStatusReceiver opens the confirm screen.
 */
@CapacitorPlugin(name = "AppInstaller")
public class AppInstallerPlugin extends Plugin {

    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getContext().getPackageManager().canRequestPackageInstalls();
        JSObject result = new JSObject();
        result.put("value", allowed);
        call.resolve(result);
    }

    /** Android's "Install unknown apps" switch for this app. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("An https URL is required");
            return;
        }
        new Thread(() -> {
            try {
                File apk = download(url);
                commit(apk);
                call.resolve();
            } catch (Exception e) {
                call.reject("Update failed: " + e.getMessage(), e);
            }
        }).start();
    }

    private File download(String url) throws Exception {
        File apk = new File(getContext().getCacheDir(), "update.apk");
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(20_000);
        conn.setReadTimeout(60_000);
        try {
            if (conn.getResponseCode() != 200) throw new Exception("download answered " + conn.getResponseCode());
            long total = conn.getContentLengthLong();
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
                byte[] buf = new byte[64 * 1024];
                long done = 0;
                int lastPercent = -1;
                for (int n; (n = in.read(buf)) > 0; ) {
                    out.write(buf, 0, n);
                    done += n;
                    int percent = total > 0 ? (int) (done * 100 / total) : 0;
                    if (percent != lastPercent) {
                        lastPercent = percent;
                        JSObject event = new JSObject();
                        event.put("percent", percent);
                        notifyListeners("progress", event);
                    }
                }
            }
        } finally {
            conn.disconnect();
        }
        return apk;
    }

    private void commit(File apk) throws Exception {
        Context context = getContext();
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        // Only an update of this app: Android refuses any other package.
        params.setAppPackageName(context.getPackageName());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        }
        int sessionId = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(sessionId)) {
            try (InputStream in = new FileInputStream(apk); OutputStream out = session.openWrite("update.apk", 0, apk.length())) {
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                session.fsync(out);
            }
            // Mutable: the installer adds the status extras to this intent.
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
            Intent status = new Intent(context, InstallStatusReceiver.class);
            PendingIntent pending = PendingIntent.getBroadcast(context, sessionId, status, flags);
            session.commit(pending.getIntentSender());
        } finally {
            apk.delete();
        }
    }
}
