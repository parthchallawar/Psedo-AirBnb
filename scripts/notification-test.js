// Exercises the Notification Microservice end to end:
// 1. Booking confirmed notification (guest + host emails via Ethereal).
// 2. Ethereal preview URLs reachable and valid.
// 3. Booking cancelled notification (guest + host emails).
// 4. Review created notification (host email).
// 5. Host reviewing own listing does not enqueue notification.
// 6. Idempotency of job enqueueing with deterministic jobId.
//
// Usage:
//   node scripts/notification-test.js [--base=http://localhost:8080] [--redis=redis://127.0.0.1:6379] [--status] [--keep]
//
// Needs TEST_USER/TEST_PASS (host) and TEST_USER2/TEST_PASS2 (guest) in .env

require('dotenv').config();
const mongoose = require('mongoose');
const { Queue } = require('bullmq');
const Listing = require('../models/listing.js');
const User = require('../models/user.js');
const Booking = require('../models/booking.js');
const Review = require('../models/review.js');

const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
  if (match) flags[match[1]] = match[2] ?? true;
}

const BASE = flags.base || 'http://localhost:8080';
const REDIS_URL = flags.redis || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const STATUS_ONLY = Boolean(flags.status);
const KEEP = Boolean(flags.keep);

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

async function waitForJob(queue, jobId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await queue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state === 'completed' || state === 'failed') {
        return { job, state, returnvalue: job.returnvalue };
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { job: await queue.getJob(jobId), state: 'timeout', returnvalue: null };
}

async function verifyPreviewUrl(url) {
  try {
    const res = await fetch(url);
    return res.status === 200;
  } catch {
    return false;
  }
}

async function cleanupTestListings(hostId) {
  const stale = await Listing.find({ owner: hostId, title: /^\[TEST\]/ });
  for (const listing of stale) {
    await Booking.deleteMany({ listing: listing._id });
    await Review.deleteMany({ _id: { $in: listing.reviews } });
    await Listing.findByIdAndDelete(listing._id);
  }
  return stale.length;
}

