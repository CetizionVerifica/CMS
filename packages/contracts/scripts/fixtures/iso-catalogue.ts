// The ISO catalogue fixture (docs/contracts/fixtures.md §8, docs/iso/catalogue.md): standards, clauses, management
// review inputs and outputs, and the STANDARD acts with their activities. Clause titles are the standards' headings,
// with our own short label where a numbered paragraph has none; every summary is our own wording. No text of any
// standard is copied here (ADR M16-0001). ISO-9 (M6) checks numbers and titles against the published standards.
import type { z } from 'zod';
import type * as C from '../../src/index.js';
import type { IsoCatalogueFixture } from '../../src/fixtures/schema.js';

type Code = z.input<typeof C.IsoStandardCode>;
type Fixture = z.input<typeof IsoCatalogueFixture>;
type ReviewSource = z.input<typeof C.ReviewInputSource>;
type Rule = z.input<typeof C.RecurrenceRule>;

/** Bumped when the catalogue changes, as ISO-9's bundle version is. */
export const ISO_CATALOGUE_VERSION = '2026.1';

export const EDITIONS: Record<Code, string> = {
  ISO_9001: '2015+A1:2024',
  ISO_14001: '2015+A1:2024',
  ISO_45001: '2018+A1:2024',
};

const STANDARDS: [Code, string, string][] = [
  ['ISO_9001', 'ISO 9001', 'Quality management'],
  ['ISO_14001', 'ISO 14001', 'Environmental management'],
  ['ISO_45001', 'ISO 45001', 'Occupational health and safety management'],
];

/** [number, title, summary]. Clauses 1 to 3 are never assessable. */
type Row = [string, string, string];

const INTRO: Row[] = [
  ['1', 'Scope', 'What the standard covers and who can use it.'],
  ['2', 'Normative references', 'Other documents the standard relies on.'],
  ['3', 'Terms and definitions', 'The words the standard uses and what they mean.'],
];

