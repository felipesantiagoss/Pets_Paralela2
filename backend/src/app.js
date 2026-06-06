const express = require('express');
const cors = require('cors');
const animaisRoutes = require('./routes/animais');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/animais', animaisRoutes);

module.exports = app;
