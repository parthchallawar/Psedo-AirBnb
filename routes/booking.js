const express = require('express');
const router = express.Router();
const wrapAsync = require('../utils/wrapAsync.js');
const { isLoggedIn, validateBooking, isBookingOwner } = require('../middleware.js');
const bookingsController = require('../controllers/bookings.js');

router.get("/", isLoggedIn, wrapAsync(bookingsController.myTrips)); // My Trips

router.post("/:listingId", isLoggedIn, validateBooking, wrapAsync(bookingsController.createBooking));

router.delete("/:bookingId", isLoggedIn, isBookingOwner, wrapAsync(bookingsController.cancelBooking));

module.exports = router;
