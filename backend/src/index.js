import App from './app.js';
import config from './config/config.js';

const startServer = async () => {
    try {
        // Create app instance
        const appInstance = new App();
        const app = appInstance.getApp();

        // Initialize all services
        const servicesInitialized = await appInstance.initializeServices();
        
        if (!servicesInitialized) {
            console.error('❌ Failed to initialize services. Exiting...');
            process.exit(1);
        }

        // Start the server
        const server = app.listen(config.port, () => {
            console.log('');
            console.log('🎉 ===== Policy Audit Backend Started =====');
            console.log(`🚀 Server running on port: ${config.port}`);
            console.log(`📋 Policy index loaded: ${config.policyIndexPath}`);
            console.log(`📁 Drive path: ${config.driveRootPath}`);
            console.log(`🤖 Gemini API: ${config.geminiApiKey ? 'Configured ✅' : 'Not configured ❌'}`);
            console.log(`🌍 Environment: ${config.nodeEnv}`);
            console.log('');
            console.log('📡 API Endpoints:');
            console.log(`   Health Check: http://localhost:${config.port}/api/v1/health`);
            console.log(`   Process PDF:  http://localhost:${config.port}/api/v1/process`);
            console.log(`   Submit Match: http://localhost:${config.port}/api/v1/submit-matches`);
            console.log('');
            console.log('🔗 Ready to receive requests!');
            console.log('==========================================');
            console.log('');
        });

        // Graceful shutdown handling
        const gracefulShutdown = (signal) => {
            console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
            
            server.close((err) => {
                if (err) {
                    console.error('❌ Error during server shutdown:', err);
                    process.exit(1);
                }
                
                console.log('✅ Server closed successfully');
                console.log('👋 Goodbye!');
                process.exit(0);
            });
        };

        // Handle process signals
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));

        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            console.error('❌ Uncaught Exception:', error);
            gracefulShutdown('UNCAUGHT_EXCEPTION');
        });

        // Handle unhandled promise rejections
        process.on('unhandledRejection', (reason, promise) => {
            console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
            gracefulShutdown('UNHANDLED_REJECTION');
        });

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
};

// Start the server
startServer();