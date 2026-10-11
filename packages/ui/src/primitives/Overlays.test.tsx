import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Download, Trash2 } from 'lucide-react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { Button } from './Button';
import { Input } from './Field';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from './Menu';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from './Popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './Tabs';
import { Tooltip, TooltipProvider } from './Tooltip';

describe('Tabs', () => {
  it('arrow keys move, Home and End jump, and the panel follows', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="details">
        <TabsList aria-label="Instance">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="details">Description</TabsContent>
        <TabsContent value="evidence">Files</TabsContent>
        <TabsContent value="history">Audit</TabsContent>
      </Tabs>,
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Details' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Evidence' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tabpanel').textContent).toBe('Files');
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'History' }));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Details' }));
    await expectNoAxeViolations();
  });
});

describe('DropdownMenu', () => {
  it('opens with Enter, moves with arrows, selects, and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    const onRemove = vi.fn();
    render(
      <Menu>
        <MenuTrigger asChild>
          <Button>Actions</Button>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>Instance</MenuLabel>
          <MenuItem icon={Download} onSelect={onExport}>
            Export
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={Trash2} destructive onSelect={onRemove}>
            Remove
          </MenuItem>
        </MenuContent>
      </Menu>,
    );
    const trigger = screen.getByRole('button', { name: 'Actions' });
    await user.tab();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    expect(menu).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Export' })),
    );
    await expectNoAxeViolations();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Remove' }));
    expect(screen.getByRole('menuitem', { name: 'Remove' }).className).toContain('text-crit-ink');
    await user.keyboard('{Enter}');
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onExport).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('Escape closes; radio items show the selection', async () => {
    const user = userEvent.setup();
    render(
      <Menu>
        <MenuTrigger asChild>
          <Button>View</Button>
        </MenuTrigger>
        <MenuContent>
          <MenuRadioGroup value="default">
            <MenuRadioItem value="default">Default</MenuRadioItem>
            <MenuRadioItem value="overdue">Overdue super critical</MenuRadioItem>
          </MenuRadioGroup>
        </MenuContent>
      </Menu>,
    );
    await user.tab();
    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('menuitemradio', { name: 'Default' })).toHaveProperty(
      'ariaChecked',
      'true',
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'View' }));
  });

  it('renders a link item with asChild', async () => {
    const user = userEvent.setup();
    render(
      <Menu>
        <MenuTrigger asChild>
          <Button>Account</Button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem asChild icon={Download}>
            <a href="/profile">Profile</a>
          </MenuItem>
        </MenuContent>
      </Menu>,
    );
    await user.tab();
    await user.keyboard('{Enter}');
    const item = await screen.findByRole('menuitem', { name: 'Profile' });
    expect(item.tagName).toBe('A');
    expect(item.querySelector('svg')).not.toBeNull();
  });
});

describe('Popover', () => {
  it('moves focus inside, traps nothing it should not, and Escape returns focus', async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger asChild>
          <Button>Columns</Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Choose columns">
          <Input label="Search columns" />
          <PopoverClose asChild>
            <Button>Done</Button>
          </PopoverClose>
        </PopoverContent>
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: 'Columns' });
    await user.tab();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Choose columns' })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search columns' })),
    );
    await expectNoAxeViolations();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Tooltip', () => {
  it('appears on keyboard focus and is linked as a description', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Copy the obligation ID">
        <Button>TAX-CL-033</Button>
      </Tooltip>,
    );
    await user.tab();
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('Copy the obligation ID');
    expect(screen.getByRole('button', { description: 'Copy the obligation ID' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('renders only the child when disabled', () => {
    render(
      <Tooltip content="Hidden" disabled>
        <Button>Plain</Button>
      </Tooltip>,
    );
    expect(screen.getByRole('button', { name: 'Plain' })).toBeTruthy();
  });
});

describe('Tabs overflow', () => {
  it('fades the ends that have more tabs behind them', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="Sections">
          <TabsTrigger value="a">Details</TabsTrigger>
          <TabsTrigger value="b">Evidence</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const list = screen.getByRole('tablist');
    expect(list.hasAttribute('data-fade-end')).toBe(false);
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(list, 'scrollWidth', { configurable: true, value: 500 });
    fireEvent.scroll(list);
    expect(list.hasAttribute('data-fade-start')).toBe(false);
    expect(list.hasAttribute('data-fade-end')).toBe(true);
    list.scrollLeft = 120;
    fireEvent.scroll(list);
    expect(list.hasAttribute('data-fade-start')).toBe(true);
    expect(list.hasAttribute('data-fade-end')).toBe(true);
    list.scrollLeft = 300;
    fireEvent.scroll(list);
    expect(list.hasAttribute('data-fade-end')).toBe(false);
  });

  it('forwards a ref to the tab list', () => {
    const calls: (HTMLDivElement | null)[] = [];
    const objectRef = createRef<HTMLDivElement>();
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="One" ref={(n) => void calls.push(n)}>
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
        <TabsList aria-label="Two" ref={objectRef}>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(calls[0]).toBe(screen.getByRole('tablist', { name: 'One' }));
    expect(objectRef.current).toBe(screen.getByRole('tablist', { name: 'Two' }));
  });
});

describe('TooltipProvider', () => {
  it('shares one provider so tooltips inside it still open on focus', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delay={0}>
        <Tooltip content="Export the register">
          <button type="button">Export</button>
        </Tooltip>
      </TooltipProvider>,
    );
    await user.tab();
    expect((await screen.findByRole('tooltip')).textContent).toBe('Export the register');
  });
});
