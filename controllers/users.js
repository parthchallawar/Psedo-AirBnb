const User = require("../models/user.js"); 

module.exports.signup = (async (req, res) => {
    try{
        let { email, username, password } = req.body; 
    const user = new User({ email, username });
    const registeredUser = await User.register(user, password);
    console.log(registeredUser);
    req.login(registeredUser,(err) => {
    if (err) {
        return next(err);
    }
    // Automatically log in the user after registration
    req.flash("success", "Welcome to the app!");
    res.redirect("/listings");
    });
    }catch (error) {
        console.error("Error during user registration:", error);
        req.flash("error", "Registration failed. Please try again.");
        res.redirect("/signup");
    }
    
});

module.exports.renderSignup = ((req, res) => {
    res.render("users/signup.ejs");
});

module.exports.renderLogin = ((req, res) => {
    res.render("users/login.ejs");
});

module.exports.login = (async(req, res) => {
    req.flash("success", "Welcome back!");
    const redirectUrl = res.locals.redirectUrl || "/listings";
    console.log("Redirect URL:", redirectUrl); // Log the redirect URL for debugging
    res.redirect(redirectUrl); // Redirect to listings page or fallback on success
});

module.exports.logout = ((req, res, next) => {
    req.logout((err) => {
        if (err) {
            return next(err);
        }
        req.flash("success", "Logged out successfully!");
        res.redirect("/login"); // Redirect to login page after logout
    });
});