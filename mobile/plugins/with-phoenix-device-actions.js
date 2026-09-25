const fs = require("fs");
const path = require("path");

const { AndroidConfig, withAndroidManifest, withDangerousMod } = require("expo/config-plugins");

/**
 * Ring the alarm, and show a message on the tablet.
 *
 * 🔴 WHY THIS IS IN OUR OWN APP AND NOT IN THE MDM. The owner's ruling on 2026-09-25 was "do not build
 * a dead button — find a tool that can do this function for free". Two of the actions he wants have no
 * free MDM route at all, and looking harder does not produce one:
 *
 *   **Ring the alarm.** No Headwind push makes a sound. There is no such message type in the agent.
 *   **Show a message.** Headwind's messaging plugin sends push type `textMessage`, and the stock agent
 *     has NO handler for it — it falls to the default branch and is only re-broadcast to plugins. The
 *     message reaches the tablet and nothing draws it. (Its server half also hand-builds JSON with
 *     unquoted keys.) So that plugin is a dead end even though it exists and answers 200.
 *
 * What the agent DOES have is `intent`: it starts a named activity with `CLEAR_TASK | NEW_TASK` and
 * hands it typed extras. That is a door into any app on the tablet — including ours. So Phoenix pushes
 * an `intent`, and the Phoenix app does the work. No admin rights are needed for either, because an
 * app is allowed to make noise and draw on its own screen.
 *
 * 🔴 THE TWO ACTION STRINGS BELOW ARE A CONTRACT WITH THE SERVER. They are matched by
 * `PHOENIX_ALARM_INTENT` and `PHOENIX_MESSAGE_INTENT` in `src/lib/devices/headwind/actions.ts`.
 * Renaming one on either side alone gives a button that reports "sent" and does nothing on the tablet.
 *
 * 🔴 AND `exported="true"` IS LOAD-BEARING, NOT AN OVERSIGHT. The activity is started by the Headwind
 * agent, which is a different app; an unexported activity cannot be. What stops anyone else using it
 * is that the tablet is a managed device running only company apps — and that neither action can read
 * anything, write anything or leave the screen. The worst a misuse achieves is a noise.
 *
 * A config plugin rather than an edit to `android/` because this app has no `android/` folder: EAS
 * generates it on every build, and anything written there by hand is thrown away. `runtimeVersion` is
 * `fingerprint`, so this is native code and reaches the fleet as a NEW APK through Headwind — not as
 * an over-the-air update.
 *
 * ONE HONEST LIMIT, WRITTEN ON THE CONSOLE TOO. Under Do Not Disturb the alarm plays at whatever
 * volume is already set, because raising it needs notification-policy access — a special access that a
 * device owner cannot grant on a rep's behalf. It still plays, and it still plays on the ALARM channel,
 * which is heard with the ringer down.
 */

const PACKAGE = "com.satopharma.phoenixworkforce";
const ALARM_ACTION = `${PACKAGE}.DEVICE_ALARM`;
const MESSAGE_ACTION = `${PACKAGE}.DEVICE_MESSAGE`;
const ACTIVITY = `${PACKAGE}.deviceactions.PhoenixDeviceActionActivity`;

/**
 * 🔴 PLAYED FROM THE ACTIVITY, NOT A FOREGROUND SERVICE — a deliberate change from the first design.
 * A foreground service would need `FOREGROUND_SERVICE` plus a notification channel plus its own
 * lifecycle, and it buys nothing here: the activity is on screen, holds the screen awake and shows
 * over the lock screen, so it survives exactly as long as the alarm should. Fewer moving parts is the
 * point on a device nobody can walk over to.
 */
