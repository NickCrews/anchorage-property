import { RoomShell } from '@sqlrooms/room-shell';
import { roomStore } from './store';
import type { FC } from 'react';

export const Room: FC = () => {
  return (
    <RoomShell className="h-screen" roomStore={roomStore}>
      <RoomShell.SidebarContainer className="gap-2">
        <RoomShell.TabButtons />
      </RoomShell.SidebarContainer>
      <RoomShell.LayoutComposer />
      <RoomShell.LoadingProgress />
      <RoomShell.CommandPalette />
    </RoomShell>
  );
};
