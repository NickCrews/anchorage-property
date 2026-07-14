import {BaseRoomStoreState, createSlice} from '@sqlrooms/room-shell';
import {produce} from 'immer';
import {z} from 'zod';

export const MapSettingsConfig = z.object({
  enableBrushing: z.boolean().default(false),
  // Meters. Parcels are city-block scale, so the default is a neighborhood,
  // not the region-sized radius the earthquake example shipped with.
  brushRadius: z.number().default(1500),
});
export type MapSettingsConfig = z.infer<typeof MapSettingsConfig>;

export type MapSettingsSliceState = {
  mapSettings: {
    config: MapSettingsConfig;
    setEnableBrushing: (enabled: boolean) => void;
    setBrushRadius: (radius: number) => void;
  };
};

export function createDefaultMapSettingsConfig(
  props?: Partial<MapSettingsConfig>,
): MapSettingsConfig {
  return {
    enableBrushing: false,
    brushRadius: 1500,
    ...props,
  } as MapSettingsConfig;
}

export function createMapSettingsSlice(props?: {
  config?: Partial<MapSettingsConfig>;
}) {
  return createSlice<
    MapSettingsSliceState,
    BaseRoomStoreState & MapSettingsSliceState
  >((set, _get, _store) => ({
    mapSettings: {
      config: createDefaultMapSettingsConfig(props?.config),
      setEnableBrushing: (enabled: boolean) => {
        set((state) =>
          produce(state, (draft) => {
            draft.mapSettings.config.enableBrushing = enabled;
          }),
        );
      },
      setBrushRadius: (radius: number) => {
        set((state) =>
          produce(state, (draft) => {
            draft.mapSettings.config.brushRadius = radius;
          }),
        );
      },
    },
  }));
}
