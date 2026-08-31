export interface SetLocationParams {
  udid: string;
  latitude: number;
  longitude: number;
}

export interface SetLocationResult {
  located: boolean;
  latitude: number;
  longitude: number;
}

export type SetLocationServices = Record<string, never>;
