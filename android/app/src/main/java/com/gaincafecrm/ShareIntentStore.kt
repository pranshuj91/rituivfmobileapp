package com.gaincafecrm

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileOutputStream

/**
 * Receives audio files shared into the app ("Share to Gaincafe CRM"), copies them
 * into the app cache while the sender's URI grant is still valid, and hands them
 * to JavaScript either through an event or through ShareReceiverModule.getPendingShares().
 */
object ShareIntentStore {
  const val EVENT_NAME = "GaincafeShareReceived"
  private const val TAG = "ShareIntentStore"

  data class SharedFile(
    val path: String,
    val name: String,
    val mime: String,
    val size: Long,
    val receivedAt: Long,
  )

  private val pending = mutableListOf<SharedFile>()

  @Synchronized
  fun drain(): List<SharedFile> {
    val copy = pending.toList()
    pending.clear()
    return copy
  }

  fun toMap(f: SharedFile): WritableMap =
    Arguments.createMap().apply {
      putString("path", f.path)
      putString("name", f.name)
      putString("mime", f.mime)
      putDouble("size", f.size.toDouble())
      putDouble("receivedAt", f.receivedAt.toDouble())
    }

  @Suppress("DEPRECATION")
  fun handleIntent(context: Context, intent: Intent?) {
    if (intent == null) return
    val action = intent.action ?: return
    val uris = mutableListOf<Uri>()
    when (action) {
      Intent.ACTION_SEND -> intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.add(it) }
      Intent.ACTION_SEND_MULTIPLE ->
        intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
      else -> return
    }
    if (uris.isEmpty()) return

    val fallbackMime = intent.type ?: "application/octet-stream"
    val dir = File(context.cacheDir, "shared").apply { mkdirs() }
    val received = mutableListOf<SharedFile>()
    for (uri in uris) {
      try {
        val rawName = queryDisplayName(context, uri) ?: "recording_${System.currentTimeMillis()}.m4a"
        val safeName = rawName.replace(Regex("[^A-Za-z0-9._()+ -]"), "_")
        val out = File(dir, "${System.currentTimeMillis()}_$safeName")
        val input = context.contentResolver.openInputStream(uri) ?: continue
        input.use { source -> FileOutputStream(out).use { sink -> source.copyTo(sink) } }
        val mime = context.contentResolver.getType(uri) ?: fallbackMime
        received.add(SharedFile(out.absolutePath, safeName, mime, out.length(), System.currentTimeMillis()))
      } catch (e: Exception) {
        Log.w(TAG, "Could not copy shared file: ${e.message}")
      }
    }
    if (received.isEmpty()) return

    synchronized(this) { pending.addAll(received) }
    // Consume the intent so a configuration change does not import the file twice.
    intent.action = Intent.ACTION_MAIN
    intent.removeExtra(Intent.EXTRA_STREAM)
    emit(context, received)
  }

  private fun emit(context: Context, files: List<SharedFile>) {
    try {
      val app = context.applicationContext as? ReactApplication ?: return
      val reactContext = app.reactHost?.currentReactContext ?: return
      val array = Arguments.createArray()
      files.forEach { array.pushMap(toMap(it)) }
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(EVENT_NAME, array)
    } catch (e: Exception) {
      // JS not ready yet; getPendingShares() will pick the files up.
      Log.d(TAG, "emit skipped: ${e.message}")
    }
  }

  private fun queryDisplayName(context: Context, uri: Uri): String? {
    if (uri.scheme == "file") return uri.lastPathSegment
    try {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (index >= 0) return cursor.getString(index)
        }
      }
    } catch (e: Exception) {
      Log.d(TAG, "display name lookup failed: ${e.message}")
    }
    return uri.lastPathSegment
  }
}
