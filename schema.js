const Joi=require('joi');
const { model } = require('mongoose');

const LISTING_CATEGORIES = [
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

const listingSchema = Joi.object({
    listing: Joi.object({
        title: Joi.string().required(),
        description: Joi.string(),
        image: Joi.object({
            filename: Joi.string().default("listing-image.jpg"),
            url: Joi.string().uri().default("https://images.unsplash.com/photo-1527672809634-04ed36500acd?ixlib=rb-1.2.1&q=80&fm=jpg&crop=entropy&cs=tinysrgb&w=1080&fit=max")
        }),
        images: Joi.array().items(Joi.object({
            filename: Joi.string(),
            url: Joi.string().uri()
        })),
        price: Joi.number().min(0).required(),
        location: Joi.string().required(),
        country: Joi.string().required(),
        category: Joi.string().valid(...LISTING_CATEGORIES).required()
    }).required()
});

    module.exports.listingSchema = listingSchema;

module.exports.reviewSchema = Joi.object({
    review: Joi.object({
        comment: Joi.string().required(),
        rating: Joi.number().min(1).max(5).required()
    }).required()
});

module.exports.bookingSchema = Joi.object({
    booking: Joi.object({
        checkIn: Joi.date().required(),
        checkOut: Joi.date().greater(Joi.ref('checkIn')).required(),
        guests: Joi.number().min(1).default(1)
    }).required()
});