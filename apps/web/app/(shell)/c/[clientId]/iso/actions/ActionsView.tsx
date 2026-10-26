'use client';
// Every ISO action of the client (packages.md ISO-6b, model §3.12): corrective, treatment, objective plan,
// improvement and review actions, by what they are for, owner, state and due date. A row opens the action in a drawer
// named in the URL (`?action=`), with exactly the steps its `allowedActions` offers.
import type { IsoActionView } from '@canopy/contracts';
import { Drawer, formatDate, type DataTableProps, type FilterDef } from '@canopy/ui';
import NextLink from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { nameOf, type PersonOption } from '../_lib/people';
import { actionName, ActionItem, type ActionEditing } from '../_components/ActionsPanel';
import { IsoFilterBar, withOpen } from '../_components/IsoFilterBar';
import { StatePill, TimingPill } from '../_components/IsoStates';
import { IsoTable } from '../_components/IsoTable';
import type { ActionSubject } from './actions-model';

type ActionRow = {
  id: string;
  title: string;
  sub: string;
  ownerName: string;
  action: IsoActionView;
};

const columns: DataTableProps<ActionRow>['columns'] = [
  {
    id: 'title',
    header: 'Action',
    accessorFn: (r) => ({ title: r.title, sub: r.sub }) as never,
    meta: { type: 'title', locked: true },
    size: 420,
  },
  {
    id: 'owner',
    header: 'Owner',
    accessorFn: (r) => r.ownerName as never,
    meta: { type: 'text' },
    size: 170,
  },
  {
    id: 'due',
    header: 'Due',
    accessorFn: (r) => r.action.dueOn as never,
    cell: (ctx) => {
      const a = ctx.row.original.action;
      return (
        <span className="flex flex-wrap items-center gap-2">
          {formatDate(a.dueOn)}
          {a.state === 'OPEN' ? <TimingPill status={a.status} /> : null}
        </span>
      );
    },
    size: 220,
  },
  {
    id: 'state',
    header: 'State',
    accessorFn: (r) => r.action.state as never,
    cell: (ctx) => <StatePill of="IsoActionState" value={ctx.row.original.action.state} />,
    size: 130,
  },
];

export type ActionsViewProps = {
  clientId: string;
  actions: IsoActionView[];
  subjects: Record<string, ActionSubject>;
  people: PersonOption[];
  filters: FilterDef[];
  filterValue: Record<string, string[]>;
  openActionId: string | null;
  editing: ActionEditing;
  today: string;
};

export function ActionsView(props: ActionsViewProps) {
  const { clientId, actions, subjects, people, openActionId } = props;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const hrefFor = (id?: string) =>
    withOpen(pathname, new URLSearchParams(params.toString()), 'action', id);
  const rows: ActionRow[] = actions.map((a) => ({
    id: a.id,
    title: a.text,
    sub: `${actionName(a.subject.type)} · ${subjects[a.subject.id]?.label ?? ''}`,
    ownerName: nameOf(people, a.ownerId),
    action: a,
  }));
  const open = actions.find((a) => a.id === openActionId) ?? null;
  const subject = open ? subjects[open.subject.id] : undefined;

  return (
    <>
      <IsoFilterBar
        filters={props.filters}
        value={props.filterValue}
        resultText={`${rows.length} ${rows.length === 1 ? 'action' : 'actions'}`}
        resultCount={rows.length}
        search={{ placeholder: 'Search actions' }}
      />
      <IsoTable
        label="Actions"
        columns={columns}
        data={rows}
        rowId={(r) => r.id}
        rowLabel={(r) => `${actionName(r.action.subject.type)}: ${r.title.slice(0, 60).trim()}`}
        rowHref={(r) => hrefFor(r.id)}
        countNoun={{ one: 'action', other: 'actions' }}
        empty={
          <p className="p-6 text-body text-muted">
            No action matches. Clear a filter, or add actions from a risk item or objective.
          </p>
        }
      />
      {open ? (
        <Drawer
          key={`${open.id}-${open.version}`}
          open
          onOpenChange={(o) => !o && router.push(hrefFor(), { scroll: false })}
          title={actionName(open.subject.type)}
          backLabel="Back to actions"
          size="md"
        >
          <ul className="flex flex-col">
            <ActionItem
              clientId={clientId}
              subject={open.subject}
              action={open}
              people={people}
              editing={props.editing}
              {...(subject?.hierarchy ? { hierarchy: subject.hierarchy } : {})}
              today={props.today}
              subjectLine={
                <p className="text-meta text-muted">
                  For{' '}
                  {subject?.href ? (
                    <NextLink
                      href={subject.href}
                      prefetch={false}
                      className="text-forest underline"
                    >
                      {subject.label}
                    </NextLink>
                  ) : (
                    (subject?.label ?? actionName(open.subject.type))
                  )}
                </p>
              }
            />
          </ul>
        </Drawer>
      ) : null}
    </>
  );
}
