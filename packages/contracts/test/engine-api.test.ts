// Types of the engine signatures (src/engine-api.ts) that M4 implements and M16, M9 and M10 call. `tsc` checks these;
// at run time they only show up as passing tests.
import { describe, expectTypeOf, it } from 'vitest';
import { LocalDate } from '../src/index.js';
import type {
  Id,
  IsoEngineApi,
  ReviewFigureAction,
  ReviewFigureData,
  ReviewFigureDays,
  ReviewFigureEventDay,
  ReviewInputFigures,
  ReviewInputSource,
  RiskKind,
  TypedReviewInputFigures,
} from '../src/index.js';

const SINCE = LocalDate.parse('2024-04-10');
const AS_OF = LocalDate.parse('2024-10-28');

describe('IsoEngineApi.reviewInputFigures', () => {
  it('has data for every input source, and none for MANUAL', () => {
    expectTypeOf<keyof ReviewFigureData>().toEqualTypeOf<ReviewInputSource>();
    expectTypeOf<ReviewFigureData['MANUAL']>().toEqualTypeOf<Record<string, never>>();
  });

  it("takes the data of the source it is called for, and no other source's", () => {
    const incidents = (figures: TypedReviewInputFigures): ReviewInputFigures =>
      figures('INCIDENTS', { nonconformities: [], timeZone: 'Asia/Kolkata' }, SINCE, AS_OF);
    const manual = (figures: TypedReviewInputFigures) => figures('MANUAL', {}, SINCE, AS_OF);
    const wrong = (figures: TypedReviewInputFigures) =>
      figures(
        'RISKS',
        // @ts-expect-error RISKS reads risk items, rating changes and treatment actions, not incidents
        { nonconformities: [], timeZone: 'Asia/Kolkata' },
        SINCE,
        AS_OF,
      );
    expectTypeOf(incidents).returns.toEqualTypeOf<ReviewInputFigures>();
    expectTypeOf(manual).returns.toEqualTypeOf<ReviewInputFigures>();
    expectTypeOf(wrong).returns.toEqualTypeOf<ReviewInputFigures>();
  });

  it('declares the signature typed per source, so a caller through IsoEngineApi passes the data its source names', () => {
    expectTypeOf<IsoEngineApi['reviewInputFigures']>().toEqualTypeOf<TypedReviewInputFigures>();
    const engine = (figures: TypedReviewInputFigures) =>
      ({ reviewInputFigures: figures }) satisfies Pick<IsoEngineApi, 'reviewInputFigures'>;
    expectTypeOf(engine).returns.toExtend<Pick<IsoEngineApi, 'reviewInputFigures'>>();
    const wrong = (api: IsoEngineApi) =>
      api.reviewInputFigures(
        'OBJECTIVES',
        // @ts-expect-error OBJECTIVES reads objectives, readings and their actions, not incidents
        { nonconformities: [], timeZone: 'Asia/Kolkata' },
        SINCE,
        AS_OF,
      );
    expectTypeOf(wrong).returns.toEqualTypeOf<ReviewInputFigures>();
  });

  it('reads every record with its creation and archive days, and no held flag or general change list', () => {
    expectTypeOf<ReviewFigureDays>().toEqualTypeOf<{
      createdOn: LocalDate;
      archivedOn: LocalDate | null;
    }>();
    // Every row of every source's lists, the event-day lists aside, carries both days.
    type Rows<D> = {
      [K in keyof D]: D[K] extends readonly (infer R)[]
        ? R extends ReviewFigureEventDay | string
          ? never
          : R
        : never;
    }[keyof D];
    type Read = Exclude<ReviewInputSource, 'MANUAL'>;
    type AllRows = { [S in Read]: Rows<ReviewFigureData[S]> }[Read];
    expectTypeOf<AllRows>().not.toBeNever();
    expectTypeOf<AllRows>().toExtend<ReviewFigureDays>();
    type Reading = ReviewFigureData['OBJECTIVES']['objectives'][number]['readings'][number];
    expectTypeOf<Reading>().toExtend<ReviewFigureDays>();
    type Nc = ReviewFigureData['NONCONFORMITIES']['nonconformities'][number];
    expectTypeOf<Nc['reportedOn']>().toEqualTypeOf<LocalDate>();
    expectTypeOf<ReviewFigureAction['doneOn']>().toEqualTypeOf<LocalDate | null>();
    expectTypeOf<ReviewFigureAction>().toHaveProperty('subject');
    // No source's data has a held flag or a general change list (each source on its own, not their union's keys).
    type AllKeys = { [S in Read]: keyof ReviewFigureData[S] }[Read];
    expectTypeOf<Extract<AllKeys, 'contextChanges'>>().not.toBeNever();
    expectTypeOf<Extract<AllKeys, 'held' | 'changes'>>().toBeNever();
  });

  it('takes the risk kinds the input reads, and the day of the step that set each date the user enters (ISO-1a3)', () => {
    expectTypeOf<ReviewFigureData['RISKS']['kinds']>().toEqualTypeOf<RiskKind[]>();
    type Data = ReviewFigureData;
    expectTypeOf<ReviewFigureAction['settledOn']>().toEqualTypeOf<LocalDate | null>();
    type Objective = Data['OBJECTIVES']['objectives'][number];
    expectTypeOf<Objective['closeStepOn']>().toEqualTypeOf<LocalDate | null>();
    type Internal = Data['AUDIT_RESULTS']['internalAudits'][number];
    expectTypeOf<Internal['reportStepOn']>().toEqualTypeOf<LocalDate | null>();
    type External = Data['AUDIT_RESULTS']['externalAudits'][number];
    expectTypeOf<External['heldStepOn']>().toEqualTypeOf<LocalDate | null>();
  });

  it('takes the event days of the window counts that have no date field of their own', () => {
    expectTypeOf<ReviewFigureEventDay>().toEqualTypeOf<{ entityId: Id; on: LocalDate }>();
    expectTypeOf<ReviewFigureData['CONTEXT']['contextChanges']>().toEqualTypeOf<
      ReviewFigureEventDay[]
    >();
    expectTypeOf<ReviewFigureData['RISKS']['ratingChanges']>().toEqualTypeOf<
      ReviewFigureEventDay[]
    >();
    expectTypeOf<ReviewFigureData['NONCONFORMITIES']['notEffectiveSteps']>().toEqualTypeOf<
      ReviewFigureEventDay[]
    >();
    // Every climate decision, each on its own day (ISO-1a3).
    expectTypeOf<ReviewFigureData['CONTEXT']['climateDecisions']>().toEqualTypeOf<
      ReviewFigureEventDay[]
    >();
    expectTypeOf<ReviewFigureData['CONTEXT']['system']>().not.toHaveProperty('climateStepOn');
  });
});
