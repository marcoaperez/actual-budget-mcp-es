// messages.ts — mensajes de runtime en los dos idiomas.
// El español es el tipo de referencia: `const en: Messages` obliga al compilador a
// exigir cada clave y cada firma. Los mensajes con datos son funciones.
// NO entran aquí: los logs a stderr ni la validación de config (que corre antes
// de que exista config y por eso no puede consultar el idioma).
//
// Criterio de nombres:
// - Sufijo `NotFound` para toda entidad que no existe (antes convivía con
//   `Missing` para la misma idea; unificado).
// - Ninguna clave se nombra como si fuera un predicado booleano (`isX`) cuando en
//   realidad es un mensaje: se nombra por lo que dice, no por la condición que lo
//   dispara (p.ej. `cannotSplitTransfer`, no `isTransfer`).
// - Sufijo `Item` para la versión abreviada de un mensaje que se usa como campo
//   `error` de un ítem dentro de un lote (categorize_transactions); la clave sin
//   sufijo es la versión que se lanza como excepción para una única transacción
//   (update_transaction, split_transaction). Ambas formas pueden coexistir para
//   la misma condición (p.ej. `splitChild` / `splitChildItem`).
// - Prefijo de dominio (`transfer`, `schedule`, `spending`, `split`...) solo
//   cuando agrupa varias claves relacionadas y ayuda a leerlas juntas; se omite
//   cuando el nombre ya es autoexplicativo en solitario (`alreadySplit`,
//   `echoPending`, `ambiguousNewRow`).
//
// Las claves se agrupan en bloques (mismo orden en `es` y en `en`, para leerlos
// en paralelo): formato y validación de entrada, no encontrado, guardas de
// estado y consistencia de escritura, e infraestructura del presupuesto.
import type { Config } from './config.js';

