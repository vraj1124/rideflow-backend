const jwt = require('jsonwebtoken');
const socketHandler = (io) => {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      socket.userRole = decoded.role;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });
  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.userRole} ${socket.userId}`);
    if (socket.userRole === 'rider') socket.join(`rider:${socket.userId}`);
    else if (socket.userRole === 'driver') socket.join(`driver:${socket.userId}`);
    else if (socket.userRole === 'admin') socket.join('admin');
    socket.on('trip:subscribe', (tripId) => socket.join(`trip:${tripId}`));
    socket.on('trip:unsubscribe', (tripId) => socket.leave(`trip:${tripId}`));
    socket.on('driver:location', async ({ lat, lng, tripId }) => {
      if (socket.userRole !== 'driver') return;
      io.to('admin').emit('driver:location', { driverId: socket.userId, location: { lat, lng } });
      if (tripId) io.to(`trip:${tripId}`).emit('driver:location', { driverId: socket.userId, location: { lat, lng } });
    });
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.userRole} ${socket.userId}`);
      if (socket.userRole === 'driver') io.to('admin').emit('driver:disconnected', { driverId: socket.userId });
    });
  });
};
module.exports = socketHandler;
