import { Id } from '@canopy/contracts';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';

import { serverApi } from '../../../../../../../lib/api/server';
import { PageHeader } from '../../../../../../../lib/patterns';
import { allPages, people, standards, systems } from '../../_lib/data';
import { isoGate, isoLoad, isoMetadata } from '../../_lib/gate';
import { mayCall } from '../../_lib/may';
import { clientToday } from '../../_lib/people';
import { word } from '../../_lib/words';
import { IsoRefusal } from '../../_components/IsoStates';
import { isoPath } from '../../overview/overview-model';
import { reviewTitle, standardsWords, systemStandardOptions } from '../review-model';
import { ReviewRecord } from './ReviewRecord';

type Props = { params: Promise<{ clientId: string; reviewId: string }> };

const TITLE = 'Management reviews';

// The title names the review only when the add-on is on and the person can read it.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId, reviewId } = await params;
  const base = await isoMetadata(clientId, TITLE);
  const gate = await isoGate(clientId);
  if (!gate.on || !Id.safeParse(reviewId).success) return base;
  const api = await serverApi();
  const review = await api
    .call('getIsoManagementReview', { params: { clientId, id: reviewId } })
    .then((r) => r.data)
    .catch(() => null);
  return review ? { title: `${reviewTitle(review)} · ${gate.client.name}` } : base;
}

// One management review (packages.md ISO-6c, model §3.13, §4.5): each step its `allowedActions` lists, the meeting, the
// inputs with their figures, the outputs, the review actions, its files, and the review pack beside the NC log and the
// audit reports.
export default async function IsoManagementReviewPage({ params }: Props) {
  const { clientId, reviewId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  if (!Id.safeParse(reviewId).success) notFound();
  const api = await serverApi();
  const p = { params: { clientId, id: reviewId } };
  const loaded = await isoLoad(async () => {
    const [review, inputs, outputs, actions, systemList, peopleList, standardList] =
      await Promise.all([
        api.call('getIsoManagementReview', p).then((r) => r.data),
        api.call('listIsoReviewInputs', p).then((r) => r.data.items),
        api.call('listIsoReviewOutputs', p).then((r) => r.data.items),
        allPages(
          async (query) =>
            (
              await api.call('listIsoActions', {
                params: { clientId },
                query: { subjectType: 'MANAGEMENT_REVIEW', subjectId: reviewId, ...query },
              })
            ).data,
        ),
        systems(api, clientId),
        people(api, clientId),
        standards(api, clientId),
      ]);
    const system = { managementSystemId: review.managementSystemId };
    const [otherReviews, audits] = await Promise.all([
      allPages(
        async (query) =>
          (
            await api.call('listIsoManagementReviews', {
              params: { clientId },
              query: { ...system, state: 'HELD,CLOSED', ...query },
            })
          ).data,
      ),
      allPages(
        async (query) =>
          (
            await api.call('listIsoInternalAudits', {
              params: { clientId },
              query: { ...system, state: 'REPORTED,CLOSED', ...query },
            })
          ).data,
      ),
    ]);
    return {
      review,
      inputs,
      outputs,
      actions,
      systemList,
      peopleList,
      standardList,
      otherReviews,
      audits,
    };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const d = loaded.data;
  const { review } = d;
  const system = d.systemList.find((s) => s.id === review.managementSystemId);
  const chair = review.chairId === gate.personId;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-meta">
        <NextLink
          href={isoPath(clientId, 'management-reviews')}
          prefetch={false}
          className="text-forest underline"
        >
          Management reviews
        </NextLink>
      </nav>
      <PageHeader
        title={reviewTitle(review)}
        description={[
          standardsWords(d.standardList, review.standards),
          d.systemList.length > 1 ? system?.name : null,
          word('ManagementReviewState', review.state),
        ]
          .filter(Boolean)
          .join(' · ')}
      />
      <ReviewRecord
        clientId={clientId}
        review={review}
        inputs={d.inputs}
        outputs={d.outputs}
        actions={d.actions}
        people={d.peopleList}
        standards={d.standardList}
        systemStandards={systemStandardOptions(system, d.standardList)}
        otherReviews={d.otherReviews}
        audits={[...d.audits]
          .sort((a, b) => (b.reportedOn ?? '').localeCompare(a.reportedOn ?? ''))
          .map((a) => ({ id: a.id, title: a.title, reportedOn: a.reportedOn }))}
        canReplan={mayCall('replanIsoManagementReview', gate.roles)}
        canWrite={mayCall('updateIsoManagementReview', gate.roles, chair)}
        canAddAction={mayCall('createIsoAction', gate.roles, chair)}
        actionEditing={{ all: mayCall('updateIsoAction', gate.roles), personId: gate.personId }}
        today={clientToday(gate.client.timeZone)}
        timeZone={gate.client.timeZone}
      />
    </>
  );
}
