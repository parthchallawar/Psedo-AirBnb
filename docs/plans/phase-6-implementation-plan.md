# Phase 6 — Implementation Plan: Apache Cassandra for Chat Messages

Spec: [docs/specs/phase-6-cassandra-chat-storage.md](../specs/phase-6-cassandra-chat-storage.md)

---

## Decisions & Design Notes

| # | Decision | Why |
|---|---|---|
| D1 | Dual-support via `MESSAGE_STORE=mongo` (default) / `MESSAGE_STORE=cassandra` | Enables development and fallback without requiring a running Cassandra instance (~500MB RAM), while providing the polyglot Cassandra architecture when enabled. |
| D2 | Query-first data modeling with two tables | Cassandra cannot perform joins or arbitrary filtering. Table 1 (`messages_by_conversation`) handles chronological message retrieval clustered by `sent_at DESC`. Table 2 (`conversations_by_listing`) tracks unique guest conversations per listing. |
| D3 | Use `timeuuid` for message clustering key | Prevents message collisions and silent upsert overwrites if two messages arrive during the exact same millisecond, while maintaining natural time ordering. |
| D4 | Atomic logged batch inserts for dual-table writes | `saveMessage` writes to both `messages_by_conversation` and `conversations_by_listing` in a single logged batch query for consistency. |
| D5 | Clean DTO contract matching `mongoStore` | Both `mongoStore` and `cassandraStore` output identical plain JavaScript object shapes (`{ conversationId, senderId, senderName, text, sentAt }`), so `socket/chat.js` and controllers require zero changes. |
| D6 | Automatic schema bootstrapping on startup | `connectCassandra()` executes `cassandra/schema.cql` (with `IF NOT EXISTS`), creating the keyspace and tables automatically if they don't already exist. |

---

## Step 0 — Install Dependencies
- Install `cassandra-driver` in `package.json`.

## Step 1 — CQL Schema (`cassandra/schema.cql`)
- Keyspace `wanderlust` with `SimpleStrategy`, `replication_factor: 1`.
- Table `messages_by_conversation` (`conversation_id` text, `sent_at` timeuuid, `sender_id` text, `sender_name` text, `body` text, `PRIMARY KEY ((conversation_id), sent_at)`) `WITH CLUSTERING ORDER BY (sent_at DESC)`.
- Table `conversations_by_listing` (`listing_id` text, `guest_id` text, `last_message_at` timestamp, `PRIMARY KEY ((listing_id), guest_id)`).

## Step 2 — Cassandra Client Connection (`config/cassandra.js`)
- Initialize `cassandra-driver` client with configurable contact points, local DC, and keyspace.
- Provide `connectCassandra()`, `getCassandraClient()`, `isCassandraReady()`, and `closeCassandra()`.
- Parse and apply `schema.cql` upon initial connection.

## Step 3 — Cassandra Message Store (`services/messageStore/cassandraStore.js`)
- Implement `saveMessage`: generates `types.TimeUuid.now()`, executes logged batch query across both tables, returns DTO.
- Implement `getRecentMessages`: queries `messages_by_conversation` by `conversation_id` with limit, reverses to oldest-to-newest.
- Implement `listConversations`: queries `conversations_by_listing` by `listing_id`, sorts descending in memory by `last_message_at`.

## Step 4 — Switchable Store Interface (`services/messageStore/index.js`)
- Read `process.env.MESSAGE_STORE` (defaults to `'mongo'`). If `'cassandra'`, exports `cassandraStore`, else `mongoStore`.

## Step 5 — App Integration & Health Check (`app.js`)
- In `app.js`: if `MESSAGE_STORE === 'cassandra'`, await `connectCassandra()`.
- Update `/health` endpoint with `cassandra` status (`"connected"`, `"disabled"`, or `"down"`).
- Add Cassandra cleanup in `shutdown()` handler.

## Step 6 — Docker Compose Configuration (`docker-compose.yml`)
- Add `cassandra` service with healthcheck (`cqlsh -e "describe keyspaces"`), memory limits, and named volume `cassandra_data`.

## Step 7 — Automated Test Suite & Verification (`scripts/chat-test.js` & `scripts/cassandra-test.js`)
- Add a dedicated test or test flag validating Cassandra storage queries, batch writes, timeuuid uniqueness, and fallback behavior.

## Step 8 — Documentation (`CLAUDE.md`)
- Document Cassandra commands, architecture, configuration options, and polyglot persistence rationale.
