import { screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/** Picks `option` in the design system's Select labelled `label` (a Radix listbox). */
export async function choose(user: UserEvent, label: string, option: string) {
  const trigger = screen.getByRole('combobox', { name: label });
  trigger.focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('option', { name: option }));
}
