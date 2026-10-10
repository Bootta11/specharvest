package dev.bootta.specharvest;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Text shared from another app (ACTION_SEND) is turned into a VIEW intent for specharvest://share?text=…,
     * which the @capacitor/app plugin delivers to the web layer as an appUrlOpen event (see lib/share.ts).
     */
    private static Intent fromShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return intent;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null) return intent;
        Uri uri = new Uri.Builder().scheme("specharvest").authority("share").appendQueryParameter("text", text).build();
        return new Intent(Intent.ACTION_VIEW, uri);
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before super: the bridge reads the launch intent while it starts up.
        setIntent(fromShare(getIntent()));
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        Intent converted = fromShare(intent);
        setIntent(converted);
        super.onNewIntent(converted);
    }
}
