// Storage for chat messages. Everything goes through this module so the
// backing database can change (Phase 6: Cassandra) without touching callers.
module.exports = require('./mongoStore.js');
