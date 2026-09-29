const Listing = require('../models/listing.js'); // Import the Listing model
const Booking = require('../models/booking.js'); // Booking model (used to show owner bookings)
const User = require('../models/user.js'); // User model (used to resolve guest names for chat)
const messageStore = require('../services/messageStore'); // Chat message storage (owner's guest list)
const mongoose = require('mongoose');
const mbxGeocoding = require('@mapbox/mapbox-sdk/services/geocoding');
const mapToken = process.env.MAP_TOKEN;
const geoCodingClient = mbxGeocoding({ accessToken: mapToken });
const { getOrSet, invalidateListingsCache, LISTINGS_INDEX_PREFIX } = require('../utils/cache.js');
const ExpressError = require('../utils/ExpressError.js');

const LISTINGS_CACHE_TTL = 60; // seconds
const PAGE_SIZE = 12; // 12 listings per page

const FILTER_CATEGORIES = [
  'Trending',
  'Rooms',
  'Iconic Cities',
  'Mountains',
  'Castles',
  'Beachfront',
  'Lakefront',
  'Luxury',
  'Historic Stays',
  'Amazing Pools',
  'Camping',
  'Farms'
];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const avgRating = (reviews = []) =>
  reviews.length ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length : 0;

const SORT_OPTIONS = {
  priceAsc: { price: 1 },
  priceDesc: { price: -1 },
  newest: { _id: -1 },
};

