// Fires N concurrent booking requests for the same listing and the same
// dates, then checks how many bookings actually landed in MongoDB.
//
// Usage:
//   node scripts/race-test.js [listingId] [--n=10] [--base=http://localhost:8080] [--keep]
//
// Needs TEST_USER / TEST_PASS in .env (a real signed-up user — see the
// Phase 3 implementation plan for how one was created).

require('dotenv').config();
const mongoose = require('mongoose');
const Listing = require('../models/listing.js');
const Booking = require('../models/booking.js');

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (const arg of args) {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
  if (match) flags[match[1]] = match[2] ?? true;
  else positional.push(arg);
}

const N = Number(flags.n) || 10;
const BASE = flags.base || 'http://localhost:8080';
const KEEP = Boolean(flags.keep);
const LISTING_ID_ARG = positional[0];

const TEST_USER = process.env.TEST_USER;
const TEST_PASS = process.env.TEST_PASS;

const pad = (n) => String(n).padStart(2, '0');
// Build the YYYY-MM-DD string from LOCAL date parts (not toISOString, which
// converts to UTC first and can shift the calendar day depending on the
// machine's timezone). This has to match what an <input type="date"> sends.
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The server stores checkIn/checkOut as `new Date(req.body.booking.checkIn)`,
// i.e. parsed FROM the "YYYY-MM-DD" string (UTC midnight). To find the same
// rows again for the DB check and cleanup, we must parse the same way here —
// not reuse the local-midnight Date objects the strings were built from,
// which differ from UTC midnight by the local timezone offset.
const wireDate = (str) => new Date(str);

function randomFutureDates() {
  // 300-700 days out: far enough that it can never collide with a real
  // booking or a previous test run, and never in the past.
  const daysOut = 300 + Math.floor(Math.random() * 400);
  const checkIn = new Date();
  checkIn.setHours(0, 0, 0, 0);
  checkIn.setDate(checkIn.getDate() + daysOut);
  const checkOut = new Date(checkIn);
  checkOut.setDate(checkOut.getDate() + 2);
  return { checkInStr: fmt(checkIn), checkOutStr: fmt(checkOut) };
}

async function login() {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: TEST_USER, password: TEST_PASS }),
    redirect: 'manual',
  });
  const location = res.headers.get('location') || '';
  const cookies = res.headers.getSetCookie();
  if (!location.includes('/listings') || cookies.length === 0) {
    throw new Error(
      `Login failed (redirected to "${location}"). Check TEST_USER/TEST_PASS in .env.`
    );
  }
  // Only the session cookie matters; forward it as-is on every booking request.
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

async function fireBooking(cookie, listingId, checkInStr, checkOutStr) {
  const started = Date.now();
  const res = await fetch(`${BASE}/bookings/${listingId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
    },
    body: new URLSearchParams({
      'booking[checkIn]': checkInStr,
      'booking[checkOut]': checkOutStr,
      'booking[guests]': '1',
    }),
    redirect: 'manual',
  });
  return {
    status: res.status,
    location: res.headers.get('location') || '',
    instance: res.headers.get('x-instance-id') || '(none)',
    ms: Date.now() - started,
  };
}

async function main() {
  if (!TEST_USER || !TEST_PASS) {
    console.error('Set TEST_USER and TEST_PASS in .env first (a real signed-up user).');
    process.exit(1);
  }

  await mongoose.connect(process.env.ATLASDB_URL);

  let listing;
  if (LISTING_ID_ARG) {
    listing = await Listing.findById(LISTING_ID_ARG);
    if (!listing) {
      console.error(`No listing found with id ${LISTING_ID_ARG}`);
      process.exit(1);
    }
  } else {
    listing = await Listing.findOne();
    if (!listing) {
      console.error('No listings in the database. Run node init/index.js first, or pass a listingId.');
      process.exit(1);
    }
  }

  const { checkInStr, checkOutStr } = randomFutureDates();
  const checkIn = wireDate(checkInStr);
  const checkOut = wireDate(checkOutStr);

  console.log(`Listing:   ${listing.title} (${listing._id})`);
  console.log(`Dates:     ${checkInStr} -> ${checkOutStr}`);
  console.log(`Sent:      ${N} concurrent requests to ${BASE}`);

  const cookie = await login();

  const results = await Promise.all(
    Array.from({ length: N }, () => fireBooking(cookie, listing._id, checkInStr, checkOutStr))
  );

  const succeeded = results.filter((r) => r.location.includes('/bookings')).length;
  const rejected = results.length - succeeded;
  console.log(`Responses: ${succeeded} -> /bookings (success)   ${rejected} -> /listings/... (rejected)`);

  const byInstance = {};
  for (const r of results) byInstance[r.instance] = (byInstance[r.instance] || 0) + 1;
  const instanceSummary = Object.entries(byInstance)
    .map(([id, count]) => `${id} x${count}`)
    .join(', ');
  console.log(`Instances: ${instanceSummary}`);

  const count = await Booking.countDocuments({
    listing: listing._id,
    checkIn,
    checkOut,
  });

  const verdict = count === 1 ? '✅ SAFE' : '❌ DOUBLE BOOKING';
  console.log(`DB check:  ${count} booking(s) exist for these dates  ${verdict}`);

  if (!KEEP) {
    const { deletedCount } = await Booking.deleteMany({
      listing: listing._id,
      checkIn,
      checkOut,
    });
    console.log(`Cleanup:   removed ${deletedCount} test booking(s) (pass --keep to skip this)`);
  } else {
    console.log('Cleanup:   skipped (--keep)');
  }

  await mongoose.disconnect();
  process.exit(count === 1 ? 0 : 1);
}

main().catch((err) => {
  console.error('Race test failed:', err);
  process.exit(1);
});
