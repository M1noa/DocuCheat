const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const debug = require('debug')('Docu:server');
const cors = require('cors');
const { processDocument } = require('./utils/documentProcessor');
const tempFileManager = require('./utils/tempFileManager');

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
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
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
  let currentTempFile = null;

  socket.on('disconnect', async () => {
    debug('Client disconnected');
    if (currentTempFile) {
      await tempFileManager.cleanupTempFile(currentTempFile);
    }
  });

  // Handle document processing
  socket.on('process-document', async (data) => {
    try {
      debug('Starting document processing with file path:', data.filePath);
      await processDocument(data, socket);
      await tempFileManager.cleanupTempFile(data.filePath);
    } catch (error) {
      debug('Error processing document:', error);
      socket.emit('error', { message: 'Error processing document' });
      if (data.filePath) {
        await tempFileManager.cleanupTempFile(data.filePath);
      }
    }
  });

  socket.on('cancel-processing', async () => {
    if (currentTempFile) {
      await tempFileManager.cleanupTempFile(currentTempFile);
      currentTempFile = null;
    }
  });
});

// File upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const tempFilePath = await tempFileManager.saveTempFile(req.file.buffer, req.file.originalname);
    debug('File uploaded successfully to:', tempFilePath);
    res.json({ success: true, filePath: tempFilePath });
  } catch (error) {
    debug('Error saving uploaded file:', error);
    res.status(500).json({ error: 'Error saving uploaded file' });
  }
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

// Cleanup on server shutdown
process.on('SIGINT', async () => {
  debug('Server shutting down, cleaning up temp files...');
  await tempFileManager.cleanupAllTempFiles();
  process.exit(0);
});