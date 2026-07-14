import {Spec} from '@sqlrooms/mosaic';
import {MAIN_TABLE} from '../../config';

const backgroundColor = '#f5d9a6';
const foregroundColor = '#e67f5f';

export interface FilterChartItem {
  id: string;
  title: string;
  spec: Spec;
}

// The *_capped / *_clean columns are derived in the data source SQL (see
// src/store.ts): appraised values are capped near p98 so the long commercial
// tail doesn't flatten the histograms, and year built / deed date have
// upstream junk (year 1, future dates) nulled out.

/**
 * A cross-filtered histogram: the full dataset in the background color, the
 * brushed subset over it, and an intervalX selection feeding `$brush`.
 */
function histogramConfig(props: {
  id: string;
  title: string;
  column: string;
  xLabel: string;
}): FilterChartItem {
  const {id, title, column, xLabel} = props;
  const layer = (filtered: boolean) => ({
    mark: 'rectY',
    data: filtered ? {from: MAIN_TABLE, filterBy: '$brush'} : {from: MAIN_TABLE},
    x: {bin: column, maxbins: 40},
    y: {count: null},
    fill: filtered ? foregroundColor : backgroundColor,
    inset: 0.5,
  });
  return {
    id,
    title,
    spec: {
      plot: [layer(false), layer(true), {select: 'intervalX', as: '$brush'}],
      xLabel,
      yLabel: null,
      yAxis: null,
      height: 180,
      width: 380,
      margins: {left: 0, right: 10, top: 10, bottom: 30},
      params: {brush: {select: 'crossfilter'}},
    } as Spec,
  };
}

export const landVsBuildingChartConfig: FilterChartItem = {
  id: 'land-vs-building',
  title: 'Land vs building value (capped at $1M)',
  spec: {
    plot: [
      {
        mark: 'raster',
        data: {from: MAIN_TABLE, filterBy: '$brush'},
        x: 'land_value_capped',
        y: 'building_value_capped',
        fill: 'density',
        bandwidth: 0,
        pixelSize: 3,
      },
      {select: 'intervalXY', as: '$brush'},
    ],
    colorScale: 'sqrt',
    colorScheme: 'ylorrd',
    xLabel: 'Land value ($)',
    yLabel: 'Building value ($)',
    height: 250,
    width: 380,
    margins: {left: 40, right: 10, top: 15, bottom: 30},
    params: {brush: {select: 'crossfilter'}},
  } as Spec,
};

export const defaultChartConfigs: FilterChartItem[] = [
  histogramConfig({
    id: 'total-value',
    title: 'Appraised total value (capped at $2M)',
    column: 'total_value_capped',
    xLabel: 'Appraised total value ($)',
  }),
  histogramConfig({
    id: 'year-built',
    title: 'Year built',
    column: 'year_built_clean',
    xLabel: 'Year built',
  }),
  histogramConfig({
    id: 'deed-date',
    title: 'Deed date',
    column: 'deed_date_clean',
    xLabel: 'Deed date',
  }),
  landVsBuildingChartConfig,
];
