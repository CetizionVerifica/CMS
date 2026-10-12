import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { DataTable } from './data-table/DataTable';
import { SavedViews, type SavedView, type SavedViewsProps } from './data-table/SavedViews';

function Harness(props: Partial<SavedViewsProps> & { spy?: Partial<SavedViewsProps> }) {
  const [list, setList] = useState<SavedView[]>([
    { id: 'v1', name: 'Overdue super critical' },
    { id: 'v2', name: 'My EHS' },
  ]);
  const [current, setCurrent] = useState<string | undefined>();
  const [defaultId, setDefaultId] = useState<string | undefined>();
  const { spy = {}, ...rest } = props;
  return (
    <SavedViews
      list={list}
      current={current}
      defaultId={defaultId}
      onSelect={(id) => {
        setCurrent(id);
        spy.onSelect?.(id);
      }}
      onSave={(name) => {
        setList((l) => [...l, { id: 'v3', name }]);
        setCurrent('v3');
        return spy.onSave?.(name);
      }}
      onRename={(id, name) => {
        setList((l) => l.map((v) => (v.id === id ? { ...v, name } : v)));
        return spy.onRename?.(id, name);
      }}
      onDelete={(id) => {
        setList((l) => l.filter((v) => v.id !== id));
        setCurrent(undefined);
        return spy.onDelete?.(id);
      }}
      onSetDefault={(id) => {
        setDefaultId(id);
        return spy.onSetDefault?.(id);
      }}
      {...rest}
    />
  );
}

const trigger = () => screen.getByRole('button', { name: /^View: / });

describe('SavedViews (spec 09, audit #2)', () => {
  it('lists Default and personal views as radio items and switches with the keyboard', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness spy={{ onSelect }} />);
    expect(trigger().textContent).toBe('View: Default');
    await user.tab();
    await user.keyboard('{Enter}');
    const menu = screen.getByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((i) => [i.textContent, i.getAttribute('aria-checked')]),
    ).toEqual([
      ['DefaultMy default', 'true'],
      ['Overdue super critical', 'false'],
      ['My EHS', 'false'],
    ]);
    // Default is built in: it can be saved from but not renamed or deleted.
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Save current view…']);
    await expectNoAxeViolations();
    // Opening with Enter focuses the first item (Default), so one ArrowDown reaches the first personal view.
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith('v1');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().textContent).toBe('View: Overdue super critical');
  });

  it('saves the current view under a name typed in a dialog, Enter confirming', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<Harness spy={{ onSave }} />);
    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: 'Save current view…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Save current view?' });
    const input = within(dialog).getByRole('textbox', { name: /View name/ });
    expect(document.activeElement).toBe(input);
    await user.keyboard('{Enter}');
    expect(onSave).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Enter a view name/)).toBeTruthy();
    await user.type(input, 'Riverbend this week{Enter}');
    expect(onSave).toHaveBeenCalledWith('Riverbend this week');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(trigger().textContent).toBe('View: Riverbend this week');
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it('renames with the current name pre-filled, deletes after a danger confirm and sets my default', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onDelete = vi.fn();
    const onSetDefault = vi.fn();
    render(<Harness spy={{ onRename, onDelete, onSetDefault }} />);
    await user.click(trigger());
    await user.click(screen.getByRole('menuitemradio', { name: 'My EHS' }));

    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: 'Set as my default' }));
    expect(onSetDefault).toHaveBeenCalledWith('v2');
    await user.click(trigger());
    expect(screen.getByRole('menuitemradio', { name: /My EHS/ }).textContent).toBe(
      'My EHSMy default',
    );
    // Already my default, so the item is gone.
    expect(screen.queryByRole('menuitem', { name: 'Set as my default' })).toBeNull();

    await user.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const rename = screen.getByRole('alertdialog', { name: 'Rename "My EHS"?' });
    const input = within(rename).getByRole('textbox', { name: /View name/ });
    expect((input as HTMLInputElement).value).toBe('My EHS');
    await user.clear(input);
    await user.type(input, 'EHS, all units');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onRename).toHaveBeenCalledWith('v2', 'EHS, all units');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    const del = screen.getByRole('alertdialog', { name: 'Delete "EHS, all units"?' });
    // Danger tone: focus starts on Cancel.
    expect(document.activeElement).toBe(within(del).getByRole('button', { name: 'Cancel' }));
    await user.click(within(del).getByRole('button', { name: 'Delete view' }));
    expect(onDelete).toHaveBeenCalledWith('v2');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(trigger().textContent).toBe('View: Default');
  });

  it('shows "• Edited" with Save and Discard; Save updates a personal view or asks for a name on Default', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const onDiscard = vi.fn();
    const base = {
      list: [{ id: 'v1', name: 'Overdue super critical' }],
      onSelect: () => {},
      onSave: () => {},
      onRename: () => {},
      onDelete: () => {},
      onSetDefault: () => {},
    };
    const { rerender } = render(
      <SavedViews {...base} current="v1" edited onUpdate={onUpdate} onDiscard={onDiscard} />,
    );
    expect(screen.getByText('• Edited')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onUpdate).toHaveBeenCalledWith('v1');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onDiscard).toHaveBeenCalled();

    rerender(<SavedViews {...base} edited onUpdate={onUpdate} />);
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alertdialog', { name: 'Save current view?' })).toBeTruthy();
    expect(onUpdate).toHaveBeenCalledTimes(1);

    rerender(<SavedViews {...base} current="v1" />);
    expect(screen.queryByText('• Edited')).toBeNull();
  });

  it('sits first in the DataTable toolbar through the views prop', () => {
    render(
      <DataTable
        label="Register"
        columns={[]}
        data={[]}
        rowId={(r: { id: string }) => r.id}
        rowLabel={(r) => r.id}
        views={{
          list: [],
          onSelect: () => {},
          onSave: () => {},
          onRename: () => {},
          onDelete: () => {},
          onSetDefault: () => {},
        }}
      />,
    );
    expect(trigger().textContent).toBe('View: Default');
  });
});
