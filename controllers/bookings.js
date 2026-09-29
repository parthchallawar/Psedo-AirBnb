const Booking = require('../models/booking.js'); // Booking model
const Listing = require('../models/listing.js'); // Listing model
const ExpressError = require('../utils/ExpressError.js');
const { withLock, LockBusyError, LockUnavailableError } = require('../utils/lock.js');
const { publishNotification } = require('../queues/notificationQueue.js');

module.exports.myTrips = (async (req, res) => {
  const bookings = await Booking.find({ user: req.user._id }).populate("listing");
  res.render("bookings/trips.ejs", { bookings });
});

module.exports.createBooking = (async (req, res) => {
  const { listingId } = req.params;
  const listing = await Listing.findById(listingId).populate('owner', 'username email');
  if (!listing) {
    req.flash('error', 'Listing not found');
    return res.redirect('/listings');
  }

  const checkIn = new Date(req.body.booking.checkIn);
  const checkOut = new Date(req.body.booking.checkOut);
  const guests = Number(req.body.booking.guests) || 1;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (checkIn < today) {
    req.flash('error', 'Check-in date cannot be in the past.');
    return res.redirect(`/listings/${listingId}`);
  }
  if (checkOut <= checkIn) {
    req.flash('error', 'Check-out date must be after check-in date.');
    return res.redirect(`/listings/${listingId}`);
  }

  const nights = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));
  const totalPrice = nights * listing.price;

  // Check-then-insert must be atomic per listing: without the lock, two
  // concurrent requests can both see "no clash" and both insert. The lock is
  // in Redis (not memory) so it holds across all app instances (Phase 2).
  let outcome;
  try {
    outcome = await withLock(`lock:booking:listing:${listingId}`, async () => {
      const clash = await Booking.findOne({
        listing: listingId,
        checkIn: { $lt: checkOut },
        checkOut: { $gt: checkIn },
      });
      if (clash) return { clash: true };

      const booking = new Booking({
        listing: listingId,
        user: req.user._id,
        checkIn,
        checkOut,
        guests,
        totalPrice,
      });
      await booking.save();
      return { booking };
    });
  } catch (err) {
    if (err instanceof LockBusyError) {
      req.flash('error', 'Someone else is booking this listing right now. Please try again.');
      return res.redirect(`/listings/${listingId}`);
    }
    if (err instanceof LockUnavailableError) {
      // Fail closed: without the lock we can't rule out a double booking.
      throw new ExpressError(503, 'Booking is temporarily unavailable. Please try again shortly.');
    }
    throw err;
  }

  if (outcome.clash) {
    req.flash('error', 'Those dates are already booked.');
    return res.redirect(`/listings/${listingId}`);
  }

  const { booking } = outcome;
  await publishNotification('booking.confirmed', {
    bookingId: booking._id.toString(),
    guestEmail: req.user.email,
    guestName: req.user.username,
    hostEmail: listing.owner?.email || null,
    hostName: listing.owner?.username || null,
    listingTitle: listing.title,
    checkIn: checkIn.toISOString(),
    checkOut: checkOut.toISOString(),
    guests,
    totalPrice,
  }, `booking.confirmed-${booking._id}`);

  req.flash('success', 'Booking confirmed!');
  res.redirect('/bookings');
});

module.exports.cancelBooking = (async (req, res) => {
  const { bookingId } = req.params;
  const booking = await Booking.findById(bookingId)
    .populate('user', 'username email')
    .populate({ path: 'listing', select: 'title owner', populate: { path: 'owner', select: 'username email' } });

  if (booking) {
    await Booking.findByIdAndDelete(bookingId);
    await publishNotification('booking.cancelled', {
      bookingId: booking._id.toString(),
      guestEmail: booking.user?.email || null,
      guestName: booking.user?.username || null,
      hostEmail: booking.listing?.owner?.email || null,
      listingTitle: booking.listing?.title || 'Listing',
      checkIn: booking.checkIn ? booking.checkIn.toISOString() : null,
      checkOut: booking.checkOut ? booking.checkOut.toISOString() : null,
    }, `booking.cancelled-${bookingId}`);
  }

  req.flash('success', 'Booking cancelled.');
  res.redirect('/bookings');
});

