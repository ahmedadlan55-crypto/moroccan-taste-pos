/**
 * Barrel export — single import point for the repository layer.
 *
 *   const repos = require('../repositories');
 *   repos.tx.findById(id);
 *   repos.users.getPermissionProfile(username);
 *   repos.workflow.getInitiatorFirstStep(positionId);
 *
 * Adding a new repository: create the file, require it here, and bind
 * it to a short alias. Keep aliases stable — they are the public API
 * the services consume.
 */
'use strict';

module.exports = {
  tx:       require('./TransactionRepository'),
  workflow: require('./WorkflowRepository'),
  users:    require('./UserRepository')
};
