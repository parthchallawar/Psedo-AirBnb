const mongoose = require("mongoose");
const initData = require("./data.js");
const Listing = require("../models/listing.js");

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const MONGO_URL = process.env.ATLASDB_URL || "mongodb://127.0.0.1:27017/wanderlust";

main()
  .then(() => {
    console.log("connected to DB");
  })
  .catch((err) => {
    console.log(err);
  });

async function main() {
  await mongoose.connect(MONGO_URL);
}

const locationCoordinates = {
  "Malibu": [-118.7798, 34.0259],
  "New York City": [-74.006, 40.7128],
  "Aspen": [-106.8175, 39.1911],
  "Florence": [11.2558, 43.7696],
  "Portland": [-122.6784, 45.5152],
  "Cancun": [-86.8515, 21.1619],
  "Lake Tahoe": [-120.0324, 39.0968],
  "Los Angeles": [-118.2437, 34.0522],
  "Verbier": [7.2286, 46.0961],
  "Serengeti National Park": [34.6857, -2.3333],
  "Amsterdam": [4.9041, 52.3676],
  "Fiji": [178.065, -17.7134],
  "Cotswolds": [-1.8433, 51.833],
  "Boston": [-71.0589, 42.3601],
  "Bali": [115.1889, -8.4095],
  "Banff": [-115.5708, 51.1784],
  "Miami": [-80.1918, 25.7617],
  "Phuket": [98.3381, 7.8804],
  "Scottish Highlands": [-4.2026, 57.1208],
  "Dubai": [55.2708, 25.2048],
  "Montana": [-110.3626, 46.8797],
  "Mykonos": [25.3289, 37.4467],
  "Costa Rica": [-84.0907, 9.9281],
  "Charleston": [-79.9311, 32.7765],
  "Tokyo": [139.6917, 35.6895],
  "New Hampshire": [-71.5724, 43.1939],
  "Maldives": [73.2207, 3.2028],
  "Copenhagen": [12.5683, 55.6761],
  "Lisbon": [-9.1393, 38.7223],
  "Marrakech": [-7.9811, 31.6295],
  "Prague": [14.4378, 50.0755],
  "Sydney": [151.2093, -33.8688],
  "Wadi Rum": [35.4444, 29.5321],
  "Queenstown": [168.6626, -45.0312],
  "Buenos Aires": [-58.3816, -34.6037],
  "Dubrovnik": [18.0944, 42.6507],
  "Napa Valley": [-122.2869, 38.2975],
  "Tromso": [18.9553, 69.6492],
  "Cartagena": [-75.4794, 10.391],
  "Hallstatt": [13.6493, 47.5622],
  "Budapest": [19.0402, 47.4979],
  "Nuwara Eliya": [80.7891, 6.9497],
  "Seoul": [126.978, 37.5665]
};

const defaultCoordinates = [77.209, 28.6139];

const pickCategory = (listing) => {
  const text = `${listing.title} ${listing.location} ${listing.country} ${listing.description}`.toLowerCase();

  const hasAny = (keywords) => keywords.some((word) => text.includes(word));

  if (hasAny(['aspen', 'banff', 'mountain', 'highlands', 'hallstatt', 'verbier', 'nuwara'])) return 'Mountains';
  if (hasAny(['castle'])) return 'Castles';
  if (hasAny(['beach', 'coast', 'shore', 'mykonos', 'maldives', 'fiji', 'cancun', 'bali', 'dubrovnik'])) return 'Beachfront';
  if (hasAny(['lake', 'lakefront', 'hallstatt', 'wakatipu', 'tahoe', 'new hampshire'])) return 'Lakefront';
  if (hasAny(['luxury', 'penthouse', 'private island', 'opulent', 'overwater'])) return 'Luxury';
  if (hasAny(['historic', 'brownstone', 'colonial', 'old town', 'canal house', 'riad'])) return 'Historic Stays';
  if (hasAny(['pool', 'villa', 'oasis'])) return 'Amazing Pools';
  if (hasAny(['camp', 'wadi rum', 'cabin', 'retreat', 'treehouse', 'lodge'])) return 'Camping';
  if (hasAny(['farm', 'vineyard', 'napa'])) return 'Farms';
  if (hasAny(['tokyo', 'new york', 'seoul', 'lisbon', 'sydney', 'amsterdam', 'prague', 'budapest', 'dubai', 'miami', 'los angeles', 'boston'])) return 'Iconic Cities';
  if (hasAny(['room', 'studio', 'apartment', 'loft', 'flat', 'penthouse'])) return 'Rooms';

  return 'Trending';
};

const initDB = async () => {
  await Listing.deleteMany({});
  initData.data = initData.data.map((obj) => ({
    ...obj,
    owner: "686a259adc83c042a4761937",
    category: pickCategory(obj),
    geometry: {
      type: "Point",
      coordinates: locationCoordinates[obj.location] || defaultCoordinates
    }
  }));
 
  await Listing.insertMany(initData.data);//initData is an object with a data property that is an array of objects
  console.log("data was initialized");
};

initDB();