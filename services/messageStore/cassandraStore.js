// Cassandra implementation of the message store interface.
// Returns the exact same DTO shapes as mongoStore.js.
const { getClient, types } = require('../../config/cassandra.js');

module.exports.saveMessage = async ({ conversationId, listingId, guestId, senderId, senderName, text }) => {
  const client = getClient();
  const sentAt = types.TimeUuid.now();

  const queries = [
    {
      query:
        'INSERT INTO messages_by_conversation (conversation_id, sent_at, sender_id, sender_name, body) VALUES (?, ?, ?, ?, ?)',
      params: [conversationId, sentAt, senderId.toString(), senderName, text],
    },
    {
      query:
        'INSERT INTO conversations_by_listing (listing_id, guest_id, last_message_at) VALUES (?, ?, ?)',
      params: [listingId.toString(), guestId.toString(), sentAt.getDate()],
    },
  ];

  await client.batch(queries, { prepare: true, logged: true });

  return {
    conversationId,
    senderId: senderId.toString(),
    senderName,
    text,
    sentAt: sentAt.getDate().toISOString(),
  };
};

module.exports.getRecentMessages = async (conversationId, limit = 50) => {
  const client = getClient();
  const query =
    'SELECT conversation_id, sent_at, sender_id, sender_name, body FROM messages_by_conversation WHERE conversation_id = ? LIMIT ?';
  const result = await client.execute(query, [conversationId, limit], { prepare: true });

  // Map rows and reverse so messages are in chronological (oldest -> newest) order
  return result.rows
    .map((row) => ({
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      senderName: row.sender_name,
      text: row.body,
      sentAt: row.sent_at.getDate().toISOString(),
    }))
    .reverse();
};

module.exports.listConversations = async (listingId) => {
  const client = getClient();
  const query =
    'SELECT guest_id, last_message_at FROM conversations_by_listing WHERE listing_id = ?';
  const result = await client.execute(query, [listingId.toString()], { prepare: true });

  const rows = result.rows.map((r) => ({
    guestId: r.guest_id,
    lastMessageAt: r.last_message_at,
  }));

  // Sort descending by recency in memory
  return rows.sort(
    (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
  );
};
