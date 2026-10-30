package com.gaincafecrm

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/** JS-facing side of "Share to Gaincafe CRM". */
class ShareReceiverModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

  companion object {
    const val NAME = "ShareReceiver"
  }

  override fun getName(): String = NAME

  /** Returns files shared into the app since the last call, then forgets them. */
  @ReactMethod
  fun getPendingShares(promise: Promise) {
    val array = Arguments.createArray()
    ShareIntentStore.drain().forEach { array.pushMap(ShareIntentStore.toMap(it)) }
    promise.resolve(array)
  }

  /** Phone make/model and the default dialer package, so JS can pick the right recording mode. */
  @ReactMethod
  fun getDeviceInfo(promise: Promise) {
    val map = Arguments.createMap()
    map.putString("manufacturer", android.os.Build.MANUFACTURER ?: "")
    map.putString("brand", android.os.Build.BRAND ?: "")
    map.putString("model", android.os.Build.MODEL ?: "")
    map.putInt("sdk", android.os.Build.VERSION.SDK_INT)
    var dialer = ""
    try {
      val telecom = reactApplicationContext.getSystemService(android.content.Context.TELECOM_SERVICE)
        as? android.telecom.TelecomManager
      dialer = telecom?.defaultDialerPackage ?: ""
    } catch (e: Exception) {
      dialer = ""
    }
    map.putString("dialer", dialer)
    promise.resolve(map)
  }

  /** Deletes a file copied into the app cache once it has been uploaded or discarded. */
  @ReactMethod
  fun deleteFile(path: String, promise: Promise) {
    try {
      promise.resolve(File(path).delete())
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  // Keep NativeEventEmitter quiet; events go through RCTDeviceEventEmitter.
  @ReactMethod
  fun addListener(eventName: String) = Unit

  @ReactMethod
  fun removeListeners(count: Int) = Unit
}
