import { Inject, Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type AccountId,
  type Uuid,
} from '@justgo/kernel';
import type { CaseActor, ReclamationsPort } from '../contract/reclamations.port';
import type {
  CaseAuthorRole,
  CaseDTO,
  CaseMessageDTO,
  CasePage,
  CaseQuery,
  CaseStatus,
  FileCaseDTO,
} from '../contract/dto';
import { CLOSING } from '../domain/case-state';
import { PgReclamationsRepository } from '../infra/pg-reclamations.repository';

export const RECLAMATIONS_REPOSITORY = Symbol('RECLAMATIONS_REPOSITORY');

const MAX_TITLE = 200;
const MAX_BODY = 5000;
const MAX_MESSAGE = 5000;
const MAX_RESOLUTION = 2000;
const MAX_ATTACHMENTS = 10;

/**
 * Buckets an attachment may point at.
 *
 * An allow-list, not a free string: `bucket` comes from the client, and
 * without this a claimant could attach `registrations` and turn a complaint
 * — which the supplier they are complaining about can read — into a read
 * handle for somebody's scanned vehicle papers.
 *
 * A PLAIN ARRAY, not a Set: SWC's loose downlevelling rewrites a Set spread
 * as `[].concat(set)`, which silently produces `[{}]` in the webpack bundle
 * and matches nothing. That has shipped twice in this codebase.
 */
const ATTACHMENT_BUCKETS: readonly string[] = ['part-photos', 'vehicle-photos'];

@Injectable()
export class ReclamationsService implements ReclamationsPort {
  constructor(
    @Inject(RECLAMATIONS_REPOSITORY) private readonly repo: PgReclamationsRepository,
  ) {}

  private scopeOf(actor: CaseActor) {
    return actor.isOps
      ? { ops: true }
      : { claimantAccountId: actor.accountId, respondentSupplierId: actor.supplierId };
  }

  /**
   * Which side of the case the actor is on.
   *
   * Ops first, because an ops admin who also happens to be the claimant
   * should still be able to leave internal notes. Then claimant, then
   * respondent — and a caller who is none of the three cannot see the case at
   * all, so there is no fourth branch to reach.
   */
  private roleOn(actor: CaseActor, c: CaseDTO): CaseAuthorRole {
    if (actor.isOps) return 'ops';
    if ((c.claimantAccountId as unknown as string) === (actor.accountId as unknown as string)) {
      return 'claimant';
    }
    if (actor.supplierId && c.respondentSupplierId === actor.supplierId) return 'respondent';
    throw new NotFoundError('Case', c.id);
  }

  async file(claimant: AccountId, input: FileCaseDTO): Promise<CaseDTO> {
    const title = input.title?.trim() ?? '';
    const body = input.body?.trim() ?? '';
    if (title.length === 0) throw new ValidationError('A complaint needs a title');
    if (body.length === 0) throw new ValidationError('A complaint needs a description');
    if (title.length > MAX_TITLE) {
      throw new ValidationError(`The title may not exceed ${MAX_TITLE} characters`);
    }
    if (body.length > MAX_BODY) {
      throw new ValidationError(`The description may not exceed ${MAX_BODY} characters`);
    }
    if ((input.subjectType === undefined) !== (input.subjectId === undefined)) {
      throw new ValidationError('subjectType and subjectId must be provided together');
    }

    const attachments = input.attachments ?? [];
    if (attachments.length > MAX_ATTACHMENTS) {
      throw new ValidationError(`At most ${MAX_ATTACHMENTS} attachments`);
    }
    for (const a of attachments) {
      if (!ATTACHMENT_BUCKETS.includes(a.bucket)) {
        throw new ValidationError(`Attachments may not come from the "${a.bucket}" bucket`);
      }
      // The uploader namespaces every object under the caller's account id.
      // Re-checking stops a claimant pasting somebody else's upload path into
      // a case the respondent can read.
      if (!a.path.startsWith(`${claimant}/`)) {
        throw new ForbiddenError('Attachments must be your own uploads');
      }
    }

    return this.repo.file(claimant, { ...input, title, body });
  }

