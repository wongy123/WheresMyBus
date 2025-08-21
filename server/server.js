const express = require('express');
const dotenv = require('dotenv');
const indexRouter = require('./src/routes')

const app = express();
dotenv.config();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Welcome to the WheresMyBus server!');
});

app.use('/api', indexRouter);

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});