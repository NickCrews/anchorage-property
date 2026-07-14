import { DataTableExplorer, useDataTable } from '@sqlrooms/mosaic';
import { cn } from '@sqlrooms/ui';
import { FC, useMemo } from 'react';
import { MAIN_TABLE } from '../../config';
import { useRoomStore } from '../../store';

type ParcelProfilerProps = { className?: string };

// Every column here costs a Mosaic summary client that re-queries on each
// brush move (the full table has 80 columns, several of near-unique
// cardinality like legal_description, which made filter drags crawl), so the
// profiler shows only this curated set. The full width is still available in
// the SQL editor.
const PROFILER_COLUMNS = [
  'parcel_address',
  'owner_name',
  'property_type',
  'land_use',
  'zoning_district',
  'appraised_land_value',
  'appraised_building_value',
  'appraised_total_value',
  'total_exemptions',
  'exemption_type_group',
  'taxable_value',
  'year_built_min',
  'deed_date',
  'lot_size',
  'total_living_units',
];

export const ParcelProfiler: FC<ParcelProfilerProps> = ({ className }) => {
  const mosaic = useRoomStore((state) => state.mosaic);
  const brush = useMemo(() => mosaic.getSelection('brush'), [mosaic]);

  const dataTable = useDataTable(MAIN_TABLE);

  if (!dataTable) {
    return (
      <div
        className={cn(
          'bg-background flex h-full w-full items-center justify-center',
          className,
        )}
      >
        No data table found.
      </div>
    );
  }

  return (
    <section
      className={cn('bg-background flex min-h-0 flex-col border-t', className)}
    >
      <DataTableExplorer
        pageSize={25}
        selection={brush}
        tableName={dataTable}
        columns={PROFILER_COLUMNS}
      >
        <div className="flex items-center justify-between gap-4 px-3 py-2">
          <div>
            <h2 className="text-sm font-semibold">Parcel Profiler</h2>
            <p className="text-muted-foreground text-xs">
              Cross-filtered rows and per-column summaries powered by Mosaic.
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="h-full w-full overflow-auto">
            <DataTableExplorer.Table>
              <DataTableExplorer.Header />
              <DataTableExplorer.Rows />
            </DataTableExplorer.Table>
          </div>
        </div>

        <DataTableExplorer.StatusBar />
      </DataTableExplorer>
    </section>
  );
};