const CLAUSES: Record<Code, Row[]> = {
  ISO_9001: [
    ...INTRO,
    [
      '4',
      'Context of the organization',
      'Know the organisation, who it answers to and where the system stops.',
    ],
    [
      '4.1',
      'Understanding the organization and its context',
      'List the internal and external issues that shape what the system must achieve, and decide whether climate change is one of them.',
    ],
    [
      '4.2',
      'Understanding the needs and expectations of interested parties',
      'Name the parties that matter and what each expects; some may have climate-related requirements.',
    ],
    [
      '4.3',
      'Determining the scope of the quality management system',
      'Write down the sites, products and services the system covers, and justify any requirement that does not apply.',
    ],
    [
      '4.4',
      'Quality management system and its processes',
      'Set up and run the processes the system needs.',
    ],
    [
      '4.4.1',
      'Processes of the system',
      'Name the processes, their inputs, outputs, order, owners and measures.',
    ],
    [
      '4.4.2',
      'Documented information on processes',
      'Keep what is needed to run the processes and show they ran as planned.',
    ],
    ['5', 'Leadership', 'Top management leads the system and owns its results.'],
    [
      '5.1',
      'Leadership and commitment',
      'Top management is accountable for the system and backs it in practice.',
    ],
    [
      '5.1.1',
      'General',
      'Top management takes part, gives resources and makes the system part of the business.',
    ],
    ['5.1.2', 'Customer focus', 'Keep customer needs and satisfaction at the centre of decisions.'],
    ['5.2', 'Policy', 'Keep a quality policy that sets direction.'],
    [
      '5.2.1',
      'Establishing the quality policy',
      'Write a policy that fits the organisation and commits to improvement.',
    ],
    [
      '5.2.2',
      'Communicating the quality policy',
      'Make the policy available, understood and applied.',
    ],
    [
      '5.3',
      'Organizational roles, responsibilities and authorities',
      'Assign who does what in the system and tell people.',
    ],
    ['6', 'Planning', 'Plan how the system deals with risks and reaches its objectives.'],
    [
      '6.1',
      'Actions to address risks and opportunities',
      'Find what could go wrong or better and plan actions for it.',
    ],
    [
      '6.1.1',
      'Determining risks and opportunities',
      'Consider the context and parties to find the risks and opportunities to act on.',
    ],
    ['6.1.2', 'Planning actions', 'Plan proportionate actions and check they work.'],
    [
      '6.2',
      'Quality objectives and planning to achieve them',
      'Set measurable objectives and plan how to reach them.',
    ],
    [
      '6.2.1',
      'Setting quality objectives',
      'Objectives are consistent with the policy, measurable, monitored and updated.',
    ],
    [
      '6.2.2',
      'Planning to achieve quality objectives',
      'Decide what will be done, by whom, with what, by when and how results are judged.',
    ],
    ['6.3', 'Planning of changes', 'Change the system in a planned way, keeping it whole.'],
    ['7', 'Support', 'Provide the people, skills, communication and records the system needs.'],
    ['7.1', 'Resources', 'Make sure people, infrastructure and tools are in place.'],
    ['7.1.1', 'General', 'Decide the resources needed, from inside and outside.'],
    ['7.1.2', 'People', 'Have the people needed to run the system and its processes.'],
    [
      '7.1.3',
      'Infrastructure',
      'Provide and maintain buildings, equipment, software and transport.',
    ],
    [
      '7.1.4',
      'Environment for the operation of processes',
      'Provide the working conditions processes need.',
    ],
    ['7.1.5', 'Monitoring and measuring resources', 'Keep measuring equipment fit for use.'],
    [
      '7.1.5.1',
      'General',
      'Use suitable, maintained resources where results are monitored or measured.',
    ],
    [
      '7.1.5.2',
      'Measurement traceability',
      'Calibrate or verify equipment where traceability is needed, and act on faults.',
    ],
    ['7.1.6', 'Organizational knowledge', 'Keep the know-how processes need and share it.'],
    ['7.2', 'Competence', 'Decide the skills each role needs, close gaps and keep proof.'],
    [
      '7.3',
      'Awareness',
      'People know the policy, their part in the system and what slipping would mean.',
    ],
    ['7.4', 'Communication', 'Decide what is said, to whom, when and how.'],
    ['7.5', 'Documented information', 'Keep the documents and records the system needs.'],
    ['7.5.1', 'General', 'Decide which documented information the system needs.'],
    ['7.5.2', 'Creating and updating', 'Identify, format, review and approve documents.'],
    [
      '7.5.3',
      'Control of documented information',
      'Keep documents available, protected and under change control.',
    ],
    [
      '7.5.3.1',
      'Availability and protection',
      'Documents are where they are needed and protected from misuse or loss.',
    ],
    [
      '7.5.3.2',
      'Distribution, storage and retention',
      'Control access, versions, storage, retention and disposal.',
    ],
    ['8', 'Operation', 'Run day-to-day work under the controls the system plans.'],
    [
      '8.1',
      'Operational planning and control',
      'Plan and control the processes, including changes and outsourced work.',
    ],
    [
      '8.2',
      'Requirements for products and services',
      'Agree what customers need and confirm it can be met.',
    ],
    [
      '8.2.1',
      'Customer communication',
      'Talk with customers about offers, orders, feedback and their property.',
    ],
    [
      '8.2.2',
      'Determining the requirements for products and services',
      'Define the requirements, legal ones included.',
    ],
    [
      '8.2.3',
      'Review of the requirements for products and services',
      'Check the organisation can meet what it offers before committing.',
    ],
    [
      '8.2.3.1',
      'Conducting the review',
      'Review stated, implied and legal requirements before accepting an order.',
    ],
    [
      '8.2.3.2',
      'Records of the review',
      'Keep the results of the review and any new requirements.',
    ],
    [
      '8.2.4',
      'Changes to requirements for products and services',
      'Update records and tell people when requirements change.',
    ],
    [
      '8.3',
      'Design and development of products and services',
      'Control design work from inputs to verified outputs.',
    ],
    ['8.3.1', 'General', 'Set up a design process where design is needed.'],
    [
      '8.3.2',
      'Design and development planning',
      'Plan stages, reviews, responsibilities and resources.',
    ],
    ['8.3.3', 'Design and development inputs', 'Gather the requirements a design must meet.'],
    ['8.3.4', 'Design and development controls', 'Review, verify and validate designs.'],
    [
      '8.3.5',
      'Design and development outputs',
      'Outputs meet the inputs and are fit for later steps.',
    ],
    ['8.3.6', 'Design and development changes', 'Control and record design changes.'],
    [
      '8.4',
      'Control of externally provided processes, products and services',
      'Choose, check and monitor suppliers and outsourced work.',
    ],
    ['8.4.1', 'General', 'Evaluate, select and re-evaluate external providers.'],
    [
      '8.4.2',
      'Type and extent of control',
      'Decide how tightly to control what suppliers provide.',
    ],
    ['8.4.3', 'Information for external providers', 'Tell suppliers clearly what is needed.'],
    [
      '8.5',
      'Production and service provision',
      'Make products and deliver services under controlled conditions.',
    ],
    [
      '8.5.1',
      'Control of production and service provision',
      'Work to defined conditions, with checks at the right stages.',
    ],
    [
      '8.5.2',
      'Identification and traceability',
      'Identify outputs and their status, and trace them where needed.',
    ],
    [
      '8.5.3',
      'Property belonging to customers or external providers',
      'Look after property owned by customers or suppliers.',
    ],
    ['8.5.4', 'Preservation', 'Keep outputs in good condition through production and delivery.'],
    [
      '8.5.5',
      'Post-delivery activities',
      'Meet the needs that follow delivery, such as support or warranty.',
    ],
    ['8.5.6', 'Control of changes', 'Review and control changes in production or service.'],
    ['8.6', 'Release of products and services', 'Release only what has passed its checks.'],
    ['8.7', 'Control of nonconforming outputs', 'Stop faulty output reaching the customer.'],
    [
      '8.7.1',
      'Handling nonconforming outputs',
      'Identify faulty output and correct, segregate, return or accept it under concession.',
    ],
    [
      '8.7.2',
      'Records of nonconforming outputs',
      'Record the problem, the action and who decided.',
    ],
    ['9', 'Performance evaluation', 'Check how the system performs.'],
    [
      '9.1',
      'Monitoring, measurement, analysis and evaluation',
      'Decide what to measure, measure it and act on the results.',
    ],
    ['9.1.1', 'General', 'Decide what, how and when to monitor and measure.'],
    [
      '9.1.2',
      'Customer satisfaction',
      "Find out how customers see the organisation's performance.",
    ],
    [
      '9.1.3',
      'Analysis and evaluation',
      'Analyse the data to judge performance and find improvements.',
    ],
    ['9.2', 'Internal audit', 'Audit the system to a plan, with auditors who stay objective.'],
    [
      '9.2.1',
      'Purpose of internal audits',
      "Check the system meets its own and the standard's requirements and works.",
    ],
    [
      '9.2.2',
      'Audit programme',
      'Plan audits by importance and past results, and report and act on them.',
    ],
    ['9.3', 'Management review', 'Top management reviews the system at set intervals.'],
    ['9.3.1', 'General', 'Hold reviews at planned intervals.'],
    ['9.3.2', 'Management review inputs', 'What the review looks at.'],
    ['9.3.3', 'Management review outputs', 'What the review decides, with records.'],
    ['10', 'Improvement', 'Keep making the system and its results better.'],
    ['10.1', 'General', 'Look for chances to improve and act on them.'],
    [
      '10.2',
      'Nonconformity and corrective action',
      'Contain problems, find their cause and fix it.',
    ],
    [
      '10.2.1',
      'Responding to nonconformity',
      'React, find the cause, act, check the action worked and update the system.',
    ],
    ['10.2.2', 'Records of nonconformity', 'Record each problem, the action taken and the result.'],
    [
      '10.3',
      'Continual improvement',
      'Improve how suitable, adequate and effective the system is over time.',
    ],
  ],
  ISO_14001: [
    ...INTRO,
    [
      '4',
      'Context of the organization',
      'Know the organisation, who it answers to and where the system stops.',
    ],
    [
      '4.1',
      'Understanding the organization and its context',
      'List the issues, environmental conditions included, that shape the system, and decide whether climate change is one of them.',
    ],
    [
      '4.2',
      'Understanding the needs and expectations of interested parties',
      'Name the parties that matter, what each expects and which become compliance obligations; some may have climate-related requirements.',
    ],
    [
      '4.3',
      'Determining the scope of the environmental management system',
      'Write down the boundaries and activities the system covers.',
    ],
    ['4.4', 'Environmental management system', 'Set up, run, keep up and improve the system.'],
    ['5', 'Leadership', 'Top management leads the system and owns its results.'],
    [
      '5.1',
      'Leadership and commitment',
      'Top management is accountable for the system and backs it in practice.',
    ],
    [
      '5.2',
      'Environmental policy',
      'Keep a policy committing to protect the environment, meet obligations and improve.',
    ],
    [
      '5.3',
      'Organizational roles, responsibilities and authorities',
      'Assign who does what in the system and tell people.',
    ],
    ['6', 'Planning', 'Plan how the system deals with aspects, obligations and risks.'],
    [
      '6.1',
      'Actions to address risks and opportunities',
      'Find what could go wrong or better and plan actions for it.',
    ],
    ['6.1.1', 'General', 'Plan the processes for risks, opportunities and emergencies.'],
    [
      '6.1.2',
      'Environmental aspects',
      'List how activities affect the environment over the life cycle and which effects are significant.',
    ],
    [
      '6.1.3',
      'Compliance obligations',
      'Know the environmental laws and other commitments that apply.',
    ],
    ['6.1.4', 'Planning action', 'Plan actions for significant aspects, obligations and risks.'],
    [
      '6.2',
      'Environmental objectives and planning to achieve them',
      'Set measurable objectives and plan how to reach them.',
    ],
    [
      '6.2.1',
      'Environmental objectives',
      'Objectives are consistent with the policy, measurable and monitored.',
    ],
    [
      '6.2.2',
      'Planning actions to achieve environmental objectives',
      'Decide what will be done, by whom, by when and how results are judged.',
    ],
    ['7', 'Support', 'Provide the people, skills, communication and records the system needs.'],
    ['7.1', 'Resources', 'Provide the resources the system needs.'],
    ['7.2', 'Competence', 'Decide the skills each role needs, close gaps and keep proof.'],
    [
      '7.3',
      'Awareness',
      'People know the policy, the significant aspects near them and their part.',
    ],
    ['7.4', 'Communication', 'Decide what is said, to whom, when and how.'],
    ['7.4.1', 'General', 'Plan internal and external communication, obligations included.'],
    [
      '7.4.2',
      'Internal communication',
      'Share system information across levels and let people suggest improvements.',
    ],
    [
      '7.4.3',
      'External communication',
      'Communicate outside as planned and as obligations require.',
    ],
    ['7.5', 'Documented information', 'Keep the documents and records the system needs.'],
    ['7.5.1', 'General', 'Decide which documented information the system needs.'],
    ['7.5.2', 'Creating and updating', 'Identify, format, review and approve documents.'],
    [
      '7.5.3',
      'Control of documented information',
      'Keep documents available, protected and under change control.',
    ],
    ['8', 'Operation', 'Run day-to-day work under the controls the system plans.'],
    [
      '8.1',
      'Operational planning and control',
      'Control processes, changes, outsourcing and life-cycle stages.',
    ],
    [
      '8.2',
      'Emergency preparedness and response',
      'Prepare for environmental emergencies and test the plans.',
    ],
    ['9', 'Performance evaluation', 'Check how the system performs.'],
    [
      '9.1',
      'Monitoring, measurement, analysis and evaluation',
      'Decide what to measure, measure it and act on the results.',
    ],
    ['9.1.1', 'General', 'Monitor environmental performance with calibrated equipment.'],
    [
      '9.1.2',
      'Evaluation of compliance',
      'Check at set intervals that compliance obligations are met.',
    ],
    ['9.2', 'Internal audit', 'Audit the system to a plan, with auditors who stay objective.'],
    [
      '9.2.1',
      'General',
      "Check the system meets its own and the standard's requirements and works.",
    ],
    [
      '9.2.2',
      'Internal audit programme',
      'Plan audits by importance and past results, and report them.',
    ],
    [
      '9.3',
      'Management review',
      'Top management reviews the system at set intervals and decides on changes.',
    ],
    ['10', 'Improvement', 'Keep making the system and its results better.'],
    ['10.1', 'General', 'Look for chances to improve and act on them.'],
    [
      '10.2',
      'Nonconformity and corrective action',
      'Contain problems, find their cause and fix it so they do not return.',
    ],
    ['10.3', 'Continual improvement', 'Improve the system to improve environmental performance.'],
  ],
  ISO_45001: [
    ...INTRO,
    [
      '4',
      'Context of the organization',
      'Know the organisation, who it answers to and where the system stops.',
    ],
    [
      '4.1',
      'Understanding the organization and its context',
      'List the issues that shape the OH&S system, and decide whether climate change is one of them.',
    ],
    [
      '4.2',
      'Understanding the needs and expectations of workers and other interested parties',
      'Name workers and other parties, what each expects and which become legal or other requirements; some may have climate-related requirements.',
    ],
    [
      '4.3',
      'Determining the scope of the OH&S management system',
      'Write down the boundaries and activities the system covers.',
    ],
    ['4.4', 'OH&S management system', 'Set up, run, keep up and improve the system.'],
    [
      '5',
      'Leadership and worker participation',
      'Top management leads, and workers take part in, the system.',
    ],
    [
      '5.1',
      'Leadership and commitment',
      'Top management is accountable for preventing injury and ill health.',
    ],
    [
      '5.2',
      'OH&S policy',
      'Keep a policy committing to safe and healthy work, legal compliance and consultation.',
    ],
    [
      '5.3',
      'Organizational roles, responsibilities and authorities',
      'Assign who does what in the system and tell people.',
    ],
    [
      '5.4',
      'Consultation and participation of workers',
      'Involve workers and their representatives in the OH&S system.',
    ],
    ['6', 'Planning', 'Plan how the system deals with hazards, risks and requirements.'],
    [
      '6.1',
      'Actions to address risks and opportunities',
      'Find what could go wrong or better and plan actions for it.',
    ],
    ['6.1.1', 'General', 'Plan the processes for hazards, risks, opportunities and requirements.'],
    [
      '6.1.2',
      'Hazard identification and assessment of risks and opportunities',
      'Find hazards and rate risks and opportunities.',
    ],
    [
      '6.1.2.1',
      'Hazard identification',
      'Find hazards in routine and non-routine work, emergencies and changes.',
    ],
    [
      '6.1.2.2',
      'Assessment of OH&S risks and other risks to the OH&S management system',
      'Rate the risks from the hazards found and to the system itself.',
    ],
    [
      '6.1.2.3',
      'Assessment of OH&S opportunities and other opportunities for the OH&S management system',
      'Find chances to make work safer and the system better.',
    ],
    [
      '6.1.3',
      'Determination of legal requirements and other requirements',
      'Know the OH&S laws and other commitments that apply.',
    ],
    ['6.1.4', 'Planning action', 'Plan actions for risks, legal requirements and emergencies.'],
    [
      '6.2',
      'OH&S objectives and planning to achieve them',
      'Set measurable objectives and plan how to reach them.',
    ],
    [
      '6.2.1',
      'OH&S objectives',
      'Objectives are consistent with the policy, measurable and monitored.',
    ],
    [
      '6.2.2',
      'Planning to achieve OH&S objectives',
      'Decide what will be done, by whom, by when and how results are judged.',
    ],
    ['7', 'Support', 'Provide the people, skills, communication and records the system needs.'],
    ['7.1', 'Resources', 'Provide the resources the system needs.'],
    [
      '7.2',
      'Competence',
      'Decide the skills each role needs, including spotting hazards, and keep proof.',
    ],
    [
      '7.3',
      'Awareness',
      'Workers know the policy, the hazards near them and that they may step away from danger.',
    ],
    ['7.4', 'Communication', 'Decide what is said, to whom, when and how.'],
    [
      '7.4.1',
      'General',
      'Plan communication, taking language, culture and disability into account.',
    ],
    [
      '7.4.2',
      'Internal communication',
      'Share system information across levels and let workers suggest improvements.',
    ],
    [
      '7.4.3',
      'External communication',
      'Communicate outside as planned and as requirements demand.',
    ],
    ['7.5', 'Documented information', 'Keep the documents and records the system needs.'],
    ['7.5.1', 'General', 'Decide which documented information the system needs.'],
    ['7.5.2', 'Creating and updating', 'Identify, format, review and approve documents.'],
    [
      '7.5.3',
      'Control of documented information',
      'Keep documents available, protected and under change control.',
    ],
    ['8', 'Operation', 'Run day-to-day work under the controls the system plans.'],
    ['8.1', 'Operational planning and control', 'Plan and control the processes that affect OH&S.'],
    ['8.1.1', 'General', 'Set criteria for processes and adapt work to workers.'],
    [
      '8.1.2',
      'Eliminating hazards and reducing OH&S risks',
      'Remove hazards first, then reduce risk in the order of controls.',
    ],
    ['8.1.3', 'Management of change', 'Control the OH&S effects of planned changes.'],
    ['8.1.4', 'Procurement', 'Control OH&S in buying, contractors and outsourcing.'],
    ['8.1.4.1', 'General', "Make sure what is bought meets the system's requirements."],
    [
      '8.1.4.2',
      'Contractors',
      'Coordinate with contractors on hazards and risks and check they meet requirements.',
    ],
    ['8.1.4.3', 'Outsourcing', 'Control outsourced functions and processes.'],
    [
      '8.2',
      'Emergency preparedness and response',
      'Prepare for emergencies, train people and test the plans.',
    ],
    ['9', 'Performance evaluation', 'Check how the system performs.'],
    [
      '9.1',
      'Monitoring, measurement, analysis and performance evaluation',
      'Decide what to measure, measure it and act on the results.',
    ],
    ['9.1.1', 'General', 'Monitor OH&S performance and controls with calibrated equipment.'],
    [
      '9.1.2',
      'Evaluation of compliance',
      'Check at set intervals that legal and other requirements are met.',
    ],
    ['9.2', 'Internal audit', 'Audit the system to a plan, with auditors who stay objective.'],
    [
      '9.2.1',
      'General',
      "Check the system meets its own and the standard's requirements and works.",
    ],
    [
      '9.2.2',
      'Internal audit programme',
      'Plan audits, report them to workers and managers, and act on them.',
    ],
    [
      '9.3',
      'Management review',
      'Top management reviews the system at set intervals and decides on changes.',
    ],
    ['10', 'Improvement', 'Keep making the system and its results better.'],
    ['10.1', 'General', 'Look for chances to improve and act on them.'],
    [
      '10.2',
      'Incident, nonconformity and corrective action',
      'Report and investigate incidents and nonconformities, fix causes and check the fix worked.',
    ],
    ['10.3', 'Continual improvement', 'Improve the system to improve OH&S performance.'],
  ],
};

