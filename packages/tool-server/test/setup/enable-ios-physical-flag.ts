import { __setIosPhysicalDevicesFlagForTests } from "../../src/utils/device-info";

// Unit tests see the 'ios-physical-devices' flag as ON. Device suites across
// the repo assert shape classification — resolveDevice on a physical-shaped
// UDID must yield kind 'device', not the flag-gate rejection — and a real
// isFlagEnabled read would make those assertions depend on the flags.json of
// the developer (or CI machine) running them, the same reasoning as
// `new Registry()` defaulting every flag to enabled. Setting the seam here,
// rather than sniffing a test-runner env var inside src, keeps the test-runner
// knowledge in test code.
//
// test/ios-physical-device-flag-gate.test.ts exercises the gate itself: it
// flips the seam per case and restores this default in afterEach. Outside
// vitest — production, and node scripts importing src directly — setup files
// never run, the override stays undefined, and the stored flag decides.
__setIosPhysicalDevicesFlagForTests(true);
