if(process.env.NODE_ENV !== 'production') {
  require('dotenv').config(); // Load environment variables from .env file
}

 


const express = require('express');
const app = express();
// Behind Nginx (Phase 2) requests arrive from the proxy, not the real client;
// this makes Express read the true client IP from X-Forwarded-For (one hop)
// so rate limiting (below) is keyed per real user, not per proxy.
app.set('trust proxy', 1);
const helmet = require('helmet');
const mongoose = require('mongoose');
const Listing = require('./models/listing'); 
const path = require('path');
const methodOverride = require('method-override');
const ejsMate = require('ejs-mate'); // EJS template engine for Express
const wrapAsync = require('./utils/wrapAsync.js'); // Utility to wrap async functions for error handling
const ExpressError = require('./utils/ExpressError.js'); // Custom error class for Express
const Review = require('./models/review.js'); // Review model
const listingsRouter = require('./routes/listing.js'); // Import the listings routes
const reviewsRouter = require('./routes/review.js'); // Import the reviews routes
const userRouter = require('./routes/user.js'); // Import the user routes
const bookingsRouter = require('./routes/booking.js'); // Import the bookings routes
const session = require('express-session');
const MongoStore = require("connect-mongo");
const flash = require('connect-flash'); // Flash messages for Express
const  passport = require('passport'); // Passport for authentication
const LocalStrategy = require('passport-local'); // Local strategy for Passport 
const User = require('./models/user.js'); // User model for authentication
const { globalLimiter } = require('./middleware/rateLimit.js'); // Redis-backed rate limiting
const os = require('os');
const { redis, isRedisReady } = require('./config/redis.js');
const { createSocketServer, closeSocketServer } = require('./socket/index.js');
const { closeNotificationQueue } = require('./queues/notificationQueue.js');
const { connectCassandra, closeCassandra, isCassandraReady } = require('./config/cassandra.js');

const dburl = process.env.ATLASDB_URL;

const PORT = process.env.PORT || 8080;
// Which copy of the app answered — shown in the X-Instance-Id header and logs,
// so load balancing (Phase 2) is visible instead of invisible.
const INSTANCE_ID = process.env.INSTANCE_ID || os.hostname();

// Security headers with tailored Content Security Policy (CSP)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://cdn.jsdelivr.net',
          'https://api.mapbox.com',
          'https://cdnjs.cloudflare.com',
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://cdn.jsdelivr.net',
          'https://cdnjs.cloudflare.com',
          'https://fonts.googleapis.com',
          'https://api.mapbox.com',
        ],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
        imgSrc: [
          "'self'",
          'data:',
          'blob:',
          'https://res.cloudinary.com',
          'https://images.unsplash.com',
          'https://*.tiles.mapbox.com',
          'https://api.mapbox.com',
        ],
        connectSrc: [
          "'self'",
          'https://api.mapbox.com',
          'https://events.mapbox.com',
          'https://*.tiles.mapbox.com',
          'ws:',
          'wss:',
        ],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
      },
    },
  })
);

// connect-mongo opens its own MongoClient connection as soon as it's
// created. Creating it at module load (in parallel with mongoose's own
// connection below) makes two concurrent TLS handshakes to the same Atlas
// cluster at startup, which is flaky on some networks. Building it only
// after mongoose's connection has succeeded serializes the handshakes.
let store;
let server;
let io;

async function main(){
    // Prevent NoSQL query injection
    mongoose.set('sanitizeFilter', true);
    await mongoose.connect(dburl);
    if (process.env.MESSAGE_STORE === 'cassandra') {
      await connectCassandra();
    }
    store = MongoStore.create({
      mongoUrl: dburl,
      crypto :{
        secret : process.env.SECRET,
      },
      touchAfter: 24* 3600,
    });
    store.on("error",(err) => {
        console.log("error in  mongo session",err)
    });
}



app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); // Set the views directory

// Tag every response with the instance that served it, so load balancing
// (Phase 2) is visible instead of invisible.
app.use((req, res, next) => {
  res.set('X-Instance-Id', INSTANCE_ID);
  next();
});

// Health check for Docker and the load balancer. Registered before static
// files, rate limiting and sessions so it's cheap, never rate-limited and
// never creates a session document. Only MongoDB decides healthy vs
// unhealthy: Redis is optional and fails open (see config/redis.js), so a
// Redis outage must not take every instance out of rotation at once.
app.get('/health', (req, res) => {
  const mongoUp = mongoose.connection.readyState === 1;
  let cassandraStatus = 'disabled';
  if (process.env.MESSAGE_STORE === 'cassandra') {
    cassandraStatus = isCassandraReady() ? 'connected' : 'down';
  }
  res.status(mongoUp ? 200 : 503).json({
    status: mongoUp ? 'ok' : 'unavailable',
    instance: INSTANCE_ID,
    mongo: mongoUp ? 'connected' : 'disconnected',
    redis: isRedisReady() ? 'ready' : 'down',
    cassandra: cassandraStatus,
  });
});

