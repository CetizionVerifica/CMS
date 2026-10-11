import { Copy, Download, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  Button,
  Checkbox,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
} from '../../src';
import { Page, Section } from '../Page';

export function OverlaysPage() {
  const [view, setView] = useState('default');
  const [last, setLast] = useState('nothing yet');
  return (
    <Page
      title="Tabs, menus, popover and tooltip"
      intro="Radix primitives: arrow keys inside, Esc closes, focus returns."
    >
      <Section title="Tabs" className="block">
        <Tabs defaultValue="details">
          <TabsList aria-label="Instance sections">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="evidence">Evidence (2)</TabsTrigger>
            <TabsTrigger value="comments">Comments</TabsTrigger>
            <TabsTrigger value="history">Audit trail</TabsTrigger>
            <TabsTrigger value="forms" disabled>
              Forms
            </TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="text-body text-ink">
            Deposit TCS collected in the month by the 7th of the next month.
          </TabsContent>
          <TabsContent value="evidence" className="text-body text-ink">
            Challan_Apr.pdf, Challan_May.pdf
          </TabsContent>
          <TabsContent value="comments" className="text-body text-ink">
            No comments yet.
          </TabsContent>
          <TabsContent value="history" className="text-body text-ink">
            Priya Rane submitted for approval.
          </TabsContent>
        </Tabs>
      </Section>
      <Section title="Dropdown menu">
        <Menu>
          <MenuTrigger asChild>
            <IconButton label="Actions for TAX-CL-033" icon={MoreHorizontal} />
          </MenuTrigger>
          <MenuContent>
            <MenuLabel>TAX-CL-033</MenuLabel>
            <MenuItem icon={Pencil} onSelect={() => setLast('Reassign')}>
              Reassign
            </MenuItem>
            <MenuItem icon={Copy} onSelect={() => setLast('Copy ID')}>
              Copy ID
            </MenuItem>
            <MenuItem icon={Download} disabled>
              Export (no evidence)
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={Trash2} destructive onSelect={() => setLast('Remove')}>
              Remove evidence
            </MenuItem>
          </MenuContent>
        </Menu>
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm">
              View: {view === 'default' ? 'Default' : 'Overdue super critical'}
            </Button>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuRadioGroup value={view} onValueChange={setView}>
              <MenuRadioItem value="default">Default</MenuRadioItem>
              <MenuRadioItem value="overdue">Overdue super critical</MenuRadioItem>
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
        <span role="status" className="text-meta text-muted">
          Last action: {last}
        </span>
      </Section>
      <Section title="Popover and tooltip">
        <Popover>
          <PopoverTrigger asChild>
            <Button>Columns</Button>
          </PopoverTrigger>
          <PopoverContent aria-label="Choose columns" className="flex w-64 flex-col gap-1">
            <Input label="Search columns" hideLabel placeholder="Search columns" />
            <Checkbox label="Act" defaultChecked />
            <Checkbox label="Department" defaultChecked />
            <Checkbox label="Approver" />
            <PopoverClose asChild>
              <Button variant="primary" size="sm">
                Done
              </Button>
            </PopoverClose>
          </PopoverContent>
        </Popover>
        <Tooltip content="Deposit TCS collected in the month by the 7th of the next month">
          <Button variant="ghost">Tax collection at source</Button>
        </Tooltip>
      </Section>
    </Page>
  );
}