module.exports.index = (async (req, res) => {
  const q = (req.query.q || "").trim().slice(0, 100);
  const selectedCategory = (req.query.category || "").trim();
  const minPrice = (req.query.minPrice || "").trim();
  const maxPrice = (req.query.maxPrice || "").trim();
  const sort = (req.query.sort || "").trim();
  const query = {};

  if (q) {
    const safePattern = new RegExp(escapeRegex(q), "i");
    query.$or = mongoose.trusted([
      { title: safePattern },
      { location: safePattern },
      { country: safePattern },
      { description: safePattern }
    ]);
  }

  if (FILTER_CATEGORIES.includes(selectedCategory)) {
    query.category = selectedCategory;
  }

  const min = Number(minPrice);
  const max = Number(maxPrice);
  const priceFilter = {};
  if (minPrice !== "" && !Number.isNaN(min)) {
    priceFilter.$gte = min;
  }
  if (maxPrice !== "" && !Number.isNaN(max)) {
    priceFilter.$lte = max;
  }
  if (Object.keys(priceFilter).length > 0) {
    query.price = mongoose.trusted(priceFilter);
  }

  // Count total matching listings for pagination
  const totalCount = await Listing.countDocuments(query);
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const requestedPage = parseInt(req.query.page, 10) || 1;
  const currentPage = Math.min(Math.max(1, requestedPage), totalPages);

  // Normalised cache key: includes all filters and current page
  const cacheKey = LISTINGS_INDEX_PREFIX + [
    `q=${q.toLowerCase()}`,
    `cat=${query.category || ''}`,
    `min=${query.price?.$gte ?? ''}`,
    `max=${query.price?.$lte ?? ''}`,
    `sort=${SORT_OPTIONS[sort] ? sort : ''}`,
    `page=${currentPage}`,
  ].join('|');

  const { data: listings, hit } = await getOrSet(cacheKey, LISTINGS_CACHE_TTL, () => {
    let cursor = Listing.find(query)
      .populate({ path: "reviews", select: "rating" })
      .skip((currentPage - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean();
    if (SORT_OPTIONS[sort]) {
      cursor = cursor.sort(SORT_OPTIONS[sort]);
    }
    return cursor;
  });
  res.set("X-Cache", hit ? "HIT" : "MISS");

  res.render("listings/index", {
    listings,
    searchQuery: q,
    selectedCategory,
    minPrice,
    maxPrice,
    sort,
    categories: FILTER_CATEGORIES,
    avgRating,
    currentPage,
    totalPages,
    totalCount,
    hasPrevPage: currentPage > 1,
    hasNextPage: currentPage < totalPages,
  });
});

module.exports.renderNewForm = (async (req, res) => {
  res.render('listings/new.ejs');
});

module.exports.showListing = (async (req, res) => {
  const listing = await Listing.findById(req.params.id).populate({
    path: "reviews",
    populate: {
      path: "author",
    },
  }).populate("owner");

  if (!listing) {
    req.flash('error', 'Listing not found in the database');
    return res.redirect('/listings');
  }

  let ownerBookings = null;
  let conversations = null;
  const isOwnerViewing = res.locals.currUser && listing.owner &&
    listing.owner._id.equals(res.locals.currUser._id);
  if (isOwnerViewing) {
    ownerBookings = await Booking.find({ listing: listing._id }).populate("user");

    const threads = await messageStore.listConversations(listing._id);
    if (threads && threads.length > 0) {
      const guestIds = threads.map((t) => t.guestId).filter(Boolean);
      const guests = await User.find({ _id: mongoose.trusted({ $in: guestIds }) }).select('username');
      const nameById = new Map(guests.map((g) => [g._id.toString(), g.username]));
      conversations = threads.map((t) => ({ ...t, guestName: nameById.get(t.guestId) || 'guest' }));
    } else {
      conversations = [];
    }
  }
  res.render('listings/show', { listing, mapToken, avgRating, isOwnerViewing, ownerBookings, conversations });
});

module.exports.createListing = (async (req, res, next) => {
  let response = await geoCodingClient.forwardGeocode({
    query: req.body.listing.location,
    limit: 1
  }).send();

  if (!response.body.features || response.body.features.length === 0) {
    req.flash('error', 'Location not found. Please provide a valid location.');
    return res.redirect('/listings/new');
  }

  if (!req.body.listing) {
    throw new ExpressError(400, 'Listing data is required');
  }

  const newListing = new Listing(req.body.listing);
  newListing.owner = req.user._id;
  const cover = req.files?.['listing[image][url]']?.[0];
  if (cover) {
    newListing.image = {
      url: cover.path,
      filename: cover.filename,
    };
  }
  const gallery = req.files?.['images'] || [];
  newListing.images = gallery.map(f => ({ url: f.path, filename: f.filename }));
  newListing.geometry = response.body.features[0].geometry;

  await newListing.save();
  await invalidateListingsCache(); // so /listings shows the new listing right away
  req.flash('success', 'Listing created successfully!');
  res.redirect('/listings');
});

module.exports.renderEditForm = (async (req, res) => {
  const listing = await Listing.findById(req.params.id);
  if (!listing) {
    req.flash('error', 'Listing not found');
    return res.redirect('/listings');
  }
  let originalImageUrl = listing.image.url;
  originalImageUrl = originalImageUrl.replace("/upload", "/upload/h_300,w_250");
  res.render('listings/edit.ejs', { listing, originalImageUrl });
});

module.exports.updateListing = (async (req, res) => {
  let { id } = req.params;
  await Listing.findByIdAndUpdate(id, { ...req.body.listing });
  const cover = req.files?.['listing[image][url]']?.[0];
  const gallery = req.files?.['images'] || [];
  if (cover || gallery.length) {
    let listing = await Listing.findById(id);
    if (cover) {
      listing.image = {
        url: cover.path,
        filename: cover.filename,
      };
    }
    if (gallery.length) {
      listing.images = gallery.map(f => ({ url: f.path, filename: f.filename }));
    }
    await listing.save();
  }
  await invalidateListingsCache();

  req.flash('success', 'Listing updated successfully!');
  res.redirect(`/listings/${id}`);
});

module.exports.destroyListing = (async (req, res) => {
  const { id } = req.params;
  await Listing.findByIdAndDelete(id);
  await invalidateListingsCache();
  req.flash('success', 'Listing deleted successfully!');
  res.redirect('/listings');
});