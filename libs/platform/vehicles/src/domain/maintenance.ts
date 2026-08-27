import type { HealthStatus, MaintenanceStatus } from '../contract/dto';

/** Health ranking, worst-first — used to roll a vehicle's status up (§1). */
const HEALTH_RANK: Record<HealthStatus, number> = {
  urgent: 4,
  critical: 3,
  warning: 2,
  good: 1,
  optimal: 0,
};

export function worstHealth(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>(
    (worst, s) => (HEALTH_RANK[s] > HEALTH_RANK[worst] ? s : worst),
    'optimal',
  );
}

/**
 * A maintenance task is DUE when its odometer threshold is reached or its due
 * date has passed. Pure so it is unit-tested without a database (§17.5).
 */
export function isMaintenanceDue(
  task: { dueAtKm: number | null; dueDate: string | null; status: MaintenanceStatus },
  ctx: { mileageKm: number | null; now: Date },
): boolean {
  if (task.status !== 'pending') return false;
  if (task.dueAtKm != null && ctx.mileageKm != null && ctx.mileageKm >= task.dueAtKm) return true;
  if (task.dueDate != null && new Date(task.dueDate).getTime() <= ctx.now.getTime()) return true;
  return false;
}