/** The shared structure (clauses 4 to 10) the three standards have in common; `hlsKey` is the nearest of these. */
const SHARED = new Set([
  '4',
  '4.1',
  '4.2',
  '4.3',
  '4.4',
  '5',
  '5.1',
  '5.2',
  '5.3',
  '6',
  '6.1',
  '6.2',
  '7',
  '7.1',
  '7.2',
  '7.3',
  '7.4',
  '7.5',
  '8',
  '8.1',
  '9',
  '9.1',
  '9.2',
  '9.3',
  '10',
  '10.1',
  '10.2',
  '10.3',
]);

/** ISO 9001 clauses a client may have approved as not applicable (catalogue.md §4, the starting list). */
const EXCLUDABLE_9001 = new Set([
  '7.1.5.2',
  '8.3.1',
  '8.3.2',
  '8.3.3',
  '8.3.4',
  '8.3.5',
  '8.3.6',
  '8.5.3',
  '8.5.5',
]);

function hlsKey(number: string): string | null {
  for (let parts = number.split('.'); parts.length > 0; parts = parts.slice(0, -1)) {
    const candidate = parts.join('.');
    if (SHARED.has(candidate)) return candidate;
  }
  return null;
}

// ---------- management review inputs and outputs (catalogue.md §5) ----------

