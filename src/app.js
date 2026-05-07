const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createServer } = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./routes/auth');
const riderRoutes = require('./routes/riders');
const driverRoutes = require('./routes/drivers');
const tripRoutes = require('./routes/trips');
const adminRoutes = require('./routes/admin');
const zoneRoutes = require('./routes/zones');
const paymentRoutes = require('./routes/payments');
const errorHandler = require('./middleware/errorHandler');
const { authenticateToken } = require('./middleware/auth');
const socketHandler = require('./services/socketHandler');
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*', methods: ['GET', 'POST'] } });
socketHandler(io);
app.set('io', io);
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { error: 'Too many requests.' } });
app.use('/api/', limiter);
app.get('/health', (req, res) => { res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() }); });
app.use('/api/auth', authRoutes);
app.use('/api/riders', authenticateToken, riderRoutes);
app.use('/api/drivers', authenticateToken, driverRoutes);
app.use('/api/trips', authenticateToken, tripRoutes);
app.use('/api/admin', authenticateToken, adminRoutes);
app.use('/api/zones', zoneRoutes);
app.use('/api/payments', authenticateToken, paymentRoutes);
app.use((req, res) => { res.status(404).json({ error: `Route ${req.originalUrl} not found` }); });
app.use(errorHandler);
module.exports = { app, httpServer };

// Process trip matching every 10 seconds
const { processExpiredOffers } = require('./services/matchingService');
setInterval(async () => {
  try { await processExpiredOffers(); } catch(e) {}
}, 10000);
