const wrapAsync = require('../utils/wrapAsync.js'); // Utility to wrap async functions for error handling
const ExpressError = require('../utils/ExpressError.js'); // Custom error class for Express
const { listingSchema, reviewSchema } = require('../schema.js'); // Joi schema for validation
const Review = require('../models/review.js'); // Review model
const Listing = require('../models/listing'); // Listing model
const express = require('express');
const {isLoggedIn, isOwner} = require('../middleware.js'); // Import the isLoggedIn middleware
const router = express.Router({mergeParams: true}); // Merge params from parent route
router.use(express.urlencoded({ extended: true })); // Middleware to parse URL-encoded bodies
const listingsController = require('../controllers/listing.js'); // Import the listings controller
const multer = require('multer'); // Import multer for file uploads
const {storage} = require('../cloudConfig.js'); // Import Cloudinary storage configuration 
const upload = multer({ storage }); // Set the destination for uploaded files





// Middleware to parse JSON bodies
router.use(express.json()); // Middleware to parse JSON bodies

const validateListing = (req, res, next) => {
     console.log('Validating listing data:', req.body.listing); // Log the nested listing object for debugging

    next();
  
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

router.route("/")

.get(wrapAsync(listingsController.index))
.post(
  isLoggedIn,
  upload.single('listing[image][url]'),
  validateListing,
  wrapAsync(listingsController.createListing)
); // Handle file upload and create listing

// Create a new listing
router.get('/new',isLoggedIn, wrapAsync(listingsController.renderNewForm)); // Render the form for creating a new listing

router.route('/:id')
.get(wrapAsync(listingsController.showListing)) // Show a specific listing
.put(isLoggedIn,isOwner, upload.single('listing[image][url]'),  wrapAsync(listingsController.updateListing)) // Create a

.delete(isOwner ,isLoggedIn,wrapAsync(listingsController.destroyListing));



// Edit listing route
router.get('/:id/edit',isOwner ,isLoggedIn,wrapAsync(listingsController.renderEditForm));

module.exports = router;