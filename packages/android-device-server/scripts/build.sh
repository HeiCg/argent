#!/usr/bin/env bash
# Build the open-source Argent device-control server APK. Runnable from any
# directory.
#
# Unlike native-devtools-android (Java + raw d8/aapt2, sources in a private
# submodule), this server is Kotlin and its sources are committed IN THIS REPO —
# being open is the point. Kotlin + the UiAutomator AAR need the Android Gradle
# Plugin, so the build wraps the committed Gradle wrapper rather than driving
# javac/d8 by hand. Gradle (via the wrapper) and an Android SDK are required.
#
# Bump assets/manifest.json AND build.gradle.kts (versionName/versionCode must
# match) in git when releasing a new server, then rebuild.
#
# Environment:
#   PREBUILT_ANDROID_DEVICE_SERVER_APK  if set, copy this path to bin/ instead of building
#   ANDROID_HOME / ANDROID_SDK_ROOT     Android SDK location (auto-detected if unset)
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${PKG_DIR}/bin"

VERSION="$(node -p "require('${PKG_DIR}/assets/manifest.json').versionName")"
VERSION_CODE="$(node -p "require('${PKG_DIR}/assets/manifest.json').versionCode")"

APK_OUT="${BIN_DIR}/argent-device-control-${VERSION}.apk"
mkdir -p "${BIN_DIR}"

if [[ -n "${PREBUILT_ANDROID_DEVICE_SERVER_APK:-}" ]]; then
  echo "Using prebuilt APK from PREBUILT_ANDROID_DEVICE_SERVER_APK"
  cp "${PREBUILT_ANDROID_DEVICE_SERVER_APK}" "${APK_OUT}"
  echo "Done. APK at ${APK_OUT}"
  exit 0
fi

if [[ -z "${ANDROID_HOME:-}" ]]; then
  if [[ -n "${ANDROID_SDK_ROOT:-}" ]]; then
    export ANDROID_HOME="${ANDROID_SDK_ROOT}"
  elif [[ -d "${HOME}/Library/Android/sdk" ]]; then
    export ANDROID_HOME="${HOME}/Library/Android/sdk"
  elif [[ -d "${HOME}/Android/Sdk" ]]; then
    export ANDROID_HOME="${HOME}/Android/Sdk"
  elif [[ -d "/opt/homebrew/share/android-commandlinetools" ]]; then
    export ANDROID_HOME="/opt/homebrew/share/android-commandlinetools"
  else
    echo "ANDROID_HOME is not set and no default SDK location found." >&2
    echo "Set ANDROID_HOME or PREBUILT_ANDROID_DEVICE_SERVER_APK." >&2
    exit 1
  fi
fi

# The AGP needs an sdk.dir; write a local.properties if the caller has not.
if [[ ! -f "${PKG_DIR}/local.properties" ]]; then
  echo "sdk.dir=${ANDROID_HOME}" > "${PKG_DIR}/local.properties"
fi

echo "→ ANDROID_HOME=${ANDROID_HOME}"
echo "→ version=${VERSION} (code ${VERSION_CODE})"
echo "→ gradle assembleDebug"

( cd "${PKG_DIR}" && ./gradlew --no-daemon assembleDebug )

BUILT_APK="${PKG_DIR}/build/outputs/apk/debug/android-device-server-debug.apk"
if [[ ! -f "${BUILT_APK}" ]]; then
  # AGP names the APK from the Gradle project name; fall back to a glob.
  BUILT_APK="$(find "${PKG_DIR}/build/outputs/apk/debug" -name '*.apk' | head -n1)"
fi
if [[ ! -f "${BUILT_APK}" ]]; then
  echo "Gradle build did not produce an APK under build/outputs/apk/debug." >&2
  exit 1
fi

cp "${BUILT_APK}" "${APK_OUT}"
echo "→ wrote ${APK_OUT} ($(stat -f%z "${APK_OUT}" 2>/dev/null || stat -c%s "${APK_OUT}") bytes)"