/** "9.3.2 a" or "9.3 b1, b2": one row per item; "" when the standard has no such input. */
type Refs = Partial<Record<Code, string>>;

const INPUTS: [z.input<typeof C.ReviewInputKey>, string, Refs, ReviewSource][] = [
  [
    'PREVIOUS_ACTIONS',
    'Status of actions from earlier reviews',
    { ISO_9001: '9.3.2 a', ISO_14001: '9.3 a', ISO_45001: '9.3 a' },
    'PREVIOUS_ACTIONS',
  ],
  [
    'CONTEXT_CHANGES',
    'Changes in external and internal issues',
    { ISO_9001: '9.3.2 b', ISO_14001: '9.3 b1', ISO_45001: '9.3 b' },
    'CONTEXT',
  ],
  [
    'INTERESTED_PARTIES',
    "Changes in interested parties' needs, compliance obligations, legal and other requirements",
    { ISO_14001: '9.3 b2', ISO_45001: '9.3 b1, b2' },
    'CONTEXT',
  ],
  [
    'SIGNIFICANT_ASPECTS',
    'Changes in significant environmental aspects',
    { ISO_14001: '9.3 b3' },
    'RISKS',
  ],
  [
    'RISKS_AND_OPPORTUNITIES',
    'Changes in risks and opportunities',
    { ISO_14001: '9.3 b4', ISO_45001: '9.3 b3, d6' },
    'RISKS',
  ],
  [
    'RISK_ACTIONS',
    'Effectiveness of actions on risks and opportunities',
    { ISO_9001: '9.3.2 e' },
    'RISKS',
  ],
  [
    'CUSTOMER_SATISFACTION',
    'Customer satisfaction and feedback',
    { ISO_9001: '9.3.2 c1' },
    'MANUAL',
  ],
  [
    'OBJECTIVES',
    'How far the policy and objectives were met',
    { ISO_9001: '9.3.2 c2', ISO_14001: '9.3 c', ISO_45001: '9.3 c' },
    'OBJECTIVES',
  ],
  [
    'PROCESS_PERFORMANCE',
    'Process performance and conformity of products and services',
    { ISO_9001: '9.3.2 c3' },
    'MANUAL',
  ],
  [
    'NONCONFORMITIES',
    'Nonconformities and corrective actions',
    { ISO_9001: '9.3.2 c4', ISO_14001: '9.3 d1', ISO_45001: '9.3 d1' },
    'NONCONFORMITIES',
  ],
  ['INCIDENTS', 'Incidents', { ISO_45001: '9.3 d1' }, 'INCIDENTS'],
  [
    'MONITORING_RESULTS',
    'Monitoring and measurement results',
    { ISO_9001: '9.3.2 c5', ISO_14001: '9.3 d2', ISO_45001: '9.3 d2' },
    'MANUAL',
  ],
  [
    'COMPLIANCE_EVALUATION',
    'Fulfilment of compliance obligations, evaluation of compliance',
    { ISO_14001: '9.3 d3', ISO_45001: '9.3 d3' },
    'COMPLIANCE_EVALUATION',
  ],
  [
    'AUDIT_RESULTS',
    'Audit results',
    { ISO_9001: '9.3.2 c6', ISO_14001: '9.3 d4', ISO_45001: '9.3 d4' },
    'AUDIT_RESULTS',
  ],
  ['EXTERNAL_PROVIDERS', 'Performance of external providers', { ISO_9001: '9.3.2 c7' }, 'MANUAL'],
  [
    'WORKER_CONSULTATION',
    'Consultation and participation of workers',
    { ISO_45001: '9.3 d5' },
    'MANUAL',
  ],
  [
    'RESOURCES',
    'Adequacy of resources',
    { ISO_9001: '9.3.2 d', ISO_14001: '9.3 e', ISO_45001: '9.3 e' },
    'MANUAL',
  ],
  [
    'COMMUNICATIONS',
    'Relevant communications from interested parties, complaints included',
    { ISO_14001: '9.3 f', ISO_45001: '9.3 f' },
    'MANUAL',
  ],
  [
    'IMPROVEMENT_OPPORTUNITIES',
    'Opportunities for improvement',
    { ISO_9001: '9.3.2 f', ISO_14001: '9.3 g', ISO_45001: '9.3 g' },
    'MANUAL',
  ],
];

