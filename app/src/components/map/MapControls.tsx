import {Flashlight, MousePointer2, Info} from 'lucide-react';
import {Skeleton} from '@sqlrooms/ui';

interface MapControlsProps {
  dbReady: boolean;
  enableBrushing: boolean;
  setEnableBrushing: (v: boolean) => void;
  brushRadius: number;
  setBrushRadius: (v: number) => void;
  clearBrush: () => void;
  onShowInfo: () => void;
}

export function MapControls({
  dbReady,
  enableBrushing,
  setEnableBrushing,
  brushRadius,
  setBrushRadius,
  clearBrush,
  onShowInfo,
}: MapControlsProps) {
  return (
    <div className="bg-card/90 text-card-foreground absolute top-4 right-4 z-50 flex w-64 flex-col gap-4 rounded-sm border p-2 shadow-xl backdrop-blur">
      <div className="flex items-center gap-2">
        {!dbReady && (
          <>
            <Skeleton />
            <Skeleton />
          </>
        )}

        {dbReady && (
          <>
            <button
              onClick={clearBrush}
              className={`flex flex-1 items-center justify-center gap-2 rounded p-2 ${
                !enableBrushing
                  ? 'bg-[#e67f5f] text-white'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              }`}
            >
              <MousePointer2 size={16} />
              <span className="text-xs font-medium">View</span>
            </button>

            <button
              onClick={() => setEnableBrushing(true)}
              className={`flex flex-1 items-center justify-center gap-2 rounded p-2 ${
                enableBrushing
                  ? 'bg-[#e67f5f] text-white'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              }`}
            >
              <Flashlight size={16} />
              <span className="text-xs font-medium">Brush</span>
            </button>

            <button
              onClick={onShowInfo}
              className="text-muted-foreground hover:bg-accent hover:text-accent-foreground rounded p-2"
            >
              <Info size={16} />
            </button>
          </>
        )}
      </div>

      {enableBrushing && (
        <div className="space-y-2">
          <div className="text-muted-foreground flex justify-between text-xs">
            <span>Radius</span>
            <span>{(brushRadius / 1000).toFixed(1)} km</span>
          </div>
          <input
            type="range"
            min="100"
            max="10000"
            step="100"
            value={brushRadius}
            onChange={(e) => setBrushRadius(Number(e.target.value))}
            className="bg-muted h-1 w-full cursor-pointer rounded-sm accent-[#e67f5f]"
          />
        </div>
      )}
    </div>
  );
}
