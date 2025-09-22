import { GoogleGenerativeAI } from '@google/generative-ai';
import config from './config.js';
import { ApiError } from '../utils/apiError.js';

let genAI;
let model;

const initializeGemini = () => {
    try {
        if (!config.geminiApiKey) {
            throw new ApiError(500, "Gemini API key is not configured");
        }
        genAI = new GoogleGenerativeAI(config.geminiApiKey);
        model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        
        console.log('✅ Gemini AI initialized successfully');
        return { genAI, model };
    } catch (error) {
        console.error('❌ Error initializing Gemini AI:', error.message);
        throw new ApiError(500, `Failed to initialize Gemini AI: ${error.message}`);
    }
};

const getGeminiModel = () => {
    if (!model) {
        throw new ApiError(500, "Gemini AI not initialized");
    }
    return model;
};

export { initializeGemini, getGeminiModel };