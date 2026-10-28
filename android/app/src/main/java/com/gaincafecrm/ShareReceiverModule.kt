package com.gaincafecrm

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/** JS-facing side of "Share to Gaincafe CRM". */
class ShareReceiverModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

  override fun getName(): String = "ShareReceiver"

  /** Returns files shared into the app since the last call, then forgets them. */
  @ReactMethod
  fun getPendingShares(promise: Promise) {
    val array = Arguments.createArray()
    ShareIntentStore.drain().forEach { array.pushMap(ShareIntentStore.toMap(it)) }
    promise.resolve(array)
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
