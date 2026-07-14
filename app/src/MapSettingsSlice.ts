import {BaseRoomStoreState, createSlice} from '@sqlrooms/room-shell';
import {produce} from 'immer';
import {z} from 'zod';
import {
  COLOR_BY_FIELDS,
  ColorByField,
  DEFAULT_COLOR_BY,
} from './components/map/colorByOptions';

export const MapSettingsConfig = z.object({
  enableBrushing: z.boolean().default(false),
  // Meters. Parcels are city-block scale, so the default is a neighborhood,
  // not the region-sized radius the earthquake example shipped with.
  brushRadius: z.number().default(1500),
  // The .catch() matters for persistence: a stored value that drops out of
  // the catalog degrades to the default instead of failing rehydration.
  colorBy: z.enum(COLOR_BY_FIELDS).default(DEFAULT_COLOR_BY).catch(DEFAULT_COLOR_BY),
});
export type MapSettingsConfig = z.infer<typeof MapSettingsConfig>;

export type MapSettingsSliceState = {
  mapSettings: {
    config: MapSettingsConfig;
    setEnableBrushing: (enabled: boolean) => void;
    setBrushRadius: (radius: number) => void;
    setColorBy: (field: ColorByField) => void;
  };
};

export function createDefaultMapSettingsConfig(
  props?: Partial<MapSettingsConfig>,
): MapSettingsConfig {
  return {
    enableBrushing: false,
    brushRadius: 1500,
    colorBy: DEFAULT_COLOR_BY,
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
      setColorBy: (field: ColorByField) => {
        set((state) =>
          produce(state, (draft) => {
            draft.mapSettings.config.colorBy = field;
          }),
        );
      },
    },
  }));
}
