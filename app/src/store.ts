import {createWasmDuckDbConnector} from '@sqlrooms/duckdb';
import {createMosaicSlice} from '@sqlrooms/mosaic';
import {MosaicSliceState} from '@sqlrooms/mosaic/dist/MosaicSlice';
import {
  createRoomShellSlice,
  createRoomStore,
  LayoutConfig,
  persistSliceConfigs,
  RoomShellSliceState,
} from '@sqlrooms/room-shell';
import {
  createSqlEditorSlice,
  SqlEditorSliceConfig,
  SqlEditorSliceState,
} from '@sqlrooms/sql-editor';
import {DatabaseIcon} from 'lucide-react';
import {z} from 'zod';
import DataSourcesPanel from './components/data-sources/DataSourcesPanel';
import {MainView} from './components/MainView';
import {DATA_URL, MAIN_TABLE} from './config';
import {
  createMapSettingsSlice,
  MapSettingsConfig,
  MapSettingsSliceState,
} from './MapSettingsSlice';

export const RoomPanelTypes = z.enum(['left', 'data', 'main'] as const);
export type RoomPanelTypes = z.infer<typeof RoomPanelTypes>;

export type RoomState = RoomShellSliceState &
  SqlEditorSliceState &
  MosaicSliceState &
  MapSettingsSliceState;

export const {roomStore, useRoomStore} = createRoomStore<RoomState>(
  persistSliceConfigs(
    {
      name: 'anchorage-parcel-explorer-state',
      // `room` (title + dataSources) is deliberately NOT persisted: it's
      // static code config, and rehydrating it replays whatever dataSources a
      // previous version of the app wrote to localStorage. An early build
      // loaded parcels via a `sql` data source reading `source.parcels_current`;
      // rehydrating that entry re-ran it against a long-detached catalog and
      // crashed the app at startup.
      sliceConfigSchemas: {
        layout: LayoutConfig,
        sqlEditor: SqlEditorSliceConfig,
        mapSettings: MapSettingsConfig,
      },
    },
    (set, get, store) => ({
      // Sql editor slice
      ...createSqlEditorSlice()(set, get, store),

      // Room shell slice
      ...createRoomShellSlice({
        connector: createWasmDuckDbConnector({
          // The artifact is attached whole (duckdb-wasm downloads it in full;
          // see src/export.ts in the repo root) and copied into in-memory
          // tables, so every later query is local. This happens in the
          // initialization query rather than as a `sql`-type data source
          // because those are materialized into an internal attached database
          // (`__sqlrooms_ephemeral`) that bare `FROM parcels` queries cannot
          // resolve.
          //
          // The capped/cleaned columns exist for the filter charts: raw
          // appraised values have a huge right tail (max ~$400M against a
          // ~$400k median) that would flatten any histogram, and year_built /
          // deed_date carry upstream junk (year 1, dates in the future).
          // The CASE guards matter: DuckDB's least() ignores NULLs, so a bare
          // least(x, cap) would turn an unvalued parcel into a phantom
          // parcel at the cap.
          initializationQuery: `
            LOAD spatial;
            ATTACH '${DATA_URL}' AS source (READ_ONLY);
            CREATE TABLE ${MAIN_TABLE} AS
              SELECT *,
                CASE WHEN appraised_total_value IS NOT NULL
                     THEN least(appraised_total_value, 2000000) END AS total_value_capped,
                CASE WHEN appraised_land_value IS NOT NULL
                     THEN least(appraised_land_value, 1000000) END AS land_value_capped,
                CASE WHEN appraised_building_value IS NOT NULL
                     THEN least(appraised_building_value, 1000000) END AS building_value_capped,
                CASE WHEN year_built_min BETWEEN 1900 AND year(current_date)
                     THEN year_built_min END AS year_built_clean,
                CASE WHEN deed_date BETWEEN TIMESTAMP '1950-01-01' AND now()
                     THEN deed_date END AS deed_date_clean
              FROM source.parcels_current;
            CREATE TABLE ingest_runs AS SELECT * FROM source.ingest_runs;
            DETACH source;
          `,
        }),
        config: {
          dataSources: [],
        },
        layout: {
          config: {
            id: 'root',
            type: 'split',
            direction: 'row',
            children: [
              {
                type: 'tabs',
                id: RoomPanelTypes.enum.left,
                children: [RoomPanelTypes.enum.data],
                defaultSize: '30%',
                maxSize: '50%',
                minSize: '300px',
                activeTabIndex: 0,
                collapsible: true,
                collapsed: true,
                collapsedSize: 0,
                hideTabStrip: true,
              },
              {
                type: 'panel',
                id: RoomPanelTypes.enum.main,
                panel: RoomPanelTypes.enum.main,
              },
            ],
          } satisfies LayoutConfig,
          panels: {
            [RoomPanelTypes.enum.data]: {
              title: 'Data',
              icon: DatabaseIcon,
              component: DataSourcesPanel,
            },
            [RoomPanelTypes.enum.main]: {
              title: 'Main view',
              icon: () => null,
              component: MainView,
            },
          },
        },
      })(set, get, store),

      ...createMosaicSlice()(set, get, store),

      ...createMapSettingsSlice()(set, get, store),
    }),
  ),
);
