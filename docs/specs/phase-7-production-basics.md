# Phase 7 — Production Basics (Indexes, Pagination, Security, Cleanup)

## 1. Goal

A small set of backend essentials that interviewers expect in any serious project. Each item is
short and independent, so this phase can be done at any time.

## 2. Concepts (keep to these)

| Concept | One-line explanation |
|---|---|
| **Database index** | A sorted lookup structure that turns a full collection scan into a quick search. |
| **Pagination** | Return results in pages instead of everything at once. |
| **Security headers** | HTTP headers that tell the browser to block common attacks (clickjacking, sniffing, unsafe scripts). |
| **NoSQL injection** | Attacker sends `{ "$gt": "" }` instead of a string to change a query's meaning. |

## 3. Scope and design

### 3.1 Indexes — `models/listing.js`, `models/booking.js`

| Model | Index | Serves |
|---|---|---|
| Listing | `{ category: 1, price: 1 }` | category + price filters on `/listings` |
| Listing | `{ owner: 1 }` | profile page "my listings" |
| Listing | `{ geometry: "2dsphere" }` | geo queries (future "near me"). Required for any `$near` query |
| Booking | `{ listing: 1, checkIn: 1, checkOut: 1 }`, `{ user: 1 }` | already added in Phase 3 |

Verify with `.explain("executionStats")`: the winning plan should be `IXSCAN`, not `COLLSCAN`.
The regex text search (`q`) can't use a normal index. Mention that a text index or Atlas Search is
the next step, but don't implement it.

### 3.2 Pagination — `controllers/listing.js` `index` + `views/listings/index.ejs`
- `?page=N` (default 1). Page size 12.
- The query adds `.skip((page-1)*12).limit(12)`, plus a `countDocuments(query)` for the total.
- **The Phase 1 cache key must include `page`** (`|page=N`).
- The view shows Previous / Next links that keep all current filters in the URL.
- Invalid or too-large page numbers clamp to a valid range.

### 3.3 Security headers — `app.js`
- `helmet()` mounted first.
- Configure `contentSecurityPolicy.directives` to allow only the external sources the app actually
  loads: check `views/layouts/boilerplate.ejs` and `show.ejs` at implementation time (Bootstrap and
  Font Awesome CDNs, Google Fonts, `api.mapbox.com`, `*.tiles.mapbox.com`, `events.mapbox.com`,
  `res.cloudinary.com`, `images.unsplash.com`, and `ws:` / `wss:` for Socket.IO).
- Acceptance: no CSP errors in the browser console on any page.

### 3.4 NoSQL injection — `app.js`
- `mongoose.set("sanitizeFilter", true)` before connecting. Mongoose then wraps any object that
  contains `$` operators in user input, so it's treated as a literal value.
- (`express-mongo-sanitize` isn't compatible with Express 5's read-only `req.query`, which is why
  Mongoose's built-in option is used.)

### 3.5 Session cookie hardening — `app.js` session options
- `sameSite: "lax"` (basic CSRF protection for cross-site POSTs).
- `secure: true` only when `NODE_ENV === "production"` (HTTPS).

### 3.6 Bug fixes found while reading the code

| Bug | File | Fix |
|---|---|---|
| `signup` calls `next(err)` but `next` isn't a parameter, so it crashes if login-after-signup fails | `controllers/users.js` | add `next` to the handler signature |
| `isReviewAuthor` crashes if the review doesn't exist (`review.author` of null) | `middleware.js` | a null check plus a flash message and redirect |
| Unused `validateListing` referencing an undefined `listingSchema` | `routes/review.js` | delete the dead code |
| Duplicate `validateListing` / `validateReview` in `app.js` and `routes/listing.js` | `app.js`, `routes/listing.js` | delete them and use the `middleware.js` versions |
| Debug `console.log` of request bodies and whole listings | controllers, `middleware.js` | remove |
| `createListing` crashes when Mapbox finds no match (`features[0]` undefined) | `controllers/listing.js` | flash "Location not found" and redirect back to the form |
| CLAUDE.md "Known quirks" section is outdated | `CLAUDE.md` | update after this phase |

## 4. Files changed

`app.js`, `models/listing.js`, `controllers/listing.js`, `views/listings/index.ejs`,
`controllers/users.js`, `middleware.js`, `routes/review.js`, `routes/listing.js`, `CLAUDE.md`,
`package.json` (`helmet`).

## 5. Acceptance criteria

- [ ] `Listing.find({ category: "Castles" }).explain("executionStats")` shows `IXSCAN`.
- [ ] `/listings?page=2` shows the next 12 listings, filters survive paging, and `page=999` doesn't error.
- [ ] Response headers include `Content-Security-Policy`, `X-Content-Type-Options`, and so on. No CSP errors in the console on the index, show (with the map), new and edit pages.
- [ ] `POST /login` with `username[$gt]=` doesn't log anyone in.
- [ ] Each bug in 3.6 is fixed and verified by hand.

## 6. Interview explanation

**Two-minute version**
> "I added indexes that match the actual queries: a compound category-plus-price index for the
> filters, owner for the profile page, and a 2dsphere index for geo queries. I verified them with
> explain(), checking for IXSCAN rather than COLLSCAN. The listings page is paginated, and the page
> number is part of the cache key. For security: Helmet sets headers including a Content Security
> Policy that only allows the CDNs I actually use, Mongoose's sanitizeFilter blocks NoSQL injection
> such as `$gt` payloads, and the session cookie is httpOnly, SameSite=Lax, and secure in production.
> I also fixed several crash bugs I found reading the code."

**Likely questions**

| Question | Answer |
|---|---|
| Downsides of indexes? | Slower writes (every index is updated on insert) and more memory. Only index what queries use. |
| Why is compound index order `category, price`? | Equality fields first, range fields after. The index can then jump to the category and scan the price range in order. |
| Skip/limit vs cursor pagination? | `skip(N)` still walks N documents, so it gets slow on deep pages, and results shift when new items are inserted. Cursor pagination (`_id > lastSeenId`) is constant-time and stable, but can't jump to page 7. For a listings browser, skip/limit is fine. |
| What does CSP protect against? | XSS: even if an attacker injects a `<script>`, the browser refuses to run code from sources not on the allow-list. |
| What is NoSQL injection? | Sending an object such as `{"$ne": null}` where a string is expected, so `findOne({ username, password })` matches everything. |
