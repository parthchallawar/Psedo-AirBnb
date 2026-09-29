const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const bookingSchema = new Schema({
    listing: {
        type: Schema.Types.ObjectId,
        ref: "Listing",
        required: true,
    },
    user: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },
    checkIn: {
        type: Date,
        required: true,
    },
    checkOut: {
        type: Date,
        required: true,
    },
    guests: {
        type: Number,
        min: 1,
        default: 1,
    },
    totalPrice: Number,
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// The overlap check in createBooking runs inside a Redis lock, so it must be fast.
bookingSchema.index({ listing: 1, checkIn: 1, checkOut: 1 });
// My Trips and profile pages look up bookings by user.
bookingSchema.index({ user: 1 });

module.exports = mongoose.model("Booking", bookingSchema);