const OUTPUTS: [z.input<typeof C.ReviewOutputKey>, string, Refs][] = [
  [
    'SUITABILITY',
    'Conclusions on continuing suitability, adequacy and effectiveness',
    { ISO_14001: '9.3', ISO_45001: '9.3' },
  ],
  [
    'IMPROVEMENT',
    'Decisions on improvement opportunities',
    { ISO_9001: '9.3.3 a', ISO_14001: '9.3', ISO_45001: '9.3' },
  ],
  [
    'SYSTEM_CHANGES',
    'Decisions on changes to the management system',
    { ISO_9001: '9.3.3 b', ISO_14001: '9.3', ISO_45001: '9.3' },
  ],
  [
    'RESOURCE_NEEDS',
    'Resources needed',
    { ISO_9001: '9.3.3 c', ISO_14001: '9.3', ISO_45001: '9.3' },
  ],
  [
    'OBJECTIVES_NOT_MET',
    'Actions where objectives were not met',
    { ISO_14001: '9.3', ISO_45001: '9.3' },
  ],
  [
    'INTEGRATION',
    'Better integration with other business processes',
    { ISO_14001: '9.3', ISO_45001: '9.3' },
  ],
  [
    'STRATEGIC_DIRECTION',
    "Implications for the organisation's strategic direction",
    { ISO_14001: '9.3', ISO_45001: '9.3' },
  ],
  [
    'WORKER_COMMUNICATION',
    'Outputs communicated to workers and their representatives',
    { ISO_45001: '9.3' },
  ],
];

