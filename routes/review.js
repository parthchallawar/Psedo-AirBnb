const wrapAsync = require('../utils/wrapAsync.js'); // Utility to wrap async functions for error handling
const ExpressError = require('../utils/ExpressError.js'); // Custom error class for Express
const { reviewSchema } = require('../schema.js'); // Joi schema for validation
const Review = require('../models/review.js'); // Review model
const Listing = require('../models/listing.js'); // Listing model

const express = require('express');
const { isLoggedIn, isReviewAuthor } = require('../middleware.js');
const router = express.Router({mergeParams: true}); // Merge params from parent route
const listingsController = require('../controllers/reviews.js');


const validateListing = (req, res, next) => {
    let { error } = listingSchema.validate(req.body); // Validate the listing data using Joi schema

  if (error) {
    let errorMessage = error.details.map(el => el.message).join(', ');
    throw new ExpressError(400, errorMessage); 
  } else{
    next();
  }
}



//validate review
const validateReview = (req, res, next) => {
  let { error } = reviewSchema.validate(req.body); // Validate the review data using Joi schema
  if (error) {
    let errorMessage = error.details.map(el => el.message).join(', ');
    throw new ExpressError(400, errorMessage);
  } else {
    next();
  }
}


//reviews route
//post route
router.post('/',isLoggedIn,validateReview, wrapAsync(listingsController.postReview)); // Handle posting a new review

//delete review route
router.delete('/:reviewId',isLoggedIn,isReviewAuthor, wrapAsync(listingsController.destroyReview));

module.exports = router; // Export the router to use in app.js