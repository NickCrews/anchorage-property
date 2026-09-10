import { Flashlight } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Slider,
  Switch,
} from '@sqlrooms/ui';
import { FC, ReactNode } from 'react';
import { COLOR_BY_OPTIONS, ColorByField } from './colorByOptions';

interface MapControlsProps {
  dbReady: boolean;
  colorBy: ColorByField;
  setColorBy: (v: ColorByField) => void;
  /** Color ramp or category swatches for the current field. */
  legend: ReactNode;
  enableBrushing: boolean;
  setEnableBrushing: (v: boolean) => void;
  brushRadius: number;
  setBrushRadius: (v: number) => void;
  clearBrush: () => void;
}

const SectionLabel: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
    {children}
  </span>
);

/**
 * The map's one floating card: what the colors mean, and whether hovering
 * spotlight-filters the rest of the app.
 */
export function MapControls({
  dbReady,
  colorBy,
  setColorBy,
  legend,
  enableBrushing,
  setEnableBrushing,
  brushRadius,
  setBrushRadius,
  clearBrush,
}: MapControlsProps) {
  if (!dbReady) {
    return (
      <div className="bg-card/90 absolute top-3 right-3 z-50 flex w-[264px] flex-col gap-3 rounded-lg border p-3 shadow-xl backdrop-blur">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="bg-card/90 text-card-foreground absolute top-3 right-3 z-50 flex w-[264px] flex-col rounded-lg border p-3 shadow-xl backdrop-blur">
      <div className="flex flex-col gap-1.5">
        <SectionLabel>Color by</SectionLabel>
        <Select
          value={colorBy}
          // Safe cast: the only selectable values are COLOR_BY_OPTIONS items.
          onValueChange={(v) => setColorBy(v as ColorByField)}
        >
          <SelectTrigger className="h-8 w-full text-xs">
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
        {legend}
      </div>

      <div className="bg-border my-3 h-px" />

      <div className="flex flex-col gap-2">
        <label
          htmlFor="spotlight-toggle"
          className="flex cursor-pointer items-center justify-between gap-2"
        >
          <span className="flex items-center gap-1.5">
            {/* #e67f5f is the app accent, also the histogram bar color. */}
            <Flashlight
              size={13}
              className={
                enableBrushing ? 'text-[#e67f5f]' : 'text-muted-foreground'
              }
            />
            <SectionLabel>Spotlight filter</SectionLabel>
          </span>
          <Switch
            id="spotlight-toggle"
            checked={enableBrushing}
            onCheckedChange={(on) =>
              on ? setEnableBrushing(true) : clearBrush()
            }
            className="data-[state=checked]:bg-[#e67f5f]"
          />
        </label>
        <p className="text-muted-foreground text-[11px] leading-snug">
          Hover the map to filter to nearby parcels.
        </p>

        {enableBrushing && (
          <div className="flex flex-col gap-1.5">
            <div className="text-muted-foreground flex justify-between text-[11px]">
              <span>Radius</span>
              <span className="tabular-nums">
                {(brushRadius / 1000).toFixed(1)} km
              </span>
            </div>
            <Slider
              value={[brushRadius]}
              min={100}
              max={10000}
              step={100}
              onValueChange={([v]) => setBrushRadius(v ?? brushRadius)}
              // Radix exposes no styling hooks on the track parts; the range is
              // the track's only child and the thumb carries role="slider".
              className="[&>span:first-child>span]:bg-[#e67f5f] [&_[role=slider]]:border-[#e67f5f]"
            />
          </div>
        )}
      </div>
    </div>
  );
}
