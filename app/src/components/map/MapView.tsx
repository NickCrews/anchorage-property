import type {ColorScaleConfig} from '@sqlrooms/color-scales';
import {categoricalSchemeColors} from '@sqlrooms/color-scales';
import {DeckJsonMap} from '@sqlrooms/deck';
import {
  asc,
  column,
  MosaicColorLegend,
  Query,
  sql,
  useMosaicClient,
} from '@sqlrooms/mosaic';
import {
  cn,
  ResolvedTheme,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useTheme,
} from '@sqlrooms/ui';
import {FC, useMemo, useRef, useState} from 'react';
import {MAIN_TABLE} from '../../config';
import {useRoomStore} from '../../store';
import {
  COLOR_BY_OPTIONS,
  ColorByField,
  formatDollars,
  resolveColorByOption,
} from './colorByOptions';
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

// Always queried: the tooltip shows these regardless of the color field.
const BASE_COLUMNS = [
  'parcel_id',
  'parcel_address',
  'owner_name',
  'property_type',
  'appraised_total_value',
];

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
  const colorBy = useRoomStore((state) => state.mapSettings.config.colorBy);
  const setColorBy = useRoomStore((state) => state.mapSettings.setColorBy);
  const colorByOption = resolveColorByOption(colorBy);
  const colorField = colorByOption.scale.field;

  const lastUpdateRef = useRef<number>(0);

  const {data: rawData, client} = useMosaicClient({
    // useMosaicClient holds `query` in a ref, so switching the color field
    // must change the id to tear down and rebuild the client.
    id: `map-parcels-${colorField}`,
    selectionName: 'brush',
    query: (filter: any) =>
      Query.from(MAIN_TABLE)
        .select(
          ...(BASE_COLUMNS.includes(colorField)
            ? BASE_COLUMNS
            : [...BASE_COLUMNS, colorField]),
          {
            geom: sql`ST_AsWKB(ST_Point(centroid_lon, centroid_lat))`,
          },
        )
        // A single .where() call: the filter param arrives nullish before the
        // first selection, and Mosaic drops null clauses.
        .where(filter, sql`centroid_lon IS NOT NULL`)
        // Ascending by the color field so high values draw on top; for
        // categorical fields this also fixes the category → color assignment
        // to alphabetical order.
        .orderby([asc(column(colorField))]),
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
  const colorScale = useMemo<ColorScaleConfig>(() => {
    if (colorByOption.scale.type === 'categorical') {
      return colorByOption.scale;
    }
    return {...colorByOption.scale, reverse: resolvedTheme === 'dark'};
  }, [colorByOption.scale, resolvedTheme]);

  // The deck colorScale assigns categorical colors by order of first
  // appearance in the data (cycling through the scheme); mirror that here so
  // the legend stays in sync even when cross-filters hide a category.
  const categoricalSwatches = useMemo(() => {
    if (colorScale.type !== 'categorical' || !rawData) {
      return undefined;
    }
    const values = rawData.getChild(colorScale.field);
    if (!values) {
      return undefined;
    }
    const seen = new Set<string>();
    for (const value of values) {
      if (value != null) {
        seen.add(String(value));
      }
    }
    const colors = categoricalSchemeColors[colorScale.scheme];
    return [...seen].map((label, i) => ({
      label,
      color: colors[i % colors.length]!,
    }));
  }, [colorScale, rawData]);

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
                    ${String(object.property_type ?? '')} · ${formatDollars(object.appraised_total_value)}${
                      BASE_COLUMNS.includes(colorField)
                        ? ''
                        : `<br/>${colorByOption.label}: ${colorByOption.formatValue(object[colorField])}`
                    }
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

        {/* The dropdown doubles as the legend's title. */}
        <div className="absolute bottom-2 left-2 z-10 flex w-[244px] flex-col gap-1">
          <Select
            value={colorField}
            // Safe cast: the only selectable values are COLOR_BY_OPTIONS items.
            onValueChange={(v) => setColorBy(v as ColorByField)}
          >
            <SelectTrigger className="bg-card/90 text-card-foreground h-8 w-full border text-xs shadow-lg backdrop-blur">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COLOR_BY_OPTIONS.map((option) => (
                <SelectItem
                  key={option.scale.field}
                  value={option.scale.field}
                  className="text-xs"
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {colorScale.type === 'categorical' ? (
            categoricalSwatches && (
              <div className="bg-card/90 text-card-foreground rounded-md border px-3 py-2 text-xs shadow-lg backdrop-blur">
                {categoricalSwatches.map(({label, color}) => (
                  <div key={label} className="flex items-center gap-2 py-0.5">
                    <span
                      className="h-3 w-3 shrink-0 rounded-sm"
                      style={{background: color}}
                    />
                    {label}
                  </div>
                ))}
              </div>
            )
          ) : (
            <MosaicColorLegend
              // No title: the dropdown names the field, but the legend would
              // fall back to the raw column name. Hide the bold svg label and
              // reclaim its row (ramp starts at y=18 in the 46px viewBox).
              className="[&_svg]:-mt-3.5 [&_svg>text[font-weight=bold]]:hidden"
              colorScale={colorScale}
              selection={brush ?? undefined}
              tickFormat={colorByOption.tickFormat}
              width={220}
            />
          )}
        </div>

        {showInfo ? <MapInfoModal onClose={() => setShowInfo(false)} /> : null}
      </div>
    </div>
  );
};
