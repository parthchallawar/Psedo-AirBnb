const express = require('express');
const router = express.Router();

//delete - users
router.delete('/:id', (req, res) => {
    res.send("Delete user with ID: " + req.params.id);
});

//index - users
router.get('/', (req, res) => {
    // Logic to fetch and return users
    res.send('List of users');
});

//show - users
router.get('/:id', (req, res) => {
    res.send("User details for ID: " + req.params.id);
});

//edit - users
router.get('/:id/edit', (req, res) => {  
    res.send("Edit user with ID: " + req.params.id);
});

module.exports = router;