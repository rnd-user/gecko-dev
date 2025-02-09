/* -*- Mode: Java; c-basic-offset: 4; tab-width: 4; indent-tabs-mode: nil; -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.gecko.push;

import android.content.Context;
import android.os.Bundle;
import android.support.annotation.NonNull;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;
import org.mozilla.gecko.EventDispatcher;
import org.mozilla.gecko.GeckoAppShell;
import org.mozilla.gecko.GeckoProfile;
import org.mozilla.gecko.GeckoThread;
import org.mozilla.gecko.Telemetry;
import org.mozilla.gecko.TelemetryContract;
import org.mozilla.gecko.annotation.ReflectionTarget;
import org.mozilla.gecko.gcm.GcmTokenClient;
import org.mozilla.gecko.push.autopush.AutopushClientException;
import org.mozilla.gecko.util.BundleEventListener;
import org.mozilla.gecko.util.EventCallback;
import org.mozilla.gecko.util.ThreadUtils;

import java.io.IOException;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;

/**
 * Class that handles messages used in the Google Cloud Messaging and DOM push API integration.
 * <p/>
 * This singleton services Gecko messages from dom/push/PushServiceAndroidGCM.jsm and Google Cloud
 * Messaging requests.
 * <p/>
 * It is expected that Gecko is started (if not already running) soon after receiving GCM messages
 * otherwise there is a greater risk that pending messages that have not been handle by Gecko will
 * be lost if this service is killed.
 * <p/>
 * It's worth noting that we allow the DOM push API in restricted profiles.
 */
@ReflectionTarget
public class PushService implements BundleEventListener {
    private static final String LOG_TAG = "GeckoPushService";

    public static final String SERVICE_WEBPUSH = "webpush";

    private static PushService sInstance;

    private static final String[] GECKO_EVENTS = new String[] {
            "PushServiceAndroidGCM:Configure",
            "PushServiceAndroidGCM:DumpRegistration",
            "PushServiceAndroidGCM:DumpSubscriptions",
            "PushServiceAndroidGCM:Initialized",
            "PushServiceAndroidGCM:Uninitialized",
            "PushServiceAndroidGCM:RegisterUserAgent",
            "PushServiceAndroidGCM:UnregisterUserAgent",
            "PushServiceAndroidGCM:SubscribeChannel",
            "PushServiceAndroidGCM:UnsubscribeChannel",
    };

    public static synchronized PushService getInstance() {
        if (sInstance == null) {
            throw new IllegalStateException("PushService not yet created!");
        }
        return sInstance;
    }

    @ReflectionTarget
    public static synchronized void onCreate(Context context) {
        if (sInstance != null) {
            throw new IllegalStateException("PushService already created!");
        }
        sInstance = new PushService(context);

        sInstance.registerGeckoEventListener();
        sInstance.onStartup();
    }

    protected final PushManager pushManager;

    private boolean canSendPushMessagesToGecko;

    private final List<String> pendingPushMessages;

    public PushService(Context context) {
        pushManager = new PushManager(new PushState(context, "GeckoPushState.json"), new GcmTokenClient(context), new PushManager.PushClientFactory() {
            @Override
            public PushClient getPushClient(String autopushEndpoint, boolean debug) {
                return new PushClient(autopushEndpoint);
            }
        });

        pendingPushMessages = new LinkedList<String>();
    }

    public void onStartup() {
        Log.i(LOG_TAG, "Starting up.");
        ThreadUtils.assertOnBackgroundThread();

        try {
            pushManager.startup(System.currentTimeMillis());
        } catch (Exception e) {
            Log.e(LOG_TAG, "Got exception during startup; ignoring.", e);
            return;
        }
    }

    public void onRefresh() {
        Log.i(LOG_TAG, "Google Play Services requested GCM token refresh; invalidating GCM token and running startup again.");
        ThreadUtils.assertOnBackgroundThread();

        pushManager.invalidateGcmToken();
        try {
            pushManager.startup(System.currentTimeMillis());
        } catch (Exception e) {
            Log.e(LOG_TAG, "Got exception during refresh; ignoring.", e);
            return;
        }
    }

