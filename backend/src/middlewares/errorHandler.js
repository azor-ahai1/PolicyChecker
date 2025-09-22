import { ApiError } from '../utils/apiError.js';
import { ApiResponse } from '../utils/apiResponse.js';
import config from '../config/config.js';

const errorHandler = (err, req, res, next) => {
    let error = err;

    // Convert non-ApiError errors to ApiError
    if (!(error instanceof ApiError)) {
        const statusCode = error.statusCode || 500;
        const message = error.message || "Internal Server Error";
        error = new ApiError(statusCode, message, [], err.stack);
    }

    // Log error in development
    if (config.nodeEnv === 'development') {
        console.error('Error:', {
            message: error.message,
            stack: error.stack,
            statusCode: error.statusCode
        });
    } else {
        // Log only error message in production
        console.error('Error:', error.message);
    }

    // Send error response
    const response = {
        success: false,
        message: error.message,
        ...(config.nodeEnv === 'development' && { stack: error.stack }),
        ...(error.errors.length > 0 && { errors: error.errors })
    };

    return res.status(error.statusCode).json(response);
};

// Handle 404 routes
const notFoundHandler = (req, res, next) => {
    const error = new ApiError(404, `Route ${req.originalUrl} not found`);
    next(error);
};

export { errorHandler, notFoundHandler };