// Storage for chat messages. Supports both MongoDB (default) and Apache Cassandra
// (Phase 6) behind a single unified interface.
const store =
  process.env.MESSAGE_STORE === 'cassandra'
    ? require('./cassandraStore.js')
    : require('./mongoStore.js');

module.exports = store;

