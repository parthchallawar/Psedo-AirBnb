# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Wanderlust ("Pseudo-AirBnb") — a server-rendered Express + MongoDB app for property
listings with authentication, reviews, image uploads, and map display. Views are EJS
templates rendered on the server; there is no separate frontend/API layer.

## Commands

There is no build step, linter, or test suite (the `npm test` script is a placeholder
that exits with an error).

```bash
node app.js          # Start the server on http://localhost:8080 (port is hardcoded)
node init/index.js   # Seed the DB — WIPES the listings collection, then re-inserts sample data
```

No auto-reload is configured; restart `node app.js` manually after changes (or run it
under `nodemon` if installed globally).

## Required environment (.env, loaded unless NODE_ENV=production)

The app will not start or function without these:

- `ATLASDB_URL` — MongoDB connection string (also used for the session store)
- `SECRET` — express-session + connect-mongo secret
- `CLOUD_NAME`, `CLOUD_API_KEY`, `CLOUD_API_SECRET` — Cloudinary (image uploads)
- `MAP_TOKEN` — Mapbox token (geocoding on create + map rendering on show page)

`init/index.js` falls back to `mongodb://127.0.0.1:27017/wanderlust` if `ATLASDB_URL`
is unset, but `app.js` has no such fallback.

## Architecture

Standard Express MVC. Request flow: `app.js` → router (`routes/`) → controller
(`controllers/`) → Mongoose model (`models/`) → EJS view (`views/`).

- **`app.js`** — Entry point. Connects Mongoose, configures ejs-mate as the EJS engine,
  sets up session (stored in Mongo via connect-mongo), connect-flash, and Passport.
  Mounts three routers and defines the final error-handling middleware that renders
  `views/error.ejs`.
- **`routes/`** — `listing.js` (`/listings`), `review.js` (`/listings/:id/reviews`,
  uses `mergeParams`), `user.js` (`/signup`, `/login`, `/logout`). Routers wire
  middleware (auth, upload, validation) to controller methods.
- **`controllers/`** — `listing.js`, `reviews.js`, `users.js`. Business logic lives here.
- **`models/`** — Mongoose schemas: `Listing`, `Review`, `User`.
- **`middleware.js`** — Auth/authorization guards: `isLoggedIn`, `isOwner`,
  `isReviewAuthor`, plus `saveRedirectUrl`.
- **`views/`** — `layouts/boilerplate.ejs` is the ejs-mate layout; `includes/` holds
  navbar/footer/flash partials; `listings/` and `users/` hold page templates.
- **`public/`** — Static assets. `js/map.js` reads Mapbox config + listing GeoJSON from
  data attributes injected into the show page and renders the map.
- **`utils/`** — `wrapAsync.js` (wraps async route handlers so rejections reach the
  error middleware) and `ExpressError.js` (custom error with `statusCode`).

### Data model relationships

- `Listing` has an `owner` (ref `User`), an array of `reviews` (ref `Review`), an
  `image` `{ url, filename }`, a `category` (enum), and GeoJSON `geometry`
  (`{ type: "Point", coordinates: [lng, lat] }`).
- `Listing` has a `post('findOneAndDelete')` hook that cascade-deletes its reviews —
  so **delete listings via `findByIdAndDelete` / `findOneAndDelete`** to keep reviews
  from being orphaned.
- `User` uses `passport-local-mongoose`, which adds `username`/hashed password fields;
  the schema itself only declares `email`.

### Cross-cutting patterns

- **Auth**: Passport local strategy. `res.locals.currUser`, `success`, and `error`
  (flash) are set globally in `app.js` and available in every view.
- **Authorization**: `isOwner` (listings) and `isReviewAuthor` (reviews) compare the
  resource's owner/author to `res.locals.currUser._id`.
- **Post-login redirect**: `isLoggedIn` stashes `req.originalUrl` in
  `req.session.redirectUrl`; `saveRedirectUrl` promotes it to `res.locals` before the
  login POST so the user returns to where they were.
- **Validation**: Joi schemas live in `schema.js` (`listingSchema`, `reviewSchema`).
  Note both wrap the payload under a top-level key (`listing` / `review`), matching the
  `listing[field]` form input naming.
- **Image uploads**: multer + `multer-storage-cloudinary` (`cloudConfig.js`). The file
  form field is `listing[image][url]`; the uploaded Cloudinary URL/filename overwrite
  the model's `image` object in the controller. Cloudinary folder: `wanderlust_DEV`.
- **Geocoding**: On create, the listing's `location` string is forward-geocoded via the
  Mapbox SDK and stored as `geometry`.

## Known quirks / gotchas

Be careful — this codebase has redundant and inconsistent middleware that is easy to
misread:

- **Listing validation is effectively disabled.** `validateListing` is defined multiple
  times: the real Joi-backed versions live in `app.js` and `middleware.js`, but the copy
  used by `routes/listing.js` (line ~22) is a **no-op that just logs and calls `next()`**.
  Creating a listing does not actually validate against `listingSchema`. If you need
  real validation, wire in the `middleware.js` `validateListing` (and note it also needs
  `listingSchema`/`ExpressError` imported there).
- `routes/review.js` defines an unused `validateListing` that references an undefined
  `listingSchema` — dead code; don't call it.
- Middleware order on the listing PUT/DELETE routes lists `isOwner` before `isLoggedIn`
  in places. Since `isOwner` reads `res.locals.currUser._id`, it depends on an
  authenticated user; prefer `isLoggedIn, isOwner` ordering when editing these routes.
- `Review`'s `createdAt` default is `Date.now()` (called once at module load), not
  `Date.now` — all reviews get the server's start time, not their creation time.
- `init/index.js` hardcodes a single `owner` ObjectId (`686a259adc83c042a4761937`) for
  all seeded listings; that user must exist for owner-based views to resolve.
- The server port (8080) and the error-render middleware ignore `statusCode` — every
  error renders `error.ejs` with a 200. Change `app.js` if you need proper status codes.
- Several handlers `console.log` request bodies and listings; these are debug leftovers.

## Conventions

- CommonJS (`require`/`module.exports`) throughout; Node engine pinned to v22.14.0.
- Controllers export methods as `module.exports.name = async (req, res) => {...}` and
  are attached to routes via `router.route(...)` chains wrapped in `wrapAsync`.
- Form inputs use bracket-nested names (`listing[title]`, `review[rating]`) so
  `express.urlencoded({ extended: true })` parses them into nested objects.
