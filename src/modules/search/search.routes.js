// src/modules/search/search.routes.js
const express = require("express");
const router = express.Router();
const auth = require("../../middlewares/auth");
const { globalSearch } = require("./search.controller");

router.use(auth);

router.get("/", globalSearch);

module.exports = router;