const JAVA = `package ${PACKAGE}.deviceactions;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Started by the Headwind agent's \`intent\` push. Rings, or shows words. Reads nothing and sends
 * nothing anywhere.
 */
public class PhoenixDeviceActionActivity extends Activity {

    /** Five minutes, the same as Google's own Find Hub ring. Long enough to search a room. */
    private static final long MAX_RING_MS = 5 * 60 * 1000L;

    private MediaPlayer player;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showOverLockScreen();

        String action = getIntent() != null ? getIntent().getAction() : null;
        boolean isAlarm = "${ALARM_ACTION}".equals(action);
        String message = getIntent() != null ? getIntent().getStringExtra("message") : null;

        setContentView(buildView(isAlarm, message));
        if (isAlarm) {
            startRinging();
            handler.postDelayed(new Runnable() {
                @Override public void run() { finish(); }
            }, MAX_RING_MS);
        }
    }

    /** The tablet may be face down in a bag with the screen off. Wake it and draw over the lock. */
    private void showOverLockScreen() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
    }

    private View buildView(boolean isAlarm, String message) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.parseColor("#0A527D"));
        root.setPadding(48, 48, 48, 48);

        TextView title = new TextView(this);
        title.setText(isAlarm ? "Phoenix" : "Message from Phoenix");
        title.setTextColor(Color.WHITE);
        title.setTextSize(22f);
        title.setGravity(Gravity.CENTER);
        root.addView(title);

        TextView body = new TextView(this);
        body.setText(message != null && message.trim().length() > 0
            ? message
            : (isAlarm ? "This tablet is being located." : ""));
        body.setTextColor(Color.WHITE);
        body.setTextSize(18f);
        body.setGravity(Gravity.CENTER);
        body.setPadding(0, 32, 0, 32);
        root.addView(body);

        Button dismiss = new Button(this);
        dismiss.setText(isAlarm ? "Stop" : "Got it");
        dismiss.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });
        root.addView(dismiss);
        return root;
    }

    /**
     * 🔴 STREAM_ALARM AND USAGE_ALARM, NOT THE NOTIFICATION CHANNEL. A rep's tablet is usually on
     * silent; the alarm channel is the one that is still heard. Raising the volume is wrapped because
     * it THROWS under Do Not Disturb without notification-policy access, which a device owner cannot
     * grant — and an alarm that crashes instead of playing quietly is the worse outcome.
     */
    private void startRinging() {
        try {
            AudioManager audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (audio != null) {
                try {
                    audio.setStreamVolume(
                        AudioManager.STREAM_ALARM,
                        audio.getStreamMaxVolume(AudioManager.STREAM_ALARM),
                        0);
                } catch (SecurityException ignored) {
                    // Do Not Disturb. It still plays, at whatever volume is set.
                }
            }

            Uri tone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (tone == null) tone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            if (tone == null) return;

            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
            player.setDataSource(this, tone);
            player.setLooping(true);
            player.prepare();
            player.start();
        } catch (Exception ignored) {
            // A tablet with no alarm tone at all still shows the screen, which is most of the value.
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (player != null) {
            try {
                player.stop();
                player.release();
            } catch (Exception ignored) {
                // Already gone.
            }
            player = null;
        }
        super.onDestroy();
    }
}
`;

function withSourceFile(config) {
  return withDangerousMod(config, [
    "android",
    (modConfig) => {
      const dir = path.join(
        modConfig.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "java",
        ...PACKAGE.split("."),
        "deviceactions",
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "PhoenixDeviceActionActivity.java"), JAVA, "utf8");
      return modConfig;
    },
  ]);
}

function withManifestEntry(config) {
  return withAndroidManifest(config, (modConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(modConfig.modResults);
    application.activity = application.activity ?? [];

    // Idempotent: a plugin that appends on every prebuild produces a manifest with duplicates, which
    // fails the merge with a message that names neither this file nor the reason.
    const existing = application.activity.findIndex(
      (entry) => entry?.$?.["android:name"] === ACTIVITY,
    );
    if (existing >= 0) application.activity.splice(existing, 1);

    application.activity.push({
      $: {
        "android:excludeFromRecents": "true",
        "android:exported": "true",
        "android:launchMode": "singleTop",
        "android:name": ACTIVITY,
        "android:showOnLockScreen": "true",
        "android:taskAffinity": "",
        "android:theme": "@android:style/Theme.Material.NoActionBar",
      },
      "intent-filter": [
        {
          action: [{ $: { "android:name": ALARM_ACTION } }],
          category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
        },
        {
          action: [{ $: { "android:name": MESSAGE_ACTION } }],
          category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
        },
      ],
    });

    return modConfig;
  });
}

module.exports = function withPhoenixDeviceActions(config) {
  return withManifestEntry(withSourceFile(config));
};