/** "9.3 b1, b2" → [["9.3","b1"],["9.3","b2"]]; "9.3" → [["9.3",null]]. */
function refItems(ref: string): [string, string | null][] {
  const [clause, items] = ref.split(' ', 2) as [string, string | undefined];
  if (items === undefined) return [[clause, null]];
  return ref
    .slice(clause.length + 1)
    .split(',')
    .map((item) => [clause, item.trim()]);
}

// ---------- STANDARD acts and activities (catalogue.md §2-3) ----------

const ACTS: Fixture['acts'] = [
  { key: 'ISO_9001', name: 'ISO 9001 quality management', shortName: 'ISO 9001' },
  { key: 'ISO_14001', name: 'ISO 14001 environmental management', shortName: 'ISO 14001' },
  {
    key: 'ISO_45001',
    name: 'ISO 45001 occupational health and safety management',
    shortName: 'ISO 45001',
  },
  {
    key: 'IMS',
    name: 'Integrated management system (ISO 9001, 14001, 45001)',
    shortName: 'ISO IMS',
  },
];

const ANNUAL: Rule = { kind: 'ANNUAL', month: 3, day: 31 };
const HALF_YEARLY: Rule = { kind: 'HALF_YEARLY', anchor: 'PERIOD_END', days: 0 };
const QUARTERLY: Rule = { kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 0 };
const MONTHLY: Rule = { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 };

