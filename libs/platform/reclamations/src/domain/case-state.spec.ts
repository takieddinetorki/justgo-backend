import { assertCaseTransition, CLOSING, isOpenCase } from './case-state';

describe('complaint lifecycle', () => {
  it('walks acknowledge-then-decide', () => {
    expect(assertCaseTransition('open', 'under_review')).toBe('under_review');
    expect(assertCaseTransition('under_review', 'resolved')).toBe('resolved');
  });

  it('allows a decision without an explicit acknowledgement', () => {
    // A supplier who fixes it immediately should not have to click twice.
    expect(assertCaseTransition('open', 'resolved')).toBe('resolved');
    expect(assertCaseTransition('open', 'rejected')).toBe('rejected');
  });

  it('lets the claimant withdraw while it is live', () => {
    expect(assertCaseTransition('open', 'withdrawn')).toBe('withdrawn');
    expect(assertCaseTransition('under_review', 'withdrawn')).toBe('withdrawn');
  });

  /*
    REOPENING IS NOT A TRANSITION. A complaint that resurfaces is a new
    complaint with its own reference — otherwise a resolution that was true
    when it was written quietly becomes untrue, and the history of what was
    decided when is lost.
  */
  it('never reopens a closed case', () => {
    for (const from of ['resolved', 'rejected', 'withdrawn'] as const) {
      for (const to of ['open', 'under_review', 'resolved', 'rejected'] as const) {
        expect(() => assertCaseTransition(from, to)).toThrow(/Cannot move a complaint/);
      }
    }
  });

  it('keeps resolved and rejected distinct and terminal', () => {
    expect(isOpenCase('resolved')).toBe(false);
    expect(isOpenCase('rejected')).toBe(false);
    expect(isOpenCase('open')).toBe(true);
    expect(isOpenCase('under_review')).toBe(true);
  });

  it('marks exactly the states that demand a reason', () => {
    // withdrawn is the claimant's own exit — nobody has to justify it.
    expect(CLOSING).toEqual(['resolved', 'rejected']);
  });
});
