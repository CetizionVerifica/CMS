import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Check, Plus } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { Button, buttonClasses, IconButton } from './Button';

describe('Button', () => {
  it('activates with Enter and Space and is axe-clean in every variant', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <div>
        <Button variant="primary" icon={Check} onClick={onClick}>
          Submit for approval
        </Button>
        <Button variant="secondary">Send back</Button>
        <Button variant="ghost" size="sm">
          View all
        </Button>
        <Button variant="danger">Remove evidence</Button>
      </div>,
    );
    await user.tab();
    const submit = screen.getByRole('button', { name: 'Submit for approval' });
    expect(submit).toHaveProperty('type', 'button');
    expect(document.activeElement).toBe(submit);
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
    await expectNoAxeViolations();
  });

  it('while loading keeps its label, sets aria-busy and ignores clicks', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button variant="primary" loading onClick={onClick}>
        Approve
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Approve' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('with a disabled reason stays focusable and describes why', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button variant="primary" disabledReason="Only the approver can approve" onClick={onClick}>
        Approve
      </Button>,
    );
    await user.tab();
    const button = screen.getByRole('button', { name: 'Approve' });
    expect(document.activeElement).toBe(button);
    expect(button).toHaveProperty('disabled', false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('button', { description: /Only the approver can approve/ })).toBe(
      button,
    );
    await user.keyboard('{Enter}');
    expect(onClick).not.toHaveBeenCalled();
    await expectNoAxeViolations();
  });

  it('native disabled is skipped by Tab', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Button disabled>Export</Button>
        <Button>Cancel</Button>
      </div>,
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('renders a link with button styles via asChild', () => {
    render(
      <Button asChild variant="primary" icon={Plus}>
        <a href="/assign">Assign obligation</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Assign obligation' });
    expect(link.getAttribute('href')).toBe('/assign');
    expect(link.className).toContain('bg-forest');
    expect(link.querySelector('svg')).not.toBeNull();
  });

  it('builds classes for each size', () => {
    expect(buttonClasses({ size: 'sm' })).toContain('h-control-compact');
    expect(buttonClasses()).toContain('h-control ');
  });
});

describe('IconButton', () => {
  it('requires a label, uses it as the name and shows it as a tooltip on focus', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton label="Add obligation" icon={Plus} onClick={onClick} />);
    await user.tab();
    const button = screen.getByRole('button', { name: 'Add obligation' });
    expect(document.activeElement).toBe(button);
    expect(await screen.findByRole('tooltip')).toHaveProperty('textContent', 'Add obligation');
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
    await expectNoAxeViolations();
  });

  it('supports primary and secondary variants and the small size', () => {
    render(
      <div>
        <IconButton label="Primary" icon={Plus} variant="primary" hideTooltip />
        <IconButton label="Small" icon={Plus} size="sm" variant="secondary" hideTooltip />
      </div>,
    );
    expect(screen.getByRole('button', { name: 'Primary' }).className).toContain('bg-forest');
    expect(screen.getByRole('button', { name: 'Small' }).className).toContain('w-control-compact');
  });
});
