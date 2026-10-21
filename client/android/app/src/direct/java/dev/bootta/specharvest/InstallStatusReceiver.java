package dev.bootta.specharvest;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.util.Log;
import android.widget.Toast;
import androidx.core.content.IntentCompat;

/**
 * The package installer's answer to AppInstallerPlugin.install. When Android wants the user to confirm (the first
 * self-update, or when it doesn't allow a silent one), this opens its confirm screen; failures show a toast.
 */
public class InstallStatusReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent.class);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(confirm);
            }
        } else if (status != PackageInstaller.STATUS_SUCCESS) {
            String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            Log.w("AppInstaller", "Install failed (" + status + "): " + message);
            // Aborted: the user tapped Cancel on the confirm screen, nothing to report.
            if (status != PackageInstaller.STATUS_FAILURE_ABORTED) {
                Toast.makeText(context, "Update failed" + (message != null ? ": " + message : ""), Toast.LENGTH_LONG).show();
            }
        }
    }
}
