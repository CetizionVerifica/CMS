import type {
  Act,
  ClauseRef,
  IsoStandardCode,
  LocalDate,
  Obligation,
  RecurrenceRule,
  ReviewInputKey,
  ReviewInputSource,
  ReviewOutputKey,
} from '@canopy/contracts';
import { ruleIssues } from './rules.js';

/**
 * The ISO catalogue an account gets when the ISO add-on first comes on (docs/iso/catalogue.md, ADR M6-0003): the
 * standards and their clauses, the management review inputs and outputs, and the four STANDARD acts with their one
 * category and their recurring activities. Clause numbers and titles only; every summary is in our own words and never
 * the standard's text. `copyIsoCatalogue` copies it; the master library never holds any of it.
 */

/** A clause as written here: number, title, our summary. Parent, `assessable` and `hlsKey` follow from the numbers. */
type ClauseRow = readonly [number: string, title: string, summary: string];

export interface CatalogueClause {
  number: string;
  title: string;
  summary: string;
  /** The number of the parent clause; null at the top level. */
  parent: string | null;
  hlsKey: string | null;
  assessable: boolean;
  exclusionAllowed: boolean;
}

export interface CatalogueReviewInput {
  key: ReviewInputKey;
  clauseNumber: string;
  item: string | null;
  title: string;
  source: ReviewInputSource;
}

export interface CatalogueReviewOutput {
  key: ReviewOutputKey;
  clauseNumber: string;
  item: string | null;
  title: string;
}

export interface CatalogueStandard {
  code: IsoStandardCode;
  edition: string;
  title: string;
  topic: string;
  clauses: readonly CatalogueClause[];
  reviewInputs: readonly CatalogueReviewInput[];
  reviewOutputs: readonly CatalogueReviewOutput[];
}

type Server = 'id' | 'firmId' | 'createdAt' | 'updatedAt' | 'archivedAt' | 'version';

export type CatalogueAct = Omit<Act, Server | 'kind'> & { key: ActKey };
export type CatalogueActivity = Omit<
  Obligation,
  Server | 'actId' | 'categoryId' | 'libraryVersion' | 'clauseRefs'
> & {
  /** The activity key; `externalRef` is `ISO-<key>`. */
  key: string;
  act: ActKey;
  clauseRefs: ClauseRef[];
};

export type ActKey = 'ISO_9001' | 'ISO_14001' | 'ISO_45001' | 'ISO_IMS';

export interface IsoCatalogue {
  /** Copied into each activity's `libraryVersion`. */
  version: number;
  standards: readonly CatalogueStandard[];
  acts: readonly CatalogueAct[];
  /** The one category every activity is filed under (catalogue §2). */
  category: string;
  activities: readonly CatalogueActivity[];
}

// ---------- clauses ----------

