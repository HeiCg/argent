// Minimal Android app for the Phase E churn experiment (E-1). Framework widgets
// only (ListView / HorizontalScrollView) — no AndroidX — so the cold AGP resolve
// stays small and fast. Matches the android-device-server toolchain (AGP 8.2.2 /
// Kotlin 1.9.22 / compileSdk 34 / minSdk 26) so the CI SDK already has both.
plugins {
    id("com.android.application") version "8.2.2"
    id("org.jetbrains.kotlin.android") version "1.9.22"
}

android {
    namespace = "com.argent.churnapp"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.argent.churnapp"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}
