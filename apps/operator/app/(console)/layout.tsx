import type { ReactNode } from 'react';

import { ConsoleShell } from '../../lib/ui/ConsoleShell';

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
