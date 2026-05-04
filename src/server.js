require('dotenv').config();
const { httpServer } = require('./app');

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║   RideFlow API Server            ║
  ║   Running on port ${PORT}           ║
  ║   ENV: ${process.env.NODE_ENV || 'development'}          ║
  ╚══════════════════════════════════╝
  `);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});
