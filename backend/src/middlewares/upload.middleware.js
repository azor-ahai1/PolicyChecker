import multer from 'multer';
import path from 'path';
import config from '../config/config.js';
import { ApiError } from '../utils/apiError.js';

// Configure multer storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, config.uploadDir);
    },
    filename: (req, file, cb) => {
        // Generate unique filename with timestamp
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

// File filter function
const fileFilter = (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
        cb(null, true);
    } else {
        cb(new ApiError(400, 'Only PDF files are allowed'), false);
    }
};

// Configure multer
const upload = multer({
    storage: storage,
    limits: {
        fileSize: config.maxFileSize, // 10MB limit
        files: 1 // Only allow 1 file
    },
    fileFilter: fileFilter
});

// Middleware for handling single file upload
const uploadSinglePDF = upload.single('questions');

// Error handling middleware for multer errors
const handleUploadError = (error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return next(new ApiError(400, 'File size too large. Maximum size is 10MB'));
        }
        if (error.code === 'LIMIT_FILE_COUNT') {
            return next(new ApiError(400, 'Too many files. Only 1 file is allowed'));
        }
        if (error.code === 'LIMIT_UNEXPECTED_FILE') {
            return next(new ApiError(400, 'Unexpected field name. Use "questions" as field name'));
        }
        return next(new ApiError(400, `Upload error: ${error.message}`));
    }
    next(error);
};

export { uploadSinglePDF, handleUploadError };