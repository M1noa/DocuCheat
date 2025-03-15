const fs = require('fs');
const path = require('path');
const debug = require('debug')('docucheat:tempmanager');

class TempFileManager {
    constructor() {
        this.tempDir = path.join(__dirname, '..', 'temp');
        this.ensureTempDirExists();
    }

    ensureTempDirExists() {
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
            debug('Created temp directory:', this.tempDir);
        }
    }

    generateTempFilePath(originalFilename) {
        const timestamp = Date.now();
        const randomString = Math.random().toString(36).substring(2, 15);
        const sanitizedFilename = path.basename(originalFilename).replace(/[^a-zA-Z0-9.]/g, '_');
        return path.join(this.tempDir, `${timestamp}_${randomString}_${sanitizedFilename}`);
    }

    async saveTempFile(fileBuffer, originalFilename) {
        const tempFilePath = this.generateTempFilePath(originalFilename);
        await fs.promises.writeFile(tempFilePath, fileBuffer);
        debug('Saved temp file:', tempFilePath);
        return tempFilePath;
    }

    async cleanupTempFile(filePath) {
        try {
            if (filePath && fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath);
                debug('Cleaned up temp file:', filePath);
            }
        } catch (error) {
            debug('Error cleaning up temp file:', error);
        }
    }

    async cleanupAllTempFiles() {
        try {
            const files = await fs.promises.readdir(this.tempDir);
            await Promise.all(files.map(file => 
                this.cleanupTempFile(path.join(this.tempDir, file))
            ));
            debug('Cleaned up all temp files');
        } catch (error) {
            debug('Error cleaning up temp files:', error);
        }
    }
}

module.exports = new TempFileManager();