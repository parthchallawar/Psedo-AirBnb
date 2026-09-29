// The only file that touches the Message model directly. Every function
// returns plain objects in one DTO shape, so callers (socket/chat.js) never
// see Mongoose documents or ObjectIds — swapping this for Cassandra later
// (Phase 6) is a new file plus one env variable, not a rewrite of the caller.
const mongoose = require('mongoose');
const Message = require('../../models/message.js');

const toDTO = (doc) => ({
  conversationId: doc.conversationId,
  senderId: doc.sender.toString(),
  senderName: doc.senderName,
  text: doc.text,
  sentAt: doc.sentAt.toISOString(),
});

module.exports.saveMessage = async ({ conversationId, listingId, guestId, senderId, senderName, text }) => {
  const doc = await Message.create({
    conversationId,
    listing: listingId,
    guest: guestId,
    sender: senderId,
    senderName,
    text,
  });
  return toDTO(doc);
};

module.exports.getRecentMessages = async (conversationId, limit = 50) => {
  const docs = await Message.find({ conversationId })
    .sort({ sentAt: -1 })
    .limit(limit)
    .lean();
  // .lean() skips toISOString-friendly getters, so map by hand, then reverse
  // to oldest -> newest (the order the chat UI renders in).
  return docs
    .map((d) => ({
      conversationId: d.conversationId,
      senderId: d.sender.toString(),
      senderName: d.senderName,
      text: d.text,
      sentAt: d.sentAt.toISOString(),
    }))
    .reverse();
};

module.exports.listConversations = async (listingId) => {
  // Aggregation's $match, unlike find(), doesn't auto-cast a string to an
  // ObjectId, so cast explicitly to accept either.
  const rows = await Message.aggregate([
    { $match: { listing: new mongoose.Types.ObjectId(listingId) } },
    { $group: { _id: '$guest', lastMessageAt: { $max: '$sentAt' } } },
    { $sort: { lastMessageAt: -1 } },
  ]);
  return rows.map((r) => ({ guestId: r._id.toString(), lastMessageAt: r.lastMessageAt }));
};
