import type { ReactNode } from 'react';

import { ShellFrame } from '../../lib/shell/ShellFrame';
import { loadShell, shellLayoutHint } from '../../lib/shell/server';

// Every signed-in page: the AppShell around it. Signed-out users go to /login and come back here afterwards.
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const [model, layout] = await Promise.all([loadShell(), shellLayoutHint()]);
  return (
    <ShellFrame model={model} initialLayout={layout}>
      {children}
    </ShellFrame>
  );
}
