const Listing = require('../models/listing.js'); // Import the Listing model
const Booking = require('../models/booking.js'); // Booking model (used to show owner bookings)
const mbxGeocoding = require('@mapbox/mapbox-sdk/services/geocoding');
const mapToken = process.env.MAP_TOKEN;
const geoCodingClient = mbxGeocoding({ accessToken: mapToken });

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

module.exports.index = (async (req,res) =>{
  const q = (req.query.q || "").trim();
  const selectedCategory = (req.query.category || "").trim();
  const minPrice = (req.query.minPrice || "").trim();
  const maxPrice = (req.query.maxPrice || "").trim();
  const sort = (req.query.sort || "").trim();
  const query = {};

  if (q) {
    const safePattern = new RegExp(escapeRegex(q), "i");
    query.$or = [
      { title: safePattern },
      { location: safePattern },
      { country: safePattern },
      { description: safePattern }
    ];
  }

  if (FILTER_CATEGORIES.includes(selectedCategory)) {
    query.category = selectedCategory;
  }

  const min = Number(minPrice);
  const max = Number(maxPrice);
  if (minPrice !== "" && !Number.isNaN(min)) {
    query.price = { ...query.price, $gte: min };
  }
  if (maxPrice !== "" && !Number.isNaN(max)) {
    query.price = { ...query.price, $lte: max };
  }

  let cursor = Listing.find(query).populate("reviews");
  if (SORT_OPTIONS[sort]) {
    cursor = cursor.sort(SORT_OPTIONS[sort]);
  }
  const listings = await cursor;

  res.render("listings/index", {
    listings,
    searchQuery: q,
    selectedCategory,
    minPrice,
    maxPrice,
    sort,
    categories: FILTER_CATEGORIES,
    avgRating
  });
});

module.exports.renderNewForm = (async(req, res) => {
  //console.log(req.user);
  
  res.render('listings/new.ejs');
});

module.exports.showListing = (async (req, res) => {
  const listing = await Listing.findById(req.params.id).populate({
    path:"reviews",
    populate: {
      path: "author", // Populate the author field of the reviews
    },
  }).populate("owner"); // Populate the reviews field with review data
  console.log('Listing found:', listing);
  if (!listing) {
    req.flash('error','Listing not found in the database'); // Flash message for error
    // return res.status(404).send('Listing not found');
    res.redirect('/listings');
  }
  else{
    let ownerBookings = null;
    const isOwnerViewing = res.locals.currUser && listing.owner &&
      listing.owner._id.equals(res.locals.currUser._id);
    if (isOwnerViewing) {
      ownerBookings = await Booking.find({ listing: listing._id }).populate("user");
    }
    res.render('listings/show', { listing, mapToken, avgRating, isOwnerViewing, ownerBookings });
  }

});

module.exports.createListing = (async (req, res,next) => {

 let response =await geoCodingClient.forwardGeocode({
  query: req.body.listing.location,
  limit: 1
})

  .send();
  console.log('Received data:', req.body);
  console.log(req.body);
  if (!req.body.listing) {
    throw new ExpressError(400, 'Listing data is required');
  }

  const newListing = new Listing(req.body.listing); // Use req.body.listing to access the nested object
  newListing.owner = req.user._id; // Set the owner field to the current user's ID
  const cover = req.files?.['listing[image][url]']?.[0];
  if (cover) {
    newListing.image = {
      url: cover.path, // Use the URL from the uploaded file
      filename: cover.filename, // Use the filename from the uploaded file
    };
  }
  const gallery = req.files?.['images'] || [];
  newListing.images = gallery.map(f => ({ url: f.path, filename: f.filename }));
  newListing.geometry = response.body.features[0].geometry;
    await newListing.save();
    console.log('Listing created successfully:', newListing);
    req.flash('success', 'Listing created successfully!'); // Flash message for success
    res.redirect('/listings'); 
  
 });

 module.exports.renderEditForm = (async (req, res) => {
  const listing = await Listing.findById(req.params.id);
  if (!listing) {
    req.flash('error', 'Listing not found'); // Flash message for error
    return res.redirect('/listings'); // Redirect to the listings page if listing not found
  }
  let originalImageUrl =  listing.image.url;
  originalImageUrl = originalImageUrl.replace("/upload","/upload/h_300,w_250"); 
  res.render('listings/edit.ejs', { listing, originalImageUrl }); // Render the edit form with the listing data
})

module.exports.updateListing = (async (req, res) => {
  let {id} = req.params;
  await Listing.findByIdAndUpdate(id, {...req.body.listing});// Extract the fields from req.body.listing
  const cover = req.files?.['listing[image][url]']?.[0];
  const gallery = req.files?.['images'] || [];
  if (cover || gallery.length) {
    // Fetch the updated listing document
    let listing = await Listing.findById(id);
    if (cover) {
      listing.image = {
        url: cover.path, // Use the URL from the uploaded file
        filename: cover.filename, // Use the filename from the uploaded file
      };
    }
    if (gallery.length) {
      listing.images = gallery.map(f => ({ url: f.path, filename: f.filename }));
    }
    await listing.save(); // Save the updated listing
  }

  console.log('Listing updated successfully:', req.body.listing);
  req.flash('success', 'Listing updated successfully!'); // Flash message for success
  res.redirect(`/listings/${id}`); // Redirect to the listings page after successful update
  
});
module.exports.destroyListing = (async (req, res) => {
  const { id } = req.params;
  
    await Listing.findByIdAndDelete(id);
  console.log('Listing deleted successfully:', id);
  req.flash('success', 'Listing deleted successfully!'); // Flash message for success
  res.redirect('/listings'); // Redirect to the listings page after successful deletion
});