    public void onMessageReceived(final @NonNull Bundle bundle) {
        Log.i(LOG_TAG, "Google Play Services GCM message received; delivering.");
        ThreadUtils.assertOnBackgroundThread();

        final String chid = bundle.getString("chid");
        if (chid == null) {
            Log.w(LOG_TAG, "No chid found; ignoring message.");
            return;
        }

        final PushRegistration registration = pushManager.registrationForSubscription(chid);
        if (registration == null) {
            Log.w(LOG_TAG, "Cannot find registration corresponding to subscription for chid: " + chid + "; ignoring message.");
            return;
        }

        final PushSubscription subscription = registration.getSubscription(chid);
        if (subscription == null) {
            // This should never happen.  There's not much to be done; in the future, perhaps we
            // could try to drop the remote subscription?
            Log.e(LOG_TAG, "No subscription found for chid: " + chid + "; ignoring message.");
            return;
        }

        Log.i(LOG_TAG, "Message directed to service: " + subscription.service);

        if (SERVICE_WEBPUSH.equals(subscription.service)) {
            if (subscription.serviceData == null) {
                Log.e(LOG_TAG, "No serviceData found for chid: " + chid + "; ignoring dom/push message.");
                return;
            }

            final String profileName = subscription.serviceData.optString("profileName", null);
            final String profilePath = subscription.serviceData.optString("profilePath", null);
            if (profileName == null || profilePath == null) {
                Log.e(LOG_TAG, "Corrupt serviceData found for chid: " + chid + "; ignoring dom/push message.");
                return;
            }

            // Let's look to the future, when we'll deliver messages without regard to whether
            // Gecko is running or not.
            Telemetry.sendUIEvent(TelemetryContract.Event.ACTION, TelemetryContract.Method.SERVICE, "dom-push-api");

            if (!GeckoThread.isRunning()) {
                Log.w(LOG_TAG, "dom/push message received but no Gecko thread is running; ignoring message.");
                return;
            }

            final GeckoAppShell.GeckoInterface geckoInterface = GeckoAppShell.getGeckoInterface();
            if (geckoInterface == null) {
                Log.w(LOG_TAG, "dom/push message received but no Gecko interface is registered; ignoring message.");
                return;
            }

            final GeckoProfile profile = geckoInterface.getProfile();
            if (profile == null || !profileName.equals(profile.getName()) || !profilePath.equals(profile.getDir().getAbsolutePath())) {
                Log.w(LOG_TAG, "dom/push message received but Gecko is running with the wrong profile name or path; ignoring message.");
                return;
            }

            // DELIVERANCE!
            final JSONObject data = new JSONObject();
            try {
                data.put("channelID", chid);
                data.put("enc", bundle.getString("enc"));
                // Only one of cryptokey (newer) and enckey (deprecated) should be set, but the
                // Gecko handler will verify this.
                data.put("cryptokey", bundle.getString("cryptokey"));
                data.put("enckey", bundle.getString("enckey"));
                data.put("message", bundle.getString("body"));
            } catch (JSONException e) {
                Log.e(LOG_TAG, "Got exception delivering dom/push message to Gecko!", e);
                return;
            }

            enqueueOrSendMessage(data.toString());
        } else {
            Log.e(LOG_TAG, "Message directed to unknown service; dropping: " + subscription.service);
        }
    }

    protected void enqueueOrSendMessage(final @NonNull String message) {
        if (canSendPushMessagesToGecko) {
            sendMessageToGeckoService(message);
        } else {
            Log.i(LOG_TAG, "Service not initialized, adding message to queue.");
            pendingPushMessages.add(message);
        }
    }

    protected void sendMessageToGeckoService(final @NonNull String message) {
        Log.i(LOG_TAG, "Delivering dom/push message to Gecko!");
        GeckoAppShell.notifyObservers("PushServiceAndroidGCM:ReceivedPushMessage", message);
    }

    protected void registerGeckoEventListener() {
        Log.d(LOG_TAG, "Registered Gecko event listener.");
        EventDispatcher.getInstance().registerBackgroundThreadListener(this, GECKO_EVENTS);
    }

    protected void unregisterGeckoEventListener() {
        Log.d(LOG_TAG, "Unregistered Gecko event listener.");
        EventDispatcher.getInstance().unregisterBackgroundThreadListener(this, GECKO_EVENTS);
    }

