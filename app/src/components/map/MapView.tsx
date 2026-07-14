import type {ColorScaleConfig} from '@sqlrooms/color-scales';
import {DeckJsonMap} from '@sqlrooms/deck';
import {
  asc,
  column,
  MosaicColorLegend,
  Query,
  sql,
  useMosaicClient,
} from '@sqlrooms/mosaic';
import {cn, ResolvedTheme, useTheme} from '@sqlrooms/ui';
import {FC, useMemo, useRef, useState} from 'react';
import {MAIN_TABLE} from '../../config';
import {useRoomStore} from '../../store';
import {MapControls} from './MapControls';
import {MapInfoModal} from './MapInfoModal';

const MAP_STYLES: Record<ResolvedTheme, string> = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};

// The Anchorage bowl; the municipality stretches from Eklutna down to
// Girdwood, but almost all parcels sit here.
const INITIAL_VIEW_STATE = {
  longitude: -149.7,
  latitude: 61.15,
  zoom: 9.5,
  pitch: 0,
  bearing: 0,
};

const COLOR_FIELD = 'appraised_total_value';

const formatDollars = (v: unknown) =>
  v == null ? 'n/a' : `$${Number(v).toLocaleString('en-US')}`;

export const MapView: FC<{className?: string}> = ({className}) => {
  const brush = useRoomStore((state) => state.mosaic.selections.brush);

  const [showInfo, setShowInfo] = useState(false);

  const enableBrushing = useRoomStore(
    (state) => state.mapSettings.config.enableBrushing,
  );
  const brushRadius = useRoomStore(
    (state) => state.mapSettings.config.brushRadius,
  );
  const setEnableBrushing = useRoomStore(
    (state) => state.mapSettings.setEnableBrushing,
  );
  const setBrushRadius = useRoomStore(
    (state) => state.mapSettings.setBrushRadius,
  );

  const lastUpdateRef = useRef<number>(0);

  const {data: rawData, client} = useMosaicClient({
    selectionName: 'brush',
    query: (filter: any) =>
      Query.from(MAIN_TABLE)
        .select(
          'parcel_id',
          'parcel_address',
          'owner_name',
          'property_type',
          COLOR_FIELD,
          {
            geom: sql`ST_AsWKB(ST_Point(centroid_lon, centroid_lat))`,
          },
        )
        // A single .where() call: the filter param arrives nullish before the
        // first selection, and Mosaic drops null clauses.
        .where(filter, sql`centroid_lon IS NOT NULL`)
        // Ascending by value so the expensive parcels draw on top.
        .orderby([asc(column(COLOR_FIELD))]),
  });

  const datasets = useMemo(
    () => ({
      parcels: {
        arrowTable: rawData ?? undefined,
        geometryColumn: 'geom',
        geometryEncodingHint: 'wkb' as const,
      },
    }),
    [rawData],
  );
  const dbReady = rawData !== null;
  const {resolvedTheme} = useTheme();
  const colorScale = useMemo(() => {
    return {
      field: COLOR_FIELD,
      type: 'sequential',
      scheme: 'YlOrBr',
      // Clamped at ~p98 of appraised values; the far tail is a handful of
      // commercial parcels that would wash out the residential range.
      domain: [0, 2000000],
      reverse: resolvedTheme === 'dark',
      clamp: true,
    } satisfies ColorScaleConfig;
  }, [resolvedTheme]);

  const legendColorScale = useMemo(
    () =>
      ({
        ...colorScale,
        legend: {title: 'Appraised total value ($)'},
      }) satisfies ColorScaleConfig,
    [colorScale],
  );

  const mapSpec = useMemo(
    () => ({
      initialViewState: INITIAL_VIEW_STATE,
      layers: [
        {
          '@@type': 'GeoArrowScatterplotLayer',
          id: 'parcels',
          _sqlroomsBinding: {
            dataset: 'parcels',
          },
          getFillColor: {
            '@@function': 'colorScale',
            ...colorScale,
          },
          filled: true,
          stroked: false,
          pickable: !enableBrushing,
          getRadius: 25,
          radiusUnits: 'meters',
          radiusMinPixels: 1,
          radiusMaxPixels: 8,
        },
      ],
    }),
    [colorScale, enableBrushing],
  );

  const clearBrushSelection = () => {
    if (client) {
      brush?.update({
        source: client,
        value: null,
        predicate: null as any,
      });
    }
  };

  const onHover = (info: {coordinate?: [number, number]}) => {
    if (!enableBrushing || !client) {
      return;
    }

    if (!info.coordinate) {
      clearBrushSelection();
      lastUpdateRef.current = 0;
      return;
    }

    const now = Date.now();
    if (now - lastUpdateRef.current < 50) {
      return;
    }

    const [lon, lat] = info.coordinate;
    const metersPerDeg = 111320;
    const cosLat = Math.cos(lat * (Math.PI / 180));
    const radiusSq = brushRadius * brushRadius;

    const predicate = sql`(
      pow((centroid_lon - ${lon}) * ${cosLat * metersPerDeg}, 2) +
      pow((centroid_lat - ${lat}) * ${metersPerDeg}, 2)
    ) < ${radiusSq}`;

    brush?.update({
      source: client,
      value: [lon, lat, brushRadius],
      predicate,
    });

    lastUpdateRef.current = now;
  };

  const clearBrush = () => {
    setEnableBrushing(false);
    clearBrushSelection();
  };

  return (
    <div className={cn('flex h-full w-full', className)}>
      <div className="relative flex-1">
        <DeckJsonMap
          className="h-full w-full"
          spec={mapSpec}
          datasets={datasets}
          showLegends={false}
          mapStyle={MAP_STYLES[resolvedTheme]}
          // The camera belongs to the maplibre base map, not the deck overlay:
          // DeckJsonMap renders a MapboxOverlay that follows the map, so the
          // starting view must go through mapProps.
          mapProps={{
            projection: 'mercator',
            initialViewState: INITIAL_VIEW_STATE,
          }}
          deckProps={{
            onHover: onHover as any,
            getTooltip: ({object}: {object?: any}) =>
              !enableBrushing &&
              object && {
                html: `<div style="font-family:system-ui; font-size:12px; padding:4px;">
                    <strong>${String(object.parcel_address ?? object.parcel_id ?? '')}</strong><br/>
                    ${String(object.owner_name ?? '')}<br/>
                    ${String(object.property_type ?? '')} · ${formatDollars(object[COLOR_FIELD])}
                  </div>`,
              },
          }}
        />

        <MapControls
          dbReady={dbReady}
          enableBrushing={enableBrushing}
          setEnableBrushing={setEnableBrushing}
          brushRadius={brushRadius}
          setBrushRadius={setBrushRadius}
          clearBrush={clearBrush}
          onShowInfo={() => setShowInfo(true)}
        />

        <MosaicColorLegend
          className="absolute bottom-2 left-2 z-10"
          colorScale={legendColorScale}
          selection={brush ?? undefined}
          tickFormat="~s"
          width={220}
        />

        {showInfo ? <MapInfoModal onClose={() => setShowInfo(false)} /> : null}
      </div>
    </div>
  );
};
