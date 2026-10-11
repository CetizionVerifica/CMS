import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { Combobox, type ComboboxOption } from './Combobox';
import { Input, Textarea } from './Field';
import { Select } from './Select';

describe('Input and Textarea', () => {
  it('wires label, helper and error and accepts typing', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Input label="Challan number" helper="As printed on the receipt" />
        <Input label="Amount" error="Enter an amount" />
        <Textarea label="Reason for sending back" />
      </div>,
    );
    const challan = screen.getByRole('textbox', { name: 'Challan number' });
    expect(challan).toHaveProperty('ariaInvalid', null);
    expect(screen.getByRole('textbox', { description: 'As printed on the receipt' })).toBe(challan);

    const amount = screen.getByRole('textbox', { name: 'Amount' });
    expect(amount.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('textbox', { description: 'Enter an amount' })).toBe(amount);
    expect(amount.className).toContain('border-crit');

    await user.tab();
    expect(document.activeElement).toBe(challan);
    await user.keyboard('CH-0042');
    expect((challan as HTMLInputElement).value).toBe('CH-0042');
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Reason for sending back' }),
    );
    await expectNoAxeViolations();
  });

  it('can hide the label visually but keep the name', () => {
    render(<Input label="Search register" hideLabel placeholder="Search" />);
    expect(screen.getByText('Search register').className).toBe('sr-only');
    expect(screen.getByRole('textbox', { name: 'Search register' })).toBeTruthy();
  });
});

describe('Select', () => {
  it('opens with the keyboard, moves with arrows and selects with Enter', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Select
        label="Department"
        helper="Who owns this obligation"
        options={[
          { value: 'hr', label: 'Human resources' },
          { value: 'ehs', label: 'EHS' },
          { value: 'fin', label: 'Finance', disabled: true },
        ]}
        onValueChange={onValueChange}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Department' });
    expect(trigger.textContent).toContain('Choose…');
    await expectNoAxeViolations();
    await user.tab();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard('{Enter}');
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeTruthy();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('ehs');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('shows an error state', () => {
    render(<Select label="Approver" error="Choose an approver" options={[]} />);
    const trigger = screen.getByRole('combobox', { name: 'Approver' });
    expect(trigger.getAttribute('aria-invalid')).toBe('true');
  });
});

const units: ComboboxOption[] = [
  { value: 'belur', label: 'Hindalco Belur', description: 'Metals · 1 unit' },
  { value: 'renukoot', label: 'Hindalco Renukoot' },
  { value: 'taloja', label: 'Taloja plant' },
];

function ControlledCombobox({ initial = null }: { initial?: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <Combobox
        label="Unit"
        options={units}
        value={value}
        onValueChange={setValue}
        placeholder="Find a unit"
      />
      <output data-testid="value">{value ?? 'none'}</output>
    </>
  );
}

describe('Combobox', () => {
  it('filters as you type and selects with arrows and Enter, keeping focus in the input', async () => {
    const user = userEvent.setup();
    render(<ControlledCombobox />);
    const input = screen.getByRole('combobox', { name: 'Unit' });
    await user.tab();
    expect(document.activeElement).toBe(input);
    await user.keyboard('hind');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'Hindalco BelurMetals · 1 unit',
      'Hindalco Renukoot',
    ]);
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    await user.keyboard('{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('value').textContent).toBe('renukoot');
    expect((input as HTMLInputElement).value).toBe('Hindalco Renukoot');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('supports ArrowUp, Home, End, Escape and an empty result', async () => {
    const user = userEvent.setup();
    render(<ControlledCombobox initial="taloja" />);
    const input = screen.getByRole('combobox', { name: 'Unit' });
    await user.tab();
    await user.keyboard('{ArrowUp}');
    const options = screen.getAllByRole('option');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[2]!.id);
    expect(options[2]!.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Home}');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    await user.keyboard('{End}{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[2]!.id);
    await user.keyboard('{ArrowUp}');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByTestId('value').textContent).toBe('taloja');
    // Escape on a closed combobox clears the value.
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('value').textContent).toBe('none');
    await user.keyboard('zzz');
    expect(screen.getByText('No matches')).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('value').textContent).toBe('none');
    await user.tab();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens on click and selects with the pointer, and is axe-clean while open', async () => {
    const user = userEvent.setup();
    render(<ControlledCombobox />);
    const input = screen.getByRole('combobox', { name: 'Unit' });
    await user.click(input);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    await expectNoAxeViolations();
    await user.click(screen.getByRole('option', { name: /Taloja plant/ }));
    expect(screen.getByTestId('value').textContent).toBe('taloja');
    await user.click(input);
    await user.click(input);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