    @Override
    public void handleMessage(final String event, final Bundle message, final EventCallback callback) {
        Log.i(LOG_TAG, "Handling event: " + event);
        ThreadUtils.assertOnBackgroundThread();

        // We're invoked in response to a Gecko message on a background thread.  We should always
        // be able to safely retrieve the current Gecko profile.
        final GeckoProfile geckoProfile = GeckoProfile.get(GeckoAppShell.getApplicationContext());

        if (callback == null) {
            Log.e(LOG_TAG, "callback must not be null in " + event);
            return;
        }

        try {
            if ("PushServiceAndroidGCM:Configure".equals(event)) {
                final String endpoint = message.getString("endpoint");
                if (endpoint == null) {
                    callback.sendError("endpoint must not be null in " + event);
                    return;
                }
                final boolean debug = message.getBoolean("debug", false);
                pushManager.configure(geckoProfile.getName(), endpoint, debug, System.currentTimeMillis()); // For side effects.
                callback.sendSuccess(null);
                return;
            }
            if ("PushServiceAndroidGCM:DumpRegistration".equals(event)) {
                // In the future, this might be used to interrogate the Java Push Manager
                // registration state from JavaScript.
                callback.sendError("Not yet implemented!");
                return;
            }
            if ("PushServiceAndroidGCM:DumpSubscriptions".equals(event)) {
                try {
                    final Map<String, PushSubscription> result = pushManager.allSubscriptionsForProfile(geckoProfile.getName());

                    final JSONObject json = new JSONObject();
                    for (Map.Entry<String, PushSubscription> entry : result.entrySet()) {
                        json.put(entry.getKey(), entry.getValue().toJSONObject());
                    }
                    callback.sendSuccess(json);
                } catch (JSONException e) {
                    callback.sendError("Got exception handling message [" + event + "]: " + e.toString());
                }
                return;
            }
            if ("PushServiceAndroidGCM:Initialized".equals(event)) {
                // Send all pending messages to Gecko and set the
                // canSendPushMessageToGecko flag to true so that
                // all new push messages are sent directly to Gecko
                // instead of being queued.
                canSendPushMessagesToGecko = true;
                for (String pushMessage : pendingPushMessages) {
                    sendMessageToGeckoService(pushMessage);
                }
                pendingPushMessages.clear();
                callback.sendSuccess(null);
                return;
            }
            if ("PushServiceAndroidGCM:Uninitialized".equals(event)) {
                canSendPushMessagesToGecko = false;
                callback.sendSuccess(null);
                return;
            }
            if ("PushServiceAndroidGCM:RegisterUserAgent".equals(event)) {
                try {
                    pushManager.registerUserAgent(geckoProfile.getName(), System.currentTimeMillis()); // For side-effects.
                    callback.sendSuccess(null);
                } catch (PushManager.ProfileNeedsConfigurationException | AutopushClientException | PushClient.LocalException | IOException e) {
                    Log.e(LOG_TAG, "Got exception in " + event, e);
                    callback.sendError("Got exception handling message [" + event + "]: " + e.toString());
                }
                return;
            }
            if ("PushServiceAndroidGCM:UnregisterUserAgent".equals(event)) {
                // In the future, this might be used to tell the Java Push Manager to unregister
                // a User Agent entirely from JavaScript.  Right now, however, everything is
                // subscription based; there's no concept of unregistering all subscriptions
                // simultaneously.
                callback.sendError("Not yet implemented!");
                return;
            }
            if ("PushServiceAndroidGCM:SubscribeChannel".equals(event)) {
                final String service = SERVICE_WEBPUSH;
                final JSONObject serviceData;
                try {
                    serviceData = new JSONObject();
                    serviceData.put("profileName", geckoProfile.getName());
                    serviceData.put("profilePath", geckoProfile.getDir().getAbsolutePath());
                } catch (JSONException e) {
                    Log.e(LOG_TAG, "Got exception in " + event, e);
                    callback.sendError("Got exception handling message [" + event + "]: " + e.toString());
                    return;
                }

                final PushSubscription subscription;
                try {
                    subscription = pushManager.subscribeChannel(geckoProfile.getName(), service, serviceData, System.currentTimeMillis());
                } catch (PushManager.ProfileNeedsConfigurationException | AutopushClientException | PushClient.LocalException | IOException e) {
                    Log.e(LOG_TAG, "Got exception in " + event, e);
                    callback.sendError("Got exception handling message [" + event + "]: " + e.toString());
                    return;
                }

                final JSONObject json = new JSONObject();
                try {
                    json.put("channelID", subscription.chid);
                    json.put("endpoint", subscription.webpushEndpoint);
                } catch (JSONException e) {
                    Log.e(LOG_TAG, "Got exception in " + event, e);
                    callback.sendError("Got exception handling message [" + event + "]: " + e.toString());
                    return;
                }

                Telemetry.sendUIEvent(TelemetryContract.Event.SAVE, TelemetryContract.Method.SERVICE, "dom-push-api");
                callback.sendSuccess(json);
                return;
            }
            if ("PushServiceAndroidGCM:UnsubscribeChannel".equals(event)) {
                final String channelID = message.getString("channelID");
                if (channelID == null) {
                    callback.sendError("channelID must not be null in " + event);
                    return;
                }

                // Fire and forget.  See comments in the function itself.
                final PushSubscription pushSubscription = pushManager.unsubscribeChannel(channelID);
                if (pushSubscription != null) {
                    Telemetry.sendUIEvent(TelemetryContract.Event.UNSAVE, TelemetryContract.Method.SERVICE, "dom-push-api");
                    callback.sendSuccess(null);
                    return;
                }

                callback.sendError("Could not unsubscribe from channel: " + channelID);
                return;
            }
        } catch (GcmTokenClient.NeedsGooglePlayServicesException e) {
            // TODO: improve this.  Can we find a point where the user is *definitely* interacting
            // with the WebPush?  Perhaps we can show a dialog when interacting with the Push
            // permissions, and then be more aggressive showing this notification when we have
            // registrations and subscriptions that can't be advanced.
            callback.sendError("To handle event [" + event + "], user interaction is needed to enable Google Play Services.");
        }
    }
}