const all = (...numbers: string[]) =>
  (['ISO_9001', 'ISO_14001', 'ISO_45001'] as const).flatMap((standard) =>
    numbers.map((clauseNumber) => ({ standard, clauseNumber })),
  );

const ACTIVITIES: Fixture['activities'] = [
  {
    key: 'CONTEXT-REVIEW',
    title: 'Review of context and interested parties',
    act: 'IMS',
    rule: ANNUAL,
    evidence: 'Updated issues and interested-party lists (the ISO context screen).',
    clauseRefs: all('4.1', '4.2'),
  },
  {
    key: 'COMPLIANCE-EVALUATION',
    title: 'Evaluation of compliance',
    act: 'IMS',
    rule: HALF_YEARLY,
    evidence: 'Evaluation record; the statutory score report can be attached.',
    clauseRefs: [
      { standard: 'ISO_14001', clauseNumber: '9.1.2' },
      { standard: 'ISO_45001', clauseNumber: '9.1.2' },
    ],
  },
  {
    key: 'COMPETENCE-REVIEW',
    title: 'Competence review: training needs and effectiveness',
    act: 'IMS',
    rule: ANNUAL,
    evidence: 'Training matrix.',
    clauseRefs: all('7.2'),
  },
  {
    key: 'AWARENESS',
    title: 'Awareness and induction',
    act: 'IMS',
    rule: HALF_YEARLY,
    evidence: 'Attendance record.',
    clauseRefs: all('7.3'),
  },
  {
    key: 'CALIBRATION',
    title: 'Calibration or verification of monitoring equipment',
    act: 'IMS',
    rule: QUARTERLY,
    evidence: 'Instrument list with calibration status.',
    clauseRefs: [
      { standard: 'ISO_9001', clauseNumber: '7.1.5' },
      { standard: 'ISO_14001', clauseNumber: '9.1.1' },
      { standard: 'ISO_45001', clauseNumber: '9.1.1' },
    ],
  },
  {
    key: 'EXTERNAL-PROVIDERS',
    title: 'Evaluation and re-evaluation of external providers',
    act: 'IMS',
    rule: ANNUAL,
    evidence: 'Approved supplier list with ratings.',
    clauseRefs: [
      { standard: 'ISO_9001', clauseNumber: '8.4.1' },
      { standard: 'ISO_14001', clauseNumber: '8.1' },
      { standard: 'ISO_45001', clauseNumber: '8.1.4' },
    ],
  },
  {
    key: 'EMERGENCY-DRILL',
    title: 'Emergency drill and post-drill evaluation',
    act: 'IMS',
    rule: HALF_YEARLY,
    evidence:
      'Drill report. Where a state factory rule already requires a mock drill, assign one of the two, not both.',
    clauseRefs: [
      { standard: 'ISO_14001', clauseNumber: '8.2' },
      { standard: 'ISO_45001', clauseNumber: '8.2' },
    ],
  },
  {
    key: 'CONTRACTOR-REVIEW',
    title: 'Contractor OH&S review',
    act: 'ISO_45001',
    rule: QUARTERLY,
    evidence: 'Review record.',
    clauseRefs: [{ standard: 'ISO_45001', clauseNumber: '8.1.4.2' }],
  },
  {
    key: 'WORKPLACE-INSPECTION',
    title: 'Workplace inspection',
    act: 'ISO_45001',
    rule: MONTHLY,
    evidence: 'Inspection record.',
    clauseRefs: [{ standard: 'ISO_45001', clauseNumber: '9.1.1' }],
  },
  {
    key: 'WORKER-CONSULTATION',
    title: 'Worker consultation and participation',
    act: 'ISO_45001',
    rule: QUARTERLY,
    evidence:
      'Committee minutes. Where a state rule already requires a safety committee meeting, assign one of the two.',
    clauseRefs: [{ standard: 'ISO_45001', clauseNumber: '5.4' }],
  },
  {
    key: 'ENV-MONITORING',
    title: 'Environmental performance monitoring',
    act: 'ISO_14001',
    rule: MONTHLY,
    evidence: 'Monitoring data.',
    clauseRefs: [{ standard: 'ISO_14001', clauseNumber: '9.1.1' }],
  },
  {
    key: 'CUSTOMER-SATISFACTION',
    title: 'Customer satisfaction survey and analysis',
    act: 'ISO_9001',
    rule: ANNUAL,
    evidence: 'Survey results and analysis.',
    clauseRefs: [{ standard: 'ISO_9001', clauseNumber: '9.1.2' }],
  },
  {
    key: 'DATA-ANALYSIS',
    title: 'Analysis and evaluation of data',
    act: 'ISO_9001',
    rule: QUARTERLY,
    evidence: 'Analysis record.',
    clauseRefs: [{ standard: 'ISO_9001', clauseNumber: '9.1.3' }],
  },
];

