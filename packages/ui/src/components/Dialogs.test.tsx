import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { setViewport } from '../../test/viewport';
import { Button } from '../primitives/Button';
import { Textarea } from '../primitives/Field';
import { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog';
import { Drawer, DrawerSection, type DrawerProps } from './Drawer';
import { StatusPill } from './StatusPill';

function Confirm(props: Partial<ConfirmDialogProps>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Send back</Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Send back to Priya Rane?"
        body="They'll be notified and the instance returns to their list."
        confirmLabel="Send back"
        onConfirm={() => {}}
        {...props}
      />
    </>
  );
}

describe('ConfirmDialog', () => {
  it('asks, repeats the verb and returns focus on cancel', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Confirm onConfirm={onConfirm} tone="danger" />);
    const opener = screen.getByRole('button', { name: 'Send back' });
    await user.click(opener);
    const dialog = screen.getByRole('alertdialog', { name: 'Send back to Priya Rane?' });
    expect(dialog.textContent).toContain("They'll be notified");
    // Danger: Cancel first.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await expectNoAxeViolations(dialog);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('requires a reason of the minimum length and passes it on', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <Confirm
        onConfirm={onConfirm}
        reason={{
          label: 'Reason (required)',
          required: true,
          minLength: 5,
          helper: 'The owner sees this.',
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Send back' }));
    const box = screen.getByRole('textbox', { name: 'Reason (required)' });
    expect(document.activeElement).toBe(box);
    const confirm = screen.getAllByRole('button', { name: 'Send back' }).at(-1)!;
    await user.keyboard('Bad');
    await user.click(confirm);
    expect(screen.getByText('Enter a reason of at least 5 characters.')).toBeTruthy();
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(onConfirm).not.toHaveBeenCalled();
    await user.keyboard(' scan');
    expect(box.getAttribute('aria-invalid')).toBeNull();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('Bad scan');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('words a required reason without a minimum and allows an optional one', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { unmount } = render(
      <Confirm
        onConfirm={onConfirm}
        reason={{ label: 'Justification (required)', required: true }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Send back' }));
    await user.click(screen.getAllByRole('button', { name: 'Send back' }).at(-1)!);
    expect(screen.getByText('Enter a justification.')).toBeTruthy();
    unmount();
    render(
      <Confirm
        onConfirm={onConfirm}
        tone="danger"
        confirmLabel="Remove"
        reason={{ label: 'Note', required: false }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Send back' }));
    const remove = screen.getByRole('button', { name: 'Remove' });
    expect(remove.className).toContain('bg-crit');
    await user.click(remove);
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('shows loading until the action settles and stays open when it fails', async () => {
    const user = userEvent.setup();
    let reject: (e: Error) => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((_, r) => (reject = r)));
    render(<Confirm onConfirm={onConfirm} body={undefined} />);
    await user.click(screen.getByRole('button', { name: 'Send back' }));
    const confirm = screen.getAllByRole('button', { name: 'Send back' }).at(-1)!;
    await user.click(confirm);
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    reject(new Error('500'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe("That didn't work. Try again.");
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});

function DrawerHarness(props: Partial<DrawerProps> & { withComment?: boolean }) {
  const { withComment, ...rest } = props;
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [comment, setComment] = useState('');
  const titles = [
    'Tax collection at source return',
    'Annual return in Form 1',
    'Monthly PF challan',
  ];
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open TAX-CL-033</Button>
      <Drawer
        open={open}
        onOpenChange={setOpen}
        title={titles[index]!}
        eyebrow="TAX-CL-033"
        meta={<StatusPill status="DUE_SOON" days={3} />}
        itemNoun="instance"
        onPrev={() => setIndex((i) => Math.max(0, i - 1))}
        onNext={() => setIndex((i) => Math.min(titles.length - 1, i + 1))}
        footer={
          <>
            <Button>Request not applicable</Button>
            <Button variant="primary">Submit for approval</Button>
          </>
        }
        dirty={comment.length > 0}
        backLabel="Back to register"
        {...rest}
      >
        <DrawerSection title="Description">
          <p>File the quarterly TCS return.</p>
        </DrawerSection>
        {withComment ? (
          <Textarea label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} />
        ) : null}
      </Drawer>
    </>
  );
}

describe('ConfirmDialog keyboard and focus (audit #4)', () => {
  it('focuses Confirm for a primary action and confirms with Ctrl/Cmd+Enter', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Confirm onConfirm={onConfirm} confirmLabel="Approve" title="Approve 3 instances?" />);
    await user.click(screen.getByRole('button', { name: 'Send back' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Approve' }));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Send back' }));
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('confirms a reason with Ctrl+Enter from the text area, after validating it', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <Confirm onConfirm={onConfirm} reason={{ label: 'Reason', required: true, minLength: 5 }} />,
    );
    await user.click(screen.getByRole('button', { name: 'Send back' }));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a reason of at least 5 characters.')).toBeTruthy();
    await user.keyboard('Wrong month{Control>}{Enter}{/Control}');
    expect(onConfirm).toHaveBeenCalledWith('Wrong month');
  });

  it('returns focus to returnFocusTo when the opener is gone', async () => {
    const user = userEvent.setup();
    function Removable() {
      const [open, setOpen] = useState(false);
      const [gone, setGone] = useState(false);
      return (
        <>
          {gone ? null : <Button onClick={() => setOpen(true)}>Remove</Button>}
          <Button>Choose files</Button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="Remove challan.pdf?"
            confirmLabel="Remove"
            tone="danger"
            onConfirm={() => setGone(true)}
            returnFocusTo={() => screen.getByRole('button', { name: 'Choose files' })}
          />
        </>
      );
    }
    render(<Removable />);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose files' }));
  });

  it('takes a short name with a pre-filled value and confirms with Enter', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <Confirm
        title="Rename view"
        confirmLabel="Rename"
        onConfirm={onConfirm}
        reason={{
          label: 'Name',
          required: true,
          multiline: false,
          maxLength: 60,
          initialValue: 'Overdue',
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Send back' }));
    const name = screen.getByRole('textbox', { name: /Name/ });
    expect(document.activeElement).toBe(name);
    expect((name as HTMLInputElement).value).toBe('Overdue');
    await user.clear(name);
    await user.keyboard('{Enter}');
    expect(screen.getByText('Enter a name.')).toBeTruthy();
    await user.keyboard('Overdue super critical{Enter}');
    expect(onConfirm).toHaveBeenCalledWith('Overdue super critical');
  });
});

describe('Drawer', () => {
  it('focuses the title, is described by the meta row and returns focus on close', async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    const opener = screen.getByRole('button', { name: 'Open TAX-CL-033' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Tax collection at source return' });
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Tax collection at source return' }),
    );
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByRole('dialog', { description: 'Due in 3 days' })).toBe(dialog);
    expect(screen.getByRole('heading', { level: 3, name: 'Description' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Submit for approval' })).toBeTruthy();
    await expectNoAxeViolations(dialog);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('moves between records with J/K, Alt+arrows and the buttons, not while typing', async () => {
    const user = userEvent.setup();
    render(<DrawerHarness withComment />);
    await user.click(screen.getByRole('button', { name: /Open/ }));
    await user.keyboard('j');
    expect(screen.getByRole('dialog', { name: 'Annual return in Form 1' })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Annual return in Form 1');
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(screen.getByRole('dialog', { name: 'Monthly PF challan' })).toBeTruthy();
    await user.keyboard('k');
    expect(screen.getByRole('dialog', { name: 'Annual return in Form 1' })).toBeTruthy();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(screen.getByRole('dialog', { name: 'Tax collection at source return' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next instance' }));
    await user.click(screen.getByRole('button', { name: 'Previous instance' }));
    expect(screen.getByRole('dialog', { name: 'Tax collection at source return' })).toBeTruthy();
    await user.click(screen.getByRole('textbox', { name: 'Comment' }));
    await user.keyboard('jk');
    expect(screen.getByRole('dialog', { name: 'Tax collection at source return' })).toBeTruthy();
  });

  it('guards closing with unsaved text and runs the primary action with Ctrl+Enter', async () => {
    const user = userEvent.setup();
    const onSubmitShortcut = vi.fn();
    render(<DrawerHarness withComment onSubmitShortcut={onSubmitShortcut} />);
    await user.click(screen.getByRole('button', { name: /Open/ }));
    await user.click(screen.getByRole('textbox', { name: 'Comment' }));
    await user.keyboard('Looks fine');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmitShortcut).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    const guard = screen.getByRole('alertdialog', { name: 'Discard your comment?' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(guard).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows loading, error and unavailable states and hides the footer', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const { rerender } = render(<DrawerHarness loading />);
    await user.click(screen.getByRole('button', { name: /Open/ }));
    expect(screen.getByText('Loading')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Tax collection at source return' })).toBeTruthy();
    rerender(<DrawerHarness error={{ message: 'Check your connection and try again.', retry }} />);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
    rerender(<DrawerHarness unavailable />);
    expect(
      screen.getByRole('heading', { name: "This instance isn't available to you" }),
    ).toBeTruthy();
  });

  it('is full screen with a back arrow under 640px', async () => {
    setViewport(375);
    const user = userEvent.setup();
    render(<DrawerHarness size="md" />);
    await user.click(screen.getByRole('button', { name: /Open/ }));
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    await expectNoAxeViolations(screen.getByRole('dialog'));
    await user.click(screen.getByRole('button', { name: 'Back to register' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
