const Joi=require('joi');
const { model } = require('mongoose');

const listingSchema = Joi.object({
    listing: Joi.object({
        title: Joi.string().required(),
        description: Joi.string(),
        image: Joi.object({
            filename: Joi.string().required().default("listing-image.jpg"),
            url: Joi.string().uri().default("https://images.unsplash.com/photo-1527672809634-04ed36500acd?ixlib=rb-1.2.1&q=80&fm=jpg&crop=entropy&cs=tinysrgb&w=1080&fit=max")
        }).required(),
        price: Joi.number().min(0).required(),
        location: Joi.string().required(),
        country: Joi.string().required()
    }).required()
});

module.exports.reviewSchema = Joi.object({
    review: Joi.object({
        comment: Joi.string().required(),
        rating: Joi.number().min(1).max(5).required()
    }).required()
});