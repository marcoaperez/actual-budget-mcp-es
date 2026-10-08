import { z } from 'zod';
import type { ToolDef } from '../core/types.js';
import { msg } from '../core/messages.js';
import { OperationSchema } from '../core/reconcile-model.js';
import { applyOperation, type OpResult } from '../core/reconcile-apply.js';
import { syncAfterWrite } from '../core/write-sync.js';

const MAX_OPERATIONS = 50;

const input = {
  operations: z
    .array(OperationSchema)
    .min(1)
    .max(MAX_OPERATIONS)
    .describe('Operations accepted by the user, exactly as returned in the proposals of find_transfer_issues / reconcile_account'),
};
const schema = z.object(input);

export const tool: ToolDef = {
  name: 'apply_reconciliation_fixes',
  title: 'Apply reconciliation fixes',
  description:
    'Apply reconciliation operations the user accepted (link two existing transactions into one transfer, merge a ' +
    'duplicate into the bank-imported transaction, or turn a bank transaction into a transfer to another account). ' +
    'Each operation is revalidated against current data first; one that no longer fits is skipped (omitida) with the ' +
    'reason and the rest still run. Never touches reconciled transactions and never loses a bank import id. ' +
    `At most ${MAX_OPERATIONS} operations per call. ` +
    'As in Actual, link and create_transfer between two accounts on the same side of the budget (both on-budget or both off-budget) ' +
    'clear the category of both legs (proposals flag it with clears_category); merge does not.',
  readOnly: false,
  annotations: { destructiveHint: true, idempotentHint: false },
  inputSchema: input,
  handler: async (raw, { api, config }) => {
    const a = schema.parse(raw ?? {});
    const m = msg(config);
    // Revalidar contra datos frescos: ensureReady solo sincroniza si su TTL ha caducado.
    await api.sync();
    const results: OpResult[] = [];
    for (const op of a.operations) results.push(await applyOperation(api, op, m));
    const sync = await syncAfterWrite(api);
    const count = (status: OpResult['status']) => results.filter((r) => r.status === status).length;
    return {
      results,
      applied: count('aplicada'),
      skipped: count('omitida'),
      failed: count('fallida'),
      ...(sync.synced ? {} : { sync_pending: true, note: m.syncPending(sync.error!) }),
    };
  },
};
