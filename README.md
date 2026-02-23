This is a new [**React Native**](https://reactnative.dev) project, bootstrapped using [`@react-native-community/cli`](https://github.com/react-native-community/cli).

## Call logs (Android)

This app includes **native Android call log** support:

- **Permissions** (declared in `android/app/src/main/AndroidManifest.xml`):
  - `READ_CALL_LOG` – read call history
  - `READ_PHONE_STATE` – phone/SIM state
  - `READ_PHONE_NUMBERS` – multi-SIM (Android 8+)
  - `WRITE_CALL_LOG` – for future delete/export features

- **Runtime**: The app requests these permissions at runtime; the user must grant them to load call logs.
- **Capabilities**: Load and display the last 100 call log entries (number, type, date, duration, contact name) via `react-native-call-log`.

**Note:** Call log access is Android-only; iOS does not allow third-party apps to read call history.

# Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android or iOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

## Android: "Unable to locate a Java Runtime" / "adb: command not found"

You need a **JDK** and the **Android SDK** (which provides `adb` and the emulator).

### 1. Install Java 17 (required for Gradle)

On macOS with Homebrew:

```bash
brew install openjdk@17
```

Then set `JAVA_HOME` in your shell (add to `~/.zshrc` so it persists):

```bash
export JAVA_HOME="/opt/homebrew/opt/openjdk@17"   # Apple Silicon
# OR
export JAVA_HOME="/usr/local/opt/openjdk@17"     # Intel Mac
export PATH="$JAVA_HOME/bin:$PATH"
```

Reload your shell (`source ~/.zshrc`) or open a new terminal, then confirm:

```bash
java -version
# Should show openjdk 17.x
```

### 2. Install Android SDK (adb + emulator)

- **Option A – Android Studio (easiest):** Install [Android Studio](https://developer.android.com/studio). During setup it installs the SDK. Then add its tools to your PATH (add to `~/.zshrc`):

  ```bash
  export ANDROID_HOME="$HOME/Library/Android/sdk"
  export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/tools:$ANDROID_HOME/tools/bin:$PATH"
  ```

- **Option B – Command-line tools only:** Download the [command-line tools](https://developer.android.com/studio#command-tools) and install the SDK packages you need (platform-tools, emulator, a system image).

### 3. Emulator (optional)

- If you use Android Studio: **Device Manager** → **Create Device** → pick a device and system image → create an AVD. Then start it from the Device Manager or run `emulator -avd <avd_name>`.
- Or connect a **physical Android device** with USB debugging enabled; `npm run android` will install the app on it once `adb` is in PATH.

### 4. Verify

```bash
npx react-native doctor
```

Then run `npm run android` again from the project root.

---

For other issues, see the [React Native Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