const es = {
  // --- Formato y validación de entrada ---
  invalidInput: 'Entrada inválida',
  dateFormat: 'Fecha en formato YYYY-MM-DD',
  monthFormat: 'Mes en formato YYYY-MM',
  mustBeUuid: 'Debe ser un UUID (usa get_accounts / get_categories / get_transactions para obtenerlos)',
  invalidToolName: (name: string) => `Nombre de tool inválido: ${name}`,
  noFieldToUpdate: 'Debes indicar al menos un campo a actualizar (category_id, payee_id, payee_name, notes, date, amount, cleared)',
  noGroupFieldToUpdate: 'Debes indicar al menos un campo a actualizar (name, hidden)',
  noCategoryFieldToUpdate: 'Debes indicar al menos un campo a actualizar (name, group_id, hidden)',
  scheduleDateXorRecurrence: 'Indica exactamente uno: date (puntual) o recurrence (recurrente)',
  payeeIdAndNameTogether: 'Indica payee_id o payee_name, no ambos',
  transferCategoriesMustDiffer: 'Las categorías de origen y destino deben ser distintas',
  spendingRangeTooLong: 'El rango de fechas no puede superar los 5 años; acorta start_date/end_date.',
  emptyNoteRequiresClear: (name: string) =>
    `Una nota vacía borra la nota existente de "${name}". Pasa clear: true para confirmar.`,
  partsDoNotSum: (sum: string, total: string, missing: boolean, diff: string) =>
    `Las partes difieren del total: suman ${sum} y el movimiento es ${total} (${missing ? 'faltan' : 'sobran'} ${diff}). Ajusta las partes o usa adjust_last=true`,
  createSplitsMismatch: (sum: string, total: string) =>
    `Las partes difieren del total: suman ${sum} y el importe es ${total}`,
  unknownRuleField: 'Campo de regla desconocido (usa get_rules para ver ejemplos de reglas existentes)',
  unknownRuleOp: 'Operador de regla desconocido (usa get_rules para ver ejemplos de reglas existentes)',
  unknownRuleStage: "stage debe ser 'pre', 'post' o null (null = la etapa por defecto)",

  // --- No encontrado ---
  categoryNotFound: (id: string) => `categoría inexistente: ${id} (usa get_categories para ver los ids válidos)`,
  categoryGroupNotFound: (id: string) => `grupo de categorías inexistente: ${id} (usa get_categories para ver los ids válidos)`,
  txNotFound: (id: string) => `Transacción no encontrada: ${id}`,
  txNotFoundItem: 'transacción no encontrada',
  payeeNotFound: (name: string, options: string[]) =>
    `Pagador no encontrado: "${name}"${options.length ? ` — ¿quizá: ${options.join(', ')}?` : ''}`,
  payeeIdNotFound: (id: string) => `pagador inexistente: ${id} (usa get_payees para ver los ids válidos)`,
  accountNotFound: (id: string) => `cuenta inexistente: ${id} (usa get_accounts para ver los ids válidos)`,
  accountRefNotFound: (ref: string, names: string[]) =>
    `Cuenta no encontrada: "${ref}". Cuentas abiertas: ${names.join(', ')}`,
  accountRefAmbiguous: (ref: string, ids: string[]) =>
    `Hay varias cuentas llamadas "${ref}"; indica su id: ${ids.join(', ')}`,
  transferPayeeNotFound: (accountId: string) =>
    `La cuenta ${accountId} no tiene pagador de transferencia. Actual lo crea con la cuenta: comprueba el id ` +
    'con get_accounts, y si la cuenta existe, ábrela una vez en Actual para que se genere',
  transferSourceNotFound: (month: string, id: string) => `Categoría origen no encontrada en ${month}: ${id}`,
  transferTargetNotFound: (month: string, id: string) => `Categoría destino no encontrada en ${month}: ${id}`,
  ruleNotFound: (id: string) => `regla inexistente: ${id} (usa get_rules para ver los ids válidos)`,

  // --- Guardas de estado y consistencia de escritura ---
  cannotSplitTransfer: 'No se puede dividir una transferencia entre cuentas',
  alreadySplit: 'La transacción ya está dividida; edita sus partes en Actual o deshaz el split primero',
  reconciledNeedsForce: 'La transacción está conciliada; dividirla rompería la conciliación. Vuelve a intentarlo con force: true si estás seguro',
  splitChild: (id: string, parentId: string) =>
    `La transacción ${id} es una parte de un split (padre ${parentId}); edita el split completo con split_transaction o desde Actual`,
  splitParentAmount: (id: string) =>
    `La transacción ${id} es el padre de un split: importe y categoría viven en las partes; usa split_transaction para redividirla (notas, fecha, cleared y pagador sí se pueden editar aquí)`,
  splitChildFieldNotAllowed: (field: string) =>
    `En una parte de un split no se puede editar ${field}: solo categoría, notas y pagador; para cambiar importes redivide con split_transaction, o edita el padre`,
  transferPartCategorySameSide:
    'Esta parte es una transferencia entre cuentas del mismo lado del presupuesto (o no se puede confirmar): no admite categoría; quita antes la transferencia con remove_transaction_transfer',
  transferPartCategorySameSideItem:
    'es una transferencia entre cuentas del mismo lado del presupuesto (o no se puede confirmar): no admite categoría',
  transferPartPayeeUseRemove:
    'Esta parte es una transferencia: cambiar su pagador la deshace; usa remove_transaction_transfer para hacerlo explícito',
  splitParentItem: 'es el padre de un split; la categoría vive en las partes',
  echoPending: 'La escritura se envió pero aún no se refleja al releer; vuelve a consultar la transacción para confirmarla',
  ambiguousNewRow: 'Aparecieron varias filas nuevas con la misma cuenta, fecha e importe; se devuelve la primera. Revisa posibles duplicados en Actual',
  transferRolledBack: (cause: string) =>
    `No se pudo abonar en destino (${cause}); el traspaso se ha revertido y no se ha movido nada`,
  transferRollbackFailed: (cause: string, rollbackCause: string, categoryName: string) =>
    `No se pudo abonar en destino (${cause}) y ADEMÁS falló la reversión del origen (${rollbackCause}); revisa ${categoryName} en Actual`,
  unconfirmedWrites: 'Se enviaron pero no se pudieron confirmar releyendo; vuelve a consultar esas transacciones antes de darlas por categorizadas',
  syncPending: (cause: string) =>
    `El cambio se guardó en la copia local pero no se pudo sincronizar con el servidor (${cause}); ` +
    'se reintentará en la siguiente consulta. Si el error persiste, revisa la conexión con Actual',
  deleteCategoryNeedsConfirmation: (name: string) =>
    `Borrar la categoría "${name}" es irreversible. Vuelve a llamar con confirm_delete: true si estás seguro, ` +
    'o archívala sin perder nada con update_category(hidden: true)',
  deleteGroupNeedsConfirmation: (name: string, categoryCount: number) =>
    `Borrar el grupo "${name}" es irreversible y se lleva por delante sus ${categoryCount} categorías. ` +
    'Vuelve a llamar con confirm_delete: true si estás seguro, o archívalo sin perder nada con ' +
    'update_category_group(hidden: true)',
  deleteCategoryNeedsTarget: (name: string, txCount: number) =>
    `La categoría "${name}" tiene ${txCount} transacciones. Indica transfer_category_id con la categoría a la que ` +
    'reasignarlas; si se borra sin destino, esas transacciones quedan sin categoría',
  deleteGroupNeedsTarget: (name: string, txCount: number) =>
    `Las categorías del grupo "${name}" tienen ${txCount} transacciones. Indica transfer_category_id con la ` +
    'categoría (de OTRO grupo) a la que reasignarlas; si se borra sin destino, esas transacciones quedan sin categoría',
  cannotReassignToSelf: 'transfer_category_id no puede ser una de las categorías que se están borrando',
  transferSameAccount: 'La cuenta de destino debe ser distinta de la cuenta de la transacción',
  transferCategorySameSide: (accountName: string) =>
    `"${accountName}" está del mismo lado del presupuesto que la cuenta de la transacción (o no se puede confirmar): ` +
    'una transferencia entre cuentas del mismo lado no lleva categoría; quita category_id',
  accountClosed: (name: string) => `La cuenta "${name}" está cerrada`,
  transferTargetSynced: (name: string) =>
    `"${name}" se sincroniza con el banco: cuando el banco importe este movimiento quedará duplicado. ` +
    'Para unir dos movimientos que ya existen usa find_transfer_issues y la operación link',
  cannotTransferSplitParent: (id: string) =>
    `La transacción ${id} es el padre de un split y Actual no puede convertirla en transferencia: convierte sus ` +
    'partes por separado o deshaz el split primero',
  ruleDeleteRejected: (id: string) => `Actual rechazó el borrado de la regla ${id}; vuelve a consultarla con get_rules`,

  // --- Conciliación ---
  startAfterEnd: (start: string, end: string) => `rango de fechas invertido: start_date ${start} es posterior a end_date ${end}`,
  reasonLink: (days: number, unique: boolean) =>
    `Importes contrarios en dos cuentas con ${days} día(s) de diferencia` +
    (unique ? '; es la única pareja posible' : '; hay más de una pareja posible'),
  reasonMerge: (days: number, unique: boolean) =>
    `Mismo importe en la misma cuenta con ${days} día(s) de diferencia: uno vino del banco y el otro no` +
    (unique ? '' : '; hay más de un candidato'),
  reasonCreateFromHistory: (account: string) =>
    `Movimientos anteriores de este beneficiario se convirtieron en transferencias a "${account}"`,
  reasonCreateFromName: (account: string) => `El beneficiario o las notas mencionan la cuenta "${account}"`,
  reconcileMatchesNext: 'El saldo cuadra. Si quieres fijarlo, usa mark_reconciled con la misma fecha y saldo',
  reconcileMismatch: (difference: string) =>
    `No cuadra (diferencia banco − Actual: ${difference}); no se ha marcado nada. Usa reconcile_account para ver la causa`,
  reconcilePartial: (done: number, total: number) =>
    `Se marcaron ${done} de ${total} movimientos antes del fallo. Es seguro volver a ejecutar mark_reconciled con los mismos valores: solo toca los no conciliados`,
  reconcilePending: (settled: number, total: number) =>
    `Actual aún no refleja la conciliación de ${total - settled} de ${total} movimientos (se confirmaron ${settled}). Es seguro volver a ejecutar mark_reconciled con los mismos valores: solo toca los no conciliados`,
  reconcileHintExtra: 'Su importe es exactamente la diferencia: puede que sobre en Actual (duplicado o mal fechado)',
  opTxNotFound: (id: string) => `El movimiento ${id} ya no existe`,
  opCounterpartReconciled: (id: string) =>
    `La contrapartida ${id} está conciliada y fusionar la reenlazaría: no se toca`,
  opSplitRow: (id: string) => `El movimiento ${id} forma parte de un split`,
  opReconciled: (id: string) => `El movimiento ${id} está conciliado y no se toca`,
  opAlreadyTransfer: (id: string) => `El movimiento ${id} ya es una transferencia`,
  opSameAccount: 'Los dos movimientos están en la misma cuenta',
  opAmountsMismatch: 'Los importes ya no se corresponden',
  opMergeShape: 'Para fusionar, keep debe ser el movimiento importado del banco y drop el no importado, en la misma cuenta y con el mismo importe',
  opAccountUnavailable: (id: string) => `La cuenta ${id} no existe, está cerrada o es la del propio movimiento`,
  opNoTransferPayee: (id: string) => `La cuenta ${id} no tiene beneficiario de transferencia`,
  linkNoCounterpart: (id: string) => `Actual no creó la contrapartida de ${id}; se ha revertido el cambio`,
  linkReverted: (cause: string) => `Falló al fusionar (${cause}); se ha revertido el cambio`,
  linkRevertFailed: (x: string, counterpart: string, cause: string) =>
    `Falló y no se pudo revertir (${cause}): revisa a mano ${x} y la contrapartida ${counterpart}`,
  linkRevertUnsafe: (other: string) =>
    `el movimiento ya apunta a ${other}, que no es la contrapartida creada; revertir lo borraría`,
  linkUnverified: (x: string, y: string) => `Tras fusionar, ${x} y ${y} no quedaron enlazados: revísalos a mano`,
  mergeUnverified: (keep: string, drop: string) =>
    `Tras fusionar ${drop} en ${keep} el resultado no es el esperado: revisa ${keep} a mano`,

  // --- Infraestructura del presupuesto ---
  budgetClosed: (cause: string, dataDir: string) =>
    'El presupuesto de Actual está cerrado y no se pudo volver a abrir ' +
    `(causa original: ${cause}). Reinicia el servidor MCP; si el error persiste, ` +
    `revisa el log de arranque y que ${dataDir} sea accesible.`,
  budgetOpenFailed: (primaryDir: string, primaryErr: string, fallbackDir: string, fallbackErr: string) =>
    `No se pudo abrir el presupuesto ni en ${primaryDir} (${primaryErr}) ni en la copia propia ` +
    `${fallbackDir} (${fallbackErr}). Si tienes varios clientes MCP conectados a la vez, cierra ` +
    'los que no uses o da a cada uno su propio ACTUAL_DATA_DIR.',
  nativeAbiMismatch: (compiladoPara: number, runtime: number) =>
    'El módulo nativo de esta extensión se compiló para NODE_MODULE_VERSION ' +
    `${compiladoPara}, pero Claude Desktop ejecuta ahora la versión ${runtime}. Esto pasa cuando ` +
    'Claude Desktop actualiza su Electron interno después de instalar el bundle. La extensión no ' +
    'puede funcionar hasta que se reempaquete para esta versión: descarga una nueva desde ' +
    'https://github.com/marcoaperez/actual-budget-mcp-es/releases/latest e instálala de nuevo. ' +
    'Si usas la instalación manual (sin el bundle .mcpb), esto no te afecta.',
};

