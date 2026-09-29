const mongoose = require('mongoose');
const Listing = require('../models/listing.js');
const messageStore = require('../services/messageStore');

const MAX_LENGTH = 1000;
const HISTORY_LIMIT = 50;

// An error whose message is safe to show the user (as opposed to a bug,
// which gets logged server-side and a generic message sent to the client).
class ChatError extends Error {}

const conversationIdFor = (listingId, guestId) => `${listingId}_${guestId}`;

// Only the guest themself or the listing's owner may read/write a
// conversation. The sender is ALWAYS the logged-in user from the session
// (socket.request.user), never an id sent by the client.
async function authorize(user, { listingId, guestId } = {}) {
  if (!mongoose.isValidObjectId(listingId) || !mongoose.isValidObjectId(guestId)) {
    throw new ChatError('Invalid conversation.');
  }
  const listing = await Listing.findById(listingId).select('owner');
  if (!listing) throw new ChatError('Listing not found.');
  const ownerId = listing.owner?.toString();
  const userId = user._id.toString();
  if (guestId === ownerId) throw new ChatError("Hosts can't message their own listing.");
  if (userId !== guestId && userId !== ownerId) throw new ChatError('Not allowed.');
  return conversationIdFor(listingId, guestId);
}

// Handlers must never throw: an exception inside an async Socket.IO handler
// is an unhandled rejection, which crashes the process. Errors become
// { ok: false, error } replies instead.
const reply = (ack, payload) => { if (typeof ack === 'function') ack(payload); };
const fail = (ack, err) => {
  if (!(err instanceof ChatError)) console.error('Chat error:', err);
  reply(ack, { ok: false, error: err instanceof ChatError ? err.message : 'Something went wrong.' });
};

module.exports = (io, socket, { instanceId }) => {
  const user = socket.request.user;

  socket.on('chat:join', async (payload, ack) => {
    try {
      const conversationId = await authorize(user, payload);
      // One open conversation per socket: leave any previous one first.
      for (const room of socket.rooms) if (room !== socket.id) socket.leave(room);
      socket.join(conversationId);
      const messages = await messageStore.getRecentMessages(conversationId, HISTORY_LIMIT);
      reply(ack, { ok: true, messages, instance: instanceId });
    } catch (err) {
      fail(ack, err);
    }
  });

  socket.on('chat:send', async (payload, ack) => {
    try {
      // Re-check permission on every message, not only on join.
      const conversationId = await authorize(user, payload);
      const text = String(payload?.text ?? '').trim();
      if (!text) throw new ChatError('Message is empty.');
      if (text.length > MAX_LENGTH) {
        throw new ChatError(`Message is longer than ${MAX_LENGTH} characters.`);
      }

      // Save BEFORE broadcasting: Redis pub/sub is fire-and-forget, so a
      // missed live event (e.g. during a Redis blip) is recovered from
      // history the next time either side joins/reloads.
      const message = await messageStore.saveMessage({
        conversationId,
        listingId: payload.listingId,
        guestId: payload.guestId,
        senderId: user._id,
        senderName: user.username,
        text,
      });
      io.to(conversationId).emit('chat:message', message);
      reply(ack, { ok: true });
    } catch (err) {
      fail(ack, err);
    }
  });
};
