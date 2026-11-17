package com.jack.manga_index

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executors

/**
 * Draws a band of a PDF page ("manga_index/pdf" channel), so a webtoon strip 15 000 pixels tall is
 * read a screenful at a time instead of as one picture too big for the phone's memory.
 *
 * "tile": {path, page (from 0), width (pixels), top, height (both in widths of the page: a band
 * from 2 to 3.5 page widths down)} → JPEG bytes. "close": {path}.
 */
class PdfTiles {
    // PdfRenderer draws one page at a time: every call goes through this one thread.
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var open: Pair<String, PdfRenderer>? = null
    private var descriptor: ParcelFileDescriptor? = null

    fun handle(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "tile" -> worker.execute {
                try {
                    val bytes = tile(
                        call.argument<String>("path")!!,
                        call.argument<Int>("page")!!,
                        call.argument<Int>("width")!!,
                        call.argument<Double>("top")!!,
                        call.argument<Double>("height")!!,
                    )
                    main.post { result.success(bytes) }
                } catch (e: Throwable) {
                    main.post { result.error("tile", e.message, null) }
                }
            }
            "close" -> worker.execute {
                if (open?.first == call.argument<String>("path")) closeOpen()
                main.post { result.success(null) }
            }
            else -> result.notImplemented()
        }
    }

    private fun renderer(path: String): PdfRenderer {
        open?.let { if (it.first == path) return it.second }
        closeOpen()
        val fd = ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY)
        val renderer = PdfRenderer(fd)
        descriptor = fd
        open = path to renderer
        return renderer
    }

    private fun closeOpen() {
        try {
            open?.second?.close()
            descriptor?.close()
        } catch (_: Exception) {
        }
        open = null
        descriptor = null
    }

    private fun tile(path: String, index: Int, width: Int, top: Double, height: Double): ByteArray {
        val page = renderer(path).openPage(index)
        try {
            val scale = width.toFloat() / page.width
            val pixels = maxOf(1, Math.round(height * width).toInt())
            val bitmap = Bitmap.createBitmap(width, pixels, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(Color.WHITE)
            // Page points to the band's pixels: scaled to the width, moved up by the band's top.
            val matrix = Matrix().apply {
                setScale(scale, scale)
                postTranslate(0f, -(top * width).toFloat())
            }
            page.render(bitmap, null, matrix, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)
            bitmap.recycle()
            return out.toByteArray()
        } finally {
            page.close()
        }
    }
}
