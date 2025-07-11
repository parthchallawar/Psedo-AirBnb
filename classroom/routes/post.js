const express = require('express');
const router = express.Router();


//posts
//index
router.get('/', (req, res) => {
    res.send('List of posts');
});

//show  
router.get('/:id', (req, res) => {
    res.send("Post details for ID: " + req.params.id);
});

//edit
router.get('/:id/edit', (req, res) => {
    res.send("Edit post with ID: " + req.params.id);
});

//delete
router.delete('/:id', (req, res) => {
    res.send("Delete post with ID: " + req.params.id);
});

module.exports = router;

