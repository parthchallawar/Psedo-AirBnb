# Phase 6 — Apache Cassandra for Chat Messages

## 1. Goal

Store chat messages (Phase 4) in **Apache Cassandra** instead of MongoDB, by adding a Cassandra
implementation of the message store interface and selecting it with `MESSAGE_STORE=cassandra`.
Everything else (listings, users, reviews, bookings) stays in MongoDB.

## 2. Why Cassandra for messages, and only messages (the key interview point)

| Chat messages | Fits Cassandra? |
|---|---|
| Write-heavy (every message is a write) | Yes. Cassandra writes are very fast (append-only). |
| Never updated, only appended | Yes |
| Always read by one key ("messages of conversation X, newest first") | Yes. That's exactly a partition key plus a clustering order. |
| Grows forever, and needs to scale by adding nodes | Yes. Data is spread across nodes by partition key. |

| Listings / bookings | Fits Cassandra? |
|---|---|
| Ad-hoc filters (price range, category, text search) | No. Cassandra can only query efficiently by the key you designed. |
| Relationships (owner, reviews) and populate | No. There are no joins. |
| Needs consistency checks (double booking) | No. It's weaker at read-then-write logic. |

This is **polyglot persistence**: use the right database for each kind of data.

## 3. Concepts (keep to these)

| Concept | One-line explanation |
|---|---|
| **Wide-column / distributed DB** | Data is spread over many nodes. There's no single master, and any node accepts writes. |
| **Partition key** | Decides which node stores a row. All rows with the same partition key live together, and **you must query by it**. |
| **Clustering key** | The sort order of rows *inside* a partition. |
| **Query-first modelling (denormalisation)** | Design one table per query. Duplicating data is normal, because there are no joins. |
| **Replication factor (RF)** | How many nodes keep a copy of each row. |
| **Consistency level** | How many replicas must answer a read or write. `QUORUM` means a majority. |
| **Upsert** | An INSERT with an existing primary key overwrites it. There's no separate UPDATE path to worry about. |

## 4. Scope

**In scope:** Cassandra container, schema file, Cassandra message store, env switch, a health report.
**Out of scope:** multi-node cluster, migrating existing Mongo messages, pagination beyond the last 50 messages.

## 5. Design

### 5.1 Data model — new file `cassandra/schema.cql`

There are two queries (from the Phase 4 interface), so there are **two tables**:

```sql
CREATE KEYSPACE IF NOT EXISTS wanderlust
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};
-- RF 1 because it's a single dev node. Production: NetworkTopologyStrategy, RF 3.

-- Query 1: "last 50 messages of a conversation, newest first"
CREATE TABLE IF NOT EXISTS wanderlust.messages_by_conversation (
  conversation_id text,
  sent_at         timeuuid,
  sender_id       text,
  sender_name     text,
  body            text,
  PRIMARY KEY ((conversation_id), sent_at)
) WITH CLUSTERING ORDER BY (sent_at DESC);

-- Query 2: "which guests have messaged about this listing" (host's view)
CREATE TABLE IF NOT EXISTS wanderlust.conversations_by_listing (
  listing_id      text,
  guest_id        text,
  last_message_at timestamp,
  PRIMARY KEY ((listing_id), guest_id)
);
```

**Design notes**
- `timeuuid` is a timestamp plus random bits: unique **and** time-sortable. Two messages sent in the
  same millisecond don't overwrite each other, which a plain `timestamp` key would allow.
- `conversations_by_listing` is written on every message. Because of upsert, the row for
  (listing, guest) is simply overwritten with the new `last_message_at`. It's sorted by recency in
  the app (a listing has few conversations).
- Known limit: a partition should stay under about 100 MB. One conversation will never get there.
  At huge scale you'd add a time bucket (for example a month) to the partition key.

### 5.2 Connection — new file `config/cassandra.js`
- `cassandra-driver` `Client` with `contactPoints` from `CASSANDRA_CONTACT_POINTS` (comma separated),
  `localDataCenter` from `CASSANDRA_DC`, and keyspace from `CASSANDRA_KEYSPACE`.
