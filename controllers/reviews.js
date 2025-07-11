let Review = require('../models/review.js'); // Review model
let Listing = require('../models/listing.js'); // Listing model

module.exports.postReview = (async (req, res) => {
  const { id } = req.params;
  let listing = await Listing.findById(id);
  let newreview = new Review(req.body.review);
  newreview.author = req.user._id; // Set the author of the review to the current user
  listing.reviews.push(newreview); 
  await newreview.save(); 
  await listing.save(); 
  req.flash('success', 'Review added successfully!'); // Flash message for success
 res.redirect(`/listings/${id}`); // Redirect to the listing page after adding the review
 
});

module.exports.destroyReview = (async (req, res) => {
  const { id, reviewId } = req.params;
  await Listing.findByIdAndUpdate(id, { $pull: { reviews: reviewId } }); // Remove the review ID from the listing's reviews array
  await Review.findByIdAndDelete(reviewId); // Delete the review from the database
  console.log('Review deleted successfully:', reviewId);
  req.flash('success', 'Review deleted successfully!'); // Flash message for success
  res.redirect(`/listings/${id}`); // Redirect to the listing page after deleting the
});