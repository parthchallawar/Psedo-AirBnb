const mongoose= require('mongoose');
const Schema = mongoose.Schema;
const Review = require('./review.js'); // Import the Review model

const listingSchema = new Schema({
    title: {
        type: String,
        required: true
    },
    description: String,
    image: {
        filename: String,
        url:{
        default: "https://images.unsplash.com/photo-1527672809634-04ed36500acd?ixlib=rb-1.2.1&q=80&fm=jpg&crop=entropy&cs=tinysrgb&w=1080&fit=max",
        type: String,
        set : (v) => v==="" ? "https://images.unsplash.com/photo-1527672809634-04ed36500acd?ixlib=rb-1.2.1&q=80&fm=jpg&crop=entropy&cs=tinysrgb&w=1080&fit=max" : v,
        }
    },
    price: Number,
    location: String,
    country: String,
    reviews: [
        {
            type: Schema.Types.ObjectId,
            ref: "Review",
        },
    ],
     owner : {
        type: Schema.Types.ObjectId,
        ref: "User",
        
    },
  
    geometry: {
        type: {
            type: String,
            enum: ['Point'], // Must be 'Point'
            required: true
        },
        coordinates: {
            type: [Number], // Array of numbers [longitude, latitude]
            required: true
        }
    }
});

listingSchema.post('findOneAndDelete', async (doc) =>{
    if (doc) {
        await Review.deleteMany({ _id: { $in: doc.reviews } }); // Delete all reviews associated with the listing
        console.log('Reviews deleted successfully for listing:', doc._id);
    }
});

const Listing = mongoose.model('Listing', listingSchema);
module.exports = Listing;

