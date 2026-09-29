-- Keyspace definition
CREATE KEYSPACE IF NOT EXISTS wanderlust
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

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
