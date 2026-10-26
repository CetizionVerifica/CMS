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
} from '../src/index.js';

const SINCE = LocalDate.parse('2024-04-10');
const AS_OF = LocalDate.parse('2024-10-28');

describe('IsoEngineApi.reviewInputFigures', () => {
  it('has data for every input source, and none for MANUAL', () => {
    expectTypeOf<keyof ReviewFigureData>().toEqualTypeOf<ReviewInputSource>();
    expectTypeOf<ReviewFigureData['MANUAL']>().toEqualTypeOf<Record<string, never>>();
  });

  it("takes the data of the source it is called for, and no other source's", () => {
    const incidents = (engine: IsoEngineApi): ReviewInputFigures =>
      engine.reviewInputFigures(
        'INCIDENTS',
        { nonconformities: [], timeZone: 'Asia/Kolkata' },
        SINCE,
        AS_OF,
      );
    const manual = (engine: IsoEngineApi) => engine.reviewInputFigures('MANUAL', {}, SINCE, AS_OF);
    const wrong = (engine: IsoEngineApi) =>
      engine.reviewInputFigures(
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

  it('reads every record with its creation and archive days, and no held flag or general change list', () => {
    expectTypeOf<ReviewFigureDays>().toEqualTypeOf<{
      createdOn: LocalDate;
      archivedOn: LocalDate | null;
    }>();
    // Every row of every source's lists, the event-day lists aside, carries both days.
    type Rows<D> = {
      [K in keyof D]: D[K] extends readonly (infer R)[]
        ? R extends ReviewFigureEventDay
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
  });
});
