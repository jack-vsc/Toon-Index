package com.jack.manga_index

import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import io.flutter.app.FlutterApplication
import org.json.JSONObject

/**
 * Starts Firebase with the project the PC handed out (kept by the Dart side under "cloud"), before
 * anything else: a new-chapter notification can arrive with the app closed, and Android shows it
 * only once Firebase is up. Also makes the notifications' channel.
 */
class App : FlutterApplication() {
    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(
                NotificationChannel(CHANNEL, "Capítulos novos", NotificationManager.IMPORTANCE_DEFAULT)
            )
        }
        try {
            if (FirebaseApp.getApps(this).isNotEmpty()) return
            val text = getSharedPreferences("FlutterSharedPreferences", MODE_PRIVATE).getString("flutter.cloud", null) ?: return
            val info = JSONObject(text)
            val web = info.getJSONObject("web")
            FirebaseApp.initializeApp(
                this,
                FirebaseOptions.Builder()
                    .setApiKey(web.getString("apiKey"))
                    .setApplicationId(info.getString("androidAppId"))
                    .setGcmSenderId(web.getString("messagingSenderId"))
                    .setProjectId(web.getString("projectId"))
                    .apply { web.optString("storageBucket").takeIf { it.isNotEmpty() }?.let(::setStorageBucket) }
                    .build()
            )
        } catch (e: Exception) {
            // Without it the sync is simply off; the Dart side says so.
        }
    }

    companion object {
        const val CHANNEL = "chapters"
    }
}
