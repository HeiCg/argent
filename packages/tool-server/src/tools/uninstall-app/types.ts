export interface UninstallAppParams {
  udid: string;
  bundleId: string;
}

export interface UninstallAppResult {
  /** True when the app was removed; false when it was already absent (a no-op). */
  uninstalled: boolean;
  bundleId: string;
}

export type UninstallAppServices = Record<string, never>;
