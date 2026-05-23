/**
 * Barrel export — single import point for the service layer.
 *
 *   const services = require('../services');
 *   const result = await services.tx.create(payload, actor);
 *   await services.audit.record({...});
 *   await services.notify.notifyTransactionAction({...});
 *
 * Aliases are stable — they form the public API of the service layer.
 */
'use strict';

module.exports = {
  tx:       require('./TransactionService'),
  assignee: require('./AssigneeResolverService'),
  audit:    require('./AuditService'),
  notify:   require('./NotificationService')
};