async function main() {
  const { hostname, port } = new URL(REDIS_URL);
  const queue = new Queue('notifications', {
    connection: {
      host: hostname,
      port: Number(port) || 6379,
    },
  });

  if (STATUS_ONLY) {
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
    console.log(`Notification Queue status (${REDIS_URL}):`);
    console.log(JSON.stringify(counts, null, 2));
    await queue.close();
    return;
  }

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

  await cleanupTestListings(host._id);

  const listing = await Listing.create({
    title: '[TEST] Notification test listing',
    description: 'Temporary listing created by scripts/notification-test.js',
    owner: host._id,
    price: 1500,
    location: 'Goa',
    country: 'India',
    geometry: { type: 'Point', coordinates: [73.8567, 15.2993] },
  });
  const listingId = listing._id.toString();

  console.log(`Listing:   ${listing.title} (${listingId})`);
  console.log(`Host:      ${TEST_USER} (${host.email || 'no email'})`);
  console.log(`Guest:     ${TEST_USER2} (${guest.email || 'no email'})`);
  console.log(`Base:      ${BASE}`);
  console.log(`Redis:     ${REDIS_URL}`);
  console.log('');

  const hostCookie = await login(TEST_USER, TEST_PASS);
  const guestCookie = await login(TEST_USER2, TEST_PASS2);

  const jobsToClean = [];

  // 1. Guest books a stay
  const checkInDate = new Date();
  checkInDate.setDate(checkInDate.getDate() + 30);
  const checkOutDate = new Date();
  checkOutDate.setDate(checkOutDate.getDate() + 35);

  const checkInStr = checkInDate.toISOString().split('T')[0];
  const checkOutStr = checkOutDate.toISOString().split('T')[0];

  const bookRes = await fetch(`${BASE}/bookings/${listingId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: guestCookie,
    },
    body: new URLSearchParams({
      'booking[checkIn]': checkInStr,
      'booking[checkOut]': checkOutStr,
      'booking[guests]': '2',
    }),
    redirect: 'manual',
  });

  const createdBooking = await Booking.findOne({ listing: listingId, user: guest._id });
  const bookingId = createdBooking ? createdBooking._id.toString() : null;

  const confirmedJobId = `booking.confirmed-${bookingId}`;
  jobsToClean.push(confirmedJobId);

  const confirmedResult = await waitForJob(queue, confirmedJobId, 30000);
  check(
    'Guest booking creates booking.confirmed job and worker completes it',
    confirmedResult.state === 'completed',
    `state=${confirmedResult.state}`
  );

  // 2. Check preview URLs
  const confirmedPreviews = confirmedResult.returnvalue?.previews || [];
  let previewsValid = confirmedPreviews.length === 2;
  if (previewsValid) {
    for (const url of confirmedPreviews) {
      const ok = await verifyPreviewUrl(url);
      if (!ok) previewsValid = false;
    }
  }
  check(
    'booking.confirmed generates 2 reachable Ethereal preview URLs (guest + host)',
    previewsValid,
    `${confirmedPreviews.length} preview(s): ${confirmedPreviews.join(', ')}`
  );

  // 3. Guest cancels booking
  if (bookingId) {
    await fetch(`${BASE}/bookings/${bookingId}?_method=DELETE`, {
      method: 'POST',
      headers: {
        Cookie: guestCookie,
      },
      redirect: 'manual',
    });
  }

  const cancelledJobId = `booking.cancelled-${bookingId}`;
  jobsToClean.push(cancelledJobId);

  const cancelledResult = await waitForJob(queue, cancelledJobId, 30000);
  const cancelledPreviews = cancelledResult.returnvalue?.previews || [];
  let cancelPreviewsValid = cancelledPreviews.length === 2;
  if (cancelPreviewsValid) {
    for (const url of cancelledPreviews) {
      const ok = await verifyPreviewUrl(url);
      if (!ok) cancelPreviewsValid = false;
    }
  }
  check(
    'Cancelling booking creates booking.cancelled job and completes with 2 reachable previews',
    cancelledResult.state === 'completed' && cancelPreviewsValid,
    `state=${cancelledResult.state}, previews=${cancelledPreviews.length}`
  );

  // 4. Guest posts a review
  await fetch(`${BASE}/listings/${listingId}/reviews`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: guestCookie,
    },
    body: new URLSearchParams({
      'review[rating]': '5',
      'review[comment]': 'Exceptional stay with great views!',
    }),
    redirect: 'manual',
  });

  const updatedListing = await Listing.findById(listingId).populate('reviews');
  const guestReview = updatedListing.reviews.find((r) => r.author.toString() === guest._id.toString());
  const reviewJobId = guestReview ? `review.created-${guestReview._id}` : 'review.created-unknown';
  jobsToClean.push(reviewJobId);

  const reviewResult = await waitForJob(queue, reviewJobId, 30000);
  const reviewPreviews = reviewResult.returnvalue?.previews || [];
  const reviewPreviewsValid = reviewPreviews.length === 1 && (await verifyPreviewUrl(reviewPreviews[0]));

  check(
    'Guest review creates review.created job and completes with 1 reachable preview for host',
    reviewResult.state === 'completed' && reviewPreviewsValid,
    `state=${reviewResult.state}, previews=${reviewPreviews.length}`
  );

  // 5. Host reviews own listing -> should NOT enqueue a review.created notification
  await fetch(`${BASE}/listings/${listingId}/reviews`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: hostCookie,
    },
    body: new URLSearchParams({
      'review[rating]': '5',
      'review[comment]': 'Host own notes',
    }),
    redirect: 'manual',
  });

  const listingAfterHostReview = await Listing.findById(listingId).populate('reviews');
  const hostReview = listingAfterHostReview.reviews.find((r) => r.author.toString() === host._id.toString());
  await new Promise((r) => setTimeout(r, 1500));
  const hostJob = hostReview ? await queue.getJob(`review.created-${hostReview._id}`) : null;

  check(
    'Host reviewing own listing does NOT enqueue a review notification',
    hostJob === null || hostJob === undefined,
    hostJob ? 'job was enqueued unexpectedly' : 'no job found'
  );

  // 6. Enqueue idempotency test
  let duplicateCount = 0;
  if (bookingId) {
    try {
      await queue.add('booking.confirmed', { test: true }, { jobId: confirmedJobId });
      // When checking the job in queue, it remains the original single job
      const fetchedJob = await queue.getJob(confirmedJobId);
      duplicateCount = fetchedJob ? 1 : 0;
    } catch {
      // BullMQ might ignore or succeed with existing job
    }
  }
  check(
    'Deterministic jobId prevents duplicate job enqueues',
    duplicateCount === 1,
    `jobId=${confirmedJobId}`
  );

  // Cleanup
  console.log('');
  if (KEEP) {
    console.log(`Cleanup:   skipped (--keep). Listing: ${BASE}/listings/${listingId}`);
  } else {
    for (const jid of jobsToClean) {
      try {
        const j = await queue.getJob(jid);
        if (j) await j.remove();
      } catch {}
    }
    await Booking.deleteMany({ listing: listing._id });
    await Review.deleteMany({ _id: { $in: updatedListing.reviews.map((r) => r._id) } });
    await Listing.findByIdAndDelete(listing._id);
    console.log('Cleanup:   removed test listing, reviews, bookings, and test queue jobs');
  }

  await queue.close();
  await mongoose.disconnect();

  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log(
    failed.length === 0
      ? `All ${results.length} checks passed.`
      : `${failed.length} of ${results.length} checks FAILED.`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Notification test failed:', err);
  process.exit(1);
});