  async list(actor: CaseActor, query: CaseQuery = {}): Promise<CasePage> {
    return this.repo.list(this.scopeOf(actor), query);
  }

  async get(actor: CaseActor, caseId: Uuid): Promise<CaseDTO | null> {
    return this.repo.get(caseId, this.scopeOf(actor));
  }

  async postMessage(
    actor: CaseActor,
    caseId: Uuid,
    input: { body: string; internal?: boolean },
  ): Promise<CaseMessageDTO> {
    const body = input.body?.trim() ?? '';
    if (body.length === 0) throw new ValidationError('A message needs a body');
    if (body.length > MAX_MESSAGE) {
      throw new ValidationError(`A message may not exceed ${MAX_MESSAGE} characters`);
    }

    const found = await this.get(actor, caseId);
    if (!found) throw new NotFoundError('Case', caseId);
    const role = this.roleOn(actor, found);

    if (input.internal && role !== 'ops') {
      /*
        An internal note is invisible to both parties. If a claimant could set
        the flag they would be writing into the case file in a way the
        supplier cannot see and cannot answer — which is the opposite of what
        a complaints thread is for.
      */
      throw new ForbiddenError('Only platform staff may leave internal notes');
    }

    /*
      A closed case stops accepting messages. Reopening is deliberately not a
      transition: a complaint that resurfaces is a new complaint, with its own
      reference, rather than a resolution quietly becoming untrue.
    */
    if (found.status === 'resolved' || found.status === 'rejected' || found.status === 'withdrawn') {
      throw new ForbiddenError(`This complaint is ${found.status} and no longer accepts messages`);
    }

    /*
      Who hears about it: the other side, never the author. The claimant is an
      account this module knows; the respondent is a BUSINESS, and turning a
      supplier into the people who should be told means reading the suppliers
      schema, which this module may not do (§17.4). So the supplier id goes on
      the event and a notification reactor resolves it.

      An internal note notifies nobody at all — the repository enforces that
      by emitting no event for one.
    */
    const notifyAccountIds =
      role === 'claimant' ? [] : [found.claimantAccountId as unknown as string];
    const notifySupplierId =
      role === 'respondent' ? null : (found.respondentSupplierId as unknown as string | null);

    return this.repo.postMessage(
      caseId,
      actor.accountId,
      role,
      body,
      input.internal === true,
      notifyAccountIds,
      notifySupplierId,
    );
  }

  async listMessages(actor: CaseActor, caseId: Uuid): Promise<CaseMessageDTO[]> {
    const found = await this.get(actor, caseId);
    if (!found) throw new NotFoundError('Case', caseId);
    // Internal notes reach ops only. The RLS policy excludes them too, so a
    // future direct PostgREST read cannot leak them either.
    return this.repo.listMessages(caseId, actor.isOps === true);
  }

  async changeStatus(
    actor: CaseActor,
    caseId: Uuid,
    next: CaseStatus,
    resolution?: string,
  ): Promise<CaseDTO> {
    const found = await this.get(actor, caseId);
    if (!found) throw new NotFoundError('Case', caseId);
    const role = this.roleOn(actor, found);

    /*
      WHO MAY DECIDE. A claimant may withdraw their own complaint and nothing
      else — letting them mark it `resolved` would let them close a case the
      supplier never answered, and letting them `reject` it is meaningless.
      Upholding or dismissing a claim is for the respondent or for ops.
    */
    if (role === 'claimant' && next !== 'withdrawn') {
      throw new ForbiddenError('A claimant may only withdraw their own complaint');
    }
    if (role !== 'claimant' && next === 'withdrawn') {
      throw new ForbiddenError('Only the claimant may withdraw a complaint');
    }

    const needsReason = CLOSING.includes(next);
    const reason = resolution?.trim() ?? '';
    if (needsReason && reason.length === 0) {
      throw new ValidationError(`Closing a complaint as "${next}" requires a resolution`);
    }
    if (reason.length > MAX_RESOLUTION) {
      throw new ValidationError(`The resolution may not exceed ${MAX_RESOLUTION} characters`);
    }

    return this.repo.changeStatus(caseId, next, needsReason ? reason : null);
  }
}
