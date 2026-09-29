// Exercises the guest<->host chat end to end: auth, cross-instance delivery,
// authorization rules, input validation, and history.
//
// Usage:
//   node scripts/chat-test.js [--base=http://localhost:8080] [--keep] [--cleanup]
//
// Needs TEST_USER/TEST_PASS (host) and TEST_USER2/TEST_PASS2 (guest) in .env
// — real signed-up users (see the Phase 3/4 implementation plans for how
// they were created).

require('dotenv').config();
const mongoose = require('mongoose');
const { io } = require('socket.io-client');
const Listing = require('../models/listing.js');
const User = require('../models/user.js');
const Message = require('../models/message.js');

const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
  if (match) flags[match[1]] = match[2] ?? true;
}
const BASE = flags.base || 'http://localhost:8080';
const KEEP = Boolean(flags.keep);
const CLEANUP_ONLY = Boolean(flags.cleanup);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' - ' + detail : ''}`);
};

async function login(username, password) {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
    redirect: 'manual',
  });
  const location = res.headers.get('location') || '';
  const cookies = res.headers.getSetCookie();
  if (!location.includes('/listings') || cookies.length === 0) {
    throw new Error(`Login failed for ${username} (redirected to "${location}"). Check .env credentials.`);
  }
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

// Connects a socket authenticated with `cookie`. If `avoidInstance` is set,
// reconnects (Socket.IO gives each attempt a fresh handshake, which the load
// balancer routes independently) until a join lands on a different instance
// — that's how the cross-instance test puts guest and host on separate
// containers deliberately rather than by luck.
function connectSocket(cookie) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, {
      transports: ['websocket'],
      extraHeaders: { Cookie: cookie },
      reconnection: false,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

function emitWithAck(socket, event, payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function waitForMessage(socket, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.once('chat:message', (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

async function joinOnDifferentInstances(hostCookie, guestCookie, listingId, guestId) {
  const guestSocket = await connectSocket(guestCookie);
  const guestJoin = await emitWithAck(guestSocket, 'chat:join', { listingId, guestId });

  let hostSocket;
  let hostJoin;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (hostSocket) hostSocket.disconnect();
    hostSocket = await connectSocket(hostCookie);
    hostJoin = await emitWithAck(hostSocket, 'chat:join', { listingId, guestId });
    if (!guestJoin.instance || hostJoin.instance !== guestJoin.instance) break;
  }
  return { guestSocket, guestJoin, hostSocket, hostJoin };
}

async function cleanupTestListings(hostId) {
  const stale = await Listing.find({ owner: hostId, title: /^\[TEST\]/ });
  for (const listing of stale) {
    await Message.deleteMany({ listing: listing._id });
    await Listing.findByIdAndDelete(listing._id);
  }
  return stale.length;
}

async function main() {
  const { TEST_USER, TEST_PASS, TEST_USER2, TEST_PASS2 } = process.env;
  if (!TEST_USER || !TEST_PASS || !TEST_USER2 || !TEST_PASS2) {
    console.error('Set TEST_USER/TEST_PASS (host) and TEST_USER2/TEST_PASS2 (guest) in .env first.');
    process.exit(1);
  }

  await mongoose.connect(process.env.ATLASDB_URL);

  const host = await User.findOne({ username: TEST_USER });
  const guest = await User.findOne({ username: TEST_USER2 });
  if (!host || !guest) {
    console.error('TEST_USER or TEST_USER2 does not exist. Sign them up first.');
    process.exit(1);
  }

  if (CLEANUP_ONLY) {
    const removed = await cleanupTestListings(host._id);
    console.log(`Removed ${removed} leftover [TEST] listing(s).`);
    await mongoose.disconnect();
    return;
  }

  await cleanupTestListings(host._id); // in case a previous run didn't clean up

  const listing = await Listing.create({
    title: '[TEST] Chat test listing',
    description: 'Temporary listing created by scripts/chat-test.js',
    owner: host._id,
    price: 1,
    location: 'Test',
    country: 'Test',
    geometry: { type: 'Point', coordinates: [0, 0] },
  });
  const listingId = listing._id.toString();
  const guestId = guest._id.toString();

  console.log(`Listing:   ${listing.title} (${listingId})`);
  console.log(`Host:      ${TEST_USER}   Guest: ${TEST_USER2}`);
  console.log(`Base:      ${BASE}`);
  console.log('');

  const hostCookie = await login(TEST_USER, TEST_PASS);
  const guestCookie = await login(TEST_USER2, TEST_PASS2);

  // 1. No cookie -> rejected
  try {
    await connectSocket('');
    check('Unauthenticated socket is rejected', false, 'connected without a cookie');
  } catch {
    check('Unauthenticated socket is rejected', true);
  }

  // 2/3. Both join, ideally on different instances (best-effort across a
  // single local instance too — the check just reports what happened).
  const { guestSocket, guestJoin, hostSocket, hostJoin } = await joinOnDifferentInstances(
    hostCookie, guestCookie, listingId, guestId
  );
  check('Guest joins their conversation', guestJoin.ok && guestJoin.messages.length === 0);
  check('Host joins the same conversation', hostJoin.ok,
    `guest on ${guestJoin.instance || '?'}, host on ${hostJoin.instance || '?'}`);

  // 4. Guest -> host
  const guestText = `Hello from guest ${Date.now()}`;
  const hostReceived = waitForMessage(hostSocket);
  const sendGuest = await emitWithAck(guestSocket, 'chat:send', { listingId, guestId, text: guestText });
  const gotAtHost = await hostReceived;
  check('Guest message reaches the host', sendGuest.ok && gotAtHost && gotAtHost.text === guestText);

  // 5. Host -> guest
  const hostText = `Hello from host ${Date.now()}`;
  const guestReceived = waitForMessage(guestSocket);
  const sendHost = await emitWithAck(hostSocket, 'chat:send', { listingId, guestId, text: hostText });
  const gotAtGuest = await guestReceived;
  check('Host message reaches the guest', sendHost.ok && gotAtGuest && gotAtGuest.text === hostText);

  // 6. Guest can't join someone else's conversation (using the host's own id as a stand-in "other user")
  const forbiddenJoin = await emitWithAck(guestSocket, 'chat:join', { listingId, guestId: host._id.toString() });
  check("Guest can't join someone else's conversation", !forbiddenJoin.ok);

  // 7. Host can't be "the guest" on their own listing
  const ownListingJoin = await emitWithAck(hostSocket, 'chat:join', { listingId, guestId: host._id.toString() });
  check("Host can't message their own listing", !ownListingJoin.ok);

  // Re-join the real conversation (test 6/7 changed rooms).
  await emitWithAck(guestSocket, 'chat:join', { listingId, guestId });
  await emitWithAck(hostSocket, 'chat:join', { listingId, guestId });

  // 8. Empty and over-length messages are rejected
  const emptySend = await emitWithAck(guestSocket, 'chat:send', { listingId, guestId, text: '   ' });
  const longSend = await emitWithAck(guestSocket, 'chat:send', { listingId, guestId, text: 'x'.repeat(1001) });
  check('Empty message is rejected', !emptySend.ok);
  check('Over-length message is rejected', !longSend.ok);

  // 9. XSS payload round-trips as literal text
  const xssText = '<script>alert(1)</script>';
  const hostReceivedXss = waitForMessage(hostSocket);
  await emitWithAck(guestSocket, 'chat:send', { listingId, guestId, text: xssText });
  const gotXss = await hostReceivedXss;
  check('Message text is stored/delivered verbatim (client renders it as text, never HTML)',
    gotXss && gotXss.text === xssText);

  // 10. Fresh socket sees history, oldest first
  const freshGuest = await connectSocket(guestCookie);
  const historyJoin = await emitWithAck(freshGuest, 'chat:join', { listingId, guestId });
  const historyOk = historyJoin.ok
    && historyJoin.messages.length >= 3
    && historyJoin.messages[0].text === guestText
    && new Date(historyJoin.messages[0].sentAt) <= new Date(historyJoin.messages[historyJoin.messages.length - 1].sentAt);
  check('A fresh join sees history, oldest first', historyOk, `${historyJoin.messages?.length ?? 0} message(s)`);
  freshGuest.disconnect();

  // 11. Owner's conversation list includes the guest
  const messageStore = require('../services/messageStore');
  const conversations = await messageStore.listConversations(listingId);
  check("listConversations includes the guest", conversations.some((c) => c.guestId === guestId));

  guestSocket.disconnect();
  hostSocket.disconnect();

  console.log('');
  if (KEEP) {
    console.log(`Cleanup:   skipped (--keep). Listing: ${BASE}/listings/${listingId}`);
  } else {
    await Message.deleteMany({ listing: listing._id });
    await Listing.findByIdAndDelete(listing._id);
    console.log('Cleanup:   removed the test listing and its messages');
  }

  await mongoose.disconnect();

  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log(failed.length === 0
    ? `All ${results.length} checks passed.`
    : `${failed.length} of ${results.length} checks FAILED.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Chat test failed:', err);
  process.exit(1);
});