- `connectCassandra()`: connect without a keyspace, run each statement from `schema.cql`
  (all `IF NOT EXISTS`, so it's safe to run every startup), then `USE` the keyspace.
- Default query options: `prepare: true` (faster, type-safe) and `consistency: localQuorum`.
  With RF 1 the quorum is 1 node, but the code is already correct for RF 3.
- Only called when `MESSAGE_STORE=cassandra`. Otherwise Cassandra isn't needed at all.

### 5.3 Store — new file `services/messageStore/cassandraStore.js`
Implements the **same three functions** as `mongoStore.js`:

| Function | CQL |
|---|---|
| `saveMessage(...)` | `sentAt = TimeUuid.now()`. Run **one batch** with an `INSERT INTO messages_by_conversation …` and an `INSERT INTO conversations_by_listing …`. Return the message, with `sentAt` converted with `.getDate()`. |
| `getRecentMessages(id, 50)` | `SELECT … FROM messages_by_conversation WHERE conversation_id = ? LIMIT ?`, then reverse the rows to oldest → newest (the interface contract). |
| `listConversations(listingId)` | `SELECT guest_id, last_message_at FROM conversations_by_listing WHERE listing_id = ?`, sorted by `last_message_at` descending in JS. |

A logged batch is used so both tables are updated together. If the first insert succeeds, the
second is guaranteed to eventually succeed too.

### 5.4 Switch — edit `services/messageStore/index.js`
`MESSAGE_STORE=cassandra` → export `cassandraStore`, otherwise `mongoStore`.
The socket code and controllers are **unchanged**. This is the payoff of the interface from Phase 4.
`app.js` awaits `connectCassandra()` at startup when Cassandra is selected.

### 5.5 Docker — edit `docker-compose.yml`

```yaml
cassandra:
  image: cassandra:4.1
  environment:
    - MAX_HEAP_SIZE=512M
    - HEAP_NEWSIZE=128M
    - CASSANDRA_DC=datacenter1
    - CASSANDRA_ENDPOINT_SNITCH=GossipingPropertyFileSnitch
  healthcheck:
    test: ["CMD", "cqlsh", "-e", "describe keyspaces"]
    interval: 15s
    timeout: 10s
    retries: 10
  volumes: [cassandra_data:/var/lib/cassandra]
```
The app services get `MESSAGE_STORE=cassandra` and `CASSANDRA_CONTACT_POINTS=cassandra`, plus
`depends_on: cassandra: condition: service_healthy`. Cassandra takes about 60–90 s to boot.

**Low-RAM fallback:** leave `MESSAGE_STORE=mongo` and the whole app works without Cassandra.

### 5.6 Health — edit `/health` (Phase 2)
Add a `cassandra` field (`"connected"` / `"disabled"` / `"down"`).

## 6. Files changed / added

| File | Change |
|---|---|
| `cassandra/schema.cql` | **new** |
| `config/cassandra.js` | **new** |
| `services/messageStore/cassandraStore.js` | **new** |
| `services/messageStore/index.js` | env switch |
| `app.js` | connect Cassandra when selected; health field; close on shutdown |
| `docker-compose.yml` | `cassandra` service + volume + app env |
| `package.json` | `cassandra-driver` |

## 7. Acceptance criteria

- [ ] With `MESSAGE_STORE=cassandra`, chat works exactly as in Phase 4 (live messages, history, owner's guest list).
- [ ] `docker compose exec cassandra cqlsh -e "SELECT * FROM wanderlust.messages_by_conversation LIMIT 5;"` shows the messages.
- [ ] History comes back oldest → newest in the UI and is limited to 50.
- [ ] Two messages sent in quick succession both persist (the timeuuid prevents overwrites).
- [ ] With `MESSAGE_STORE=mongo`, the app runs with Cassandra stopped.
- [ ] No file outside `services/messageStore/` and `config/cassandra.js` imports `cassandra-driver`.

## 8. Demo script

1. Send a few chat messages.
2. Open `cqlsh` and show `SELECT * FROM wanderlust.messages_by_conversation WHERE conversation_id = '<id>';`, with rows newest first because of the clustering order.
3. Show that `SELECT * FROM wanderlust.messages_by_conversation WHERE sender_id = 'x';` **fails**
   (it needs `ALLOW FILTERING`). Explain that this is why the tables are designed around queries.

## 9. Interview explanation

**Two-minute version**
> "I moved chat messages to Cassandra and kept everything else in MongoDB. Messages are
> write-heavy, append-only, time-ordered, and always read the same way: the latest messages of a
> conversation. That's exactly what Cassandra is built for. In Cassandra you design tables around
> queries rather than entities. The messages table is partitioned by conversation ID, so a whole
> conversation lives together on one node, and clustered by a timeuuid in descending order, so
> 'latest 50' is one sequential read. A second table, partitioned by listing, answers the host's
> 'who messaged me' query. Each message writes to both tables in one batch. That duplication is
> normal in Cassandra because there are no joins. Listings stay in Mongo because they need flexible
> filtering and relationships, which Cassandra is bad at. Because I'd put messages behind a
> storage interface in the chat phase, switching databases was a new file and one env variable."

**Likely questions**

| Question | Answer |
|---|---|
| Why not keep messages in MongoDB? | At this scale Mongo is fine. That's why it's still the fallback. At chat-app scale (billions of messages), Cassandra's masterless, linear write scaling wins. Discord famously stored messages in Cassandra. |
| What is a partition key and why does it matter? | It decides which node owns the data, and you must query by it. A bad key (for example `sender_id`) makes the main query hit every node. |
| What if a conversation grows too large? | Add a time bucket to the partition key, for example `((conversation_id, month), sent_at)`, and read the latest bucket first. |
| Consistency in Cassandra? | Tunable per query. With RF 3, writing and reading at QUORUM (2 of 3) guarantees reads see the latest write. `ONE` is faster but may read stale data. |
| CAP theorem? | Cassandra favours availability and partition tolerance (AP) and is eventually consistent by default. MongoDB with a primary favours consistency (CP). That matches the data: missing a chat message briefly is fine, a wrong booking isn't. |
| Why timeuuid, not timestamp? | Two messages in the same millisecond would get the same primary key and silently overwrite each other (upsert). A timeuuid is unique and still time-ordered. |