export function buildIsoCatalogue(): Fixture {
  const clauses = STANDARDS.flatMap(([code]) => {
    const rows = CLAUSES[code];
    const numbers = new Set(rows.map(([n]) => n));
    const hasChildren = (n: string) => rows.some(([m]) => m.startsWith(`${n}.`));
    return rows.map(([number, title, summary]) => {
      const parts = number.split('.');
      const parent = parts.length > 1 ? parts.slice(0, -1).join('.') : null;
      if (parent !== null && !numbers.has(parent)) throw new Error(`${code} ${number}: no parent`);
      const assessable = Number(parts[0]) >= 4 && !hasChildren(number);
      return {
        standard: code,
        number,
        title,
        summary,
        parent,
        hlsKey: hlsKey(number),
        assessable,
        exclusionAllowed: code === 'ISO_9001' && EXCLUDABLE_9001.has(number),
      };
    });
  });
  const defs = <T>(
    refs: Refs,
    make: (standard: Code, clauseNumber: string, item: string | null) => T,
  ) =>
    STANDARDS.flatMap(([code]) =>
      refs[code] === undefined
        ? []
        : refItems(refs[code]).map(([clause, item]) => make(code, clause, item)),
    );
  return {
    version: ISO_CATALOGUE_VERSION,
    standards: STANDARDS.map(([code, title, topic]) => ({
      code,
      edition: EDITIONS[code],
      title,
      topic,
    })),
    clauses,
    reviewInputs: INPUTS.flatMap(([key, title, refs, source]) =>
      defs(refs, (standard, clauseNumber, item) => ({
        standard,
        key,
        clauseNumber,
        item,
        title,
        source,
      })),
    ),
    reviewOutputs: OUTPUTS.flatMap(([key, title, refs]) =>
      defs(refs, (standard, clauseNumber, item) => ({ standard, key, clauseNumber, item, title })),
    ),
    category: 'ISO management systems',
    acts: ACTS,
    activities: ACTIVITIES,
  };
}
