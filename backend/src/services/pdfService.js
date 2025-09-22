import fs from 'fs/promises';
import pdf from 'pdf-parse-fixed';
import { ApiError } from '../utils/apiError.js';
import optimizedDriveService from './driveService.js';

class PDFService {
    async extractTextFromPDF(filePath) {
        try {
            const dataBuffer = await fs.readFile(filePath);
            const data = await pdf(dataBuffer);
            return this.cleanText(data.text);
        } catch (error) {
            console.error('Error extracting PDF text:', error);
            throw new ApiError(500, `Failed to extract text from PDF: ${error.message}`);
        }
    }

    async extractTextFromDriveFile(fileId) {
        try {
            console.log(`📄 Downloading file from Drive: ${fileId}`);
            const fileBuffer = await optimizedDriveService.downloadFile(fileId);
            const data = await pdf(fileBuffer);
            return this.cleanText(data.text);
        } catch (error) {
            console.error('Error extracting PDF text from Drive file:', error);
            throw new ApiError(500, `Failed to extract text from Drive PDF: ${error.message}`);
        }
    }

    cleanText(text) {
        if (!text) return '';
        
        // Remove null bytes and other problematic characters
        text = text.replace(/\x00/g, '').replace(/\r/g, '\n');
        
        // Remove excessive whitespace
        text = text.replace(/\s+/g, ' ').trim();
        
        // More conservative limit to prevent token overflow
        const maxLength = 100000; // Increased but will be chunked by Gemini service
        if (text.length > maxLength) {
            console.log(`⚠️ PDF text is large (${text.length} chars), will be processed in chunks`);
        }
        
        return text;
    }

    async deleteTempFile(filePath) {
        try {
            await fs.unlink(filePath);
            console.log(`🗑️ Deleted temporary file: ${filePath}`);
        } catch (error) {
            console.error(`Warning: Could not delete temp file ${filePath}:`, error.message);
        }
    }

    validatePDFFile(file) {
        if (!file) {
            throw new ApiError(400, 'No PDF file provided');
        }

        if (file.mimetype !== 'application/pdf') {
            throw new ApiError(400, 'Invalid file type. Only PDF files are allowed');
        }

        if (file.size > 10 * 1024 * 1024) { // 10MB
            throw new ApiError(400, 'File size too large. Maximum size is 10MB');
        }

        return true;
    }
}

// Create singleton instance
const pdfService = new PDFService();

export default pdfService;