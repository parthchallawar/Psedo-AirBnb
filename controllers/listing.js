const Listing = require('../models/listing.js'); // Import the Listing model
const mbxGeocoding = require('@mapbox/mapbox-sdk/services/geocoding');
const mapToken = process.env.MAP_TOKEN;
const geoCodingClient = mbxGeocoding({ accessToken: mapToken });

module.exports.index = (async (req,res) =>{
  // Listing.find({}).then((res) => {
  //   console.log(res);
  // });
  const listings = await Listing.find({});
  res.render("listings/index",{listings});
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
    // Example in your listings controller or route
res.render('listings/show', { listing, mapToken });
  }
  
});

module.exports.createListing = (async (req, res,next) => {

 let response =await geoCodingClient.forwardGeocode({
  query: req.body.listing.location,
  limit: 1
})

  .send();
  let url = req.file.path;
  let filename = req.file.filename;
  console.log('Received data:', req.body);
  console.log(req.body);
  if (!req.body.listing) {
    throw new ExpressError(400, 'Listing data is required'); 
  }
  
  const newListing = new Listing(req.body.listing); // Use req.body.listing to access the nested object
  newListing.owner = req.user._id; // Set the owner field to the current user's ID
  newListing.image = {
    url: url, // Use the URL from the uploaded file 
    filename: filename, // Use the filename from the uploaded file
  };
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
  if(typeof req.file !== 'undefined'){
    let url = req.file.path;
    let filename = req.file.filename;
    // Fetch the updated listing document
    let listing = await Listing.findById(id);
    listing.image = {
      url: url, // Use the URL from the uploaded file 
      filename: filename, // Use the filename from the uploaded file
    };
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