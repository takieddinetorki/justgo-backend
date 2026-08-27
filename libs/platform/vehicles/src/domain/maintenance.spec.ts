import { isMaintenanceDue, worstHealth } from './maintenance';

describe('worstHealth', () => {
  it('rolls up to the worst status present', () => {
    expect(worstHealth(['optimal', 'good', 'warning'])).toBe('warning');
    expect(worstHealth(['good', 'urgent', 'critical'])).toBe('urgent');
    expect(worstHealth([])).toBe('optimal');
  });
});

describe('isMaintenanceDue (§1 reminders)', () => {
  const now = new Date('2026-06-01T00:00:00Z');

  it('is due when the odometer threshold is reached', () => {
    expect(
      isMaintenanceDue({ dueAtKm: 90000, dueDate: null, status: 'pending' }, { mileageKm: 90500, now }),
    ).toBe(true);
    expect(
      isMaintenanceDue({ dueAtKm: 90000, dueDate: null, status: 'pending' }, { mileageKm: 80000, now }),
    ).toBe(false);
  });

  it('is due when the due date has passed', () => {
    expect(
      isMaintenanceDue({ dueAtKm: null, dueDate: '2026-05-01', status: 'pending' }, { mileageKm: null, now }),
    ).toBe(true);
    expect(
      isMaintenanceDue({ dueAtKm: null, dueDate: '2026-07-01', status: 'pending' }, { mileageKm: null, now }),
    ).toBe(false);
  });

  it('never re-fires a task that is not pending', () => {
    expect(
      isMaintenanceDue({ dueAtKm: 1, dueDate: '2000-01-01', status: 'due' }, { mileageKm: 999999, now }),
    ).toBe(false);
  });
});
