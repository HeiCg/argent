plugins {
    id("com.android.application") version "8.2.2"
    id("org.jetbrains.kotlin.android") version "1.9.22"
}

android {
    namespace = "com.argent.devicecontrol"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.argent.devicecontrol"
        minSdk = 26
        targetSdk = 34
        // Keep versionName/versionCode in sync with assets/manifest.json — the TS
        // side reads that file, the install gate compares versionCode, and the APK
        // filename embeds versionName.
        versionCode = 17
        versionName = "0.1.15"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
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

dependencies {
    // UiAutomator drives taps/swipes/keys and the accessibility hierarchy from a
    // plain custom Instrumentation (no androidTest scope needed).
    implementation("androidx.test.uiautomator:uiautomator:2.3.0")
    implementation("androidx.test:runner:1.5.2")
}
