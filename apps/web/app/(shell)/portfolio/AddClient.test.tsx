import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const addClientAction = vi.fn();
const push = vi.fn();
vi.mock('./actions', () => ({
  addClientAction: (...args: unknown[]) => addClientAction(...args),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const { AddClient } = await import('./AddClient');

beforeEach(() => {
  addClientAction.mockReset();
  push.mockReset();
});

describe('add a client', () => {
  it('adds the client by name and opens its setup', async () => {
    addClientAction.mockResolvedValue({ ok: true, id: 'c-new' });
    render(<AddClient />);
    expect(screen.getByRole('heading', { name: 'Add a client' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/Client name/), 'Osprey Weaving Group');
    await userEvent.keyboard('{Enter}');
    expect(addClientAction).toHaveBeenCalledWith('Osprey Weaving Group');
    expect((await screen.findByRole('status')).textContent).toBe(
      'Osprey Weaving Group was added. Opening its setup.',
    );
    expect(push).toHaveBeenCalledWith('/c/c-new/setup/entities');
  });

  it('keeps the button from submitting an empty name, and says why a name was refused', async () => {
    render(<AddClient />);
    await userEvent.click(screen.getByRole('button', { name: /Add client/ }));
    expect(addClientAction).not.toHaveBeenCalled();
    addClientAction.mockResolvedValue({
      ok: false,
      message: 'Only account admins can add a client.',
    });
    await userEvent.type(screen.getByLabelText(/Client name/), 'Highmoor Group');
    await userEvent.click(screen.getByRole('button', { name: /Add client/ }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only account admins can add a client.',
    );
    expect(push).not.toHaveBeenCalled();
  });
});
