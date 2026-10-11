import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { Checkbox, RadioGroup, Switch } from './Checkbox';

describe('Checkbox', () => {
  it('toggles with Space and with a click on its label', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox label="Super critical only" onCheckedChange={onCheckedChange} />);
    const box = screen.getByRole('checkbox', { name: 'Super critical only' });
    await user.tab();
    expect(document.activeElement).toBe(box);
    await user.keyboard(' ');
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);
    expect(box.getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByText('Super critical only'));
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
    await expectNoAxeViolations();
  });

  it('exposes the indeterminate state and can hide its label', async () => {
    render(<Checkbox label="Select all 424 instances" hideLabel checked="indeterminate" />);
    const box = screen.getByRole('checkbox', { name: 'Select all 424 instances' });
    expect(box.getAttribute('aria-checked')).toBe('mixed');
    await expectNoAxeViolations();
  });
});

describe('RadioGroup', () => {
  it('is one tab stop; arrows move, Space selects', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup
        label="Density"
        defaultValue="comfortable"
        onValueChange={onValueChange}
        options={[
          { value: 'comfortable', label: 'Comfortable' },
          { value: 'compact', label: 'Compact' },
        ]}
      />,
    );
    expect(screen.getByRole('radiogroup', { name: 'Density' })).toBeTruthy();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Comfortable' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Compact' }));
    await user.keyboard(' ');
    expect(onValueChange).toHaveBeenLastCalledWith('compact');
    expect(screen.getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await user.tab();
    expect(document.activeElement).toBe(document.body);
    await expectNoAxeViolations();
  });

  it('lays out horizontally with a hidden group label', () => {
    render(
      <RadioGroup
        label="View"
        hideLabel
        orientation="horizontal"
        options={[{ value: 'a', label: 'A', disabled: true }]}
      />,
    );
    expect(screen.getByText('View').className).toBe('sr-only');
    expect(screen.getByRole('radio', { name: 'A' })).toHaveProperty('disabled', true);
  });
});

describe('Switch', () => {
  it('toggles with Space and Enter', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch label="Email reminders" onCheckedChange={onCheckedChange} />);
    const sw = screen.getByRole('switch', { name: 'Email reminders' });
    await user.tab();
    expect(document.activeElement).toBe(sw);
    await user.keyboard(' ');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{Enter}');
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
    await expectNoAxeViolations();
  });

  it('can hide its label', () => {
    render(<Switch label="Compact rows" hideLabel defaultChecked />);
    expect(screen.getByRole('switch', { name: 'Compact rows' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });
});
