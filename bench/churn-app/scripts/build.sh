#!/usr/bin/env bash
# Build the Phase E churn-experiment APK (E-1). Builds ONLY in CI (never on the
# 24 GB dev host — machine resource policy). Reuses the android-device-server
# Gradle WRAPPER via `-p` so this app ships no second gradle-wrapper.jar; it only
# needs an Android SDK (already installed on the screen-graph CI job).
#
# Output: bench/churn-app/build/outputs/apk/debug/churn-app-debug.apk
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${APP_DIR}/../.." && pwd)"
GRADLEW="${REPO_ROOT}/packages/android-device-server/gradlew"

if [[ ! -x "${GRADLEW}" ]]; then
  echo "Gradle wrapper not found at ${GRADLEW}" >&2
  exit 1
fi

if [[ -z "${ANDROID_HOME:-}" ]]; then
  if [[ -n "${ANDROID_SDK_ROOT:-}" ]]; then
    export ANDROID_HOME="${ANDROID_SDK_ROOT}"
  elif [[ -d "${HOME}/Library/Android/sdk" ]]; then
    export ANDROID_HOME="${HOME}/Library/Android/sdk"
  elif [[ -d "${HOME}/Android/Sdk" ]]; then
    export ANDROID_HOME="${HOME}/Android/Sdk"
  else
    echo "ANDROID_HOME is not set and no default SDK location found." >&2
    exit 1
  fi
fi

# AGP needs an sdk.dir in the project dir.
if [[ ! -f "${APP_DIR}/local.properties" ]]; then
  echo "sdk.dir=${ANDROID_HOME}" > "${APP_DIR}/local.properties"
fi

echo "→ ANDROID_HOME=${ANDROID_HOME}"
echo "→ gradle assembleDebug (churn-app, via android-device-server wrapper)"
( cd "${REPO_ROOT}/packages/android-device-server" && ./gradlew --no-daemon -p "${APP_DIR}" assembleDebug )

APK="${APP_DIR}/build/outputs/apk/debug/churn-app-debug.apk"
if [[ ! -f "${APK}" ]]; then
  APK="$(find "${APP_DIR}/build/outputs/apk/debug" -name '*.apk' | head -n1)"
fi
if [[ ! -f "${APK}" ]]; then
  echo "Gradle build did not produce an APK under build/outputs/apk/debug." >&2
  exit 1
fi
echo "→ built ${APK} ($(stat -f%z "${APK}" 2>/dev/null || stat -c%s "${APK}") bytes)"
