import { Router } from 'express';
import {
    processAuditQuestions,
} from '../controllers/process.controller.js';
import { uploadSinglePDF, handleUploadError } from '../middlewares/upload.middleware.js';

const router = Router();

// Health check route
// router.get('/health', getHealthStatus);

// Process audit questions PDF
router.post('/process', uploadSinglePDF, handleUploadError, processAuditQuestions);

// Submit selected matches
// router.post('/submit-matches', submitMatches);

export default router;