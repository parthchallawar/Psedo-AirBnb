const { session } = require("passport");
const Listing = require("./models/listing.js"); // Import the Listing model
const Review = require("./models/review.js"); // Review model (used by isReviewAuthor)
const Booking = require("./models/booking.js"); // Booking model (used by isBookingOwner)
const { listingSchema, bookingSchema } = require("./schema.js"); // Joi schemas for validation
const ExpressError = require("./utils/ExpressError.js"); // Custom error class

module.exports.isLoggedIn = (req, res, next) => {
  console.log(req.path, "..", req.originalUrl); // Log the user object for debugging
  if (!req.isAuthenticated()) {
    if (!req.session.redirectUrl) {
      req.session.redirectUrl = req.originalUrl; // Store the original URL to redirect after login
    }
    req.flash('error', 'You must be logged in to do that');
    return res.redirect('/login'); // Redirect to login if not authenticated
  }
  next(); // Proceed to the next middleware or route handler
};

module.exports.saveRedirectUrl = (req, res, next) => {
  if (req.session.redirectUrl) {
    res.locals.redirectUrl = req.session.redirectUrl; // Make the redirect URL available in views
   
  }
  next();
};

module.exports.isOwner =async (req, res, next) => {
   let {id} = req.params;
  let listing = await Listing.findById(id);
  if (!listing) {
    req.flash("error", "Listing not found");
    return res.redirect("/listings");
  }
  if (!listing.owner.equals(res.locals.currUser._id)) {
    req.flash("error", "You do not have permission to edit this listing.");
    return res.redirect(`/listings/${id}`);
  }
  next();
};


module.exports.isReviewAuthor = async (req, res, next) => {
  let { id, reviewId } = req.params;
  let review = await Review.findById(reviewId);
  if (!review.author.equals(res.locals.currUser._id)) {
    req.flash("error", "You do not have permission to delete this review.");
    return res.redirect(`/listings/${id}`);
  }
  next();
};


module.exports.validateListing = (req, res, next) => {
    let { error } = listingSchema.validate(req.body); // Validate the listing data using Joi schema

  if (error) {
    let errorMessage = error.details.map(el => el.message).join(', ');
    throw new ExpressError(400, errorMessage);
  } else{
    next();
  }

};

module.exports.validateBooking = (req, res, next) => {
  let { error } = bookingSchema.validate(req.body); // Validate the booking data using Joi schema

  if (error) {
    let errorMessage = error.details.map(el => el.message).join(', ');
    throw new ExpressError(400, errorMessage);
  } else {
    next();
  }
};

module.exports.isBookingOwner = async (req, res, next) => {
  let { bookingId } = req.params;
  let booking = await Booking.findById(bookingId);
  if (!booking) {
    req.flash("error", "Booking not found");
    return res.redirect("/bookings");
  }
  if (!booking.user.equals(res.locals.currUser._id)) {
    req.flash("error", "You do not have permission to cancel this booking.");
    return res.redirect("/bookings");
  }
  next();
};


  