/** Clause numbers in reading order: 4.1 before 4.10, 9 before 10. */
export function compareClauseNumbers(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The shared-structure clauses the three standards have in common (clauses 4 to 10). A clause's `hlsKey` is its own
 * number when that is one of these, else that of its top two levels when those are, else null: ISO 9001 7.1.5.2 is
 * "7.1", and ISO 9001 8.5.1 and the 8.2 of each standard are null, since they are not shared.
 */
const SHARED = new Set(
  [
    '4', '4.1', '4.2', '4.3', '4.4',
    '5', '5.1', '5.2', '5.3',
    '6', '6.1', '6.2',
    '7', '7.1', '7.2', '7.3', '7.4', '7.5',
    '8', '8.1',
    '9', '9.1', '9.2', '9.3',
    '10', '10.1', '10.2', '10.3',
  ], // prettier-ignore
);

function hlsKeyOf(number: string): string | null {
  if (SHARED.has(number)) return number;
  const two = number.split('.').slice(0, 2).join('.');
  return number.includes('.') && SHARED.has(two) ? two : null;
}

/**
 * Builds a standard's clause list. A clause is assessable unless it is clause 1, 2 or 3 or has sub-clauses here, so
 * a requirement is counted once (catalogue §4). `excludable` lists the clauses a client may determine not
 * applicable; each must be assessable.
 */
function clauses(
  rows: readonly ClauseRow[],
  excludable: readonly string[] = [],
): CatalogueClause[] {
  const numbers = new Set(rows.map(([n]) => n));
  const parentOf = (n: string) => (n.includes('.') ? n.slice(0, n.lastIndexOf('.')) : null);
  const hasChildren = new Set(
    rows.map(([n]) => parentOf(n)).filter((p): p is string => p !== null),
  );
  return rows.map(([number, title, summary]) => {
    const top = Number(number.split('.')[0]);
    const assessable = top >= 4 && !hasChildren.has(number);
    const parent = parentOf(number);
    if (parent !== null && !numbers.has(parent)) {
      throw new Error(`ISO catalogue: clause ${number} has no parent ${parent}`);
    }
    return {
      number,
      title,
      summary,
      parent,
      hlsKey: top >= 4 ? hlsKeyOf(number) : null,
      assessable,
      exclusionAllowed: excludable.includes(number),
    };
  });
}

const INTRO: readonly ClauseRow[] = [
  ['1', 'Scope', 'What the standard covers and the outcomes a management system built on it is meant to achieve.'],
  ['2', 'Normative references', 'Documents the standard depends on; for these standards there are none.'],
  ['3', 'Terms and definitions', 'The vocabulary the standard uses, so that words such as "risk" or "documented information" are read the same way everywhere.'],
]; // prettier-ignore

/** ISO 9001 clauses 4.3 lets an organisation determine not applicable (ADR M6-0003 decision 3). */
export const ISO_9001_EXCLUDABLE = [
  '7.1.5.2',
  '8.3.1', '8.3.2', '8.3.3', '8.3.4', '8.3.5', '8.3.6',
  '8.5.3',
  '8.5.5',
] as const; // prettier-ignore

const ISO_9001_CLAUSES = clauses(
  [
    ...INTRO,
    ['4', 'Context of the organization', 'Know the setting the business works in and who has a stake in it, then decide what the quality system covers and how its processes fit together.'],
    ['4.1', 'Understanding the organization and its context', 'Identify the internal and external issues that affect what the business is trying to achieve with its quality system, and keep that picture up to date. Decide whether climate change is one of those issues.'],
    ['4.2', 'Understanding the needs and expectations of interested parties', 'List the parties whose expectations matter to quality, such as customers, regulators and suppliers, and what each of them requires; review the list from time to time. Some of them may have climate-related requirements.'],
    ['4.3', 'Determining the scope of the quality management system', 'Set and record the boundaries of the system: sites, products, services and activities covered, and justify any requirement treated as not applicable.'],
    ['4.4', 'Quality management system and its processes', 'Build the system out of defined, connected processes and keep them working and improving.'],
    ['4.4.1', 'General', 'For each process, know its inputs and outputs, sequence, criteria, resources, owners, risks and how it is measured, and improve it.'],
    ['4.4.2', 'General (documented information)', 'Keep the records needed to run the processes and to show they were carried out as planned.'],
    ['5', 'Leadership', 'Top management owns the system: it sets direction, policy and responsibilities.'],
    ['5.1', 'Leadership and commitment', 'Top management takes visible ownership of the quality system and of meeting customer needs.'],
    ['5.1.1', 'General', 'Top management is accountable for the system, builds it into the business, provides resources and promotes risk-based thinking and improvement.'],
    ['5.1.2', 'Customer focus', 'Top management keeps the focus on meeting customer and legal requirements and on increasing customer satisfaction.'],
    ['5.2', 'Policy', 'A quality policy that fits the business, is written down and is understood.'],
    ['5.2.1', 'Establishing the quality policy', 'Write a policy suited to the business that frames objectives and commits to meeting requirements and to improving.'],
    ['5.2.2', 'Communicating the quality policy', 'Make the policy available as a record, explain it inside the business and share it with interested parties where suitable.'],
    ['5.3', 'Organizational roles, responsibilities and authorities', 'Assign and communicate who is responsible for the system working, for reporting on it and for keeping it intact through change.'],
    ['6', 'Planning', 'Plan for risks, opportunities, objectives and changes.'],
    ['6.1', 'Actions to address risks and opportunities', 'Find what could stop the system achieving its results, or help it, and act on it.'],
    ['6.1.1', 'General (risks and opportunities)', 'Using the context and interested parties, decide which risks and opportunities need attention.'],
    ['6.1.2', 'Planning actions (risks and opportunities)', 'Plan actions in proportion to each risk or opportunity, build them into the processes and check they worked.'],
    ['6.2', 'Quality objectives and planning to achieve them', 'Set measurable quality objectives and plan how to reach them.'],
    ['6.2.1', 'Quality objectives', 'Set objectives at relevant levels that match the policy, can be measured, are monitored, communicated and kept as records.'],
    ['6.2.2', 'Planning to achieve objectives', 'For each objective, decide what will be done, with what resources, by whom, by when and how results are judged.'],
    ['6.3', 'Planning of changes', 'Make changes to the system in a planned way, thinking about their purpose, consequences, resources and responsibilities.'],
    ['7', 'Support', 'Resources, people, awareness, communication and records the system relies on.'],
    ['7.1', 'Resources', 'Provide what the system needs to run and improve.'],
    ['7.1.1', 'General (resources)', 'Decide and provide the resources needed, considering what is available internally and what must come from outside.'],
    ['7.1.2', 'People', 'Have enough people to run the system and its processes.'],
    ['7.1.3', 'Infrastructure', 'Provide and maintain buildings, equipment, software, transport and IT needed for conforming products and services.'],
    ['7.1.4', 'Environment for the operation of processes', 'Provide and maintain suitable working conditions, physical, social and psychological, for the processes.'],
    ['7.1.5', 'Monitoring and measuring resources', 'Make sure the instruments and methods used to check products and services give valid, reliable results.'],
    ['7.1.5.1', 'General (monitoring and measuring resources)', 'Choose suitable monitoring and measuring resources, maintain them and keep records showing they are fit for use.'],
    ['7.1.5.2', 'Measurement traceability', 'Where results must be traceable, calibrate or verify instruments against recognised references, label their status, protect them, and act if one is found out of calibration.'],
    ['7.1.6', 'Organizational knowledge', 'Identify the know-how the processes depend on, keep it available and plan how to get new knowledge when needs change.'],
    ['7.2', 'Competence', 'Decide the competence each role affecting quality needs, make sure people have it through education, training or experience, act to close gaps and keep evidence.'],
    ['7.3', 'Awareness', 'People know the policy, the objectives relevant to them, how they contribute and what happens when requirements are not met.'],
    ['7.4', 'Communication', 'Decide what is communicated about the system, inside and outside, when, to whom, how and by whom.'],
    ['7.5', 'Documented information', 'Create, maintain and control the documents and records the system needs.'],
    ['7.5.1', 'General (documented information)', 'Hold the documented information the standard calls for and whatever else the business finds necessary.'],
    ['7.5.2', 'Creating and updating', 'Give documents identification, a suitable format and review and approval before use.'],
    ['7.5.3', 'Control of documented information', 'Keep documents and records available where needed and protected.'],
    ['7.5.3.1', 'Control of documented information (availability and protection)', 'Documents are available and fit for use when needed and protected from loss, misuse or loss of integrity.'],
    ['7.5.3.2', 'Control of documented information (activities)', 'Control distribution, access, storage, versions, retention and disposal, including documents from outside sources.'],
    ['8', 'Operation', 'Plan and run the work that delivers products and services.'],
    ['8.1', 'Operational planning and control', 'Plan, run and control the processes that deliver products and services, including criteria, resources, records and control of outsourced work.'],
    ['8.2', 'Requirements for products and services', 'Understand and confirm what customers and the law require before committing to supply.'],
    ['8.2.1', 'Customer communication', 'Talk with customers about products, enquiries, orders, feedback, complaints, their property and contingencies.'],
    ['8.2.2', 'Determining the requirements for products and services', 'Define product and service requirements, legal ones included, and be sure the business can meet its claims.'],
    ['8.2.3', 'Review of the requirements for products and services', 'Check the business can meet requirements before accepting an order.'],
    ['8.2.3.1', 'Review of requirements (before commitment)', 'Before committing, review the stated, implied, legal and own requirements, and settle any differences from earlier quotes.'],
    ['8.2.3.2', 'Review of requirements (records)', 'Keep records of the review and of any new requirements.'],
    ['8.2.4', 'Changes to requirements for products and services', 'When requirements change, update the records and tell the people concerned.'],
    ['8.3', 'Design and development of products and services', 'Where the business designs its products or services, control that work.'],
    ['8.3.1', 'General (design and development)', 'Set up a design and development process suited to what is designed.'],
    ['8.3.2', 'Design and development planning', 'Plan stages, reviews, verification, validation, responsibilities, resources, interfaces and records for each design.'],
    ['8.3.3', 'Design and development inputs', 'Define the functional, performance, legal and other inputs a design must meet, and resolve conflicting ones.'],
    ['8.3.4', 'Design and development controls', 'Control the design with reviews, verification and validation, acting on problems found, and keep records.'],
    ['8.3.5', 'Design and development outputs', 'Make sure design outputs meet the inputs and are adequate for later processes, monitoring and safe use.'],
    ['8.3.6', 'Design and development changes', 'Identify, review and control changes to designs and keep records of them.'],
    ['8.4', 'Control of externally provided processes, products and services', 'Make sure what suppliers and outsourced providers deliver meets requirements.'],
    ['8.4.1', 'General (external providers)', 'Decide the controls for external supply, and evaluate, select, monitor and re-evaluate providers against criteria, keeping records.'],
    ['8.4.2', 'Type and extent of control', 'Set controls on providers in proportion to the effect their supply can have on the products and services.'],
    ['8.4.3', 'Information for external providers', 'Tell providers clearly what is required, approvals, competence, interactions and any verification planned.'],
    ['8.5', 'Production and service provision', 'Make products and deliver services under controlled conditions.'],
    ['8.5.1', 'Control of production and service provision', 'Run production and service delivery with the right information, resources, monitoring, people and controls against human error.'],
    ['8.5.2', 'Identification and traceability', 'Identify outputs and their inspection status, and keep traceability where it is required.'],
    ['8.5.3', 'Property belonging to customers or external providers', 'Look after property owned by customers or providers while it is in the business’s care, and report loss or damage.'],
    ['8.5.4', 'Preservation', 'Protect outputs during production and delivery so they still conform, through handling, packaging, storage and transport.'],
    ['8.5.5', 'Post-delivery activities', 'Meet obligations after delivery, such as warranty, maintenance or recycling, considering legal requirements and customer feedback.'],
    ['8.5.6', 'Control of changes', 'Review and control unplanned changes to production or service provision and keep records.'],
    ['8.6', 'Release of products and services', 'Release products and services only after planned checks show requirements are met, and record who released them.'],
    ['8.7', 'Control of nonconforming outputs', 'Stop outputs that do not conform from being used or delivered by mistake.'],
    ['8.7.1', 'Control of nonconforming outputs (actions)', 'Identify and control nonconforming outputs: correct, separate, return, inform the customer or accept under concession.'],
    ['8.7.2', 'Control of nonconforming outputs (records)', 'Record the nonconformity, the action taken, any concession and who decided.'],
    ['9', 'Performance evaluation', 'Measure, audit and review how well the system works.'],
    ['9.1', 'Monitoring, measurement, analysis and evaluation', 'Decide what is measured and how, then analyse the results.'],
    ['9.1.1', 'General (monitoring and measurement)', 'Decide what to monitor and measure, the methods, when to do it and when to analyse results, and keep records.'],
    ['9.1.2', 'Customer satisfaction', 'Find out how customers see the business’s performance and decide how that information is gathered and used.'],
    ['9.1.3', 'Analysis and evaluation', 'Analyse the data to judge conformity, satisfaction, system performance, risk actions, supplier performance and improvement needs.'],
    ['9.2', 'Internal audit', 'Audit the system at planned intervals.'],
    ['9.2.1', 'Internal audit (purpose)', 'Audit to find out whether the system meets the business’s own and the standard’s requirements and is working.'],
    ['9.2.2', 'Internal audit (programme)', 'Plan an audit programme, set criteria and scope, choose impartial auditors, report results to management, act and keep records.'],
    ['9.3', 'Management review', 'Top management reviews the system at planned intervals.'],
    ['9.3.1', 'General (management review)', 'Review the system at planned intervals to confirm it remains suitable, adequate and effective and aligned with strategy.'],
    ['9.3.2', 'Management review inputs', 'What the review must consider: earlier actions, changes in issues, performance trends, resources, risk actions and improvement opportunities.'],
    ['9.3.3', 'Management review outputs', 'What the review must decide: improvement opportunities, changes to the system and resource needs, kept as a record.'],
    ['10', 'Improvement', 'Act on problems and keep getting better.'],
    ['10.1', 'General (improvement)', 'Look for and act on opportunities to improve products, services, results and the system.'],
    ['10.2', 'Nonconformity and corrective action', 'Deal with nonconformities and remove their causes.'],
    ['10.2.1', 'Nonconformity and corrective action (actions)', 'React to a nonconformity, find its cause, check whether it could happen elsewhere, act, check the action worked and update risks or the system.'],
    ['10.2.2', 'Nonconformity and corrective action (records)', 'Record the nonconformity, the actions taken and their results.'],
    ['10.3', 'Continual improvement', 'Keep improving the suitability, adequacy and effectiveness of the system, using analysis and review results.'],
  ],
  ISO_9001_EXCLUDABLE,
); // prettier-ignore

const ISO_14001_CLAUSES = clauses([
  ...INTRO,
  ['4', 'Context of the organization', 'Understand the business’s setting and stakeholders, then set the boundaries of the environmental system.'],
  ['4.1', 'Understanding the organization and its context', 'Identify the internal and external issues, environmental conditions included, that affect the environmental results the business aims for. Decide whether climate change is one of those issues.'],
  ['4.2', 'Understanding the needs and expectations of interested parties', 'List the interested parties, their relevant needs and which of them become compliance obligations. Some of them may have climate-related requirements.'],
  ['4.3', 'Determining the scope of the environmental management system', 'Set and record the boundaries of the system, taking account of the activities, products and services the business controls or influences.'],
  ['4.4', 'Environmental management system', 'Set up, run, maintain and improve the system and its processes to reach the intended environmental outcomes.'],
  ['5', 'Leadership', 'Top management owns the environmental system.'],
  ['5.1', 'Leadership and commitment', 'Top management is accountable for the system, builds it into the business, provides resources and supports others in their roles.'],
  ['5.2', 'Environmental policy', 'A written policy that fits the business and commits to protecting the environment, meeting compliance obligations and improving.'],
  ['5.3', 'Organizational roles, responsibilities and authorities', 'Assign and communicate who makes sure the system works and who reports on its performance.'],
  ['6', 'Planning', 'Plan from environmental aspects, compliance obligations, risks and objectives.'],
  ['6.1', 'Actions to address risks and opportunities', 'Find and act on what could affect the system’s results.'],
  ['6.1.1', 'General (risks and opportunities)', 'Plan how to find the risks and opportunities linked to aspects, obligations and context, including possible emergencies, and keep records.'],
  ['6.1.2', 'Environmental aspects', 'Identify the environmental aspects of activities, products and services over their life cycle, decide which are significant and keep that list current.'],
  ['6.1.3', 'Compliance obligations', 'Identify the legal and other requirements that apply to the aspects, know how they apply and keep them in view.'],
  ['6.1.4', 'Planning action', 'Plan actions for significant aspects, compliance obligations and risks, build them into processes and check they worked.'],
  ['6.2', 'Environmental objectives and planning to achieve them', 'Set environmental objectives and plan to reach them.'],
  ['6.2.1', 'Environmental objectives', 'Set measurable objectives consistent with the policy, monitor and communicate them, and keep records.'],
  ['6.2.2', 'Planning actions to achieve environmental objectives', 'For each objective decide the work, resources, responsibility, timing and the indicators used to track progress.'],
  ['7', 'Support', 'Resources, competence, awareness, communication and records.'],
  ['7.1', 'Resources', 'Provide the resources the environmental system needs.'],
  ['7.2', 'Competence', 'Decide the competence needed for work affecting environmental performance and obligations, close gaps through training or experience and keep evidence.'],
  ['7.3', 'Awareness', 'People know the policy, the significant aspects of their work, how they contribute and what happens when obligations are not met.'],
  ['7.4', 'Communication', 'Plan and carry out communication about the environmental system.'],
  ['7.4.1', 'General (communication)', 'Decide what, when, with whom and how to communicate, considering compliance obligations, and keep records.'],
  ['7.4.2', 'Internal communication', 'Share relevant information across levels and functions so people can contribute to improvement.'],
  ['7.4.3', 'External communication', 'Communicate externally as planned and as compliance obligations require.'],
  ['7.5', 'Documented information', 'Create, maintain and control the documents and records the system needs.'],
  ['7.5.1', 'General (documented information)', 'Hold the documented information the standard calls for and whatever else the business finds necessary.'],
  ['7.5.2', 'Creating and updating', 'Give documents identification, a suitable format and review and approval before use.'],
  ['7.5.3', 'Control of documented information', 'Keep documents available and protected, and control distribution, versions, retention and disposal, outside documents included.'],
  ['8', 'Operation', 'Control operations and be ready for emergencies.'],
  ['8.1', 'Operational planning and control', 'Run the processes needed with operating criteria, control or influence outsourced work, consider the life cycle and pass on environmental requirements to suppliers and contractors.'],
  ['8.2', 'Emergency preparedness and response', 'Prepare for possible environmental emergencies, respond to them, test the plans periodically, review them after drills or events and train people.'],
  ['9', 'Performance evaluation', 'Monitor, evaluate compliance, audit and review.'],
  ['9.1', 'Monitoring, measurement, analysis and evaluation', 'Measure environmental performance and evaluate compliance.'],
  ['9.1.1', 'General (monitoring and measurement)', 'Decide what to monitor and how, use calibrated or verified equipment, evaluate environmental performance and keep records.'],
  ['9.1.2', 'Evaluation of compliance', 'At planned intervals check whether compliance obligations are met, act where they are not, and keep records.'],
  ['9.2', 'Internal audit', 'Audit the environmental system at planned intervals.'],
  ['9.2.1', 'General (internal audit)', 'Audit to find out whether the system meets the business’s own and the standard’s requirements and is working.'],
  ['9.2.2', 'Internal audit programme', 'Plan an audit programme, set criteria and scope, choose impartial auditors, report results to management and keep records.'],
  ['9.3', 'Management review', 'Top management reviews the system at planned intervals, considering set inputs and recording decisions and actions.'],
  ['10', 'Improvement', 'Act on problems and keep improving.'],
  ['10.1', 'General (improvement)', 'Look for opportunities to improve and act on them to reach the intended outcomes.'],
  ['10.2', 'Nonconformity and corrective action', 'React to a nonconformity, limit environmental harm, find and remove the cause, check the action worked and keep records.'],
  ['10.3', 'Continual improvement', 'Keep improving the system to improve environmental performance.'],
]); // prettier-ignore

const ISO_45001_CLAUSES = clauses([
  ...INTRO,
  ['4', 'Context of the organization', 'Understand the setting, the workers and other stakeholders, then set the boundaries of the OH&S system.'],
  ['4.1', 'Understanding the organization and its context', 'Identify the internal and external issues that affect the OH&S results the business aims for. Decide whether climate change is one of those issues.'],
  ['4.2', 'Understanding the needs and expectations of workers and other interested parties', 'Identify workers and other interested parties, their relevant needs, and which of them become legal or other requirements. Some of them may have climate-related requirements.'],
  ['4.3', 'Determining the scope of the OH&S management system', 'Set and record the boundaries of the system, taking account of planned and performed work-related activities.'],
  ['4.4', 'OH&S management system', 'Set up, run, maintain and improve the system and its processes.'],
  ['5', 'Leadership and worker participation', 'Top management leads, and workers are consulted and take part.'],
  ['5.1', 'Leadership and commitment', 'Top management takes overall responsibility for preventing work-related injury and ill health, provides resources, protects workers who report hazards and supports a positive safety culture.'],
  ['5.2', 'OH&S policy', 'A written policy committing to safe and healthy working conditions, meeting legal requirements, eliminating hazards, consulting workers and improving.'],
  ['5.3', 'Organizational roles, responsibilities and authorities', 'Assign and communicate responsibilities for OH&S at every level, and who reports on the system’s performance.'],
  ['5.4', 'Consultation and participation of workers', 'Set up processes for workers and their representatives to be consulted on and take part in the system, removing barriers to doing so.'],
  ['6', 'Planning', 'Plan from hazards, risks, legal requirements and objectives.'],
  ['6.1', 'Actions to address risks and opportunities', 'Find and act on hazards, risks and opportunities for OH&S and for the system.'],
  ['6.1.1', 'General (risks and opportunities)', 'Plan how to find risks and opportunities from the context, hazards and legal requirements, including during change, and keep records.'],
  ['6.1.2', 'Hazard identification and assessment of risks and opportunities', 'Identify hazards and assess what they mean for OH&S and for the system.'],
  ['6.1.2.1', 'Hazard identification', 'Identify hazards on an ongoing basis, covering routine and non-routine work, people, the workplace, emergencies, change and past incidents.'],
  ['6.1.2.2', 'Assessment of OH&S risks and other risks to the OH&S management system', 'Assess the OH&S risks from the hazards found and other risks to the system, with methods that are proactive and kept as records.'],
  ['6.1.2.3', 'Assessment of OH&S opportunities and other opportunities for the OH&S management system', 'Assess opportunities to improve OH&S performance and the system, for example by adapting work to workers.'],
  ['6.1.3', 'Determination of legal requirements and other requirements', 'Identify the legal and other requirements that apply to hazards, risks and the system, know how they apply and keep them current.'],
  ['6.1.4', 'Planning action', 'Plan actions on risks, opportunities, legal requirements and emergencies using the hierarchy of controls, build them into processes and check they worked.'],
  ['6.2', 'OH&S objectives and planning to achieve them', 'Set OH&S objectives and plan to reach them.'],
  ['6.2.1', 'OH&S objectives', 'Set measurable objectives consistent with the policy, taking account of consultation with workers, and monitor and communicate them.'],
  ['6.2.2', 'Planning to achieve OH&S objectives', 'For each objective decide the work, resources, responsibility, timing and indicators, and keep records.'],
  ['7', 'Support', 'Resources, competence, awareness, communication and records.'],
  ['7.1', 'Resources', 'Provide the resources the OH&S system needs.'],
  ['7.2', 'Competence', 'Decide the competence workers need, including to identify hazards, make sure they have it, close gaps and keep evidence.'],
  ['7.3', 'Awareness', 'Workers know the policy and objectives, the hazards and risks of their work, past incidents relevant to them and that they can remove themselves from serious danger.'],
  ['7.4', 'Communication', 'Plan and carry out OH&S communication.'],
  ['7.4.1', 'General (communication)', 'Decide what, when, with whom and how to communicate, considering diversity and the views of interested parties, and keep records.'],
  ['7.4.2', 'Internal communication', 'Share OH&S information across levels and functions, including changes, so workers can contribute to improvement.'],
  ['7.4.3', 'External communication', 'Communicate OH&S information externally as planned and as legal requirements need.'],
  ['7.5', 'Documented information', 'Create, maintain and control the documents and records the system needs.'],
  ['7.5.1', 'General (documented information)', 'Hold the documented information the standard calls for and whatever else the business finds necessary.'],
  ['7.5.2', 'Creating and updating', 'Give documents identification, a suitable format and review and approval before use.'],
  ['7.5.3', 'Control of documented information', 'Keep documents available and protected, and control distribution, versions, retention and disposal, outside documents included.'],
  ['8', 'Operation', 'Control operations, change, procurement and emergencies.'],
  ['8.1', 'Operational planning and control', 'Plan and control the processes needed for OH&S.'],
  ['8.1.1', 'General (operational control)', 'Set operating criteria for processes, control them, keep records, and adapt work to workers; coordinate with other employers at shared workplaces.'],
  ['8.1.2', 'Eliminating hazards and reducing OH&S risks', 'Remove hazards and reduce risks following the hierarchy: eliminate, substitute, engineer, administer, then protective equipment.'],
  ['8.1.3', 'Management of change', 'Plan and control temporary and permanent changes that affect OH&S, and review unintended ones.'],
  ['8.1.4', 'Procurement', 'Control buying of goods and services so that they conform to the OH&S system.'],
  ['8.1.4.1', 'General (procurement)', 'Set up processes so that purchases of products and services conform to the OH&S system.'],
  ['8.1.4.2', 'Contractors', 'Coordinate with contractors to find and control hazards and risks from their work, and set OH&S criteria for choosing them.'],
  ['8.1.4.3', 'Outsourcing', 'Control outsourced functions and processes so that they meet legal requirements and the system’s intended outcomes.'],
  ['8.2', 'Emergency preparedness and response', 'Plan the response to possible emergencies, train people, test and exercise the plans, review them after tests or events and inform workers and others.'],
  ['9', 'Performance evaluation', 'Monitor, evaluate compliance, audit and review.'],
  ['9.1', 'Monitoring, measurement, analysis and performance evaluation', 'Measure OH&S performance and evaluate compliance.'],
  ['9.1.1', 'General (monitoring and measurement)', 'Decide what to monitor, including legal requirements, activities and controls, how and when, use calibrated equipment, and keep records.'],
  ['9.1.2', 'Evaluation of compliance', 'At planned intervals check whether legal and other requirements are met, act where they are not, and keep records.'],
  ['9.2', 'Internal audit', 'Audit the OH&S system at planned intervals.'],
  ['9.2.1', 'General (internal audit)', 'Audit to find out whether the system meets the business’s own and the standard’s requirements and is working.'],
  ['9.2.2', 'Internal audit programme', 'Plan an audit programme, choose impartial auditors, report results to management and workers, act and keep records.'],
  ['9.3', 'Management review', 'Top management reviews the system at planned intervals, considering set inputs, recording decisions and sharing the outputs with workers.'],
  ['10', 'Improvement', 'Act on incidents and problems and keep improving.'],
  ['10.1', 'General (improvement)', 'Look for opportunities to improve and act on them to reach the intended outcomes.'],
  ['10.2', 'Incident, nonconformity and corrective action', 'React to an incident or nonconformity, investigate with workers involved, find the cause, act using the hierarchy of controls, check the action worked and keep records.'],
  ['10.3', 'Continual improvement', 'Keep improving the system and OH&S performance, promoting a positive safety culture and involving workers.'],
]); // prettier-ignore

// ---------- management review (catalogue §5) ----------

type InputRow = readonly [ReviewInputKey, string, ReviewInputSource, string?, string?, string?];

/**
 * One row per input: key, title, source, then the 9001, 14001 and 45001 reference. A reference is `<clause> <item>`
 * or `<clause>`; where the catalogue lists two items for one standard, the first is the one stored (one definition
 * per key and standard).
 */
const INPUTS: readonly InputRow[] = [
  ['PREVIOUS_ACTIONS', 'Status of actions from earlier reviews', 'PREVIOUS_ACTIONS', '9.3.2 a', '9.3 a', '9.3 a'],
  ['CONTEXT_CHANGES', 'Changes in external and internal issues', 'CONTEXT', '9.3.2 b', '9.3 b1', '9.3 b'],
  ['INTERESTED_PARTIES', 'Changes in interested parties’ needs, compliance obligations, legal and other requirements', 'CONTEXT', undefined, '9.3 b2', '9.3 b1'],
  ['SIGNIFICANT_ASPECTS', 'Changes in significant environmental aspects', 'RISKS', undefined, '9.3 b3'],
  ['RISKS_AND_OPPORTUNITIES', 'Changes in risks and opportunities', 'RISKS', undefined, '9.3 b4', '9.3 b3'],
  ['RISK_ACTIONS', 'Effectiveness of actions on risks and opportunities', 'RISKS', '9.3.2 e'],
  ['CUSTOMER_SATISFACTION', 'Customer satisfaction and feedback', 'MANUAL', '9.3.2 c1'],
  ['OBJECTIVES', 'How far the policy and objectives were met', 'OBJECTIVES', '9.3.2 c2', '9.3 c', '9.3 c'],
  ['PROCESS_PERFORMANCE', 'Process performance and conformity of products and services', 'MANUAL', '9.3.2 c3'],
  ['NONCONFORMITIES', 'Nonconformities and corrective actions', 'NONCONFORMITIES', '9.3.2 c4', '9.3 d1', '9.3 d1'],
  ['INCIDENTS', 'Incidents', 'INCIDENTS', undefined, undefined, '9.3 d1'],
  ['MONITORING_RESULTS', 'Monitoring and measurement results', 'MANUAL', '9.3.2 c5', '9.3 d2', '9.3 d2'],
  ['COMPLIANCE_EVALUATION', 'Fulfilment of compliance obligations, evaluation of compliance', 'COMPLIANCE_EVALUATION', undefined, '9.3 d3', '9.3 d3'],
  ['AUDIT_RESULTS', 'Audit results', 'AUDIT_RESULTS', '9.3.2 c6', '9.3 d4', '9.3 d4'],
  ['EXTERNAL_PROVIDERS', 'Performance of external providers', 'MANUAL', '9.3.2 c7'],
  ['WORKER_CONSULTATION', 'Consultation and participation of workers', 'MANUAL', undefined, undefined, '9.3 d5'],
  ['RESOURCES', 'Adequacy of resources', 'MANUAL', '9.3.2 d', '9.3 e', '9.3 e'],
  ['COMMUNICATIONS', 'Relevant communications from interested parties, complaints included', 'MANUAL', undefined, '9.3 f', '9.3 f'],
  ['IMPROVEMENT_OPPORTUNITIES', 'Opportunities for improvement', 'MANUAL', '9.3.2 f', '9.3 g', '9.3 g'],
]; // prettier-ignore

type OutputRow = readonly [ReviewOutputKey, string, string?, string?, string?];

const OUTPUTS: readonly OutputRow[] = [
  ['SUITABILITY', 'Conclusions on continuing suitability, adequacy and effectiveness', undefined, '9.3', '9.3'],
  ['IMPROVEMENT', 'Decisions on improvement opportunities', '9.3.3 a', '9.3', '9.3'],
  ['SYSTEM_CHANGES', 'Decisions on changes to the management system', '9.3.3 b', '9.3', '9.3'],
  ['RESOURCE_NEEDS', 'Resources needed', '9.3.3 c', '9.3', '9.3'],
  ['OBJECTIVES_NOT_MET', 'Actions where objectives were not met', undefined, '9.3', '9.3'],
  ['INTEGRATION', 'Better integration with other business processes', undefined, '9.3', '9.3'],
  ['STRATEGIC_DIRECTION', 'Implications for the organisation’s strategic direction', undefined, '9.3', '9.3'],
  ['WORKER_COMMUNICATION', 'Outputs communicated to workers and their representatives', undefined, undefined, '9.3'],
]; // prettier-ignore

const STANDARD_COLUMN: Record<IsoStandardCode, 0 | 1 | 2> = {
  ISO_9001: 0,
  ISO_14001: 1,
  ISO_45001: 2,
};

function reference(ref: string): { clauseNumber: string; item: string | null } {
  const [clauseNumber, item] = ref.split(' ');
  return { clauseNumber: clauseNumber!, item: item ?? null };
}

function reviewInputs(code: IsoStandardCode): CatalogueReviewInput[] {
  return INPUTS.flatMap(([key, title, source, ...refs]) => {
    const ref = refs[STANDARD_COLUMN[code]];
    return ref === undefined ? [] : [{ key, title, source, ...reference(ref) }];
  });
}

function reviewOutputs(code: IsoStandardCode): CatalogueReviewOutput[] {
  return OUTPUTS.flatMap(([key, title, ...refs]) => {
    const ref = refs[STANDARD_COLUMN[code]];
    return ref === undefined ? [] : [{ key, title, ...reference(ref) }];
  });
}

// ---------- standards (catalogue §6) ----------

const STANDARDS: readonly CatalogueStandard[] = [
  {
    code: 'ISO_9001',
    edition: '2015+A1:2024',
    title: 'ISO 9001',
    topic: 'Quality management',
    clauses: ISO_9001_CLAUSES,
    reviewInputs: reviewInputs('ISO_9001'),
    reviewOutputs: reviewOutputs('ISO_9001'),
  },
  {
    code: 'ISO_14001',
    edition: '2015+A1:2024',
    title: 'ISO 14001',
    topic: 'Environmental management',
    clauses: ISO_14001_CLAUSES,
    reviewInputs: reviewInputs('ISO_14001'),
    reviewOutputs: reviewOutputs('ISO_14001'),
  },
  {
    code: 'ISO_45001',
    edition: '2018+A1:2024',
    title: 'ISO 45001',
    topic: 'Occupational health and safety management',
    clauses: ISO_45001_CLAUSES,
    reviewInputs: reviewInputs('ISO_45001'),
    reviewOutputs: reviewOutputs('ISO_45001'),
  },
];

// ---------- STANDARD acts and activities (catalogue §2, §3) ----------

const ACTS: readonly CatalogueAct[] = (
  [
    { key: 'ISO_9001', name: 'ISO 9001 quality management', shortName: 'ISO 9001' },
    { key: 'ISO_14001', name: 'ISO 14001 environmental management', shortName: 'ISO 14001' },
    {
      key: 'ISO_45001',
      name: 'ISO 45001 occupational health and safety management',
      shortName: 'ISO 45001',
    },
    {
      key: 'ISO_IMS',
      name: 'Integrated management system (ISO 9001, 14001, 45001)',
      shortName: 'ISO IMS',
    },
  ] satisfies { key: ActKey; name: string; shortName: string }[]
).map((a) => ({ ...a, jurisdiction: 'CENTRAL' as const, stateCode: null, aliases: [] }));

const refs = (code: IsoStandardCode, ...numbers: string[]): ClauseRef[] =>
  numbers.map((clauseNumber) => ({ standard: code, clauseNumber }));
const all3 = (...numbers: string[]): ClauseRef[] => [
  ...refs('ISO_9001', ...numbers),
  ...refs('ISO_14001', ...numbers),
  ...refs('ISO_45001', ...numbers),
];

function activity(
  key: string,
  act: ActKey,
  title: string,
  clauseRefs: ClauseRef[],
  recurrenceRule: RecurrenceRule,
  description: string,
): CatalogueActivity {
  return {
    key,
    act,
    externalRef: `ISO-${key}`,
    domain: 'OTHER',
    jurisdiction: 'CENTRAL',
    stateCode: null,
    title,
    description,
    applicabilityText: null,
    criticality: 'MEDIUM',
    timelineType: 'TIME_BASED',
    recurrenceRule,
    ruleStatus: 'CONFIRMED',
    evidenceRequired: true,
    forms: [],
    logSheets: [],
    clauseRefs,
  };
}

/** Evidence of each instance is the record named here (catalogue §3). Due dates follow an April-March year. */
const ACTIVITIES: readonly CatalogueActivity[] = [
  activity(
    'CONTEXT-REVIEW',
    'ISO_IMS',
    'Review of context and interested parties',
    all3('4.1', '4.2'),
    { kind: 'ANNUAL', month: 4, day: 30 },
    'Review the internal and external issues and the interested parties and their requirements for the management system, including whether climate change is a relevant issue. Evidence: the updated issues and interested-party lists from the ISO context screen.',
  ),
  activity(
    'COMPLIANCE-EVALUATION',
    'ISO_IMS',
    'Evaluation of compliance',
    [...refs('ISO_14001', '9.1.2'), ...refs('ISO_45001', '9.1.2')],
    { kind: 'HALF_YEARLY', anchor: 'AFTER_PERIOD_END', days: 30 },
    'Evaluate whether the legal and other requirements that apply are being met, and record the result and any actions. Evidence: the evaluation record; the statutory compliance score report for the period can be attached.',
  ),
  activity(
    'COMPETENCE-REVIEW',
    'ISO_IMS',
    'Competence review: training needs and effectiveness',
    all3('7.2'),
    { kind: 'ANNUAL', month: 5, day: 31 },
    'Review the competence each role needs, the training given and whether it worked, and plan the next year’s training. Evidence: the training matrix.',
  ),
  activity(
    'AWARENESS',
    'ISO_IMS',
    'Awareness and induction',
    all3('7.3'),
    { kind: 'HALF_YEARLY', anchor: 'PERIOD_END', days: 0 },
    'Brief new joiners and refresh existing staff on the policies, the objectives and risks relevant to their work, and what happens when requirements are not met. Evidence: the attendance record.',
  ),
  activity(
    'CALIBRATION',
    'ISO_IMS',
    'Calibration or verification of monitoring equipment',
    [...refs('ISO_9001', '7.1.5'), ...refs('ISO_14001', '9.1.1'), ...refs('ISO_45001', '9.1.1')],
    { kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 0 },
    'Check that every monitoring and measuring instrument due in the quarter has been calibrated or verified, and act on any found out of calibration. Evidence: the instrument list with calibration status.',
  ),
  activity(
    'EXTERNAL-PROVIDERS',
    'ISO_IMS',
    'Evaluation and re-evaluation of external providers',
    [...refs('ISO_9001', '8.4.1'), ...refs('ISO_14001', '8.1'), ...refs('ISO_45001', '8.1.4')],
    { kind: 'ANNUAL', month: 6, day: 30 },
    'Evaluate suppliers, service providers and contractors against the criteria, including their quality, environmental and safety performance, and update the approved list. Evidence: the approved supplier list with ratings.',
  ),
  activity(
    'EMERGENCY-DRILL',
    'ISO_IMS',
    'Emergency drill and post-drill evaluation',
    [...refs('ISO_14001', '8.2'), ...refs('ISO_45001', '8.2')],
    { kind: 'HALF_YEARLY', anchor: 'PERIOD_END', days: 0 },
    'Run an emergency drill, then review how the response went and update the emergency plan. Where a statutory obligation already requires a mock drill at this unit (for example under the state factory rules), assign that obligation or this activity, not both: one drill report serves both. Evidence: the drill report.',
  ),
  activity(
    'CONTRACTOR-REVIEW',
    'ISO_45001',
    'Contractor OH&S review',
    refs('ISO_45001', '8.1.4.2'),
    { kind: 'QUARTERLY', anchor: 'AFTER_PERIOD_END', days: 15 },
    'Review the hazards and risks from contractors’ work, how they are controlled and how contractors performed on safety in the quarter. Evidence: the review record.',
  ),
  activity(
    'WORKPLACE-INSPECTION',
    'ISO_45001',
    'Workplace inspection',
    refs('ISO_45001', '9.1.1'),
    { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
    'Inspect the workplace for hazards and for controls not in place, and record what was found and the actions raised. Evidence: the inspection record.',
  ),
  activity(
    'WORKER-CONSULTATION',
    'ISO_45001',
    'Worker consultation and participation',
    refs('ISO_45001', '5.4'),
    { kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 0 },
    'Consult workers and their representatives on safety matters, for example through the safety committee. Where a statutory obligation already requires safety committee meetings at this unit, assign that obligation or this activity, not both: the same minutes serve both. Evidence: the committee minutes.',
  ),
  activity(
    'ENV-MONITORING',
    'ISO_14001',
    'Environmental performance monitoring',
    refs('ISO_14001', '9.1.1'),
    { kind: 'MONTHLY', day: 10, offsetMonths: 1 },
    'Record the month’s environmental monitoring data, such as energy, water, waste and emissions, and compare it with the objectives and limits. Evidence: the monitoring data.',
  ),
  activity(
    'CUSTOMER-SATISFACTION',
    'ISO_9001',
    'Customer satisfaction survey and analysis',
    refs('ISO_9001', '9.1.2'),
    { kind: 'ANNUAL', month: 3, day: 31 },
    'Gather customer feedback, for example through a survey, and analyse what it says about performance. Evidence: the survey results and analysis.',
  ),
  activity(
    'DATA-ANALYSIS',
    'ISO_9001',
    'Analysis and evaluation of data',
    refs('ISO_9001', '9.1.3'),
    { kind: 'QUARTERLY', anchor: 'AFTER_PERIOD_END', days: 30 },
    'Analyse the quarter’s quality data: conformity, customer satisfaction, process and supplier performance and the effect of actions on risks. Evidence: the analysis record.',
  ),
];

export const ISO_CATALOGUE: IsoCatalogue = {
  version: 1,
  standards: STANDARDS,
  acts: ACTS,
  category: 'ISO management systems',
  activities: ACTIVITIES,
};

// ---------- check ----------

/**
 * Throws when the catalogue is inconsistent, so a broken one never half-copies (ADR M6-0003 decision 2): repeated
 * keys, editions, clause numbers or review keys; a clause whose parent is missing; an exclusion outside ISO 9001 or on a
 * clause that is not assessable; an activity under an unknown act, naming a clause the catalogue does not have, or with
 * a rule the engine finds no due dates for.
 */
export function checkIsoCatalogue(catalogue: IsoCatalogue, asOf = '2026-04-01' as LocalDate): void {
  const fail = (message: string): never => {
    throw new Error(`ISO catalogue: ${message}`);
  };
  const unique = (values: readonly string[], what: string) => {
    const seen = new Set<string>();
    for (const v of values) {
      if (seen.has(v)) fail(`${what} "${v}" is repeated`);
      seen.add(v);
    }
    return seen;
  };
  unique(
    catalogue.standards.map((s) => `${s.code} ${s.edition}`),
    'edition',
  );
  const clausesOf = new Map<IsoStandardCode, Set<string>>();
  for (const s of catalogue.standards) {
    const numbers = unique(
      s.clauses.map((c) => c.number),
      `${s.code} clause`,
    );
    for (const c of s.clauses) {
      if (c.parent !== null && !numbers.has(c.parent)) fail(`${s.code} ${c.number} has no parent`);
      if (c.exclusionAllowed && (!c.assessable || s.code !== 'ISO_9001')) {
        fail(`${s.code} ${c.number} cannot allow an exclusion`);
      }
      if (c.summary.length > 1000 || c.title.length > 200)
        fail(`${s.code} ${c.number} is too long`);
    }
    for (const d of [...s.reviewInputs, ...s.reviewOutputs]) {
      if (!numbers.has(d.clauseNumber))
        fail(`${s.code} review ${d.key} names clause ${d.clauseNumber}`);
    }
    unique(
      s.reviewInputs.map((d) => d.key),
      `${s.code} review input`,
    );
    unique(
      s.reviewOutputs.map((d) => d.key),
      `${s.code} review output`,
    );
    const known = clausesOf.get(s.code) ?? new Set<string>();
    numbers.forEach((n) => known.add(n));
    clausesOf.set(s.code, known);
  }
  const acts = unique(
    catalogue.acts.map((a) => a.key),
    'act',
  );
  unique(
    catalogue.acts.map((a) => a.name),
    'act name',
  );
  unique(
    catalogue.activities.map((a) => a.key),
    'activity',
  );
  for (const a of catalogue.activities) {
    if (!acts.has(a.act)) fail(`activity ${a.key} names unknown act ${a.act}`);
    if (a.clauseRefs.length === 0) fail(`activity ${a.key} names no clause`);
    if (a.externalRef !== `ISO-${a.key}`)
      fail(`activity ${a.key} needs the source ID ISO-${a.key}`);
    for (const ref of a.clauseRefs) {
      if (!clausesOf.get(ref.standard)?.has(ref.clauseNumber)) {
        fail(
          `activity ${a.key} names ${ref.standard} ${ref.clauseNumber}, which is not in the catalogue`,
        );
      }
    }
    if (ruleIssues(a.recurrenceRule, asOf).length > 0)
      fail(`activity ${a.key} has a rule that does not work`);
  }
}
