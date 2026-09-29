# Phase 7 — Implementation Plan: Production Basics (Indexes, Pagination, Security, Cleanup)

Spec: [docs/specs/phase-7-production-basics.md](../specs/phase-7-production-basics.md)

---

## Decisions & Design Notes

| # | Decision | Why |
|---|---|---|
| D1 | Compound index `{ category: 1, price: 1 }`, owner index `{ owner: 1 }`, and 2dsphere index `{ geometry: "2dsphere" }` on Listing | Category and price filters on `/listings` can utilize index scan (`IXSCAN`) instead of full collection scan (`COLLSCAN`). The 2dsphere index enables spatial queries. |
| D2 | Pagination with `PAGE_SIZE = 12` and clamp logic | Keeps payload sizes small and predictable while preventing crashes or blank pages on invalid/excessive page numbers. |
| D3 | Cache key incorporates normalized `page` (`|page=N`) | Preserves Phase 1 Redis caching performance without returning wrong page slices for different pagination requests. |
| D4 | `helmet()` with tailored Content Security Policy (CSP) | Protects against XSS, clickjacking, and MIME sniffing while explicitly allowing Bootstrap CDN, Font Awesome, Google Fonts, Mapbox GL JS/tiles/events, Cloudinary, and Socket.IO WebSockets. |
| D5 | `mongoose.set("sanitizeFilter", true)` | Prevents NoSQL injection by treating query operator payloads (like `{"$gt": ""}`) in user inputs as literal string values. |
| D6 | Session cookie hardening (`sameSite: "lax"`, `secure: production`) | Protects session cookies from CSRF in cross-site requests and forces HTTPS in production. |
| D7 | Code hygiene & bug fixes | Fixes `next` parameter in `users.js` signup, adds null guard in `isReviewAuthor`, removes dead validation copies in `app.js` and `routes/`, removes debug console logs, and handles geocoding zero-results gracefully. |

---

## Step 0 — Dependencies
- Install `helmet` in root `package.json`.

## Step 1 — Database Indexes (`models/listing.js`)
- Add `listingSchema.index({ category: 1, price: 1 });`
- Add `listingSchema.index({ owner: 1 });`
- Add `listingSchema.index({ geometry: "2dsphere" });`

## Step 2 — Pagination (`controllers/listing.js` & `views/listings/index.ejs`)
- In `controllers/listing.js` `index`:
  - Extract `page = Math.max(1, parseInt(req.query.page, 10) || 1)`.
  - Calculate total listings matching `query` and compute `totalPages`.
  - Clamp requested `page` to `[1, totalPages]`.
  - Include `page` in Redis cache key.
  - Apply `.skip((currentPage - 1) * 12).limit(12)` in query.
  - Pass pagination metadata (`currentPage`, `totalPages`, `totalCount`, `hasPrevPage`, `hasNextPage`) to template.
- In `views/listings/index.ejs`:
  - Add pagination component with Previous/Next controls and page indicators, preserving active filters (`q`, `category`, `minPrice`, `maxPrice`, `sort`).

## Step 3 — Security Headers & Cookie Hardening (`app.js`)
- Import `helmet` and configure `helmet.contentSecurityPolicy` directives:
  - `defaultSrc: ["'self'"]`
  - `scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://api.mapbox.com", "https://cdnjs.cloudflare.com"]`
  - `styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://api.mapbox.com"]`
  - `fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"]`
  - `imgSrc: ["'self'", "data:", "blob:", "https://res.cloudinary.com", "https://images.unsplash.com", "https://*.tiles.mapbox.com", "https://api.mapbox.com"]`
  - `connectSrc: ["'self'", "https://api.mapbox.com", "https://events.mapbox.com", "https://*.tiles.mapbox.com", "ws:", "wss:"]`
  - `workerSrc: ["'self'", "blob:"]`
  - `objectSrc: ["'none'"]`
- Add `mongoose.set('sanitizeFilter', true)` before MongoDB connection.
- Update `sessionOptions.cookie`:
  - `sameSite: 'lax'`
  - `secure: process.env.NODE_ENV === 'production'`

## Step 4 — Bug Fixes & Code Cleanup
- **`controllers/users.js`**: Update `signup` signature to `(req, res, next) => ...`. Remove debug `console.log(registeredUser)`.
- **`middleware.js`**:
  - In `isReviewAuthor`, add null check for `review` with flash message and redirect.
  - Export unified `validateReview` using `reviewSchema`.
  - Remove debug `console.log(req.path, "..", req.originalUrl)`.
- **`routes/review.js`**: Remove dead `validateListing` and `validateReview` definitions; import `validateReview` from `middleware.js`.
- **`routes/listing.js`**: Remove dead `validateReview` definition.
- **`app.js`**: Remove duplicate `validateListing` and `validateReview` definitions.
- **`controllers/listing.js`**:
  - In `createListing`, check `response.body.features?.[0]`. If missing, flash `'Location not found. Please enter a valid location.'` and redirect to `/listings/new`.
  - Remove leftover debug `console.log` statements across controllers.

## Step 5 — Automated Test Script (`scripts/production-basics-test.js`)
- Test and verify:
  1. Index definitions on `Listing` model.
  2. Pagination logic, clamping, and URL parameter retention.
  3. Security response headers (CSP, X-Content-Type-Options, etc.).
  4. Mongoose `sanitizeFilter` configuration.
  5. Session cookie security flags (`SameSite=Lax`, `HttpOnly`).
  6. Bug fixes (missing location error handling, review author guard, signup next handler).

## Step 6 — Documentation (`CLAUDE.md`)
- Update `CLAUDE.md` to document Phase 7 features, pagination parameters, security headers, indexes, and clean up the "Known quirks" section.
