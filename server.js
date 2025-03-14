const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const debug = require('debug')('docucheat:server');
const cors = require('cors');
const { processDocument } = require('./utils/documentProcessor');

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// Configure multer for file uploads
const upload = multer({
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// WebSocket connection handling
io.on('connection', (socket) => {
  debug('Client connected');

  socket.on('disconnect', () => {
    debug('Client disconnected');
  });

  // Handle document processing
  socket.on('process-document', async (data) => {
    try {
      debug('Starting document processing');
      await processDocument(data, socket);
    } catch (error) {
      debug('Error processing document:', error);
      socket.emit('error', { message: 'Error processing document' });
    }
  });
});

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  debug('File uploaded successfully');
  res.json({ success: true });
});

// Text download endpoint
app.get('/download-text/:filename', (req, res) => {
  const filePath = path.join(__dirname, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(filePath);
});

// Error handling middleware
app.use((err, req, res, next) => {
  debug('Error:', err);
  res.status(500).json({ error: err.message });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  debug(`Server running on port ${PORT}`);
});