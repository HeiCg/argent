export interface OpenUrlParams {
  udid: string;
  url: string;
}

export interface OpenUrlResult {
  opened: boolean;
  url: string;
  /**
   * Deep-link caveat: set for http(s) URLs on iOS/Android, and on HarmonyOS for
   * every URL (`aa start -U` reports success for any URI the system accepts);
   * never for custom schemes or Chromium.
   */
  note?: string;
}

export type OpenUrlServices = Record<string, never>;