app.use(express.urlencoded({ extended: true })); // Middleware to parse URL-encoded bodies
app.use(methodOverride('_method')); // Middleware to support PUT and DELETE methods in forms
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from the public directory
app.engine('ejs', ejsMate); // Use ejsMate for EJS rendering

app.use((req, res, next) => {
  // Safe defaults so error.ejs (and its navbar/flash includes) can always render,
  // even if session/flash/passport below throws before the real values are set.
  res.locals.currUser = null;
  res.locals.success = [];
  res.locals.error = [];
  next();
});

// Mounted after the safe defaults above, so a 429 rendered here still has
// non-null res.locals for error.ejs's navbar/flash includes to read.
// Static files (served earlier, line 59) never reach this middleware.
app.use(globalLimiter);

main().then(() => {
  console.log('Connected to MongoDB');

  const sessionOptions = {
    store: store,
    secret: process.env.SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
      expires: Date.now() + 1000 * 60 * 60 * 24 * 7, // Cookie expires in 7 days
      maxAge: 1000 * 60 * 60 * 24 * 7, // Cookie max age in milliseconds
      httpOnly: true, // Prevents client-side JavaScript from accessing the cookie
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    }
  };

  // Kept in a variable so Socket.IO (below) can run the exact same session
  // middleware on the WebSocket handshake and see socket.request.user.
  const sessionMiddleware = session(sessionOptions);
  app.use(sessionMiddleware);
  app.use(flash()); // Use flash messages in the application

  app.use(passport.initialize()); // Initialize Passport for authentication
  app.use(passport.session()); // Use Passport session management
  passport.use(new LocalStrategy(User.authenticate())); // Use local strategy for authentication
  passport.serializeUser(User.serializeUser()); // Serialize user for session
  passport.deserializeUser(User.deserializeUser()); // Deserialize user from session


  app.get('/', (req, res) => {
    res.redirect("/listings");
  });


  app.use((req, res, next) => {
    res.locals.success = req.flash('success'); // Make flash messages available in views
    res.locals.error = req.flash('error'); // Make error messages available in views
    res.locals.currUser = req.user; // Make the current user available in views
    next(); // Call the next middleware
  });




  app.use('/listings', listingsRouter); // Use the listings routes and mount them at the /listings path
  app.use('/listings/:id/reviews', reviewsRouter); // Use the reviews routes and mount them at the /listings/:id/reviews path
  app.use('/bookings', bookingsRouter); // Use the bookings routes and mount them at the /bookings path
  app.use('/', userRouter); // Use the user routes and mount them at the /user path

  app.use((err,req, res, next) => {
    let{statusCode = 500,message = 'Something went wrong'} = err;
    if (!err.message) err.message = message;
    res.status(statusCode).render('error.ejs', { err });
  });

  server = app.listen(PORT, () => {
    console.log(`Server ${INSTANCE_ID} is running on port ${PORT}`);
  });
  io = createSocketServer(server, { sessionMiddleware, instanceId: INSTANCE_ID });
}).catch(err => {
  console.error('Error connecting to MongoDB:', err);
});

// Graceful shutdown: on `docker stop` (SIGTERM) or Ctrl+C (SIGINT), stop
// accepting new connections, let in-flight requests finish, then close
// every connection (both MongoDB clients and Redis) before exiting.
let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received: ${INSTANCE_ID} shutting down gracefully`);

  // Docker sends SIGKILL 10s after SIGTERM, so give up cleanly before that.
  setTimeout(() => {
    console.log('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 8000).unref();

  try {
    // io.close() disconnects every open WebSocket, then closes the HTTP
    // server. A plain server.close() waits for open connections to end on
    // their own, and an open WebSocket never does — it would always hit the
    // 8s force-exit above once chat (Phase 4) is in use.
    if (io) await new Promise((resolve) => io.close(resolve));
    else if (server) await new Promise((resolve) => server.close(resolve));
    closeSocketServer();
    await closeNotificationQueue();
    if (process.env.MESSAGE_STORE === 'cassandra') {
      await closeCassandra();
    }
    if (store) await store.close(); // session store's own MongoDB client (separate from mongoose's)
    await mongoose.connection.close();
    await redis.quit().catch(() => redis.disconnect());
    console.log('Shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

 