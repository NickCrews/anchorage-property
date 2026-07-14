import type {ColorScaleConfig} from '@sqlrooms/color-scales';

/** The columns the map can be colored by; `colorBy` in MapSettingsConfig. */
export const COLOR_BY_FIELDS = [
  'appraised_total_value',
  'appraised_land_value',
  'appraised_building_value',
  'taxable_value',
  'year_built_clean',
  'property_type',
] as const;
export type ColorByField = (typeof COLOR_BY_FIELDS)[number];

export type ColorByOption = {
  /** Dropdown entry and legend title. */
  label: string;
  /** Base scale; MapView flips `reverse` for dark theme on sequential scales. */
  scale: ColorScaleConfig & {field: ColorByField};
  /** d3-format string for legend ticks (ignored for categorical scales). */
  tickFormat?: string;
  /** Renders the raw column value for the tooltip. */
  formatValue: (v: unknown) => string;
};

export const formatDollars = (v: unknown) =>
  v == null ? 'n/a' : `$${Number(v).toLocaleString('en-US')}`;

const formatPlain = (v: unknown) => (v == null ? 'n/a' : String(v));

// Dollar domains are clamped near p98; the far tail is a handful of
// commercial parcels that would wash out the residential range. They match
// the *_capped columns the filter histograms use (see src/store.ts).
export const COLOR_BY_OPTIONS: ColorByOption[] = [
  {
    label: 'Appraised total value ($)',
    scale: {
      field: 'appraised_total_value',
      type: 'sequential',
      scheme: 'YlOrBr',
      domain: [0, 2_000_000],
      clamp: true,
    },
    tickFormat: '~s',
    formatValue: formatDollars,
  },
  {
    label: 'Appraised land value ($)',
    scale: {
      field: 'appraised_land_value',
      type: 'sequential',
      scheme: 'YlOrBr',
      domain: [0, 1_000_000],
      clamp: true,
    },
    tickFormat: '~s',
    formatValue: formatDollars,
  },
  {
    label: 'Appraised building value ($)',
    scale: {
      field: 'appraised_building_value',
      type: 'sequential',
      scheme: 'YlOrBr',
      domain: [0, 1_000_000],
      clamp: true,
    },
    tickFormat: '~s',
    formatValue: formatDollars,
  },
  {
    // NULL = unvalued parcel (gray nullColor), 0 = fully exempted; the
    // distinction is deliberate upstream, so both render differently here.
    label: 'Taxable value ($)',
    scale: {
      field: 'taxable_value',
      type: 'sequential',
      scheme: 'YlOrBr',
      domain: [0, 2_000_000],
      clamp: true,
    },
    tickFormat: '~s',
    formatValue: formatDollars,
  },
  {
    label: 'Year built',
    scale: {
      field: 'year_built_clean',
      type: 'sequential',
      scheme: 'Viridis',
      domain: [1950, 2026],
      clamp: true,
    },
    tickFormat: 'd',
    formatValue: formatPlain,
  },
  {
    label: 'Property type',
    scale: {
      field: 'property_type',
      type: 'categorical',
      scheme: 'Tableau10',
    },
    formatValue: formatPlain,
  },
];

export const DEFAULT_COLOR_BY: ColorByField = 'appraised_total_value';

export function resolveColorByOption(field: ColorByField): ColorByOption {
  return (
    COLOR_BY_OPTIONS.find((o) => o.scale.field === field) ??
    COLOR_BY_OPTIONS[0]!
  );
}
