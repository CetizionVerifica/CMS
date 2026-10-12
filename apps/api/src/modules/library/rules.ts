import type { LocalDate, RecurrenceRule } from '@canopy/contracts';
import { compareDates, fyBounds, fyStartYear, generateInstances } from '@canopy/engine';
import { HttpError } from '../entities/http/errors.js';

/**
 * Recurrence rule checks for obligations (MODULES.md M6: "recurrence rule validated by M4"). The contracts schema
 * already fixed the shape; these ask the engine what the rule generates and reject a rule that cannot work.
 */

export interface RuleIssue {
  path: string[];
  message: string;
}

/** Problems with `rule`, judged over the two financial years from the one containing `asOf`. */
export function ruleIssues(rule: RecurrenceRule, asOf: LocalDate, fyStartMonth = 4): RuleIssue[] {
  if (rule.kind === 'ONE_TIME' || rule.kind === 'EVENT_DRIVEN') return [];
  const first = fyStartYear(asOf, fyStartMonth);
  const range = {
    from: fyBounds(first, fyStartMonth).from,
    to: fyBounds(first + 1, fyStartMonth).to,
  };
  const periods = generateInstances(rule, range, { fyStartMonth, holidayPolicy: 'NONE' });
  if (periods.length === 0) {
    return [{ path: [], message: 'This rule generates no due dates.' }];
  }
  const early = periods.find((p) => compareDates(p.dueDate, p.periodStart) < 0);
  if (early) {
    return [
      {
        path: ['days'],
        message: `A due date falls before its period starts (${early.dueDate} for the period from ${early.periodStart}).`,
      },
    ];
  }
  return [];
}

/** 422 RULE_INVALID when the engine finds a problem with the rule. */
export function checkRule(rule: RecurrenceRule, asOf: LocalDate): void {
  const issues = ruleIssues(rule, asOf);
  if (issues.length > 0) {
    throw new HttpError('RULE_INVALID', issues[0]!.message, {
      issues: issues.map((i) => ({
        path: ['body', 'recurrenceRule', ...i.path],
        message: i.message,
      })),
    });
  }
}
