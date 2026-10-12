import { z } from 'zod';

/**
 * Tolerant response parsing (api-conventions.md §7, README decision 8).
 *
 * The API may add fields and enum values without a version bump, so clients never parse responses with the strict
 * entity schemas. `tolerant(schema)` derives a schema that:
 * - keeps unknown object keys instead of rejecting them;
 * - turns an unknown enum value into `"UNKNOWN"` (the UI renders it as "Unknown");
 * - accepts extra keys in enum-keyed records;
 * - turns an object with an unknown discriminator (e.g. a new recurrence kind) into `{ <discriminator>: "UNKNOWN" }`;
 * - drops cross-field consistency rules, which the server enforces on write.
 * Known values are still checked, so a wrong type in a known field still fails.
 */

export const UNKNOWN = 'UNKNOWN';
export type Unknown = typeof UNKNOWN;

type EnumValue<E> = E[keyof E];

type ObjectOutput<Shape> = {
  [K in keyof Shape as Shape[K] extends z.ZodOptional ? never : K]: TolerantOutput<Shape[K]>;
} & {
  [K in keyof Shape as Shape[K] extends z.ZodOptional ? K : never]?: TolerantOutput<Shape[K]>;
};

type RecordOutput<Key, Value> = Key extends z.core.$partial
  ? Partial<Record<Extract<z.output<Key>, PropertyKey>, TolerantOutput<Value>>>
  : Record<Extract<z.output<Key>, PropertyKey>, TolerantOutput<Value>>;

/** What `tolerant(S)` parses to: `z.output<S>` with every enum widened by `"UNKNOWN"`. */
export type TolerantOutput<S> =
  S extends z.ZodEnum<infer E>
    ? EnumValue<E> | Unknown
    : S extends z.ZodNullable<infer I>
      ? TolerantOutput<I> | null
      : S extends z.ZodOptional<infer I>
        ? TolerantOutput<I> | undefined
        : S extends z.ZodArray<infer I>
          ? TolerantOutput<I>[]
          : S extends z.ZodDiscriminatedUnion<infer O, infer D>
            ? TolerantOutput<O[number]> | { [K in D]: Unknown }
            : S extends z.ZodUnion<infer O>
              ? TolerantOutput<O[number]>
              : S extends z.ZodRecord<infer K, infer V>
                ? RecordOutput<K, V>
                : S extends z.ZodObject<infer Shape>
                  ? ObjectOutput<Shape>
                  : z.output<S>;

const cache = new WeakMap<z.ZodType, z.ZodType>();

/** Derive the tolerant client-side schema for a response schema. */
export function tolerant<S extends z.ZodType>(schema: S): z.ZodType<TolerantOutput<S>> {
  return convert(schema) as z.ZodType<TolerantOutput<S>>;
}

function convert(schema: z.ZodType): z.ZodType {
  const cached = cache.get(schema);
  if (cached) return cached;
  const result = build(schema);
  cache.set(schema, result);
  return result;
}

function unknownValue(known: ReadonlySet<unknown>): z.ZodType<Unknown> {
  return z
    .string()
    .refine((value) => !known.has(value))
    .transform((): Unknown => UNKNOWN);
}

function build(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodEnum) {
    return z.union([schema, unknownValue(new Set(schema.options))]);
  }
  if (schema instanceof z.ZodNullable) {
    return convert(schema.unwrap() as z.ZodType).nullable();
  }
  if (schema instanceof z.ZodOptional) {
    return convert(schema.unwrap() as z.ZodType).optional();
  }
  if (schema instanceof z.ZodArray) {
    return z.array(convert(schema.element as z.ZodType));
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const discriminator = schema.def.discriminator;
    const options = schema.options as readonly z.ZodType[];
    const known = new Set<unknown>();
    // Every option of a discriminated union declares its discriminator values.
    for (const option of options) {
      for (const value of option._zod.propValues![discriminator]!) known.add(value);
    }
    return z.union([
      ...options.map(convert),
      z.looseObject({ [discriminator]: unknownValue(known) }),
    ]);
  }
  if (schema instanceof z.ZodUnion) {
    return z.union((schema.options as readonly z.ZodType[]).map(convert));
  }
  if (schema instanceof z.ZodRecord) {
    const value = convert(schema.valueType as z.ZodType);
    if (schema.keyType instanceof z.ZodEnum) {
      // Known keys stay required (or optional for a partial record); extra keys pass through.
      const optional = (schema.def as { partial?: boolean }).partial === true;
      const shape = Object.fromEntries(
        schema.keyType.options.map((key) => [key, optional ? value.optional() : value]),
      );
      return z.looseObject(shape);
    }
    return z.record(schema.keyType, value);
  }
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(
      Object.entries(schema.shape as Record<string, z.ZodType>).map(([key, value]) => [
        key,
        convert(value),
      ]),
    );
    return z.looseObject(shape);
  }
  return schema;
}
