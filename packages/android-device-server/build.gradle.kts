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
        versionCode = 31
        versionName = "0.1.27"
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

    testOptions {
        // The JVM unit tests exercise pure code that only reads inlined android
        // constants (e.g. `AccessibilityWindowInfo.TYPE_*`), so default-value
        // stubbing is enough and no Robolectric runtime is needed. org.json is the
        // exception: the real library is a test dependency (below), not a stub.
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    // UiAutomator drives taps/swipes/keys and the accessibility hierarchy from a
    // plain custom Instrumentation (no androidTest scope needed).
    implementation("androidx.test.uiautomator:uiautomator:2.3.0")
    implementation("androidx.test:runner:1.5.2")

    // Local JVM unit tests (window-selection predicate, R2). No device required.
    testImplementation("junit:junit:4.13.2")
    // The real org.json on the JVM test classpath, ahead of android.jar's stubs
    // (which `isReturnDefaultValues` turns into no-ops), so the RPC parameter parsing
    // of the gesture handlers is tested against real JSONObjects.
    testImplementation("org.json:json:20240303")
}
