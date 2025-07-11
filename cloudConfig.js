const cloudinary = require('cloudinary').v2; // Import Cloudinary SDK
const {CloudinaryStorage} = require('multer-storage-cloudinary'); // Import Cloudinary storage for multer

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME, // Your Cloudinary cloud name
    api_key: process.env.CLOUD_API_KEY, // Your Cloudinary API key
    api_secret: process.env.CLOUD_API_SECRET // Your Cloudinary API secret
});
const storage = new CloudinaryStorage({
  cloudinary: cloudinary, // Use the configured Cloudinary instance
  params: {
    folder: 'wanderlust_DEV', // Folder in Cloudinary where images will be stored
    allowedFormats: ['jpeg', 'png', 'jpg'], // Allowed image formats
    // transformation: { // Optional transformations to apply to the image
    //   width: 500,
    //   height: 500,
    //   crop: 'limit'
    // }
  },
});

module.exports = { 
    cloudinary,
    storage
};