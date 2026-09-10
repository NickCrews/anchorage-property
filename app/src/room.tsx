import { RoomShell } from '@sqlrooms/room-shell';
import { roomStore } from './store';
import { useState, type FC } from 'react';
import { InfoModal } from './components/InfoModal';
import { Info } from 'lucide-react';

export const Room: FC = () => {
  const [showInfo, setShowInfo] = useState(false);
  return (
    <RoomShell className="h-screen" roomStore={roomStore}>
      <RoomShell.SidebarContainer className="gap-2">
        <RoomShell.TabButtons />
        <button
          onClick={() => setShowInfo(true)}
          className="text-muted-foreground hover:bg-accent hover:text-accent-foreground rounded p-2"
        >
          <Info size={16} />
        </button>
      </RoomShell.SidebarContainer>
      <RoomShell.LayoutComposer />
      <RoomShell.LoadingProgress />
      <RoomShell.CommandPalette />
      {showInfo ? <InfoModal onClose={() => setShowInfo(false)} /> : null}
    </RoomShell>
  );
};
