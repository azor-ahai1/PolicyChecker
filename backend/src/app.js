import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';

// Import configuration and services
import config from './config/config.js';
import { initializeGemini } from './config/gemini.js';
import policyService from './services/policyService.js';

// Import middleware
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';

// Import routes
import processRoutes from './routes/process.routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class App {
    constructor() {
        this.app = express();
        this.initializeDirectories();
        this.initializeMiddleware();
        this.initializeRoutes();
        this.initializeErrorHandling();
    }

    async initializeDirectories() {
        try {
            // Create required directories if they don't exist
            await fs.mkdir(config.uploadDir, { recursive: true });
            await fs.mkdir(config.outputDir, { recursive: true });
            console.log('📁 Directories initialized successfully');
        } catch (error) {
            console.error('❌ Error creating directories:', error.message);
        }
    }

    initializeMiddleware() {
        // CORS configuration
        this.app.use(cors({
            origin: config.nodeEnv === 'production' 
                ? [config.frontendURL] // Add your production domains here
                : true, // Allow all origins in development
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization']
        }));

        // Body parsing middleware
        this.app.use(express.json({ limit: '50mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));

        // Request logging middleware
        if (config.nodeEnv === 'development') {
            this.app.use((req, res, next) => {
                console.log(`📝 ${req.method} ${req.path} - ${new Date().toISOString()}`);
                next();
            });
        }
    }

    initializeRoutes() {
        // API routes with version prefix
        this.app.use('/api/v1', processRoutes);

        // Root endpoint
        this.app.get('/', (req, res) => {
            res.json({
                success: true,
                message: 'Policy Audit Backend API',
                version: '1.0.0',
                endpoints: {
                    health: '/api/v1/health',
                    process: '/api/v1/process (POST)',
                    submitMatches: '/api/v1/submit-matches (POST)'
                }
            });
        });
    }

    initializeErrorHandling() {
        // Handle 404 routes
        this.app.use(notFoundHandler);

        // Global error handler
        this.app.use(errorHandler);
    }

    async initializeServices() {
        try {
            console.log('🚀 Initializing services...');

            // Initialize Gemini AI
            await initializeGemini();

            // Load policy index
            await policyService.loadPolicyIndex();

            console.log('✅ All services initialized successfully');
            return true;
        } catch (error) {
            console.error('❌ Service initialization failed:', error.message);
            return false;
        }
    }

    getApp() {
        return this.app;
    }
}

export default App;