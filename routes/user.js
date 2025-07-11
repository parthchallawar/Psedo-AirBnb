const express = require("express");
const router = express.Router();
const User = require("../models/user.js"); // User model for authentication
const passport = require("passport");
const { saveRedirectUrl } = require("../middleware.js");
const listingsController = require("../controllers/users.js"); // Controller for user-related actions


router.route("/signup")
    .get(listingsController.renderSignup) // Render the signup form
    .post(listingsController.signup); // Handle signup form submission

router.route("/login")
    .get(listingsController.renderLogin) // Render the login form
    .post(saveRedirectUrl, passport.authenticate("local", {
        failureRedirect: "/login", // Redirect to login page on failure
        failureFlash: true, // Enable flash messages on failure
    }), listingsController.login); // Handle login form submission


router.get("/logout", listingsController.logout);

module.exports = router;