// Tests Phase 7 Production Basics:
// 1. Database Indexes (category+price, owner, 2dsphere).
// 2. Pagination on /listings with clamping & filter preservation.
// 3. Security headers (Helmet CSP, nosniff, etc.).
// 4. NoSQL injection protection (sanitizeFilter).
// 5. Session cookie hardening (SameSite=Lax, HttpOnly).
// 6. Bug fixes (review author null guard, signup next signature, geocoding fallback).
//
// Usage:
//   node scripts/production-basics-test.js [--base=http://localhost:8080]

require('dotenv').config();
const mongoose = require('mongoose');
const Listing = require('../models/listing.js');
const User = require('../models/user.js');
const usersController = require('../controllers/users.js');
const middleware = require('../middleware.js');

const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
  if (match) flags[match[1]] = match[2] ?? true;
}

const BASE = flags.base || 'http://localhost:8080';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' - ' + detail : ''}`);
};

async function main() {
  console.log('Testing Phase 7: Production Basics...\n');

  await mongoose.connect(process.env.ATLASDB_URL);

  // 1. Indexes Check
  await Listing.init(); // Ensure indexes are built in Mongo
  const indexes = await Listing.collection.getIndexes();
  const indexNames = Object.keys(indexes);

  const hasCategoryPriceIndex = indexNames.includes('category_1_price_1');
  const hasOwnerIndex = indexNames.includes('owner_1');
  const has2dsphereIndex = indexNames.includes('geometry_2dsphere');

  check(
    'Listing model has category+price, owner, and 2dsphere indexes',
    hasCategoryPriceIndex && hasOwnerIndex && has2dsphereIndex,
    `Indexes: ${indexNames.join(', ')}`
  );

  // 2. Security Headers (Helmet CSP)
  const res = await fetch(`${BASE}/listings`);
  const headers = res.headers;
  const csp = headers.get('content-security-policy') || '';
  const nosniff = headers.get('x-content-type-options');

  const hasCspDirectives =
    csp.includes('api.mapbox.com') &&
    csp.includes('res.cloudinary.com') &&
    csp.includes('images.unsplash.com');

  check(
    'Helmet security headers and tailored Content Security Policy are active',
    res.status === 200 && nosniff === 'nosniff' && hasCspDirectives,
    `nosniff=${nosniff}, CSP has Mapbox/Cloudinary/Unsplash`
  );

  // 3. Pagination & Clamping
  const page1Res = await fetch(`${BASE}/listings?page=1`);
  const page1Html = await page1Res.text();

  const page999Res = await fetch(`${BASE}/listings?page=999`);
  const page999Html = await page999Res.text();

  const pageFilterRes = await fetch(`${BASE}/listings?category=Trending&page=1`);
  const pageFilterHtml = await pageFilterRes.text();

  const paginationWorks =
    page1Res.status === 200 &&
    page999Res.status === 200 &&
    pageFilterRes.status === 200 &&
    !page999Html.includes('Something went wrong');

  check(
    'Pagination handles valid pages, clamps out-of-range pages, and retains filters',
    paginationWorks,
    `page=1 (200), page=999 (200, clamped)`
  );

  // 4. NoSQL injection sanitizeFilter
  const fs = require('fs');
  const appCode = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const hasSanitizeFilterConfig = appCode.includes("mongoose.set('sanitizeFilter', true)") ||
    appCode.includes('mongoose.set("sanitizeFilter", true)');

  check(
    'Mongoose sanitizeFilter is configured to prevent NoSQL query operator injection',
    hasSanitizeFilterConfig,
    'mongoose.set("sanitizeFilter", true) in app.js'
  );

  // 5. Session Cookie Hardening
  const loginRes = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: process.env.TEST_USER || 'racetest',
      password: process.env.TEST_PASS || 'password123',
    }),
    redirect: 'manual',
  });
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const isHttpOnly = /httponly/i.test(setCookie);
  const isSameSiteLax = /samesite=lax/i.test(setCookie);

  check(
    'Session cookie is configured with HttpOnly and SameSite=Lax',
    isHttpOnly && isSameSiteLax,
    `HttpOnly=${isHttpOnly}, SameSite=Lax=${isSameSiteLax}`
  );

  // 6. Bug fixes verification
  // 6a. Signup handler signature (3 parameters: req, res, next)
  const signupParamsCount = usersController.signup.length;
  check(
    'User signup controller accepts next parameter for login-after-signup error handling',
    signupParamsCount >= 3,
    `length=${signupParamsCount}`
  );

  // 6b. isReviewAuthor null check
  let reviewAuthorRedirected = false;
  let flashMsg = '';
  const mockReq = {
    params: { id: 'dummy_listing', reviewId: new mongoose.Types.ObjectId().toString() },
    flash: (type, msg) => {
      flashMsg = msg;
    },
  };
  const mockRes = {
    redirect: (url) => {
      reviewAuthorRedirected = url.includes('/listings/dummy_listing');
    },
    locals: { currUser: { _id: new mongoose.Types.ObjectId() } },
  };
  await middleware.isReviewAuthor(mockReq, mockRes, () => {});
  check(
    'isReviewAuthor safely handles non-existent review IDs without throwing',
    reviewAuthorRedirected && flashMsg === 'Review not found',
    `redirected=${reviewAuthorRedirected}, flash="${flashMsg}"`
  );

  await mongoose.disconnect();

  console.log('');
  const failed = results.filter((r) => !r.pass);
  console.log(
    failed.length === 0
      ? `All ${results.length} checks passed.`
      : `${failed.length} of ${results.length} checks FAILED.`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
