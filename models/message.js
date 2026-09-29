const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const messageSchema = new Schema({
    conversationId: {
        type: String,
        required: true,
    },
    listing: {
        type: Schema.Types.ObjectId,
        ref: "Listing",
        required: true,
    },
    guest: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },
    sender: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },
    senderName: {
        type: String,
        required: true,
    },
    text: {
        type: String,
        required: true,
        maxlength: 1000,
    },
    sentAt: {
        type: Date,
        default: Date.now,
    },
});

// "Latest N messages of a conversation" — the only query the chat UI runs.
messageSchema.index({ conversationId: 1, sentAt: -1 });
// "Which guests have messaged about this listing" — the host's conversation list.
messageSchema.index({ listing: 1, sentAt: -1 });

module.exports = mongoose.model("Message", messageSchema);