export type Messages = typeof es;

const en: Messages = {
  // --- Formato y validación de entrada ---
  invalidInput: 'Invalid input',
  dateFormat: 'Date in YYYY-MM-DD format',
  monthFormat: 'Month in YYYY-MM format',
  mustBeUuid: 'Must be a UUID (use get_accounts / get_categories / get_transactions to obtain them)',
  invalidToolName: (name: string) => `Invalid tool name: ${name}`,
  noFieldToUpdate: 'You must specify at least one field to update (category_id, payee_id, payee_name, notes, date, amount, cleared)',
  noGroupFieldToUpdate: 'You must specify at least one field to update (name, hidden)',
  noCategoryFieldToUpdate: 'You must specify at least one field to update (name, group_id, hidden)',
  scheduleDateXorRecurrence: 'Specify exactly one: date (one-off) or recurrence (recurring)',
  payeeIdAndNameTogether: 'Specify payee_id or payee_name, not both',
  transferCategoriesMustDiffer: 'Source and destination categories must be different',
  spendingRangeTooLong: 'The date range cannot exceed 5 years; shorten start_date/end_date.',
  emptyNoteRequiresClear: (name: string) =>
    `An empty note erases the existing note of "${name}". Pass clear: true to confirm.`,
  partsDoNotSum: (sum: string, total: string, missing: boolean, diff: string) =>
    `The parts differ from the total: they add up to ${sum} and the transaction is ${total} (${missing ? 'missing' : 'extra'} ${diff}). Adjust the parts or use adjust_last=true`,
  createSplitsMismatch: (sum: string, total: string) =>
    `The parts differ from the total: they add up to ${sum} and the amount is ${total}`,
  unknownRuleField: 'Unknown rule field (use get_rules to see examples of existing rules)',
  unknownRuleOp: 'Unknown rule operator (use get_rules to see examples of existing rules)',
  unknownRuleStage: "stage must be 'pre', 'post' or null (null = the default stage)",

  // --- No encontrado ---
  categoryNotFound: (id: string) => `unknown category: ${id} (use get_categories to list valid ids)`,
  categoryGroupNotFound: (id: string) => `unknown category group: ${id} (use get_categories to list valid ids)`,
  txNotFound: (id: string) => `Transaction not found: ${id}`,
  txNotFoundItem: 'transaction not found',
  payeeNotFound: (name: string, options: string[]) =>
    `Payee not found: "${name}"${options.length ? ` — maybe: ${options.join(', ')}?` : ''}`,
  payeeIdNotFound: (id: string) => `unknown payee: ${id} (use get_payees to list valid ids)`,
  accountNotFound: (id: string) => `unknown account: ${id} (use get_accounts to list valid ids)`,
  accountRefNotFound: (ref: string, names: string[]) =>
    `Account not found: "${ref}". Open accounts: ${names.join(', ')}`,
  accountRefAmbiguous: (ref: string, ids: string[]) =>
    `Several accounts are named "${ref}"; pass its id: ${ids.join(', ')}`,
  transferPayeeNotFound: (accountId: string) =>
    `Account ${accountId} has no transfer payee. Actual creates one with the account: check the id with ` +
    'get_accounts, and if the account exists, open it once in Actual so the payee is generated',
  transferSourceNotFound: (month: string, id: string) => `Source category not found in ${month}: ${id}`,
  transferTargetNotFound: (month: string, id: string) => `Target category not found in ${month}: ${id}`,
  ruleNotFound: (id: string) => `unknown rule: ${id} (use get_rules to list valid ids)`,

  // --- Guardas de estado y consistencia de escritura ---
  cannotSplitTransfer: 'Cannot split a transfer between accounts',
  alreadySplit: 'The transaction is already split; edit its parts in Actual or undo the split first',
  reconciledNeedsForce: 'The transaction is reconciled; splitting it would break the reconciliation. Try again with force: true if you are sure',
  splitChild: (id: string, parentId: string) =>
    `Transaction ${id} is part of a split (parent ${parentId}); edit the whole split with split_transaction or from Actual`,
  splitParentAmount: (id: string) =>
    `Transaction ${id} is the parent of a split: amount and category live in the parts; use split_transaction to re-split it (notes, date, cleared and payee can be edited here)`,
  splitChildFieldNotAllowed: (field: string) =>
    `${field} cannot be edited on a split part: only category, notes and payee; to change amounts re-split with split_transaction, or edit the parent`,
  transferPartCategorySameSide:
    'This part is a transfer between accounts on the same budget side (or that cannot be confirmed): it takes no category; remove the transfer first with remove_transaction_transfer',
  transferPartCategorySameSideItem:
    'it is a transfer between accounts on the same budget side (or that cannot be confirmed): it takes no category',
  transferPartPayeeUseRemove:
    'This part is a transfer: changing its payee undoes it; use remove_transaction_transfer to do that explicitly',
  splitParentItem: 'it is the parent of a split; the category lives in the parts',
  echoPending: 'The write was sent but is not yet reflected on re-read; query the transaction again to confirm it',
  ambiguousNewRow: 'Several new rows appeared with the same account, date and amount; the first one is returned. Check for possible duplicates in Actual',
  transferRolledBack: (cause: string) =>
    `Could not credit the target (${cause}); the transfer was rolled back and nothing was moved`,
  transferRollbackFailed: (cause: string, rollbackCause: string, categoryName: string) =>
    `Could not credit the target (${cause}) and the source rollback ALSO failed (${rollbackCause}); check ${categoryName} in Actual`,
  unconfirmedWrites: 'They were sent but could not be confirmed by re-reading; query those transactions again before considering them categorized',
  syncPending: (cause: string) =>
    `The change was saved to the local copy but could not be synced to the server (${cause}); ` +
    'it will be retried on the next query. If the error persists, check the connection to Actual',
  deleteCategoryNeedsConfirmation: (name: string) =>
    `Deleting the category "${name}" cannot be undone. Call again with confirm_delete: true if you are sure, ` +
    'or archive it losing nothing with update_category(hidden: true)',
  deleteGroupNeedsConfirmation: (name: string, categoryCount: number) =>
    `Deleting the group "${name}" cannot be undone and takes its ${categoryCount} categories with it. ` +
    'Call again with confirm_delete: true if you are sure, or archive it losing nothing with ' +
    'update_category_group(hidden: true)',
  deleteCategoryNeedsTarget: (name: string, txCount: number) =>
    `The category "${name}" has ${txCount} transactions. Pass transfer_category_id with the category to reassign ` +
    'them to; deleting without a destination leaves those transactions uncategorized',
  deleteGroupNeedsTarget: (name: string, txCount: number) =>
    `The categories in group "${name}" have ${txCount} transactions. Pass transfer_category_id with the category ` +
    '(from ANOTHER group) to reassign them to; deleting without a destination leaves those transactions uncategorized',
  cannotReassignToSelf: 'transfer_category_id cannot be one of the categories being deleted',
  transferSameAccount: 'The destination account must be different from the account of the transaction',
  transferCategorySameSide: (accountName: string) =>
    `"${accountName}" is on the same budget side as the transaction's account (or that cannot be confirmed): ` +
    'a transfer between accounts on the same side takes no category; drop category_id',
  accountClosed: (name: string) => `Account "${name}" is closed`,
  transferTargetSynced: (name: string) =>
    `"${name}" syncs with the bank: once the bank imports this transaction it will be duplicated. ` +
    'To join two transactions that already exist use find_transfer_issues and the link operation',
  cannotTransferSplitParent: (id: string) =>
    `Transaction ${id} is the parent of a split and Actual cannot turn it into a transfer: convert its parts ` +
    'individually or undo the split first',
  ruleDeleteRejected: (id: string) => `Actual refused to delete rule ${id}; query it again with get_rules`,

  // --- Reconciliation ---
  startAfterEnd: (start: string, end: string) => `inverted date range: start_date ${start} is after end_date ${end}`,
  reasonLink: (days: number, unique: boolean) =>
    `Opposite amounts in two accounts, ${days} day(s) apart` +
    (unique ? '; it is the only possible pair' : '; there is more than one possible pair'),
  reasonMerge: (days: number, unique: boolean) =>
    `Same amount in the same account, ${days} day(s) apart: one came from the bank and the other did not` +
    (unique ? '' : '; there is more than one candidate'),
  reasonCreateFromHistory: (account: string) =>
    `Earlier transactions from this payee were turned into transfers to "${account}"`,
  reasonCreateFromName: (account: string) => `The payee or notes mention the account "${account}"`,
  reconcileMatchesNext: 'The balance matches. To lock it in, call mark_reconciled with the same date and balance',
  reconcileMismatch: (difference: string) =>
    `It does not match (bank − Actual difference: ${difference}); nothing was marked. Use reconcile_account to find the cause`,
  reconcilePartial: (done: number, total: number) =>
    `${done} of ${total} transactions were marked before the failure. It is safe to run mark_reconciled again with the same values: it only touches unreconciled rows`,
  reconcilePending: (settled: number, total: number) =>
    `Actual does not yet show ${total - settled} of ${total} transactions as reconciled (${settled} confirmed). It is safe to run mark_reconciled again with the same values: it only touches unreconciled rows`,
  reconcileHintExtra: 'Its amount is exactly the difference: it may be extra in Actual (duplicate or wrong date)',
  opTxNotFound: (id: string) => `Transaction ${id} no longer exists`,
  opCounterpartReconciled: (id: string) =>
    `The counterpart ${id} is reconciled and merging would re-link it: left untouched`,
  opSplitRow: (id: string) => `Transaction ${id} is part of a split`,
  opReconciled: (id: string) => `Transaction ${id} is reconciled and is left untouched`,
  opAlreadyTransfer: (id: string) => `Transaction ${id} is already a transfer`,
  opSameAccount: 'Both transactions are in the same account',
  opAmountsMismatch: 'The amounts no longer match',
  opMergeShape: 'To merge, keep must be the bank-imported transaction and drop the non-imported one, in the same account with the same amount',
  opAccountUnavailable: (id: string) => `Account ${id} does not exist, is closed or is the transaction's own account`,
  opNoTransferPayee: (id: string) => `Account ${id} has no transfer payee`,
  linkNoCounterpart: (id: string) => `Actual did not create the counterpart of ${id}; the change was reverted`,
  linkReverted: (cause: string) => `Merging failed (${cause}); the change was reverted`,
  linkRevertFailed: (x: string, counterpart: string, cause: string) =>
    `Failed and could not be reverted (${cause}): check ${x} and the counterpart ${counterpart} by hand`,
  linkRevertUnsafe: (other: string) =>
    `the transaction now points to ${other}, which is not the counterpart that was created; reverting would delete it`,
  linkUnverified: (x: string, y: string) => `After merging, ${x} and ${y} are not linked: check them by hand`,
  mergeUnverified: (keep: string, drop: string) =>
    `After merging ${drop} into ${keep} the result is not as expected: check ${keep} by hand`,

  // --- Infraestructura del presupuesto ---
  budgetClosed: (cause: string, dataDir: string) =>
    'The Actual budget is closed and could not be reopened ' +
    `(original cause: ${cause}). Restart the MCP server; if it persists, ` +
    `check the startup log and that ${dataDir} is accessible.`,
  budgetOpenFailed: (primaryDir: string, primaryErr: string, fallbackDir: string, fallbackErr: string) =>
    `Could not open the budget either at ${primaryDir} (${primaryErr}) or in its own copy at ` +
    `${fallbackDir} (${fallbackErr}). If you have several MCP clients connected at the same time, ` +
    'close the ones you are not using or give each its own ACTUAL_DATA_DIR.',
  nativeAbiMismatch: (compiladoPara: number, runtime: number) =>
    "This extension's native module was compiled for NODE_MODULE_VERSION " +
    `${compiladoPara}, but Claude Desktop is now running version ${runtime}. This happens when ` +
    'Claude Desktop updates its internal Electron after the bundle was installed. The extension ' +
    'cannot work until it is repackaged for this version: download a new one from ' +
    'https://github.com/marcoaperez/actual-budget-mcp-es/releases/latest and reinstall it. ' +
    'If you use the manual installation (without the .mcpb bundle), this does not affect you.',
};

const CATALOGUES: Record<'es' | 'en', Messages> = { es, en };

export function messagesFor(lang: 'es' | 'en'): Messages {
  return CATALOGUES[lang];
}

export function msg(config: Config): Messages {
  return messagesFor(config.messagesLang);
}

// Los esquemas Zod se construyen al cargar el módulo y el SDK los valida ANTES de
// llamar al handler, así que su mensaje no puede depender de config: se resuelve
// al parsear, contra este idioma activo. Es el único sitio donde el idioma no
// viaja en config, y es honesto: un proceso servidor tiene un único config.
let activo: Messages = es;

export function setMessageLanguage(lang: 'es' | 'en'): void {
  activo = CATALOGUES[lang];
}

export function activeMessages(): Messages {
  return activo;
}
