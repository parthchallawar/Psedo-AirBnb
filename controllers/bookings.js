const Booking = require('../models/booking.js'); // Booking model
const Listing = require('../models/listing.js'); // Listing model

module.exports.myTrips = (async (req, res) => {
  const bookings = await Booking.find({ user: req.user._id }).populate("listing");
  res.render("bookings/trips.ejs", { bookings });
});

module.exports.createBooking = (async (req, res) => {
  const { listingId } = req.params;
  const listing = await Listing.findById(listingId);
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

  const clash = await Booking.findOne({
    listing: listingId,
    checkIn: { $lt: checkOut },
    checkOut: { $gt: checkIn },
  });
  if (clash) {
    req.flash('error', 'Those dates are already booked.');
    return res.redirect(`/listings/${listingId}`);
  }

  const nights = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));
  const totalPrice = nights * listing.price;

  const booking = new Booking({
    listing: listingId,
    user: req.user._id,
    checkIn,
    checkOut,
    guests,
    totalPrice,
  });
  await booking.save();

  req.flash('success', 'Booking confirmed!');
  res.redirect('/bookings');
});

module.exports.cancelBooking = (async (req, res) => {
  const { bookingId } = req.params;
  await Booking.findByIdAndDelete(bookingId);
  req.flash('success', 'Booking cancelled.');
  res.redirect('/bookings');
});
