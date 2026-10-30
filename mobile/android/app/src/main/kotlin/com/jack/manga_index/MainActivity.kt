package com.jack.manga_index

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executors

/**
 * Hands what is shared to the app (a chapter's link from the browser, a PDF from the file manager)
 * to the Dart side over the "manga_index/share" channel: {"text": …} or {"file": path, "name": …}.
 */
class MainActivity : FlutterActivity() {
    private var channel: MethodChannel? = null

    /** What the app was opened with, until the Dart side asks for it. */
    private var initial: Map<String, String>? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        initial = read(intent)
        channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "manga_index/share").apply {
            setMethodCallHandler { call, result ->
                if (call.method == "initial") {
                    result.success(initial)
                    initial = null
                } else {
                    result.notImplemented()
                }
            }
        }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "manga_index/app").setMethodCallHandler { call, result ->
            when (call.method) {
                // This build's number, to compare with the one the PC hands out.
                "build" -> result.success(
                    if (Build.VERSION.SDK_INT >= 28) packageManager.getPackageInfo(packageName, 0).longVersionCode
                    else @Suppress("DEPRECATION") packageManager.getPackageInfo(packageName, 0).versionCode.toLong()
                )
                // This build's version as shown ("1.9.0"), for the about page.
                "version" -> result.success(packageManager.getPackageInfo(packageName, 0).versionName)
                // Opens Android's installer on the update downloaded from the PC.
                "install" -> try {
                    val file = File(call.argument<String>("path")!!)
                    val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
                    startActivity(Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, "application/vnd.android.package-archive")
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                    })
                    result.success(null)
                } catch (e: Exception) {
                    result.error("install", e.message, null)
                }
                // "wifi", "cellular" or "none": downloads on the phone may be kept to Wi-Fi.
                "network" -> {
                    val manager = getSystemService(ConnectivityManager::class.java)
                    val caps = manager?.getNetworkCapabilities(manager.activeNetwork)
                    result.success(
                        when {
                            caps == null -> "none"
                            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "cellular"
                            else -> "wifi"
                        }
                    )
                }
                // A page downloaded on the phone (WebP, PNG, JPEG…) as a JPEG with its size, for the PDF.
                "toJpeg" -> {
                    val bytes = call.argument<ByteArray>("bytes")!!
                    images.execute {
                        val answer = try {
                            toJpeg(bytes)
                        } catch (e: Throwable) {
                            null
                        }
                        runOnUiThread { result.success(answer) }
                    }
                }
                else -> result.notImplemented()
            }
        }
        val tiles = PdfTiles()
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "manga_index/pdf").setMethodCallHandler(tiles::handle)
    }

    private val images = Executors.newSingleThreadExecutor()

    /** Null when the bytes are not a picture Android can open. */
    private fun toJpeg(bytes: ByteArray): Map<String, Any>? {
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
        // Transparent pictures go on white, as on the site's page.
        val bitmap = if (decoded.hasAlpha()) {
            Bitmap.createBitmap(decoded.width, decoded.height, Bitmap.Config.ARGB_8888).also {
                Canvas(it).apply { drawColor(Color.WHITE); drawBitmap(decoded, 0f, 0f, null) }
                decoded.recycle()
            }
        } else decoded
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)
        val answer = mapOf("bytes" to out.toByteArray(), "width" to bitmap.width, "height" to bitmap.height)
        bitmap.recycle()
        return answer
    }

    // Shared while the app was already open.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        read(intent)?.let { channel?.invokeMethod("shared", it) }
    }

    private fun read(intent: Intent?): Map<String, String>? {
        if (intent?.action != Intent.ACTION_SEND) return null
        // Read once: the activity coming back (rotation, return from another app) must not send it again.
        setIntent(Intent())
        intent.getStringExtra(Intent.EXTRA_TEXT)?.let { return mapOf("text" to it) }
        val uri = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
        } ?: return null
        return try {
            val name = displayName(uri) ?: "capitulo.pdf"
            // The other app's permission to read the file ends with this activity; a copy stays readable.
            val folder = File(cacheDir, "shared").apply { mkdirs() }
            val copy = File(folder, name.replace(Regex("[\\\\/:*?\"<>|]"), "_"))
            contentResolver.openInputStream(uri)?.use { input -> copy.outputStream().use { input.copyTo(it) } } ?: return null
            mapOf("file" to copy.path, "name" to name)
        } catch (e: Exception) {
            null
        }
    }

    private fun displayName(uri: Uri): String? =
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
}
