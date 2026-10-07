import type {
  NativeDevtoolsApi,
  NativeDevtoolsInitFailedResult,
} from "../../blueprints/native-devtools";

export interface LaunchAppParams {
  udid: string;
  bundleId: string;
  /** Android-only. */
  activity?: string;
}

export type LaunchAppResult =
  | {
      launched: boolean;
      bundleId: string;
      note?: string;
      /**
       * iOS simulator, `open-ios-device-server` flag: the app launched but the
       * open runner's target could not be set, so later verbs use the
       * proprietary path. Set only then.
       */
      backend?: "proprietary-fallback";
      fallbackReason?: string;
    }
  | NativeDevtoolsInitFailedResult;

export interface LaunchAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type LaunchAppVegaServices = Record<string, never>;
