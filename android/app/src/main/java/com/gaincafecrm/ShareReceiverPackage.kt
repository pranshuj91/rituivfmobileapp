package com.gaincafecrm

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers ShareReceiver so it is reachable as NativeModules.ShareReceiver under
 * the new architecture (bridgeless) through the legacy-module interop layer.
 */
class ShareReceiverPackage : TurboReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == ShareReceiverModule.NAME) ShareReceiverModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
    ReactModuleInfoProvider {
      mapOf(
        ShareReceiverModule.NAME to ReactModuleInfo(
          ShareReceiverModule.NAME,
          ShareReceiverModule::class.java.name,
          false, // canOverrideExistingModule
          false, // needsEagerInit
          false, // isCxxModule
          false, // isTurboModule (legacy module, served through interop)
        )
      )
    }
}
