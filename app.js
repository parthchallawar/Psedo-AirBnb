if(process.env.NODE_ENV !== 'production') {
  require('dotenv').config(); // Load environment variables from .env file
}

 


const express = require('express');
const app = express();
const mongoose = require('mongoose');
const Listing = require('./models/listing'); 
const path = require('path');
const methodOverride = require('method-override');
const ejsMate = require('ejs-mate'); // EJS template engine for Express
const wrapAsync = require('./utils/wrapAsync.js'); // Utility to wrap async functions for error handling
const ExpressError = require('./utils/ExpressError.js'); // Custom error class for Express
const { listingSchema,reviewSchema } = require('./schema.js'); // Joi schema for validation
const Review = require('./models/review.js'); // Review model
const listingsRouter = require('./routes/listing.js'); // Import the listings routes
const reviewsRouter = require('./routes/review.js'); // Import the reviews routes
const userRouter = require('./routes/user.js'); // Import the user routes
const session = require('express-session');
const MongoStore = require("connect-mongo");
const flash = require('connect-flash'); // Flash messages for Express
const  passport = require('passport'); // Passport for authentication
const LocalStrategy = require('passport-local'); // Local strategy for Passport 
const User = require('./models/user.js'); // User model for authentication

const dburl = process.env.ATLASDB_URL;

const store = MongoStore.create({
  mongoUrl: dburl,
  crypto :{
    secret : process.env.SECRET,
  },
  touchAfter: 24* 3600,
});

store.on("error",() => {
    console.log("error in  mongo session",err)
});

const sessionOptions = {
  store: store,
  secret:process.env.SECRET,
  resave: false,
  saveUninitialized: true,
  cookie : {
    expires : Date.now() + 1000 * 60 * 60 * 24 * 7, // Cookie expires in 7 days
    maxAge: 1000 * 60 * 60 * 24 * 7 ,// Cookie max age in milliseconds
    httpOnly: true, // Prevents client-side JavaScript from accessing the cookie
  }
};



main().then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('Error connecting to MongoDB:', err);   
});
async function main(){
    await mongoose.connect (dburl);
}



app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); // Set the views directory
app.use(express.urlencoded({ extended: true })); // Middleware to parse URL-encoded bodies
app.use(methodOverride('_method')); // Middleware to support PUT and DELETE methods in forms
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from the public directory
app.engine('ejs', ejsMate); // Use ejsMate for EJS rendering






const validateListing = (req, res, next) => {
    let { error } = listingSchema.validate(req.body); // Validate the listing data using Joi schema

  if (error) {
    let errorMessage = error.details.map(el => el.message).join(', ');
    throw new ExpressError(400, errorMessage); 
  } else{
    next();
  }
}



//validate review
const validateReview = (req, res, next) => {
  let { error } = reviewSchema.validate(req.body); // Validate the review data using Joi schema
  if (error) {
    let errorMessage = error.details.map(el => el.message).join(', ');
    throw new ExpressError(400, errorMessage);
  } else {
    next();
  }
}

app.use(session(sessionOptions));
app.use(flash()); // Use flash messages in the application

app.use(passport.initialize()); // Initialize Passport for authentication
app.use(passport.session()); // Use Passport session management
passport.use(new LocalStrategy(User.authenticate())); // Use local strategy for authentication
passport.serializeUser(User.serializeUser()); // Serialize user for session
passport.deserializeUser(User.deserializeUser()); // Deserialize user from session


app.get('/', (req, res) => {
  res.send('Hello World!');
});


app.use((req, res, next) => {
  res.locals.success = req.flash('success'); // Make flash messages available in views
  res.locals.error = req.flash('error'); // Make error messages available in views
  res.locals.currUser = req.user; // Make the current user available in views
  next(); // Call the next middleware
});





app.use('/listings', listingsRouter); // Use the listings routes and mount them at the /listings path
app.use('/listings/:id/reviews', reviewsRouter); // Use the reviews routes and mount them at the /listings/:id/reviews path
app.use('/', userRouter); // Use the user routes and mount them at the /user path

app.use((err,req, res, next) => {
  let{statusCode = 500,message = 'Something went wrong'} = err;
  res.render('error.ejs', { err });
});

app.listen(8080, () => {
  console.log('Server is running on port 8080');
});

 