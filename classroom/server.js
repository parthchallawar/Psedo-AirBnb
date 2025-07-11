const express = require('express');
const app = express();
const users = require('./routes/user.js'); // Import the user routes
const posts = require('./routes/post.js'); // Import the post routes
const cookieParser = require('cookie-parser');
const path = require('path'); // Import path module for handling file paths
const session = require('express-session');
const flash = require('connect-flash'); // Import connect-flash for flash messages
//session is one when same user is logged in on same browser 
// if the user logs in on another browser or incognito mode, a new session is created for that user.

sessionOption ={ 
    secret : "mysupersecretkey", // Secret key for signing the session ID cookie
    resave: false, // Don't save session if unmodified)
    saveUninitialized: true, // Don't create session until something stored
}
app.use(session(sessionOption)); // Use express-session middleware for session management
app.use(flash()); 
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); // Set the views directory
app.use(cookieParser("secretcode")); // Use cookie-parser middleware to parse cookies

app.use((req, res, next) => {
    res.locals.successmsg = req.flash("success"); // Make success messages available in the response
    res.locals.errormsg = req.flash("error"); // Make error messages available in the response
    next();
});

app.get("/reqcount", (req, res) => {
   //req.session.count tracks the number of requests made by the user
    if (req.session.count) { // Check if the count exists in the session
        req.session.count++;    
    }
    else if (!req.session.count) {
        req.session.count = 1; // I nitialize the count if it doesn't exist
    }
    
   res.send(`This is your request number ${req.session.count++}`);
});

app.get("/register", (req, res) => {
    let {name="anonymous"} = req.query;
    req.session.name = name; 
    if(name === "anonymous") {
        req.flash("error", "Please provide a valid name!"); // Set an error flash message
    }else{
        req.flash("success", `Welcome ${name}!`); // Set a success flash message
    }
    
   res.redirect("/hello"); 
});

app.get("/hello", (req, res) => {
   
    res.render("page.ejs", {name: req.session.name}); // Render the page with the user's name from the session

});

app.get("/getsignedcookie", (req, res) => {
    res.cookie("signedCookie", "This is a signed cookie", { signed: true });
    res.send("Signed cookie has been set!");
});

app.get("/verify", (req, res) => {
    console.log(req.signedCookies); // Log the cookies to the console
    console.log(req.cookies); // Log the unsigned cookies to the console
    res.send("Cookies verified!");
});

app.get("/getcookies", (req, res) => {
    res.cookie("greeting", "Hello, World!");
    res.cookie("madeBy", "Parth");
    res.send("Cookies have been set!");
    
});

app.get("/getcookie", (req, res) => {
    res.cookie("name", "patty");
    let {name="anonymous"} = req.cookies;
    res.send(`Hello, ${name}!`); // Use the cookie value in the response
});

app.get('/', (req, res) => {

    console.dir(req.cookies); // Log the cookies to the console
    res.send('Hello, World!');  
});

app.use("/users",users);// Use the user routes and mount them at the /users path
app.use("/posts", posts); // Use the post routes and mount them at the /posts path


app.listen(3000, () => {
    console.log('Server is running on port 3000');
});