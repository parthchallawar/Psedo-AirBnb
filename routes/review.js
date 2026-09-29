const wrapAsync = require('../utils/wrapAsync.js'); // Utility to wrap async functions for error handling
const express = require('express');
const { isLoggedIn, isReviewAuthor, validateReview } = require('../middleware.js');
const router = express.Router({ mergeParams: true }); // Merge params from parent route
const reviewsController = require('../controllers/reviews.js');

// Reviews routes
// POST route to add a review
router.post('/', isLoggedIn, validateReview, wrapAsync(reviewsController.postReview));

// DELETE route to remove a review
router.delete('/:reviewId', isLoggedIn, isReviewAuthor, wrapAsync(reviewsController.destroyReview));

module.exports = router; // Export the router to use in app.js