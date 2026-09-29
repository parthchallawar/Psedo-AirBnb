const cassandra = require('cassandra-driver');
const fs = require('fs');
const path = require('path');

const contactPoints = (process.env.CASSANDRA_CONTACT_POINTS || '127.0.0.1')
  .split(',')
  .map((s) => s.trim());
const localDataCenter = process.env.CASSANDRA_DC || 'datacenter1';
const keyspace = process.env.CASSANDRA_KEYSPACE || 'wanderlust';

let client = null;
let isReady = false;

function getClient() {
  if (!client) {
    client = new cassandra.Client({
      contactPoints,
      localDataCenter,
      queryOptions: {
        prepare: true,
        consistency: cassandra.types.consistencies.localQuorum,
      },
    });
  }
  return client;
}

async function connectCassandra() {
  if (isReady && client) return client;

  const cl = getClient();
  await cl.connect();

  // Execute schema.cql statements to bootstrap keyspace and tables
  const schemaPath = path.join(__dirname, '../cassandra/schema.cql');
  if (fs.existsSync(schemaPath)) {
    const rawCql = fs.readFileSync(schemaPath, 'utf8');
    // Remove comments and split by semicolon
    const statements = rawCql
      .replace(/--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      await cl.execute(stmt);
    }
  }

  // Switch to the target keyspace
  await cl.execute(`USE ${keyspace};`);
  isReady = true;
  console.log(`Connected to Apache Cassandra (keyspace: ${keyspace}, dc: ${localDataCenter})`);
  return cl;
}

function isCassandraReady() {
  return isReady;
}

async function closeCassandra() {
  if (client) {
    isReady = false;
    await client.shutdown();
    client = null;
    console.log('Cassandra client disconnected');
  }
}

module.exports = {
  getClient,
  connectCassandra,
  isCassandraReady,
  closeCassandra,
  types: cassandra.types,
};
